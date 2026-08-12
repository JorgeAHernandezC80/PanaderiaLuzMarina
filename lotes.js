/**
 * LOTES — procesamiento de datos: arma el lote a partir de lo que ya está
 * registrado en la base y lo deja listo para analizar.
 *
 * No hay tabla `lotes` ni la hace falta: un lote ES una horneada. Lo que
 * faltaba era el trabajo de datos alrededor — cruzar cada horneada con su
 * tanda de masa (producciones), con la ficha técnica (recetas), con el
 * producto (vida útil, precio) y con las ventas del día, derivar los
 * indicadores que ninguna tabla guarda (desvío contra la receta, frescura,
 * unidades vendidas por FIFO, trazabilidad hacia el lote del proveedor) y
 * validar el resultado. Duplicar todo eso en una tabla nueva solo habría
 * agregado un lugar más donde los datos se pueden desincronizar.
 *
 * Reparto de responsabilidades, igual que estadisticas.js/analyticsEngine.js:
 * la aritmética pura vive en lotesAnalitica.js; acá está el acceso a SQLite
 * y el armado. Los endpoints (server.js) solo llaman.
 */

const db = require('./db');
const { asignarConsumoFIFO } = require('./estadisticas');
const Analitica = require('./lotesAnalitica');

/* Mismo criterio de zona horaria que server.js/analyticsEngine.js (ver
   hoyHouston en ambos): duplicado a propósito para no importar server.js
   desde acá (sería circular). */
const HOUSTON_TZ = 'America/Chicago';

// Ventana por defecto cuando la petición no trae rango: un mes de horneadas
// es suficiente para ver tendencia sin traer todo el historial.
const VENTANA_DIAS_DEFECTO = 30;

// A menos de esto para vencer, el lote se marca 'por_vencer' — la señal de
// "sácalo ya" mientras todavía se puede vender.
const UMBRAL_POR_VENCER_HORAS = 2;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function hoyHouston() {
  return new Date().toLocaleDateString('en-CA', { timeZone: HOUSTON_TZ });
}

function ahoraHoraHouston() {
  return new Date()
    .toLocaleTimeString('en-GB', { timeZone: HOUSTON_TZ, hour12: false })
    .slice(0, 5);
}

function sqliteDatetimeAIso(valor) {
  if (!valor) return null;
  return `${valor.replace(' ', 'T')}Z`;
}

/** "HH:MM" -> minutos desde medianoche; null si el formato no matchea. */
function minutosDesdeHora(horaHHMM) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(horaHHMM || '');
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Un datetime de SQLite (UTC, sin zona) -> minutos desde medianoche EN
 *  HORA DE HOUSTON. Las horas de horneado se capturan a mano en hora
 *  local: comparar contra un timestamp UTC sin convertir metería el
 *  desfase de 5-6h. */
function minutosDesdeHoraLocal(sqliteDatetimeUtc) {
  const iso = sqliteDatetimeAIso(sqliteDatetimeUtc);
  if (!iso) return null;
  const horaLocal = new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: HOUSTON_TZ,
    hour12: false,
  });
  return minutosDesdeHora(horaLocal.slice(0, 5));
}

function restarDias(fechaIso, dias) {
  const d = new Date(`${fechaIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/** Todos los días del rango, incluidos los que no tuvieron ni una
 *  horneada — sin los ceros, la tendencia y la media móvil promediarían
 *  solo los días con producción y quedarían sesgadas hacia arriba. */
function diasDelRango(desde, hasta) {
  const dias = [];
  for (let d = new Date(`${desde}T00:00:00Z`); d <= new Date(`${hasta}T00:00:00Z`);) {
    dias.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dias;
}

/** Normaliza el rango pedido: valida formato, aplica la ventana por
 *  defecto y evita el rango invertido (que devolvería 0 lotes sin decir
 *  por qué). */
function resolverRango({ desde, hasta } = {}) {
  const hastaFinal = FECHA_RE.test(hasta || '') ? hasta : hoyHouston();
  const desdeFinal = FECHA_RE.test(desde || '')
    ? desde
    : restarDias(hastaFinal, VENTANA_DIAS_DEFECTO - 1);
  return desdeFinal <= hastaFinal
    ? { desde: desdeFinal, hasta: hastaFinal }
    : { desde: hastaFinal, hasta: desdeFinal };
}

/** Código legible del lote: fecha + hora de horneado + sufijo del id. La
 *  horneada ya tiene un id (uuid), pero nadie puede leerlo en voz alta ni
 *  escribirlo en una bandeja — este código sí. */
function codigoLote(row) {
  const fecha = String(row.fecha).replace(/-/g, '');
  const hora = String(row.hora).replace(':', '');
  const sufijo = String(row.id)
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-4)
    .toUpperCase();
  return `L-${fecha}-${hora}-${sufijo}`;
}

function porcentajeDesvio(real, referencia) {
  if (!Number.isFinite(real) || !Number.isFinite(referencia) || referencia === 0) return null;
  return Analitica.redondear(((real - referencia) / referencia) * 100);
}

/* ═══════════════════════════════════════════
   EXTRACCIÓN
   ═══════════════════════════════════════════ */

/** Horneadas del rango con todo lo que hace falta para el lote, ya cruzado
 *  en una sola consulta: producto (vida útil, precio), tanda de masa
 *  (peso, unidades estimadas, condiciones del día) y ficha técnica
 *  (merma/temperatura/tiempo objetivo). productos.id es INTEGER y
 *  horneadas.producto_id es TEXT — de ahí el CAST del JOIN. */
function consultarFilas({ desde, hasta, productoId }) {
  const params = [desde, hasta];
  let filtroProducto = '';
  if (productoId) {
    filtroProducto = ' AND h.producto_id = ?';
    params.push(String(productoId));
  }

  return db
    .prepare(
      `SELECT h.id, h.producto_id, h.producto_nombre, h.cantidad, h.fecha, h.hora,
              h.registrado_por, h.notas, h.produccion_id,
              h.temperatura_horneado_real_c, h.tiempo_horneado_real_min, h.merma_real_pct,
              h.temperatura_piso_horno_c, h.peso_pan_cocido_total_g,
              h.costo_estimado_energia_lote, h.unidades_segunda_calidad,
              h.creado_en, h.actualizado_en,
              p.vida_util_horas, p.precio, p.categoria,
              pr.peso_total_masa_g, pr.unidades_estimadas, pr.fecha AS produccion_fecha,
              pr.hora_inicio AS produccion_hora_inicio, pr.temperatura_ambiente_c,
              pr.temperatura_agua_c, pr.edad_masa_madre_horas, pr.tiempo_mano_obra_real_min,
              r.merma_coccion_pct, r.temperatura_horneado_c, r.tiempo_horneado_min,
              r.peso_masa_por_unidad_g
       FROM horneadas h
       LEFT JOIN productos p ON p.id = CAST(h.producto_id AS INTEGER)
       LEFT JOIN producciones pr ON pr.id = h.produccion_id
       LEFT JOIN recetas r ON r.producto_id = h.producto_id
       WHERE h.fecha >= ? AND h.fecha <= ?${filtroProducto}
       ORDER BY h.fecha DESC, h.hora DESC`,
    )
    .all(...params);
}

/** Ingredientes reales de cada tanda involucrada, en una sola consulta
 *  (un SELECT por lote sería N+1). Map produccion_id -> filas. */
function consultarIngredientesPorProduccion(produccionIds) {
  if (produccionIds.length === 0) return new Map();
  const marcadores = produccionIds.map(() => '?').join(', ');
  const filas = db
    .prepare(
      `SELECT pi.produccion_id, pi.insumo_id, pi.insumo_nombre, pi.gramos,
              i.unidad, i.costo_unitario, i.lote_proveedor AS lote_actual_insumo
       FROM produccion_ingredientes pi
       LEFT JOIN insumos i ON i.id = pi.insumo_id
       WHERE pi.produccion_id IN (${marcadores})`,
    )
    .all(...produccionIds);

  const porProduccion = new Map();
  for (const fila of filas) {
    if (!porProduccion.has(fila.produccion_id)) porProduccion.set(fila.produccion_id, []);
    porProduccion.get(fila.produccion_id).push(fila);
  }
  return porProduccion;
}

/** Recepciones de cada insumo (con su lote de proveedor), más recientes
 *  primero. Es la tabla que permite el salto final de la trazabilidad:
 *  de un insumo usado en una tanda, a la entrega física que lo surtió y
 *  a la orden de compra que la originó. */
function consultarRecepcionesPorInsumo(insumoIds) {
  if (insumoIds.length === 0) return new Map();
  const marcadores = insumoIds.map(() => '?').join(', ');
  const filas = db
    .prepare(
      `SELECT ri.insumo_id, ri.lote_proveedor, ri.fecha_vencimiento, ri.cantidad_recibida,
              rec.fecha AS fecha_recepcion, oc.numero AS orden_numero,
              oc.proveedor_razon_social
       FROM orden_compra_recepcion_items ri
       JOIN orden_compra_recepciones rec ON rec.id = ri.recepcion_id
       JOIN ordenes_compra oc ON oc.id = rec.orden_compra_id
       WHERE ri.insumo_id IN (${marcadores})
       ORDER BY rec.fecha DESC, rec.hora DESC`,
    )
    .all(...insumoIds);

  const porInsumo = new Map();
  for (const fila of filas) {
    if (!porInsumo.has(fila.insumo_id)) porInsumo.set(fila.insumo_id, []);
    porInsumo.get(fila.insumo_id).push(fila);
  }
  return porInsumo;
}

/** Ventas 'entregada' del rango, agrupadas por producto y día, con el
 *  minuto en que se entregó cada una — la entrada de consumos para el
 *  FIFO. El momento de venta es actualizado_en (cuándo pasó a entregada),
 *  no fecha_iso (cuándo se creó): mismo criterio que analyticsEngine.js. */
function consultarConsumosPorProductoYDia({ desde, hasta }) {
  const filas = db
    .prepare(
      `SELECT fecha_iso, actualizado_en, items_json
       FROM ordenes
       WHERE estado = 'entregada' AND fecha_iso >= ? AND fecha_iso <= ?`,
    )
    .all(desde, hasta);

  const consumos = new Map(); // `${productoId}|${fecha}` -> [{minutoVenta, cantidad}]
  for (const fila of filas) {
    let items;
    try {
      items = JSON.parse(fila.items_json);
    } catch {
      continue;
    }
    const minutoVenta = minutosDesdeHoraLocal(fila.actualizado_en);
    if (minutoVenta === null) continue;
    const fecha = fila.fecha_iso.slice(0, 10);

    for (const item of items) {
      // Las órdenes viejas no guardaban productoId: no hay forma
      // confiable de asignarlas a un lote, así que se omiten (mejor que
      // cruzar por nombre y contaminar el análisis con falsos positivos).
      if (!item.productoId) continue;
      const clave = `${item.productoId}|${fecha}`;
      if (!consumos.has(clave)) consumos.set(clave, []);
      consumos.get(clave).push({ minutoVenta, cantidad: Number(item.cantidad) || 0 });
    }
  }
  return consumos;
}

/* ═══════════════════════════════════════════
   ARMADO DEL LOTE
   ═══════════════════════════════════════════ */

/** Vencimiento del lote = horneado + vida útil del producto, en ISO. null
 *  si el producto no tiene vida útil configurada. */
function calcularVencimientoIso(fecha, hora, vidaUtilHoras) {
  if (!Number.isFinite(vidaUtilHoras) || vidaUtilHoras <= 0) return null;
  const horneado = new Date(`${fecha}T${hora}:00`);
  if (Number.isNaN(horneado.getTime())) return null;
  horneado.setMinutes(horneado.getMinutes() + vidaUtilHoras * 60);
  return `${horneado.toISOString().slice(0, 19)}`;
}

/** Estado del lote hoy. 'agotado' gana sobre cualquier otro: si se vendió
 *  completo, su frescura ya no es un problema operativo. */
function calcularEstadoFrescura({ fecha, hora, vidaUtilHoras, seAgoto, ahoraFecha, ahoraHora }) {
  if (seAgoto) return 'agotado';
  if (!Number.isFinite(vidaUtilHoras) || vidaUtilHoras <= 0) return 'sin_dato';

  const minutosHorneado = minutosDesdeHora(hora) ?? 0;
  const minutosAhora = minutosDesdeHora(ahoraHora) ?? 0;
  const diasDeDiferencia = Math.round(
    (new Date(`${ahoraFecha}T00:00:00Z`) - new Date(`${fecha}T00:00:00Z`)) / 86400000,
  );
  const minutosTranscurridos = diasDeDiferencia * 1440 + (minutosAhora - minutosHorneado);
  if (minutosTranscurridos < 0) return 'fresco'; // horneada registrada a futuro

  const restantes = vidaUtilHoras * 60 - minutosTranscurridos;
  if (restantes <= 0) return 'vencido';
  if (restantes <= UMBRAL_POR_VENCER_HORAS * 60) return 'por_vencer';
  return 'fresco';
}

/** Trazabilidad hacia atrás de un ingrediente: la entrega más reciente de
 *  ese insumo ANTERIOR (o igual) a la fecha de la tanda — la que
 *  razonablemente lo surtió. Si no hay ninguna recepción registrada,
 *  cae al lote que tenga hoy la ficha del insumo, y si tampoco, queda
 *  explícitamente sin trazar (no se inventa un lote). */
function resolverLoteProveedor(recepciones, ingrediente, fechaTanda) {
  const candidata = (recepciones ?? []).find(
    (r) => r.lote_proveedor && (!fechaTanda || r.fecha_recepcion <= fechaTanda),
  );
  if (candidata) {
    return {
      loteProveedor: candidata.lote_proveedor,
      fechaVencimiento: candidata.fecha_vencimiento,
      fechaRecepcion: candidata.fecha_recepcion,
      ordenNumero: candidata.orden_numero,
      proveedor: candidata.proveedor_razon_social,
      origen: 'recepcion',
    };
  }
  if (ingrediente.lote_actual_insumo) {
    return {
      loteProveedor: ingrediente.lote_actual_insumo,
      fechaVencimiento: null,
      fechaRecepcion: null,
      ordenNumero: null,
      proveedor: null,
      origen: 'ficha_insumo',
    };
  }
  return {
    loteProveedor: null,
    fechaVencimiento: null,
    fechaRecepcion: null,
    ordenNumero: null,
    proveedor: null,
    origen: 'sin_dato',
  };
}

/** Un lote completo: la horneada + todo lo derivado. Cada indicador que
 *  no se puede calcular queda en null, nunca en 0 (0% de merma y "no se
 *  midió la merma" son cosas distintas y el análisis las trata distinto). */
function construirLote(fila, { ingredientes, recepcionesPorInsumo, ahoraFecha, ahoraHora }) {
  const cantidad = Number(fila.cantidad) || 0;
  const mermaRealPct = fila.merma_real_pct;
  const mermaEsperadaPct = fila.merma_coccion_pct;
  const segundaCalidad = fila.unidades_segunda_calidad;

  const trazabilidad = ingredientes.map((ingrediente) => ({
    insumoId: ingrediente.insumo_id,
    insumoNombre: ingrediente.insumo_nombre,
    gramos: ingrediente.gramos,
    ...resolverLoteProveedor(
      recepcionesPorInsumo.get(ingrediente.insumo_id),
      ingrediente,
      fila.produccion_fecha,
    ),
  }));

  return {
    id: fila.id,
    codigo: codigoLote(fila),
    productoId: fila.producto_id,
    productoNombre: fila.producto_nombre,
    categoria: fila.categoria ?? null,
    fecha: fila.fecha,
    hora: fila.hora,
    horaDelDia: Math.floor((minutosDesdeHora(fila.hora) ?? 0) / 60),
    cantidad,
    registradoPor: fila.registrado_por,
    notas: fila.notas,

    // Horneado real vs. ficha técnica: el corazón del análisis de proceso.
    mermaRealPct,
    mermaEsperadaPct,
    desvioMermaPp:
      Number.isFinite(mermaRealPct) && Number.isFinite(mermaEsperadaPct)
        ? Analitica.redondear(mermaRealPct - mermaEsperadaPct)
        : null,
    temperaturaHorneadoRealC: fila.temperatura_horneado_real_c,
    temperaturaRecetaC: fila.temperatura_horneado_c,
    desvioTemperaturaC:
      Number.isFinite(fila.temperatura_horneado_real_c) &&
      Number.isFinite(fila.temperatura_horneado_c)
        ? Analitica.redondear(fila.temperatura_horneado_real_c - fila.temperatura_horneado_c)
        : null,
    tiempoHorneadoRealMin: fila.tiempo_horneado_real_min,
    tiempoRecetaMin: fila.tiempo_horneado_min,
    desvioTiempoHorneadoPct: porcentajeDesvio(
      fila.tiempo_horneado_real_min,
      fila.tiempo_horneado_min,
    ),
    temperaturaPisoHornoC: fila.temperatura_piso_horno_c,
    pesoPanCocidoTotalG: fila.peso_pan_cocido_total_g,
    pesoPorUnidadG:
      Number.isFinite(fila.peso_pan_cocido_total_g) && cantidad > 0
        ? Analitica.redondear(fila.peso_pan_cocido_total_g / cantidad)
        : null,
    costoEnergiaLote: fila.costo_estimado_energia_lote,
    costoEnergiaPorUnidad:
      Number.isFinite(fila.costo_estimado_energia_lote) && cantidad > 0
        ? Analitica.redondear(fila.costo_estimado_energia_lote / cantidad, 4)
        : null,
    unidadesSegundaCalidad: segundaCalidad,
    segundaCalidadPct:
      Number.isFinite(segundaCalidad) && cantidad > 0
        ? Analitica.redondear((segundaCalidad / cantidad) * 100)
        : null,

    // Tanda de masa de origen (etapas 1-8) — el eslabón anterior.
    produccionId: fila.produccion_id,
    produccionFecha: fila.produccion_fecha ?? null,
    pesoTotalMasaG: fila.peso_total_masa_g ?? null,
    unidadesEstimadas: fila.unidades_estimadas ?? null,
    desvioRendimientoPct: porcentajeDesvio(cantidad, fila.unidades_estimadas),
    temperaturaAmbienteC: fila.temperatura_ambiente_c ?? null,
    temperaturaAguaC: fila.temperatura_agua_c ?? null,
    edadMasaMadreHoras: fila.edad_masa_madre_horas ?? null,
    ingredientesRegistrados: ingredientes.length,
    insumosSinLoteProveedor: trazabilidad.filter((t) => !t.loteProveedor).length,
    trazabilidad,

    // Frescura y salida (unidadesVendidas se completa con el FIFO).
    vidaUtilHoras: fila.vida_util_horas,
    vencimientoIso: calcularVencimientoIso(fila.fecha, fila.hora, fila.vida_util_horas),
    estadoFrescura: calcularEstadoFrescura({
      fecha: fila.fecha,
      hora: fila.hora,
      vidaUtilHoras: fila.vida_util_horas,
      seAgoto: false,
      ahoraFecha,
      ahoraHora,
    }),
    precioUnitario: fila.precio ?? null,
    unidadesVendidas: null,
    unidadesNoVendidas: null,
    horasHastaAgotarse: null,
    vendidoATiempo: null,

    creadoEn: sqliteDatetimeAIso(fila.creado_en),
    actualizadoEn: sqliteDatetimeAIso(fila.actualizado_en),
  };
}

/** Reparte las ventas de cada día entre los lotes de ese producto en orden
 *  FIFO (el más viejo primero, ver asignarConsumoFIFO en estadisticas.js) y
 *  completa sobre cada lote cuántas unidades salieron, en cuánto tiempo, y
 *  si alcanzó a venderse dentro de su vida útil. Muta los lotes recibidos:
 *  es la segunda pasada del mismo armado, no un resultado aparte. */
function asignarVentas(lotes, consumos, { ahoraFecha, ahoraHora }) {
  const porProductoYDia = new Map();
  for (const lote of lotes) {
    const clave = `${lote.productoId}|${lote.fecha}`;
    if (!porProductoYDia.has(clave)) porProductoYDia.set(clave, []);
    porProductoYDia.get(clave).push(lote);
  }

  for (const [clave, grupo] of porProductoYDia) {
    const ordenados = [...grupo].sort(
      (a, b) => (minutosDesdeHora(a.hora) ?? 0) - (minutosDesdeHora(b.hora) ?? 0),
    );
    const resueltos = asignarConsumoFIFO(
      ordenados.map((lote) => ({
        id: lote.id,
        minutoHorneado: minutosDesdeHora(lote.hora) ?? 0,
        cantidad: lote.cantidad,
      })),
      [...(consumos.get(clave) ?? [])].sort((a, b) => a.minutoVenta - b.minutoVenta),
    );

    const porId = new Map(resueltos.map((r) => [r.id, r]));
    for (const lote of ordenados) {
      const resuelto = porId.get(lote.id);
      if (!resuelto) continue;
      lote.unidadesVendidas = resuelto.unidadesVendidas;
      lote.unidadesNoVendidas = lote.cantidad - resuelto.unidadesVendidas;
      lote.horasHastaAgotarse =
        resuelto.minutoAgotado === null
          ? null
          : Analitica.redondear((resuelto.minutoAgotado - resuelto.minutoHorneado) / 60);
      lote.vendidoATiempo =
        resuelto.minutoAgotado === null || !Number.isFinite(lote.vidaUtilHoras)
          ? null
          : resuelto.minutoAgotado - resuelto.minutoHorneado <= lote.vidaUtilHoras * 60;
      lote.estadoFrescura = calcularEstadoFrescura({
        fecha: lote.fecha,
        hora: lote.hora,
        vidaUtilHoras: lote.vidaUtilHoras,
        seAgoto: resuelto.minutoAgotado !== null,
        ahoraFecha,
        ahoraHora,
      });
    }
  }
}

/** Punto de entrada del procesamiento: los lotes del rango, ya cruzados,
 *  derivados, con ventas asignadas y con sus hallazgos de validación. */
function obtenerLotes(filtros = {}) {
  const rango = resolverRango(filtros);
  const filas = consultarFilas({ ...rango, productoId: filtros.productoId });

  const produccionIds = [...new Set(filas.map((f) => f.produccion_id).filter(Boolean))];
  const ingredientesPorProduccion = consultarIngredientesPorProduccion(produccionIds);
  const insumoIds = [
    ...new Set([...ingredientesPorProduccion.values()].flat().map((i) => i.insumo_id)),
  ];
  const recepcionesPorInsumo = consultarRecepcionesPorInsumo(insumoIds);

  const ahoraFecha = hoyHouston();
  const ahoraHora = ahoraHoraHouston();

  const lotes = filas.map((fila) =>
    construirLote(fila, {
      ingredientes: ingredientesPorProduccion.get(fila.produccion_id) ?? [],
      recepcionesPorInsumo,
      ahoraFecha,
      ahoraHora,
    }),
  );

  asignarVentas(lotes, consultarConsumosPorProductoYDia(rango), { ahoraFecha, ahoraHora });

  // La validación va al final: sus reglas leen indicadores derivados
  // (desvíos, trazabilidad, segunda calidad) que recién existen acá.
  for (const lote of lotes) lote.hallazgos = Analitica.validarLote(lote);

  return { periodo: { ...rango, dias: diasDelRango(rango.desde, rango.hasta).length }, lotes };
}

/* ═══════════════════════════════════════════
   ANÁLISIS
   ═══════════════════════════════════════════ */

function sumar(valores) {
  return valores.reduce((suma, v) => suma + (Number.isFinite(v) ? v : 0), 0);
}

function promedio(valores) {
  const limpios = valores.filter((v) => Number.isFinite(v));
  return limpios.length ? Analitica.redondear(sumar(limpios) / limpios.length) : null;
}

/** Los números de encabezado del período. */
function calcularResumen(lotes) {
  const totalUnidades = sumar(lotes.map((l) => l.cantidad));
  const unidadesVendidas = sumar(lotes.map((l) => l.unidadesVendidas));

  return {
    totalLotes: lotes.length,
    totalUnidades,
    unidadesVendidas,
    unidadesNoVendidas: totalUnidades - unidadesVendidas,
    // Qué parte de lo horneado se vendió el mismo día. null sin nada
    // horneado: 0% se leería como "no se vendió nada".
    tasaVentaPct:
      totalUnidades > 0 ? Analitica.redondear((unidadesVendidas / totalUnidades) * 100) : null,
    mermaPromedioPct: promedio(lotes.map((l) => l.mermaRealPct)),
    desvioMermaPromedioPp: promedio(lotes.map((l) => l.desvioMermaPp)),
    segundaCalidadPromedioPct: promedio(lotes.map((l) => l.segundaCalidadPct)),
    horasPromedioHastaAgotarse: promedio(lotes.map((l) => l.horasHastaAgotarse)),
    costoEnergiaTotal: Analitica.redondear(sumar(lotes.map((l) => l.costoEnergiaLote))),
    lotesPorEstado: ['fresco', 'por_vencer', 'vencido', 'agotado', 'sin_dato'].map((estado) => ({
      estado,
      total: lotes.filter((l) => l.estadoFrescura === estado).length,
    })),
    lotesTrazables: lotes.filter((l) => l.produccionId && l.insumosSinLoteProveedor === 0).length,
  };
}

/* Variables que entran al análisis exploratorio. Declarativo a propósito
   (mismo criterio que el diccionario de datos de calidadDatos.js): sumar
   una variable al histograma/descriptivas es agregar una línea acá. */
const VARIABLES_ANALISIS = Object.freeze([
  { campo: 'cantidad', etiqueta: 'Unidades por lote', unidad: 'u', bins: 8 },
  { campo: 'mermaRealPct', etiqueta: 'Merma real', unidad: '%', bins: 8 },
  { campo: 'desvioMermaPp', etiqueta: 'Desvío de merma vs. receta', unidad: 'pp', bins: 8 },
  { campo: 'segundaCalidadPct', etiqueta: 'Segunda calidad', unidad: '%', bins: 6 },
  { campo: 'horasHastaAgotarse', etiqueta: 'Horas hasta agotarse', unidad: 'h', bins: 6 },
  { campo: 'pesoPorUnidadG', etiqueta: 'Peso por unidad', unidad: 'g', bins: 6 },
]);

/* Pares que se cruzan buscando relación. La merma es la variable de
   interés: lo que el panadero quiere saber es qué la mueve. */
const PARES_CORRELACION = Object.freeze([
  {
    x: 'temperaturaHorneadoRealC',
    y: 'mermaRealPct',
    etiqueta: 'Temperatura de horneado vs. merma',
  },
  { x: 'tiempoHorneadoRealMin', y: 'mermaRealPct', etiqueta: 'Tiempo de horneado vs. merma' },
  { x: 'temperaturaAmbienteC', y: 'mermaRealPct', etiqueta: 'Temperatura ambiente vs. merma' },
  { x: 'cantidad', y: 'mermaRealPct', etiqueta: 'Tamaño del lote vs. merma' },
  { x: 'horaDelDia', y: 'horasHastaAgotarse', etiqueta: 'Hora de horneado vs. tiempo en venderse' },
  { x: 'cantidad', y: 'segundaCalidadPct', etiqueta: 'Tamaño del lote vs. segunda calidad' },
]);

function resumirGrupo(grupo) {
  const totalUnidades = sumar(grupo.map((l) => l.cantidad));
  const unidadesVendidas = sumar(grupo.map((l) => l.unidadesVendidas));
  return {
    lotes: grupo.length,
    unidades: totalUnidades,
    unidadesVendidas,
    tasaVentaPct:
      totalUnidades > 0 ? Analitica.redondear((unidadesVendidas / totalUnidades) * 100) : null,
    mermaPromedioPct: promedio(grupo.map((l) => l.mermaRealPct)),
    segundaCalidadPromedioPct: promedio(grupo.map((l) => l.segundaCalidadPct)),
    horasPromedioHastaAgotarse: promedio(grupo.map((l) => l.horasHastaAgotarse)),
  };
}

/** Serie diaria con TODOS los días del rango (los días sin horneadas van
 *  en 0) — la base de la media móvil, la tendencia y la comparación entre
 *  ventanas. */
function construirSerieDiaria(lotes, { desde, hasta }) {
  const porFecha = new Map();
  for (const lote of lotes) {
    if (!porFecha.has(lote.fecha)) porFecha.set(lote.fecha, []);
    porFecha.get(lote.fecha).push(lote);
  }

  return diasDelRango(desde, hasta).map((fecha) => {
    const delDia = porFecha.get(fecha) ?? [];
    return {
      fecha,
      lotes: delDia.length,
      unidades: sumar(delDia.map((l) => l.cantidad)),
      unidadesVendidas: sumar(delDia.map((l) => l.unidadesVendidas)),
      // Promedio de merma del día: null en los días sin horneadas (un 0
      // ahí aplanaría la tendencia de merma hacia abajo sin motivo).
      mermaPromedioPct: promedio(delDia.map((l) => l.mermaRealPct)),
    };
  });
}

/** El reporte completo del módulo: exploratorio + tendencias +
 *  correlaciones + validación, sobre el mismo conjunto de lotes. */
function analizarLotes(filtros = {}) {
  const { periodo, lotes } = obtenerLotes(filtros);

  const descriptivas = VARIABLES_ANALISIS.map(({ campo, etiqueta, unidad, bins }) => ({
    campo,
    etiqueta,
    unidad,
    ...Analitica.descriptivas(lotes.map((l) => l[campo])),
    histograma: Analitica.histograma(
      lotes.map((l) => l[campo]),
      bins,
    ),
  }));

  const atipicos = VARIABLES_ANALISIS.flatMap(({ campo, etiqueta, unidad }) =>
    Analitica.outliersIQR(lotes, (lote) => lote[campo]).map(({ item, valor, lado }) => ({
      loteId: item.id,
      codigo: item.codigo,
      productoNombre: item.productoNombre,
      fecha: item.fecha,
      campo,
      etiqueta,
      unidad,
      valor,
      lado,
    })),
  );

  const serie = construirSerieDiaria(lotes, periodo);
  const serieUnidades = serie.map(({ fecha, unidades }) => ({ fecha, valor: unidades }));
  const serieMerma = serie.map(({ fecha, mermaPromedioPct }) => ({
    fecha,
    valor: mermaPromedioPct,
  }));

  return {
    periodo,
    filtros: { productoId: filtros.productoId ?? null },
    // Los lotes viajan con el análisis: la vista muestra la tabla y los
    // agregados a la vez, y pedirlos por separado significaría dos
    // consultas al mismo rango con riesgo de que no coincidan.
    lotes,
    resumen: calcularResumen(lotes),
    descriptivas,
    atipicos,
    porProducto: Analitica.agrupar(lotes, (l) => l.productoNombre, resumirGrupo).sort(
      (a, b) => b.unidades - a.unidades,
    ),
    porHora: Analitica.agrupar(lotes, (l) => String(l.horaDelDia), resumirGrupo).sort(
      (a, b) => Number(a.clave) - Number(b.clave),
    ),
    porDiaSemana: Analitica.agrupar(
      lotes,
      (l) => String(new Date(`${l.fecha}T00:00:00`).getDay()),
      resumirGrupo,
    ).sort((a, b) => Number(a.clave) - Number(b.clave)),
    correlaciones: PARES_CORRELACION.map(({ x, y, etiqueta }) => ({
      x,
      y,
      etiqueta,
      ...Analitica.correlacionPearson(lotes.map((l) => ({ x: l[x], y: l[y] }))),
    })),
    tendencias: {
      serie,
      mediaMovilUnidades: Analitica.mediaMovil(serie.map((d) => d.unidades)),
      unidades: Analitica.tendenciaSerie(serieUnidades),
      merma: Analitica.tendenciaSerie(serieMerma),
      comparacionUnidades: Analitica.compararVentanas(serieUnidades),
    },
    calidad: {
      ...Analitica.validarLotes(lotes),
      completitud: Analitica.completitudLotes(lotes),
    },
  };
}

/** Trazabilidad de un lote puntual: hacia atrás (tanda → insumos → lote
 *  del proveedor → orden de compra) y su propia ficha derivada. */
function obtenerLote(id) {
  const cabecera = db.prepare('SELECT fecha, producto_id FROM horneadas WHERE id = ?').get(id);
  if (!cabecera) return null;

  const { fecha, producto_id: productoId } = cabecera;
  const { lotes } = obtenerLotes({ desde: fecha, hasta: fecha, productoId });
  return lotes.find((lote) => lote.id === id) ?? null;
}

module.exports = {
  VENTANA_DIAS_DEFECTO,
  UMBRAL_POR_VENCER_HORAS,
  VARIABLES_ANALISIS,
  PARES_CORRELACION,
  resolverRango,
  codigoLote,
  calcularVencimientoIso,
  calcularEstadoFrescura,
  construirSerieDiaria,
  calcularResumen,
  obtenerLotes,
  obtenerLote,
  analizarLotes,
};

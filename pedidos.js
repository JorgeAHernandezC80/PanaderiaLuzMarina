/**
 * PEDIDOS — procesamiento de datos: arma cada pedido con su línea de tiempo
 * y lo deja listo para analizar.
 *
 * El pedido ya existía como fila en `ordenes`, pero esa fila solo guarda el
 * estado ACTUAL: al avanzar el pedido, el estado anterior se sobreescribe y
 * con él el tiempo que tardó cada etapa. Acá se cruza cada orden con su
 * historial de transiciones (orden_status_log) y con los metadatos del
 * checkout, y de ese cruce salen las métricas que ninguna columna guarda:
 * lead time por etapa, cuello de botella, embudo de estados y reparto por
 * dispositivo.
 *
 * Reparto de responsabilidades igual que lotes.js/lotesAnalitica.js: acá
 * vive el acceso a SQLite y el armado; la aritmética está en
 * pedidosAnalitica.js. Los endpoints (server.js) solo llaman.
 */

const db = require('./db');
const Analitica = require('./pedidosAnalitica');

/* Mismo criterio de zona horaria que server.js y lotes.js (ver hoyHouston
   en ambos): duplicado a propósito para no importar server.js desde acá
   (sería circular). */
const HOUSTON_TZ = 'America/Chicago';

// Ventana por defecto cuando la petición no trae rango: un mes de pedidos
// alcanza para ver tendencia sin traer todo el historial.
const VENTANA_DIAS_DEFECTO = 30;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function hoyHouston() {
  return new Date().toLocaleDateString('en-CA', { timeZone: HOUSTON_TZ });
}

function sqliteDatetimeAIso(valor) {
  if (!valor) return null;
  return `${valor.replace(' ', 'T')}Z`;
}

function restarDias(fechaIso, dias) {
  const d = new Date(`${fechaIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/** Todos los días del rango, incluidos los que no tuvieron ni un pedido —
 *  sin esos ceros la tendencia promediaría solo los días con venta y
 *  quedaría sesgada hacia arriba. */
function diasDelRango(desde, hasta) {
  const dias = [];
  for (let d = new Date(`${desde}T00:00:00Z`); d <= new Date(`${hasta}T00:00:00Z`);) {
    dias.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dias;
}

/** Normaliza el rango pedido: valida formato, aplica la ventana por defecto
 *  y evita el rango invertido (que devolvería 0 pedidos sin decir por qué). */
function resolverRango({ desde, hasta } = {}) {
  const hastaFinal = FECHA_RE.test(hasta || '') ? hasta : hoyHouston();
  const desdeFinal = FECHA_RE.test(desde || '')
    ? desde
    : restarDias(hastaFinal, VENTANA_DIAS_DEFECTO - 1);
  return desdeFinal <= hastaFinal
    ? { desde: desdeFinal, hasta: hastaFinal }
    : { desde: hastaFinal, hasta: desdeFinal };
}

/* ═══════════════════════════════════════════
   ESCRITURA DEL HISTORIAL
   ═══════════════════════════════════════════ */

/**
 * Registra una transición de estado. Es la única puerta de escritura del
 * historial: si un endpoint cambia `ordenes.estado` sin pasar por acá, el
 * lead time de ese pedido queda incompleto para siempre (el dato no se
 * puede reconstruir después).
 *
 * @param {string} numero número de orden
 * @param {{estadoOrigen: string|null, estadoDestino: string, usuarioAdmin?: string|null, sesionAdmin?: string|null}} datos
 */
function registrarTransicion(numero, { estadoOrigen, estadoDestino, usuarioAdmin, sesionAdmin }) {
  return db
    .prepare(
      `INSERT INTO orden_status_log
         (orden_numero, estado_origen, estado_destino, usuario_admin, sesion_admin)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(numero, estadoOrigen ?? null, estadoDestino, usuarioAdmin ?? null, sesionAdmin ?? null);
}

/** Transiciones de un pedido, en orden cronológico. */
function historialOrden(numero) {
  return db
    .prepare(
      `SELECT id, estado_origen, estado_destino, usuario_admin, sesion_admin, fecha_hora
         FROM orden_status_log
        WHERE orden_numero = ?
        ORDER BY fecha_hora ASC, id ASC`,
    )
    .all(numero)
    .map((fila) => ({
      id: fila.id,
      estadoOrigen: fila.estado_origen,
      estadoDestino: fila.estado_destino,
      etiquetaDestino: Analitica.ETIQUETAS_ESTADO[fila.estado_destino] ?? fila.estado_destino,
      usuarioAdmin: fila.usuario_admin,
      sesionAdmin: fila.sesion_admin,
      fechaHora: sqliteDatetimeAIso(fila.fecha_hora),
    }));
}

/* ═══════════════════════════════════════════
   ARMADO DEL PEDIDO
   ═══════════════════════════════════════════ */

/** Unidades totales del pedido: items_json es un blob, así que el conteo
 *  se hace acá una sola vez y queda disponible para todos los cortes. */
function contarUnidades(itemsJson) {
  try {
    const items = JSON.parse(itemsJson ?? '[]');
    return Array.isArray(items) ? items.reduce((s, i) => s + (Number(i.cantidad) || 0), 0) : 0;
  } catch {
    // items_json corrupto: se reporta como 0 unidades y la regla de
    // validación del pedido lo deja visible; no se tumba el análisis
    // completo por una fila mal escrita.
    return 0;
  }
}

function construirPedido(fila, transiciones) {
  const lineaTiempo = Analitica.construirLineaTiempo(transiciones);
  const minutos = Analitica.minutosPorEstado(lineaTiempo);
  const primera = transiciones[0] ?? null;
  const ultima = transiciones[transiciones.length - 1] ?? null;

  return {
    numero: fila.numero,
    fechaISO: fila.fecha_iso,
    fecha: String(fila.fecha_iso).slice(0, 10),
    hora: String(fila.fecha_iso).slice(11, 16),
    cliente: fila.cliente,
    telefono: fila.telefono,
    retiro: fila.retiro,
    total: fila.total,
    unidades: contarUnidades(fila.items_json),
    estado: fila.estado,
    etiquetaEstado: Analitica.ETIQUETAS_ESTADO[fila.estado] ?? fila.estado,
    creadoEn: sqliteDatetimeAIso(fila.creado_en),
    actualizadoEn: sqliteDatetimeAIso(fila.actualizado_en),

    // Metadatos del checkout (null en los pedidos anteriores a su captura).
    dispositivo: fila.dispositivo,
    userAgent: fila.user_agent,
    zonaHoraria: fila.zona_horaria,
    idioma: fila.idioma,

    // Línea de tiempo reconstruida.
    lineaTiempo,
    primeraTransicionIso: primera ? primera.fechaHora : null,
    ultimaTransicionIso: ultima ? ultima.fechaHora : null,
    minutosPorEstado: minutos,
    minutosEnPreparacion: minutos.en_preparacion ?? null,
    minutosEsperandoRetiro: minutos.preparada ?? null,
    leadTimeTotalMin: lineaTiempo.leadTimeTotalMin,
    entregada: lineaTiempo.entregada,
    // Quién movió el pedido: sin usuarios individuales (el panel usa una
    // sola contraseña) esto es lo que el operario declara al avanzarlo.
    operarios: [
      ...new Set(transiciones.map((t) => t.usuarioAdmin).filter((u) => u !== null && u !== '')),
    ],
  };
}

/**
 * Pedidos del período con su historial ya cruzado.
 * @param {{desde?: string, hasta?: string, estado?: string}} filtros
 */
function construirPedidos(filtros = {}) {
  const { desde, hasta } = resolverRango(filtros);

  let sql = `SELECT numero, fecha_iso, cliente, telefono, retiro, items_json, total, estado,
                    creado_en, actualizado_en, user_agent, dispositivo, zona_horaria, idioma
               FROM ordenes
              WHERE date(substr(fecha_iso, 1, 10)) BETWEEN date(?) AND date(?)`;
  const params = [desde, hasta];

  if (filtros.estado && Analitica.FLUJO_ESTADOS.includes(filtros.estado)) {
    sql += ' AND estado = ?';
    params.push(filtros.estado);
  }
  sql += ' ORDER BY fecha_iso DESC';

  const filas = db.prepare(sql).all(...params);
  if (filas.length === 0) return { periodo: { desde, hasta }, pedidos: [] };

  // Una sola consulta para todo el historial del período en vez de una por
  // pedido: con 200 pedidos son 200 consultas evitadas.
  const marcadores = filas.map(() => '?').join(', ');
  const historial = db
    .prepare(
      `SELECT id, orden_numero, estado_origen, estado_destino, usuario_admin, sesion_admin, fecha_hora
         FROM orden_status_log
        WHERE orden_numero IN (${marcadores})
        ORDER BY fecha_hora ASC, id ASC`,
    )
    .all(...filas.map((f) => f.numero));

  const porOrden = new Map();
  for (const fila of historial) {
    if (!porOrden.has(fila.orden_numero)) porOrden.set(fila.orden_numero, []);
    porOrden.get(fila.orden_numero).push({
      id: fila.id,
      estadoOrigen: fila.estado_origen,
      estadoDestino: fila.estado_destino,
      etiquetaDestino: Analitica.ETIQUETAS_ESTADO[fila.estado_destino] ?? fila.estado_destino,
      usuarioAdmin: fila.usuario_admin,
      sesionAdmin: fila.sesion_admin,
      fechaHora: sqliteDatetimeAIso(fila.fecha_hora),
    });
  }

  return {
    periodo: { desde, hasta },
    pedidos: filas.map((fila) => construirPedido(fila, porOrden.get(fila.numero) ?? [])),
  };
}

/** Un pedido con su línea de tiempo completa, para el detalle del panel. */
function obtenerPedido(numero) {
  const fila = db
    .prepare(
      `SELECT numero, fecha_iso, cliente, telefono, retiro, items_json, total, estado,
              creado_en, actualizado_en, user_agent, dispositivo, zona_horaria, idioma
         FROM ordenes WHERE numero = ?`,
    )
    .get(numero);
  if (!fila) return null;

  const pedido = construirPedido(fila, historialOrden(numero));
  let items = [];
  try {
    items = JSON.parse(fila.items_json ?? '[]');
  } catch {
    items = [];
  }
  return { ...pedido, items, problemas: Analitica.validarPedido(pedido) };
}

/* ═══════════════════════════════════════════
   ANÁLISIS
   ═══════════════════════════════════════════ */

/** Serie diaria del período: un punto por día, con los días sin pedidos en
 *  cero y el lead time del día en null cuando no hubo nada entregado (0
 *  minutos se leería como "instantáneo"). */
function serieDiaria(pedidos, periodo) {
  const porDia = new Map();
  for (const pedido of pedidos) {
    if (!porDia.has(pedido.fecha)) porDia.set(pedido.fecha, []);
    porDia.get(pedido.fecha).push(pedido);
  }

  return diasDelRango(periodo.desde, periodo.hasta).map((fecha) => {
    const delDia = porDia.get(fecha) ?? [];
    const leadTimes = delDia.map((p) => p.leadTimeTotalMin).filter((m) => Number.isFinite(m));
    return {
      fecha,
      pedidos: delDia.length,
      unidades: delDia.reduce((s, p) => s + p.unidades, 0),
      ingresos: Analitica.redondear(delDia.reduce((s, p) => s + (Number(p.total) || 0), 0)),
      entregados: delDia.filter((p) => p.entregada).length,
      leadTimeMedioMin:
        leadTimes.length === 0
          ? null
          : Analitica.redondear(leadTimes.reduce((s, m) => s + m, 0) / leadTimes.length),
    };
  });
}

function resumir(pedidos) {
  const total = pedidos.length;
  const entregados = pedidos.filter((p) => p.entregada).length;
  const ingresos = pedidos.reduce((s, p) => s + (Number(p.total) || 0), 0);
  const conMetadatos = pedidos.filter((p) => p.dispositivo && p.dispositivo !== 'desconocido');
  const movil = conMetadatos.filter((p) => p.dispositivo === 'movil' || p.dispositivo === 'tablet');

  return {
    pedidos: total,
    entregados,
    // Tasa de cumplimiento del período: qué parte de lo que entró terminó
    // en la mano del cliente.
    porcentajeEntregado: total === 0 ? null : Analitica.redondear((entregados / total) * 100),
    unidades: pedidos.reduce((s, p) => s + p.unidades, 0),
    ingresos: Analitica.redondear(ingresos),
    ticketPromedio: total === 0 ? null : Analitica.redondear(ingresos / total),
    pedidosConMetadatos: conMetadatos.length,
    // El porcentaje móvil se calcula sobre los pedidos QUE TIENEN el dato,
    // no sobre el total: mezclarlos diluiría la señal con pedidos viejos.
    porcentajeMovil:
      conMetadatos.length === 0
        ? null
        : Analitica.redondear((movil.length / conMetadatos.length) * 100),
  };
}

/**
 * Análisis completo del período: exploratorio, tendencias, validación y los
 * cortes que consume la vista de Pedidos del panel.
 * @param {{desde?: string, hasta?: string, estado?: string}} filtros
 */
function analizarPedidos(filtros = {}) {
  const { periodo, pedidos } = construirPedidos(filtros);
  const serie = serieDiaria(pedidos, periodo);

  const serieDe = (campo) => serie.map(({ fecha, ...resto }) => ({ fecha, valor: resto[campo] }));

  const leadTimes = pedidos.map((p) => p.leadTimeTotalMin).filter((m) => Number.isFinite(m));

  return {
    periodo,
    filtros: { estado: filtros.estado ?? null },
    pedidos,
    resumen: resumir(pedidos),

    // Exploratorio
    descriptivas: [
      { variable: 'Lead time total (min)', unidad: 'min', ...Analitica.descriptivas(leadTimes) },
      {
        variable: 'Tiempo en preparación (min)',
        unidad: 'min',
        ...Analitica.descriptivas(pedidos.map((p) => p.minutosEnPreparacion)),
      },
      {
        variable: 'Espera del cliente tras estar listo (min)',
        unidad: 'min',
        ...Analitica.descriptivas(pedidos.map((p) => p.minutosEsperandoRetiro)),
      },
      {
        variable: 'Ticket del pedido',
        unidad: '$',
        ...Analitica.descriptivas(pedidos.map((p) => Number(p.total))),
      },
      {
        variable: 'Unidades por pedido',
        unidad: 'u',
        ...Analitica.descriptivas(pedidos.map((p) => p.unidades)),
      },
    ],
    histogramaLeadTime: Analitica.histograma(leadTimes),
    // outliersIQR devuelve el pedido anidado en `item`; la tabla necesita
    // los campos planos para poder decir de qué pedido habla.
    atipicos: Analitica.outliersIQR(
      pedidos.filter((p) => Number.isFinite(p.leadTimeTotalMin)),
      (p) => p.leadTimeTotalMin,
    ).map(({ item, valor, lado }) => ({
      numero: item.numero,
      cliente: item.cliente,
      fecha: item.fecha,
      valor,
      lado,
    })),

    // Procesamiento del ciclo de vida
    leadTime: Analitica.leadTimePorEtapa(pedidos),
    embudo: Analitica.embudoEstados(pedidos),
    porDispositivo: Analitica.porDispositivo(pedidos),
    porHoraIngreso: Analitica.porHoraDeIngreso(pedidos),
    porHoraRetiro: Analitica.porHoraDeRetiro(pedidos),

    // Tendencias
    serie,
    tendencias: {
      pedidos: Analitica.tendenciaSerie(serieDe('pedidos')),
      ingresos: Analitica.tendenciaSerie(serieDe('ingresos')),
      leadTime: Analitica.tendenciaSerie(serieDe('leadTimeMedioMin')),
      mediaMovilPedidos: Analitica.mediaMovil(serie.map((d) => d.pedidos)),
      comparacionPedidos: Analitica.compararVentanas(serieDe('pedidos')),
      comparacionLeadTime: Analitica.compararVentanas(serieDe('leadTimeMedioMin')),
    },

    // Validación
    calidad: Analitica.validarPedidos(pedidos),
    completitud: Analitica.completitudPedidos(pedidos),
  };
}

module.exports = {
  VENTANA_DIAS_DEFECTO,
  resolverRango,
  registrarTransicion,
  historialOrden,
  construirPedidos,
  obtenerPedido,
  analizarPedidos,
};

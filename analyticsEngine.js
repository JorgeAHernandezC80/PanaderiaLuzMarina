/**
 * PANADERÍA LUZ MARINA — Backend: AnalyticsEngine
 *
 * Patrón 1, "Flujo Operativo Automático": al cargar o editar un producto,
 * enriquecerProductoConEstadisticas() recorre ordenes/horneadas/
 * ajustes_inventario, recalcula tasaRotacionDiaria, desviacionEstandarDemanda,
 * factorEstacionalidad, tasaMermaHistorica y probabilidadVencimiento (la
 * aritmética pura vive en estadisticas.js), y los deja guardados en la
 * propia fila de productos — sin que nadie tenga que pedirlo a mano.
 *
 * No recalcula en CADA lectura: recorrer 90 días de órdenes/horneadas por
 * producto en cada GET /productos sería lento sin necesidad. Se recalcula
 * solo si el caché tiene más de RECALCULO_MIN_INTERVALO_MIN minutos (ver
 * necesitaRecalculo) o si se pide explícitamente con { forzar: true }.
 */

const db = require('./db');
const {
  calcularEstadisticasProducto,
  calcularProduccionSugerida,
  asignarConsumoFIFO,
} = require('./estadisticas');

/* Mismo criterio de zona horaria que server.js y admin.js (ver hoyHouston
   en ambos) — duplicado a propósito: analyticsEngine.js no importa
   server.js para no crear una dependencia circular (server.js sí importa
   este archivo). */
const HOUSTON_TZ = 'America/Chicago';

function hoyHouston() {
  return new Date().toLocaleDateString('en-CA', { timeZone: HOUSTON_TZ });
}

function sqliteDatetimeAIso(valor) {
  if (!valor) return null;
  return `${valor.replace(' ', 'T')}Z`;
}

/** Índice de día de la semana (0=domingo … 6=sábado) de "mañana" en hora
 *  de Houston — para elegir qué factorEstacionalidad usar al armar
 *  produccionSugeridaManana. */
function diaSemanaMananaHouston() {
  const [y, m, d] = hoyHouston().split('-').map(Number);
  const manana = new Date(Date.UTC(y, m - 1, d));
  manana.setUTCDate(manana.getUTCDate() + 1);
  return manana.getUTCDay();
}

// Ventana de historial que se considera: ni "todo el historial" (una
// promoción de hace un año ya no predice la demanda de hoy) ni muy corta
// (menos de MIN_DIAS_HISTORIAL en estadisticas.js igual se descarta).
const VENTANA_DIAS_ESTADISTICAS = 90;

// El caché de un producto se considera fresco por esto — dentro de una
// misma sesión de trabajo en el panel, entrar y salir de Productos varias
// veces no dispara el recorrido completo de ordenes/horneadas cada vez.
const RECALCULO_MIN_INTERVALO_MIN = 30;

/** Punto de partida del rango de historial que se considera para todas las
 *  estadísticas de un producto: desde que se creó (o desde hace
 *  VENTANA_DIAS_ESTADISTICAS, lo que sea más reciente) hasta hoy, en hora
 *  de Houston. Un producto nuevo no puede tener "días sin ventas" ni
 *  "lotes horneados" antes de existir. */
function calcularDesdeEstadisticas(producto) {
  const hoy = hoyHouston();
  const creadoIso = producto.creado_en ? sqliteDatetimeAIso(producto.creado_en) : null;
  const creado = creadoIso ? creadoIso.slice(0, 10) : hoy;

  const inicioVentana = new Date(`${hoy}T00:00:00`);
  inicioVentana.setDate(inicioVentana.getDate() - (VENTANA_DIAS_ESTADISTICAS - 1));
  const inicioVentanaIso = inicioVentana.toISOString().slice(0, 10);

  return creado > inicioVentanaIso ? creado : inicioVentanaIso;
}

/** Devuelve un Map fecha ISO ('YYYY-MM-DD') -> unidades vendidas ese día,
 *  con un registro (en 0 si no hubo ventas) por cada día del rango — sin
 *  esto, calcularEstadisticasProducto promediaría solo los días con
 *  ventas y el resultado quedaría sesgado hacia arriba. */
function obtenerVentasDiariasPorProducto(producto, desde) {
  const hoy = hoyHouston();

  const ventasPorDia = new Map();
  for (
    let d = new Date(`${desde}T00:00:00`);
    d <= new Date(`${hoy}T00:00:00`);
    d.setDate(d.getDate() + 1)
  ) {
    ventasPorDia.set(d.toISOString().slice(0, 10), 0);
  }

  const rows = db
    .prepare(
      "SELECT fecha_iso, items_json FROM ordenes WHERE estado = 'entregada' AND fecha_iso >= ?",
    )
    .all(desde);

  for (const row of rows) {
    const fecha = row.fecha_iso.slice(0, 10);
    if (!ventasPorDia.has(fecha)) continue; // fuera del rango exacto — no debería pasar, guard igual
    let items;
    try {
      items = JSON.parse(row.items_json);
    } catch {
      items = [];
    }
    for (const item of items) {
      // Mismo criterio de cruce que calcularInventario (server.js): por
      // productoId cuando esté disponible, por nombre en órdenes de
      // antes de que existiera ese campo.
      const coincide = item.productoId
        ? String(item.productoId) === String(producto.id)
        : item.nombre === producto.nombre;
      if (coincide) ventasPorDia.set(fecha, ventasPorDia.get(fecha) + item.cantidad);
    }
  }

  return ventasPorDia;
}

/** Total horneado y total dado de baja por merma (ajustes_inventario con
 *  motivo = 'merma' — no error_conteo/consumo_interno/otro, esos no son
 *  desperdicio) en el mismo rango que obtenerVentasDiariasPorProducto. */
function obtenerHorneadoYMermaPorProducto(producto, desde) {
  const totalHorneado =
    db
      .prepare(
        'SELECT COALESCE(SUM(cantidad), 0) AS total FROM horneadas WHERE producto_id = ? AND fecha >= ?',
      )
      .get(String(producto.id), desde).total ?? 0;

  const totalMerma =
    db
      .prepare(
        "SELECT COALESCE(SUM(cantidad), 0) AS total FROM ajustes_inventario WHERE producto_id = ? AND motivo = 'merma' AND fecha >= ?",
      )
      .get(String(producto.id), desde).total ?? 0;

  return { totalHorneado, totalMerma };
}

/** "HH:MM" -> minutos desde medianoche. null si el formato no matchea
 *  (guard defensivo — horneadas.hora ya está validado al guardar). */
function minutosDesdeHora(horaHHMM) {
  const m = /^(\d{2}):(\d{2})$/.exec(horaHHMM || '');
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Un datetime de SQLite (actualizado_en, guardado en UTC) -> minutos
 *  desde medianoche EN HORA DE HOUSTON. horneadas.hora lo captura el
 *  personal a mano en hora local — comparar eso contra un timestamp en
 *  UTC sin convertir metería el mismo desfase de 5-6h que ya se corrigió
 *  en otras partes del proyecto (ver hoyHouston). */
function minutosDesdeHoraLocal(sqliteDatetimeUtc) {
  const iso = sqliteDatetimeAIso(sqliteDatetimeUtc);
  if (!iso) return null;
  const horaLocal = new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: HOUSTON_TZ,
    hour12: false,
  });
  return minutosDesdeHora(horaLocal.slice(0, 5));
}

/** Arma, para cada día del rango, los lotes horneados de este producto y
 *  las ventas 'entregada' que le tocaron ese mismo día, y los reparte
 *  con asignarConsumoFIFO (ver estadisticas.js) — el lote más viejo se
 *  vende primero. El "momento de venta" de una orden es actualizado_en
 *  (cuándo pasó a entregada), no fecha_iso (cuándo se creó): lo primero
 *  es lo más cercano a "cuándo salió del mostrador" que hay en el
 *  esquema actual. */
function obtenerLotesResueltosPorProducto(producto, desde) {
  const horneadasRows = db
    .prepare(
      'SELECT fecha, hora, cantidad FROM horneadas WHERE producto_id = ? AND fecha >= ? ORDER BY fecha, hora',
    )
    .all(String(producto.id), desde);

  const horneadasPorDia = new Map();
  for (const row of horneadasRows) {
    const minutoHorneado = minutosDesdeHora(row.hora);
    if (minutoHorneado === null) continue;
    if (!horneadasPorDia.has(row.fecha)) horneadasPorDia.set(row.fecha, []);
    horneadasPorDia.get(row.fecha).push({ minutoHorneado, cantidad: row.cantidad });
  }

  const ordenesRows = db
    .prepare(
      "SELECT fecha_iso, actualizado_en, items_json FROM ordenes WHERE estado = 'entregada' AND fecha_iso >= ?",
    )
    .all(desde);

  const consumosPorDia = new Map();
  for (const row of ordenesRows) {
    let items;
    try {
      items = JSON.parse(row.items_json);
    } catch {
      items = [];
    }
    const cantidadProducto = items
      .filter((item) =>
        item.productoId
          ? String(item.productoId) === String(producto.id)
          : item.nombre === producto.nombre,
      )
      .reduce((suma, item) => suma + item.cantidad, 0);
    if (cantidadProducto <= 0) continue;

    const minutoVenta = minutosDesdeHoraLocal(row.actualizado_en);
    if (minutoVenta === null) continue;

    const fecha = row.fecha_iso.slice(0, 10);
    if (!consumosPorDia.has(fecha)) consumosPorDia.set(fecha, []);
    consumosPorDia.get(fecha).push({ minutoVenta, cantidad: cantidadProducto });
  }

  const lotesResueltos = [];
  for (const [fecha, lotesDelDia] of horneadasPorDia) {
    const lotesOrdenados = [...lotesDelDia].sort((a, b) => a.minutoHorneado - b.minutoHorneado);
    const consumosOrdenados = (consumosPorDia.get(fecha) ?? []).sort(
      (a, b) => a.minutoVenta - b.minutoVenta,
    );
    lotesResueltos.push(...asignarConsumoFIFO(lotesOrdenados, consumosOrdenados));
  }

  return lotesResueltos;
}

/** Recorre ordenes/horneadas/ajustes_inventario y calcula los 5
 *  indicadores desde cero — sin tocar el caché. Es lo que usa
 *  enriquecerProductoConEstadisticas cuando el caché está vencido. */
function calcularDatosEstadisticas(producto) {
  const desde = calcularDesdeEstadisticas(producto);
  const ventasPorDia = obtenerVentasDiariasPorProducto(producto, desde);
  const { totalHorneado, totalMerma } = obtenerHorneadoYMermaPorProducto(producto, desde);
  const lotesResueltos = obtenerLotesResueltosPorProducto(producto, desde);
  return calcularEstadisticasProducto(ventasPorDia, {
    totalHorneado,
    totalMerma,
    lotesResueltos,
    vidaUtilHoras: producto.vida_util_horas,
  });
}

/** ¿Hace falta recalcular, o el caché sobre la fila del producto todavía
 *  sirve? Sin producto.estadisticas_actualizado_en (nunca se calculó, o
 *  es un producto viejo de antes de esta migración), siempre hace falta. */
function necesitaRecalculo(producto) {
  if (!producto.estadisticas_actualizado_en) return true;
  const ultima = new Date(sqliteDatetimeAIso(producto.estadisticas_actualizado_en));
  if (Number.isNaN(ultima.getTime())) return true;
  return Date.now() - ultima.getTime() > RECALCULO_MIN_INTERVALO_MIN * 60 * 1000;
}

/** Lee el caché ya guardado en la fila del producto (asume que la
 *  consulta que trajo `producto` incluyó las columnas de estadísticas —
 *  SELECT * las trae). Parsea los dos campos JSON. */
/** Lee el caché ya guardado en la fila del producto (asume que la
 *  consulta que trajo `producto` incluyó las columnas de estadísticas —
 *  SELECT * las trae). Parsea los dos campos JSON.
 *
 *  datosInsuficientes se deriva de tasa_rotacion_diaria, no de
 *  estadisticas_dias_considerados: ese último SIEMPRE guarda un número
 *  (aunque sean pocos días), así que "== null" nunca daba true. En
 *  cambio calcularEstadisticasProducto (estadisticas.js) deja
 *  tasaRotacionDiaria en null exactamente cuando datosInsuficientes fue
 *  true al calcularlo — es la señal correcta. */
function leerEstadisticasPersistidas(producto) {
  return {
    diasConsiderados: producto.estadisticas_dias_considerados,
    datosInsuficientes: producto.tasa_rotacion_diaria === null,
    tasaRotacionDiaria: producto.tasa_rotacion_diaria,
    desviacionEstandarDemanda: producto.desviacion_estandar_demanda,
    factorEstacionalidad: producto.factor_estacionalidad
      ? JSON.parse(producto.factor_estacionalidad)
      : null,
    tasaMermaHistorica: producto.tasa_merma_historica,
    probabilidadVencimiento: producto.probabilidad_vencimiento
      ? JSON.parse(producto.probabilidad_vencimiento)
      : null,
  };
}

/** Persiste los 5 indicadores calculados sobre la fila del producto, con
 *  el timestamp de cuándo se calcularon (referencia para necesitaRecalculo). */
function persistirEstadisticas(productoId, datos) {
  db.prepare(
    `UPDATE productos
     SET tasa_rotacion_diaria = ?,
         desviacion_estandar_demanda = ?,
         factor_estacionalidad = ?,
         tasa_merma_historica = ?,
         probabilidad_vencimiento = ?,
         estadisticas_dias_considerados = ?,
         estadisticas_actualizado_en = datetime('now')
     WHERE id = ?`,
  ).run(
    datos.tasaRotacionDiaria,
    datos.desviacionEstandarDemanda,
    datos.factorEstacionalidad ? JSON.stringify(datos.factorEstacionalidad) : null,
    datos.tasaMermaHistorica,
    datos.probabilidadVencimiento ? JSON.stringify(datos.probabilidadVencimiento) : null,
    datos.diasConsiderados,
    productoId,
  );
}

/** Producción sugerida para mañana (ver calcularProduccionSugerida en
 *  estadisticas.js): promedio diario ajustado por el factor de
 *  estacionalidad del día de mañana, más el colchón de stock de
 *  seguridad (desviación estándar × 1.65). null si faltan los
 *  indicadores base (datosInsuficientes, o producto sin ventas). */
function sugerirProduccionManana(datos) {
  if (datos.datosInsuficientes) return null;
  const diaManana = diaSemanaMananaHouston();
  const factorDia = datos.factorEstacionalidad?.[diaManana] ?? 1;
  return calcularProduccionSugerida(
    datos.tasaRotacionDiaria,
    datos.desviacionEstandarDemanda,
    factorDia,
  );
}

const AnalyticsEngine = {
  /** Punto de entrada del Patrón 1: dado un producto (fila completa de la
   *  tabla, con SELECT * — necesita las columnas de caché), devuelve los
   *  5 indicadores más produccionSugeridaManana, recalculando desde el
   *  historial real si el caché está vencido y guardando el resultado de
   *  vuelta en la fila. Con { forzar: true } ignora el caché.
   * @param {object} producto fila de productos (SELECT * — trae creado_en,
   *   vida_util_horas y las columnas de caché de estadísticas)
   * @param {{forzar?: boolean}} [opciones]
   */
  enriquecerProductoConEstadisticas(producto, opciones = {}) {
    const { forzar = false } = opciones;
    const hayQueRecalcular = forzar || necesitaRecalculo(producto);
    const datos = hayQueRecalcular
      ? calcularDatosEstadisticas(producto)
      : leerEstadisticasPersistidas(producto);

    if (hayQueRecalcular) persistirEstadisticas(producto.id, datos);

    return { ...datos, produccionSugeridaManana: sugerirProduccionManana(datos) };
  },

  // Expuestas para pruebas y para GET /productos/estadisticas (que sí
  // quiere forzar el recálculo — ver server.js).
  calcularDatosEstadisticas,
  necesitaRecalculo,

  /** Serie diaria de ventas (cronológica, un número por día) de un
   *  producto, lista para pasarle a AutoML.seleccionarMejorModelo — sin
   *  este método, el endpoint de AutoML tendría que reimplementar el
   *  mismo cálculo de rango/ventana que ya vive acá. */
  obtenerSerieVentasDiarias(producto) {
    const desde = calcularDesdeEstadisticas(producto);
    return [...obtenerVentasDiariasPorProducto(producto, desde).values()];
  },
};

module.exports = AnalyticsEngine;

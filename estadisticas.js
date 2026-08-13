/**
 * ESTADISTICAS — indicadores de demanda para forecasting de horneadas.
 *
 * Toma el historial de ventas diarias de un producto (ya extraído de la
 * tabla ordenes por server.js — ver obtenerVentasDiariasPorProducto) y
 * calcula tasa de rotación, variabilidad y estacionalidad por día de la
 * semana. Este módulo no toca la base de datos: son funciones puras,
 * fáciles de probar con datos de ejemplo, igual que units.js.
 *
 * Metadata que resuelve (pedida para el módulo de Productos):
 *   - tasaRotacionDiaria: promedio de unidades vendidas por día
 *   - desviacionEstandarDemanda: qué tan inestable es esa demanda día a día
 *   - factorEstacionalidad: coeficiente por día de la semana
 *     (ej. domingo = 1.4 → vende 40% más que un día cualquiera)
 *   - tasaMermaHistorica: % de lo horneado que se termina perdiendo
 *     (vencido/dañado) en vez de venderse
 *   - probabilidadVencimiento: por hora del día en que se hornea, qué
 *     tan seguido un lote se vende completo antes de vidaUtilHoras
 *     (ver asignarConsumoFIFO — reparte las ventas del día entre los
 *     lotes horneados ese día, el más viejo primero)
 *
 * calcularProduccionSugerida() usa tasaRotacionDiaria/desviacionEstandarDemanda
 * para la fórmula de stock de seguridad (Patrón 1, "Flujo Operativo
 * Automático"); la orquestación que la llama y persiste los resultados
 * sobre el producto vive en analyticsEngine.js, no acá.
 */

// Menos de esto no es "poca precisión", es ruido: con 5-6 días de
// historial un solo pedido grande puede duplicar el promedio. Devolvemos
// datosInsuficientes en vez de un número que parece confiable y no lo es.
const MIN_DIAS_HISTORIAL = 14;

// Umbral mínimo de lotes observados en una franja horaria para reportar
// su probabilidad — con 1-2 lotes, "vendido a tiempo el 100% de las
// veces" no significa nada, es una moneda al aire.
const MIN_LOTES_POR_HORA = 3;

function redondear(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {Map<string, number>} ventasPorDia fecha ISO ('YYYY-MM-DD') ->
 *   unidades vendidas ese día. Debe traer un registro por CADA día del
 *   rango, con 0 en los días sin ventas — si solo vinieran los días con
 *   ventas, el promedio quedaría sesgado hacia arriba.
 * @returns {{tasaRotacionDiaria: number, desviacionEstandarDemanda: number}}
 */
function calcularRotacionYDesviacion(ventasPorDia) {
  const valores = [...ventasPorDia.values()];
  const n = valores.length;
  if (n === 0) return { tasaRotacionDiaria: 0, desviacionEstandarDemanda: 0 };

  const promedio = valores.reduce((suma, v) => suma + v, 0) / n;
  const varianza = valores.reduce((suma, v) => suma + (v - promedio) ** 2, 0) / n;

  return {
    tasaRotacionDiaria: redondear(promedio),
    desviacionEstandarDemanda: redondear(Math.sqrt(varianza)),
  };
}

/**
 * Coeficiente de estacionalidad por día de la semana: cuánto vende ese
 * día en promedio, respecto al promedio general del período. 1.4 en
 * domingo = vende 40% más que un día cualquiera; 0.7 = vende 30% menos.
 * Índice de día: el mismo de Date#getDay() (0 = domingo … 6 = sábado).
 * @param {Map<string, number>} ventasPorDia
 * @returns {Record<number, number>|null} null si el promedio general es 0
 *   (no hay ninguna venta en el período — no se puede calcular una razón)
 */
function calcularFactorEstacionalidad(ventasPorDia) {
  const porDiaSemana = new Map();
  for (const [fecha, cantidad] of ventasPorDia) {
    const diaSemana = new Date(`${fecha}T00:00:00`).getDay();
    if (!porDiaSemana.has(diaSemana)) porDiaSemana.set(diaSemana, []);
    porDiaSemana.get(diaSemana).push(cantidad);
  }

  const todos = [...ventasPorDia.values()];
  const promedioGeneral = todos.reduce((suma, v) => suma + v, 0) / (todos.length || 1);
  if (promedioGeneral === 0) return null;

  const factores = {};
  for (let dia = 0; dia <= 6; dia++) {
    const valores = porDiaSemana.get(dia) ?? [];
    const promedioDia = valores.length ? valores.reduce((s, v) => s + v, 0) / valores.length : 0;
    factores[dia] = redondear(promedioDia / promedioGeneral);
  }
  return factores;
}

/**
 * % de las unidades horneadas en el período que se dieron de baja por
 * merma (vencido/dañado) en vez de venderse. null si no hay ningún
 * registro de horneado en el período — 0/0 no es "0% de merma", es "no
 * hay con qué calcularlo".
 * @param {number} totalHorneado unidades horneadas en el período
 * @param {number} totalMerma unidades dadas de baja por merma en el período
 */
function calcularTasaMerma(totalHorneado, totalMerma) {
  if (!totalHorneado || totalHorneado <= 0) return null;
  return redondear((totalMerma / totalHorneado) * 100);
}

/**
 * Reparte el consumo de un día entre los lotes horneados ese mismo día,
 * en orden FIFO (el lote más viejo se vende primero) — coherente con que
 * el negocio no deja sobrante de un día para el otro (regla de negocio ya
 * establecida del proyecto). Con esto se sabe cuánto tardó cada lote en
 * agotarse, o si no llegó a agotarse ese día (minutoAgotado queda null:
 * lo que sobró se da de baja como merma al cierre, sin importar si
 * técnicamente todavía estaba fresco).
 * Cada lote puede traer un `id`: se devuelve tal cual para poder cruzar el
 * resultado con el registro de origen (lo usa el módulo de Lotes; a las
 * estadísticas por producto les basta la hora).
 * @param {{id?: string, minutoHorneado: number, cantidad: number}[]} lotes ordenados por minutoHorneado ascendente
 * @param {{minutoVenta: number, cantidad: number}[]} consumos ordenados por minutoVenta ascendente
 * @returns {{id?: string, minutoHorneado: number, cantidad: number, unidadesVendidas: number, minutoAgotado: number|null}[]}
 */
function asignarConsumoFIFO(lotes, consumos) {
  const restantes = lotes.map((lote) => ({
    ...lote,
    unidadesRestantes: lote.cantidad,
    minutoAgotado: null,
  }));
  let idx = 0;

  for (const consumo of consumos) {
    let pendiente = consumo.cantidad;
    while (pendiente > 0 && idx < restantes.length) {
      const lote = restantes[idx];
      if (lote.unidadesRestantes <= 0) {
        idx++;
        continue;
      }
      const tomado = Math.min(lote.unidadesRestantes, pendiente);
      lote.unidadesRestantes -= tomado;
      pendiente -= tomado;
      if (lote.unidadesRestantes === 0) {
        lote.minutoAgotado = consumo.minutoVenta;
        idx++;
      }
    }
    // Si pendiente > 0 acá, se registraron más ventas que unidades
    // horneadas ese día para este producto (dato inconsistente — por
    // ejemplo, una orden vieja cruzada por nombre en vez de productoId).
    // El sobrante se descarta: no hay lote real al que asignárselo.
  }

  return restantes.map(({ id, minutoHorneado, cantidad, unidadesRestantes, minutoAgotado }) => ({
    id,
    minutoHorneado,
    cantidad,
    unidadesVendidas: cantidad - unidadesRestantes,
    minutoAgotado,
  }));
}

/**
 * De una lista de lotes ya resueltos por asignarConsumoFIFO (de muchos
 * días), calcula la probabilidad de que un lote horneado en cada hora
 * del día se venda por completo antes de cumplir vidaUtilHoras. Con
 * menos de MIN_LOTES_POR_HORA lotes observados en una hora, esa hora no
 * se reporta — no hay muestra suficiente para decir nada.
 * @param {{minutoHorneado: number, minutoAgotado: number|null}[]} lotesResueltos
 * @param {number|null} vidaUtilHoras
 * @returns {Record<number, number>|null} hora (0-23) -> probabilidad
 *   (0-1) de venderse a tiempo, o null si falta vidaUtilHoras o no hay
 *   ninguna hora con muestra suficiente
 */
function calcularProbabilidadVencimiento(lotesResueltos, vidaUtilHoras) {
  if (!vidaUtilHoras || vidaUtilHoras <= 0) return null;

  const vidaUtilMin = vidaUtilHoras * 60;
  const porHora = new Map(); // hora del día (0-23) -> [] de "¿se vendió a tiempo?"

  for (const lote of lotesResueltos) {
    const hora = Math.floor(lote.minutoHorneado / 60);
    const vendidoATiempo =
      lote.minutoAgotado !== null && lote.minutoAgotado - lote.minutoHorneado <= vidaUtilMin;
    if (!porHora.has(hora)) porHora.set(hora, []);
    porHora.get(hora).push(vendidoATiempo);
  }

  const resultado = {};
  let huboAlguna = false;
  for (const [hora, valores] of porHora) {
    if (valores.length < MIN_LOTES_POR_HORA) continue;
    resultado[hora] = redondear(valores.filter(Boolean).length / valores.length);
    huboAlguna = true;
  }

  return huboAlguna ? resultado : null;
}

/**
 * Arma el reporte completo para un producto a partir de su historial de
 * ventas diarias (y, si vienen, los totales de horneado/merma y los
 * lotes resueltos por FIFO del mismo período). Si el período es menor a
 * MIN_DIAS_HISTORIAL, devuelve datosInsuficientes en vez de números poco
 * confiables — para los cinco indicadores por igual, no solo para los
 * de demanda.
 * @param {Map<string, number>} ventasPorDia
 * @param {{totalHorneado?: number, totalMerma?: number, lotesResueltos?: object[], vidaUtilHoras?: number|null}} [opciones]
 */
function calcularEstadisticasProducto(ventasPorDia, opciones = {}) {
  const diasConsiderados = ventasPorDia.size;
  const { totalHorneado = 0, totalMerma = 0, lotesResueltos = [], vidaUtilHoras = null } = opciones;

  if (diasConsiderados < MIN_DIAS_HISTORIAL) {
    return {
      diasConsiderados,
      datosInsuficientes: true,
      tasaRotacionDiaria: null,
      desviacionEstandarDemanda: null,
      factorEstacionalidad: null,
      tasaMermaHistorica: null,
      probabilidadVencimiento: null,
    };
  }

  const { tasaRotacionDiaria, desviacionEstandarDemanda } =
    calcularRotacionYDesviacion(ventasPorDia);

  return {
    diasConsiderados,
    datosInsuficientes: false,
    tasaRotacionDiaria,
    desviacionEstandarDemanda,
    factorEstacionalidad: calcularFactorEstacionalidad(ventasPorDia),
    tasaMermaHistorica: calcularTasaMerma(totalHorneado, totalMerma),
    probabilidadVencimiento: calcularProbabilidadVencimiento(lotesResueltos, vidaUtilHoras),
  };
}

// Z de la distribución normal para ~95% de nivel de servicio a una cola
// (probabilidad de NO quedarse corto). Es el multiplicador estándar de
// stock de seguridad en control de inventarios: mientras más variable la
// demanda (mayor desviación estándar), más colchón hay que hornear de
// más para no desabastecerse.
const Z_NIVEL_SERVICIO_95 = 1.65;

/**
 * Producción Sugerida = Promedio Diario (ya ajustado por estacionalidad
 * del día que se está planeando) + Desviación Estándar × 1.65. El primer
 * término apunta al centro de la demanda esperada; el segundo es el
 * colchón para que la variabilidad del día no te deje corto. Redondea
 * hacia arriba: quedarse corto es desabastecimiento, sobrar un poco es
 * preferible a eso (mismo criterio que ya usa la sugerencia del panel).
 * @param {number|null} tasaRotacionDiaria
 * @param {number|null} desviacionEstandarDemanda
 * @param {number} [factorEstacionalidadDia] coeficiente del día que se
 *   está planeando (ver calcularFactorEstacionalidad); 1 si no se pasa
 * @returns {number|null} null si faltan los indicadores base
 */
function calcularProduccionSugerida(
  tasaRotacionDiaria,
  desviacionEstandarDemanda,
  factorEstacionalidadDia = 1,
) {
  if (tasaRotacionDiaria === null || desviacionEstandarDemanda === null) return null;
  const promedioAjustado = tasaRotacionDiaria * factorEstacionalidadDia;
  const stockSeguridad = desviacionEstandarDemanda * Z_NIVEL_SERVICIO_95;
  return Math.max(0, Math.ceil(promedioAjustado + stockSeguridad));
}

module.exports = {
  MIN_DIAS_HISTORIAL,
  MIN_LOTES_POR_HORA,
  Z_NIVEL_SERVICIO_95,
  calcularRotacionYDesviacion,
  calcularFactorEstacionalidad,
  calcularTasaMerma,
  asignarConsumoFIFO,
  calcularProbabilidadVencimiento,
  calcularProduccionSugerida,
  calcularEstadisticasProducto,
};

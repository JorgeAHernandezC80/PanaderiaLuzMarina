/**
 * PANADERÍA LUZ MARINA — Backend: AutoML (forecasting de demanda)
 *
 * "Aprendizaje de máquinas automatizado": en vez de que alguien decida a
 * mano qué técnica de pronóstico usar, el sistema prueba varias —
 * incluidas distintas versiones de la misma técnica con distintos
 * parámetros (ver ALPHAS_SUAVIZADO, esa es la parte de "automatizado"
 * del ajuste de hiperparámetros) — mide qué tan bien le hubieran
 * atinado a los últimos días reales (walk-forward backtesting) y elige
 * sola la de menor error para ESE producto en particular. Un producto
 * con demanda estable puede quedar mejor servido con un promedio
 * simple; uno con tendencia clara, con una regresión lineal; uno que
 * cambia rápido de un día a otro, con suavizado exponencial. No hay una
 * técnica que le gane a las demás siempre — por eso tiene sentido que
 * el sistema decida caso por caso en vez de que alguien fije una sola
 * fórmula para todos los productos (que es, hasta ahora, lo que hacía
 * AnalyticsEngine con el promedio simple).
 *
 * Todo acá es aritmética pura sobre arrays de números — sin tocar la
 * base de datos — para que sea fácil de probar con datos de ejemplo
 * (mismo criterio que estadisticas.js).
 */

const VENTANA_MEDIA_MOVIL = 7;
const ALPHAS_SUAVIZADO = [0.1, 0.3, 0.5, 0.7, 0.9];
// Menos que esto y "el modelo con menor error" es ruido — un backtest de
// 2 o 3 puntos no distingue una técnica buena de una que tuvo suerte.
const MIN_PUNTOS_BACKTEST = 5;

function redondear(n) {
  return Math.round(n * 100) / 100;
}

function promedioSimple(serie) {
  if (!serie.length) return 0;
  return serie.reduce((suma, v) => suma + v, 0) / serie.length;
}

function mediaMovil(serie, ventana = VENTANA_MEDIA_MOVIL) {
  return promedioSimple(serie.slice(-ventana));
}

/** Suavizado exponencial simple: cada punto pesa más que el anterior
 *  entre más reciente sea, según alpha (alpha alto = reacciona rápido a
 *  cambios; alpha bajo = suaviza más el ruido). Devuelve la predicción
 *  para el punto siguiente al último de la serie. */
function suavizadoExponencial(serie, alpha) {
  if (!serie.length) return 0;
  let nivel = serie[0];
  for (let i = 1; i < serie.length; i++) {
    nivel = alpha * serie[i] + (1 - alpha) * nivel;
  }
  return nivel;
}

/** Regresión lineal simple sobre (índice del día, valor) — capta
 *  tendencia (un producto que cada semana vende un poco más o un poco
 *  menos) que un promedio o una media móvil no ven. */
function regresionLineal(serie) {
  const n = serie.length;
  if (n < 2) return promedioSimple(serie);

  const xs = serie.map((_, i) => i);
  const mediaX = promedioSimple(xs);
  const mediaY = promedioSimple(serie);

  let numerador = 0;
  let denominador = 0;
  for (let i = 0; i < n; i++) {
    numerador += (xs[i] - mediaX) * (serie[i] - mediaY);
    denominador += (xs[i] - mediaX) ** 2;
  }
  const pendiente = denominador === 0 ? 0 : numerador / denominador;
  const interseccion = mediaY - pendiente * mediaX;

  return Math.max(0, interseccion + pendiente * n); // n = siguiente índice
}

/** Lista de modelos candidatos, incluidas 5 variantes de suavizado
 *  exponencial (una por cada alpha en ALPHAS_SUAVIZADO) — así el
 *  "aprendizaje" no es solo "qué técnica" sino también "con qué
 *  parámetro le va mejor a esta técnica en este producto". */
function candidatosModelos() {
  const modelos = [
    { nombre: 'Promedio simple', predecir: (serie) => promedioSimple(serie) },
    {
      nombre: `Media móvil (${VENTANA_MEDIA_MOVIL} días)`,
      predecir: (serie) => mediaMovil(serie),
    },
    { nombre: 'Regresión lineal', predecir: (serie) => regresionLineal(serie) },
  ];
  for (const alpha of ALPHAS_SUAVIZADO) {
    modelos.push({
      nombre: `Suavizado exponencial (α=${alpha})`,
      predecir: (serie) => suavizadoExponencial(serie, alpha),
    });
  }
  return modelos;
}

/** Walk-forward backtesting: para cada día desde minEntrenamiento hasta
 *  el final de la serie, entrena "hasta ayer" y compara la predicción
 *  contra lo que realmente pasó — nunca usa datos del futuro para
 *  predecir el pasado, que es el error más común al medir un modelo de
 *  series de tiempo. Devuelve el error absoluto promedio (MAE): más
 *  bajo es mejor.
 * @param {number[]} serie
 * @param {(entrenamiento: number[]) => number} predictor
 * @param {number} minEntrenamiento
 * @returns {number|null} MAE, o null si no hay puntos suficientes para evaluar
 */
function backtestModelo(serie, predictor, minEntrenamiento) {
  const errores = [];
  for (let t = minEntrenamiento; t < serie.length; t++) {
    const entrenamiento = serie.slice(0, t);
    const prediccion = predictor(entrenamiento);
    const real = serie[t];
    errores.push(Math.abs(prediccion - real));
  }
  if (errores.length === 0) return null;
  return errores.reduce((suma, e) => suma + e, 0) / errores.length;
}

/**
 * Punto de entrada: dada la serie diaria de un producto (cronológica,
 * un valor por día — ver AnalyticsEngine.obtenerSerieVentasDiarias),
 * evalúa todos los modelos candidatos por backtesting y elige el de
 * menor error. Transparente a propósito: devuelve también el resto de
 * los candidatos con su error, para que quede claro POR QUÉ se eligió
 * uno y no otro (nunca es solo "confía en la caja negra").
 * @param {number[]} serie
 * @returns {object}
 */
function seleccionarMejorModelo(serie) {
  const minEntrenamiento = Math.max(VENTANA_MEDIA_MOVIL, 2);
  const puntosEvaluables = serie.length - minEntrenamiento;

  if (puntosEvaluables < MIN_PUNTOS_BACKTEST) {
    return {
      datosInsuficientes: true,
      puntosEvaluables: Math.max(puntosEvaluables, 0),
      modeloElegido: null,
      prediccion: null,
      errorPromedio: null,
      candidatos: [],
    };
  }

  const modelos = candidatosModelos();
  const resultados = modelos
    .map(({ nombre, predecir }) => ({
      nombre,
      errorPromedio: backtestModelo(serie, predecir, minEntrenamiento),
      predecir,
    }))
    .filter((r) => r.errorPromedio !== null);

  const mejor = resultados.reduce((a, b) => (b.errorPromedio < a.errorPromedio ? b : a));

  return {
    datosInsuficientes: false,
    puntosEvaluables,
    modeloElegido: mejor.nombre,
    prediccion: redondear(Math.max(0, mejor.predecir(serie))),
    errorPromedio: redondear(mejor.errorPromedio),
    candidatos: resultados
      .map(({ nombre, errorPromedio }) => ({ nombre, errorPromedio: redondear(errorPromedio) }))
      .sort((a, b) => a.errorPromedio - b.errorPromedio),
  };
}

module.exports = {
  VENTANA_MEDIA_MOVIL,
  ALPHAS_SUAVIZADO,
  MIN_PUNTOS_BACKTEST,
  promedioSimple,
  mediaMovil,
  suavizadoExponencial,
  regresionLineal,
  backtestModelo,
  seleccionarMejorModelo,
};

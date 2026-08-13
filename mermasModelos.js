/**
 * MERMAS — MODELOS: la fase 5 del pipeline (análisis) — EDA univariado,
 * bivariado y multivariado, pruebas de hipótesis, y modelos descriptivos
 * y predictivos. Funciones puras, sin base de datos, mismo criterio que
 * mermasAnalitica.js/lotesAnalitica.js — para poder probarlas con datos
 * de ejemplo y con resultados estadísticos conocidos.
 *
 * Qué hay en cada bloque:
 *   · Univariado    → frecuencias() (categórico). Lo numérico ya lo
 *     cubren Analitica.descriptivas()/histograma() — no se duplica acá.
 *   · Bivariado     → Analitica.correlacionPearson()/agrupar() ya
 *     alcanzan (numérico-numérico y categórico-numérico); acá solo se
 *     agregan las herramientas que faltaban.
 *   · Multivariado  → regresionLinealMultiple(): mínimos cuadrados con
 *     2+ predictores, resuelto por eliminación de Gauss-Jordan sobre las
 *     ecuaciones normales (sin librería externa — mismo criterio "todo a
 *     mano" que ya usa autoML.js para el pronóstico).
 *   · Hipótesis     → pruebaTStudent() (Welch, dos muestras) con p-valor
 *     EXACTO vía la función beta incompleta regularizada, y
 *     pruebaChiCuadrado() (independencia, tabla de contingencia) con el
 *     estadístico exacto y la decisión contra una tabla de valores
 *     críticos (ver nota en esa función sobre por qué no lleva p-valor
 *     exacto).
 *   · Descriptivo   → segmentarCausas(): Pareto de causas de merma.
 *   · Predictivo    → regresión logística entrenada por descenso de
 *     gradiente, para clasificar lotes de alto riesgo.
 */

function redondear(n, decimales = 4) {
  const factor = 10 ** decimales;
  return Math.round(n * factor) / factor;
}

/* ═══════════════════════════════════════════
   UNIVARIADO — variables categóricas
   ═══════════════════════════════════════════ */

/** Tabla de frecuencias de una variable categórica: conteo, % y % acumulado
 *  (de mayor a menor) — el primer paso del análisis exploratorio cuando la
 *  variable no es numérica (causaProbable, tipo, producto). */
function frecuencias(valores) {
  const total = valores.length;
  const conteos = new Map();
  for (const v of valores) {
    const clave = v ?? 'sin_dato';
    conteos.set(clave, (conteos.get(clave) ?? 0) + 1);
  }
  const ordenado = [...conteos.entries()].sort((a, b) => b[1] - a[1]);
  let acumulado = 0;
  return ordenado.map(([valor, conteo]) => {
    acumulado += conteo;
    return {
      valor,
      conteo,
      porcentaje: total ? redondear((conteo / total) * 100, 2) : 0,
      porcentajeAcumulado: total ? redondear((acumulado / total) * 100, 2) : 0,
    };
  });
}

/* ═══════════════════════════════════════════
   MULTIVARIADO — regresión lineal múltiple
   ═══════════════════════════════════════════ */

/** Eliminación de Gauss-Jordan con pivoteo parcial para A·x = b. Devuelve
 *  null si el sistema es singular (predictores perfectamente colineales)
 *  en vez de dividir por casi-cero y devolver coeficientes sin sentido. */
function resolverSistemaLineal(A, b) {
  const n = A.length;
  const M = A.map((fila, i) => [...fila, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivote = col;
    for (let fila = col + 1; fila < n; fila++) {
      if (Math.abs(M[fila][col]) > Math.abs(M[pivote][col])) pivote = fila;
    }
    if (Math.abs(M[pivote][col]) < 1e-10) return null;
    [M[col], M[pivote]] = [M[pivote], M[col]];
    const divisor = M[col][col];
    for (let k = col; k <= n; k++) M[col][k] /= divisor;
    for (let fila = 0; fila < n; fila++) {
      if (fila === col) continue;
      const factor = M[fila][col];
      for (let k = col; k <= n; k++) M[fila][k] -= factor * M[col][k];
    }
  }
  return M.map((fila) => fila[n]);
}

/** Regresión lineal por mínimos cuadrados con 2+ predictores (evaluación
 *  conjunta de varias variables — precio, temperatura, vida útil, etc. —
 *  sobre la merma). Para un solo predictor usa Analitica.regresionLineal();
 *  esta es su generalización.
 *  @param {{x: number[], y: number}[]} filas  x = predictores en el mismo
 *    orden para todas las filas; y = la variable a explicar.
 *  @returns {{intercepto: number, coeficientes: number[], r2: number, n: number}|null}
 */
function regresionLinealMultiple(filas) {
  const limpias = (filas ?? []).filter(
    (f) =>
      Array.isArray(f.x) &&
      f.x.length > 0 &&
      f.x.every((v) => Number.isFinite(v)) &&
      Number.isFinite(f.y),
  );
  const n = limpias.length;
  if (n === 0) return null;
  const p = limpias[0].x.length;
  if (limpias.some((f) => f.x.length !== p)) return null;
  const k = p + 1; // + intercepto
  // Menos filas que parámetros (o casi) da un ajuste perfecto sin sentido
  // (R² = 1 memorizando el ruido) en vez de un modelo que generaliza.
  if (n < k + 3) return null;

  const X = limpias.map((f) => [1, ...f.x]);
  const y = limpias.map((f) => f.y);

  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }

  const coeficientes = resolverSistemaLineal(XtX, Xty);
  if (!coeficientes) return null;

  const mediaY = y.reduce((s, v) => s + v, 0) / n;
  let ssTotal = 0;
  let ssResidual = 0;
  for (let i = 0; i < n; i++) {
    const prediccion = coeficientes.reduce((s, c, j) => s + c * X[i][j], 0);
    ssTotal += (y[i] - mediaY) ** 2;
    ssResidual += (y[i] - prediccion) ** 2;
  }

  return {
    intercepto: redondear(coeficientes[0]),
    coeficientes: coeficientes.slice(1).map((c) => redondear(c)),
    r2: ssTotal === 0 ? 1 : redondear(Math.max(0, 1 - ssResidual / ssTotal)),
    n,
  };
}

/* ═══════════════════════════════════════════
   PRUEBAS DE HIPÓTESIS
   ═══════════════════════════════════════════
   Ambas pruebas necesitan integrar la cola de una distribución — no hay
   forma honesta de evitarlo si el p-valor tiene que ser real y no una
   tabla copiada. logGamma/betacf/betaIncompletaRegularizada son el
   algoritmo estándar (Numerical Recipes, "betai") para eso: el mismo que
   usan por debajo librerías como scipy, sin depender de ninguna. */

function logGamma(x) {
  const G = 7;
  const C = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // Fórmula de reflexión: evita evaluar logGamma en la zona donde la
    // aproximación de Lanczos no es fiable (x < 0.5).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const xm1 = x - 1;
  let a = C[0];
  const t = xm1 + G + 0.5;
  for (let i = 1; i < G + 2; i++) a += C[i] / (xm1 + i);
  return 0.5 * Math.log(2 * Math.PI) + (xm1 + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Fracción continua de la función beta incompleta (algoritmo de Lentz
 *  modificado) — el motor numérico de betaIncompletaRegularizada(). */
function betacf(x, a, b) {
  const MAXIT = 200;
  const EPS = 3e-9;
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** I_x(a, b) — función beta incompleta regularizada. Es la pieza que
 *  convierte un estadístico t en un p-valor real: P(|T| > |t|) para una
 *  t-Student con ν grados de libertad es exactamente
 *  betaIncompletaRegularizada(ν/(ν+t²), ν/2, 1/2). */
function betaIncompletaRegularizada(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(x, a, b)) / a;
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

function promedio(valores) {
  return valores.reduce((s, v) => s + v, 0) / valores.length;
}

/** Varianza MUESTRAL (÷ n-1, corrección de Bessel) — a propósito distinta
 *  de Analitica.descriptivas(), que usa la poblacional (÷n) para describir
 *  un conjunto de datos ya completo. Para inferir sobre una población a
 *  partir de una muestra (que es justo lo que hace una prueba de
 *  hipótesis) hace falta el estimador insesgado; usar el poblacional acá
 *  subestimaría el error estándar y volvería el resultado optimista. */
function varianzaMuestral(valores) {
  const n = valores.length;
  if (n < 2) return null;
  const media = promedio(valores);
  return valores.reduce((s, v) => s + (v - media) ** 2, 0) / (n - 1);
}

/** Prueba t de Welch (dos muestras independientes, sin asumir varianzas
 *  iguales — la merma de dos productos casi nunca varía igual). Responde
 *  exactamente al tipo de pregunta del enunciado: "¿el producto/proveedor
 *  A tiene una merma significativamente distinta de B?".
 *  @param {number[]} muestraA
 *  @param {number[]} muestraB
 *  @param {number} [alpha] nivel de significancia, por defecto 0.05
 */
function pruebaTStudent(muestraA, muestraB, alpha = 0.05) {
  const a = (muestraA ?? []).filter((v) => Number.isFinite(v));
  const b = (muestraB ?? []).filter((v) => Number.isFinite(v));
  if (a.length < 2 || b.length < 2) {
    return { valido: false, motivo: 'Se necesitan al menos 2 datos válidos en cada grupo.' };
  }

  const mediaA = promedio(a);
  const mediaB = promedio(b);
  const varA = varianzaMuestral(a);
  const varB = varianzaMuestral(b);
  const seA = varA / a.length;
  const seB = varB / b.length;
  const errorEstandar = Math.sqrt(seA + seB);
  if (errorEstandar === 0) {
    return { valido: false, motivo: 'Ambos grupos tienen varianza 0: no hay nada que probar.' };
  }

  const t = (mediaA - mediaB) / errorEstandar;
  // Grados de libertad de Welch-Satterthwaite: no es n_a + n_b - 2 (eso
  // asume varianzas iguales); esta fórmula es la que hace válida la
  // prueba cuando no lo son.
  const gl = (seA + seB) ** 2 / (seA ** 2 / (a.length - 1) + seB ** 2 / (b.length - 1));
  const pValor = betaIncompletaRegularizada(gl / (gl + t * t), gl / 2, 0.5);

  return {
    valido: true,
    nA: a.length,
    nB: b.length,
    mediaA: redondear(mediaA, 2),
    mediaB: redondear(mediaB, 2),
    diferenciaMedias: redondear(mediaA - mediaB, 2),
    estadisticoT: redondear(t),
    gradosLibertad: redondear(gl, 2),
    pValor: redondear(pValor, 6),
    alpha,
    hipotesisNulaRechazada: pValor < alpha,
    interpretacion:
      pValor < alpha
        ? `Diferencia estadísticamente significativa (p=${redondear(pValor, 4)} < α=${alpha}): las medias NO son iguales.`
        : `Sin evidencia suficiente (p=${redondear(pValor, 4)} ≥ α=${alpha}): no se puede rechazar que las medias sean iguales.`,
  };
}

/* Valores críticos de χ² para α=0.05 y α=0.01, grados de libertad 1-10
   (tabla estándar de cualquier libro de estadística). Se usa una tabla
   en vez de integrar la función gamma incompleta (como sí se hizo para
   la t-Student) porque en este módulo los grados de libertad de una
   tabla de contingencia rara vez pasan de 10 — una tabla cubre el caso
   real sin sumarle otro algoritmo numérico completo al archivo. Si algún
   día se necesita gl > 10, hay que agregar esas filas o migrar a la
   gamma incompleta regularizada (mismo patrón que betaIncompletaRegularizada). */
const CHI2_CRITICO = Object.freeze({
  1: { 0.05: 3.841, 0.01: 6.635 },
  2: { 0.05: 5.991, 0.01: 9.21 },
  3: { 0.05: 7.815, 0.01: 11.345 },
  4: { 0.05: 9.488, 0.01: 13.277 },
  5: { 0.05: 11.07, 0.01: 15.086 },
  6: { 0.05: 12.592, 0.01: 16.812 },
  7: { 0.05: 14.067, 0.01: 18.475 },
  8: { 0.05: 15.507, 0.01: 20.09 },
  9: { 0.05: 16.919, 0.01: 21.666 },
  10: { 0.05: 18.307, 0.01: 23.209 },
});

/** Prueba χ² de independencia sobre una tabla de contingencia (filas =
 *  categoría A, columnas = categoría B — ej. causaProbable × producto).
 *  Responde "¿la causa de la merma depende del producto, o son
 *  independientes?". El estadístico es exacto; la significancia se
 *  decide contra la tabla de valores críticos de arriba (ver la nota ahí
 *  sobre por qué no hay p-valor exacto).
 *  @param {number[][]} tabla conteos, filas x columnas
 */
function pruebaChiCuadrado(tabla, alpha = 0.05) {
  const filas = (tabla ?? []).length;
  const columnas = filas > 0 ? tabla[0].length : 0;
  if (filas < 2 || columnas < 2) {
    return { valido: false, motivo: 'Se necesitan al menos 2 filas y 2 columnas.' };
  }

  const totalesFila = tabla.map((fila) => fila.reduce((s, v) => s + v, 0));
  const totalesCol = Array.from({ length: columnas }, (_, j) =>
    tabla.reduce((s, fila) => s + fila[j], 0),
  );
  const total = totalesFila.reduce((s, v) => s + v, 0);
  if (total === 0) return { valido: false, motivo: 'La tabla no tiene datos.' };

  let estadistico = 0;
  let celdasEsperadoBajo5 = 0;
  for (let i = 0; i < filas; i++) {
    for (let j = 0; j < columnas; j++) {
      const esperado = (totalesFila[i] * totalesCol[j]) / total;
      if (esperado < 5) celdasEsperadoBajo5++;
      if (esperado === 0) continue;
      estadistico += (tabla[i][j] - esperado) ** 2 / esperado;
    }
  }

  const gl = (filas - 1) * (columnas - 1);
  const tablaGl = CHI2_CRITICO[gl];
  const alphaClave = alpha === 0.01 ? '0.01' : '0.05';
  const critico = tablaGl ? tablaGl[alphaClave] : null;

  return {
    valido: true,
    estadistico: redondear(estadistico),
    gradosLibertad: gl,
    alpha,
    valorCritico: critico,
    // Advertencia estándar de la prueba χ²: con muchas celdas esperadas
    // < 5, el estadístico deja de aproximarse bien a la distribución χ²
    // (la regla de dedo más citada es Cochran, 1954).
    advertenciaMuestraPequena:
      celdasEsperadoBajo5 > 0
        ? `${celdasEsperadoBajo5} celda(s) con frecuencia esperada < 5: el resultado puede no ser confiable.`
        : null,
    hipotesisNulaRechazada: critico === null ? null : estadistico > critico,
    interpretacion:
      critico === null
        ? `Sin tabla de valores críticos para ${gl} grados de libertad (máximo soportado: 10).`
        : estadistico > critico
          ? `χ²=${redondear(estadistico, 2)} > crítico=${critico} (α=${alpha}): las variables NO son independientes.`
          : `χ²=${redondear(estadistico, 2)} ≤ crítico=${critico} (α=${alpha}): sin evidencia de dependencia entre las variables.`,
  };
}

/* ═══════════════════════════════════════════
   MODELO DESCRIPTIVO — segmentación de causas
   ═══════════════════════════════════════════ */

/** Pareto de causas de merma: conteo, % y % acumulado, de mayor a menor
 *  — para responder "¿cuáles pocas causas explican la mayoría de la
 *  merma?" (el 80/20 clásico de un análisis de causas). */
function segmentarCausas(eventos) {
  return frecuencias((eventos ?? []).map((ev) => ev.causaProbable ?? 'sin_nota'));
}

/* ═══════════════════════════════════════════
   MODELO PREDICTIVO — regresión logística (clasificación binaria)
   ═══════════════════════════════════════════
   Descenso de gradiente sobre la log-verosimilitud, con los predictores
   estandarizados (media 0, desviación 1): sin eso, una variable en
   escala 0-500 (temperatura) domina el gradiente frente a una en 0-2
   (horas) sin que eso signifique que pesa más — es la misma razón por la
   que sklearn's LogisticRegression recomienda escalar antes de entrenar. */

function sigmoide(z) {
  return 1 / (1 + Math.exp(-z));
}

/** Entrena un clasificador binario por descenso de gradiente.
 *  @param {{x: number[], y: 0|1}[]} muestras
 *  @returns {object|null} el modelo (pesos + parámetros de escalado), o
 *    null si no hay suficientes datos para que el resultado sea confiable.
 */
function entrenarRegresionLogistica(muestras, { tasaAprendizaje = 0.3, iteraciones = 800 } = {}) {
  const limpias = (muestras ?? []).filter(
    (m) =>
      Array.isArray(m.x) &&
      m.x.length > 0 &&
      m.x.every((v) => Number.isFinite(v)) &&
      (m.y === 0 || m.y === 1),
  );
  const n = limpias.length;
  // Regla de dedo mínima para regresión logística: al menos ~10 casos por
  // predictor (Peduzzi et al., 1996) — menos que eso, el modelo memoriza
  // en vez de generalizar.
  const p = limpias[0]?.x.length ?? 0;
  if (n < Math.max(10, p * 10)) return null;

  const positivos = limpias.filter((m) => m.y === 1).length;
  if (positivos === 0 || positivos === n) return null; // una sola clase: no hay nada que separar

  const medias = new Array(p).fill(0);
  const desviaciones = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    const columna = limpias.map((m) => m.x[j]);
    medias[j] = promedio(columna);
    const varianza = columna.reduce((s, v) => s + (v - medias[j]) ** 2, 0) / n;
    desviaciones[j] = Math.sqrt(varianza) || 1;
  }

  const X = limpias.map((m) => [1, ...m.x.map((v, j) => (v - medias[j]) / desviaciones[j])]);
  const y = limpias.map((m) => m.y);
  const k = p + 1;

  const pesos = new Array(k).fill(0);
  let costoFinal = null;
  for (let iter = 0; iter < iteraciones; iter++) {
    const gradiente = new Array(k).fill(0);
    let costo = 0;
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, v, j) => s + v * pesos[j], 0);
      const prediccion = sigmoide(z);
      const error = prediccion - y[i];
      for (let j = 0; j < k; j++) gradiente[j] += error * X[i][j];
      const pAcotada = Math.min(Math.max(prediccion, 1e-10), 1 - 1e-10);
      costo += -(y[i] * Math.log(pAcotada) + (1 - y[i]) * Math.log(1 - pAcotada));
    }
    for (let j = 0; j < k; j++) pesos[j] -= (tasaAprendizaje * gradiente[j]) / n;
    if (iter === iteraciones - 1) costoFinal = redondear(costo / n);
  }

  return { pesos, medias, desviaciones, n, positivos, costoFinal };
}

/** Probabilidad predicha (0-1) de que `x` pertenezca a la clase 1. */
function predecirProbabilidad(modelo, x) {
  const estandarizado = x.map((v, j) => (v - modelo.medias[j]) / modelo.desviaciones[j]);
  const z = modelo.pesos[0] + estandarizado.reduce((s, v, j) => s + v * modelo.pesos[j + 1], 0);
  return sigmoide(z);
}

/** Matriz de confusión + exactitud/precisión/exhaustividad/F1. Evaluado
 *  sobre los mismos datos de entrenamiento (in-sample) — con el volumen
 *  de una panadería (decenas o pocos cientos de lotes por período), un
 *  conjunto de prueba separado se queda sin datos suficientes para
 *  entrenar; la cifra de acá mide qué tan bien el modelo describe lo que
 *  ya pasó, no cómo va a predecir un lote nunca visto. */
function evaluarClasificador(probabilidades, reales, umbral = 0.5) {
  let vp = 0;
  let vn = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < probabilidades.length; i++) {
    const predicho = probabilidades[i] >= umbral ? 1 : 0;
    if (predicho === 1 && reales[i] === 1) vp++;
    else if (predicho === 0 && reales[i] === 0) vn++;
    else if (predicho === 1 && reales[i] === 0) fp++;
    else fn++;
  }
  const total = probabilidades.length;
  const precision = vp + fp === 0 ? null : vp / (vp + fp);
  const exhaustividad = vp + fn === 0 ? null : vp / (vp + fn);
  const f1 =
    precision !== null && exhaustividad !== null && precision + exhaustividad > 0
      ? (2 * precision * exhaustividad) / (precision + exhaustividad)
      : null;

  return {
    matrizConfusion: {
      verdaderosPositivos: vp,
      verdaderosNegativos: vn,
      falsosPositivos: fp,
      falsosNegativos: fn,
    },
    exactitud: total ? redondear((vp + vn) / total) : null,
    precision: precision === null ? null : redondear(precision),
    exhaustividad: exhaustividad === null ? null : redondear(exhaustividad),
    f1: f1 === null ? null : redondear(f1),
  };
}

module.exports = {
  CHI2_CRITICO,
  frecuencias,
  resolverSistemaLineal,
  regresionLinealMultiple,
  betaIncompletaRegularizada,
  varianzaMuestral,
  pruebaTStudent,
  pruebaChiCuadrado,
  segmentarCausas,
  sigmoide,
  entrenarRegresionLogistica,
  predecirProbabilidad,
  evaluarClasificador,
};

/**
 * LOTES — ANALÍTICA: la aritmética del módulo de Lotes, sin base de datos.
 *
 * Un "lote" acá es una horneada: la unidad física que sale del horno de una
 * sola vez y que se puede rastrear hacia atrás (tanda de masa → insumos →
 * recepción → lote del proveedor). Este archivo cubre las cuatro piezas que
 * el módulo necesita, todas como funciones puras — mismo criterio que
 * estadisticas.js / units.js, para poder probarlas con datos de ejemplo:
 *
 *   1. Análisis exploratorio: descriptivas(), histograma(), outliersIQR(),
 *      agrupar() — la forma de cada variable antes de sacar conclusiones.
 *   2. Tendencias: mediaMovil(), regresionLineal(), tendenciaSerie(),
 *      compararVentanas() — hacia dónde va la serie diaria.
 *   3. Correlaciones: correlacionPearson() — qué variable de horneado
 *      acompaña a la merma (acompaña, no "causa": ver la nota en la función).
 *   4. Validación: REGLAS_LOTE / validarLote() / completitudLotes() — reglas
 *      declarativas, igual que el diccionario de datos de calidadDatos.js.
 *
 * La extracción y el armado de los lotes desde SQLite viven en lotes.js.
 */

// Con menos pares que esto, un coeficiente de correlación es una anécdota:
// dos o tres lotes alineados por casualidad dan r = 0.9 sin significar nada.
const MIN_PARES_CORRELACION = 8;

// Una recta ajustada sobre menos días que esto no describe una tendencia,
// describe el ruido de la semana.
const MIN_DIAS_TENDENCIA = 7;

// Ventana de la media móvil de la serie diaria: 7 días alisa el ciclo
// semanal del negocio (los fines de semana se hornea más).
const VENTANA_MEDIA_MOVIL_DIAS = 7;

// Regla de Tukey para marcar un lote como atípico: más de 1.5 rangos
// intercuartílicos por fuera de los cuartiles. Es el criterio estándar del
// boxplot, y no asume que los datos sean normales (la merma no lo es).
const FACTOR_IQR_ATIPICO = 1.5;

// Umbrales de las reglas de validación. Se declaran acá arriba, juntos, para
// que ajustar el criterio del negocio sea cambiar un número y no leer código.
const UMBRALES = Object.freeze({
  mermaPctMaximaFisica: 60, // por encima de esto es un error de captura, no una merma
  desvioMermaPpAlerta: 5, // puntos porcentuales de diferencia contra la receta
  desvioTemperaturaCAlerta: 15,
  desvioTiempoHorneadoPctAlerta: 25,
  segundaCalidadPctAlerta: 15,
  desvioRendimientoPctAlerta: 20, // unidades reales vs. las estimadas en la tanda
});

function redondear(n, decimales = 2) {
  const factor = 10 ** decimales;
  return Math.round(n * factor) / factor;
}

function numerosValidos(valores) {
  return valores.filter((v) => typeof v === 'number' && Number.isFinite(v));
}

/**
 * Percentil por interpolación lineal sobre la muestra ya ordenada — el
 * mismo método que usa el boxplot clásico.
 * @param {number[]} ordenados ascendente, sin huecos
 * @param {number} p 0-100
 */
function percentil(ordenados, p) {
  if (ordenados.length === 0) return null;
  if (ordenados.length === 1) return ordenados[0];
  const posicion = ((ordenados.length - 1) * p) / 100;
  const inferior = Math.floor(posicion);
  const superior = Math.ceil(posicion);
  if (inferior === superior) return ordenados[inferior];
  const peso = posicion - inferior;
  return ordenados[inferior] * (1 - peso) + ordenados[superior] * peso;
}

/**
 * Estadística descriptiva de una variable: el primer paso del análisis
 * exploratorio. Devuelve n = 0 y el resto en null cuando no hay valores —
 * nunca 0, que se leería como "la merma fue 0%" en vez de "no hay dato".
 * La desviación es poblacional (÷ n), igual que en estadisticas.js, para
 * que los dos módulos no reporten números distintos de la misma serie.
 * @param {(number|null|undefined)[]} valores
 */
function descriptivas(valores) {
  const limpios = numerosValidos(valores ?? []);
  const n = limpios.length;
  if (n === 0) {
    return {
      n: 0,
      media: null,
      mediana: null,
      desviacion: null,
      coeficienteVariacion: null,
      minimo: null,
      maximo: null,
      p25: null,
      p75: null,
      rangoIntercuartil: null,
    };
  }

  const ordenados = [...limpios].sort((a, b) => a - b);
  const media = limpios.reduce((suma, v) => suma + v, 0) / n;
  const varianza = limpios.reduce((suma, v) => suma + (v - media) ** 2, 0) / n;
  const desviacion = Math.sqrt(varianza);
  const p25 = percentil(ordenados, 25);
  const p75 = percentil(ordenados, 75);

  return {
    n,
    media: redondear(media),
    mediana: redondear(percentil(ordenados, 50)),
    desviacion: redondear(desviacion),
    // Variabilidad relativa: comparable entre variables de escalas
    // distintas (% de merma vs. unidades por lote), a diferencia de la
    // desviación cruda. Sin sentido si la media es 0.
    coeficienteVariacion: media === 0 ? null : redondear((desviacion / media) * 100),
    minimo: redondear(ordenados[0]),
    maximo: redondear(ordenados[n - 1]),
    p25: redondear(p25),
    p75: redondear(p75),
    rangoIntercuartil: redondear(p75 - p25),
  };
}

/**
 * Histograma de ancho fijo: cuántos lotes caen en cada tramo de la
 * variable. Es lo que muestra si la merma está concentrada o si hay dos
 * grupos de horneadas distintos escondidos en el mismo promedio.
 * @param {(number|null|undefined)[]} valores
 * @param {number} [bins] cantidad de tramos
 * @returns {{desde: number, hasta: number, total: number}[]}
 */
function histograma(valores, bins = 8) {
  const limpios = numerosValidos(valores ?? []);
  if (limpios.length === 0 || bins < 1) return [];

  const minimo = Math.min(...limpios);
  const maximo = Math.max(...limpios);
  // Todos los valores iguales: un solo tramo, en vez de dividir por 0.
  if (minimo === maximo) {
    return [{ desde: redondear(minimo), hasta: redondear(maximo), total: limpios.length }];
  }

  const ancho = (maximo - minimo) / bins;
  const tramos = Array.from({ length: bins }, (_, i) => ({
    desde: redondear(minimo + ancho * i),
    hasta: redondear(minimo + ancho * (i + 1)),
    total: 0,
  }));

  for (const valor of limpios) {
    // El último tramo incluye el máximo (si no, el valor más alto se
    // saldría del histograma por el redondeo del índice).
    const indice = Math.min(bins - 1, Math.floor((valor - minimo) / ancho));
    tramos[indice].total += 1;
  }
  return tramos;
}

/**
 * Lotes atípicos por la regla de Tukey sobre una variable. Devuelve los
 * elementos originales (no solo el número) para poder mostrar de qué lote
 * se trata y revisarlo.
 * @param {object[]} items
 * @param {(item: object) => number|null|undefined} obtenerValor
 * @returns {{item: object, valor: number, lado: 'alto'|'bajo'}[]}
 */
function outliersIQR(items, obtenerValor) {
  const conValor = (items ?? [])
    .map((item) => ({ item, valor: obtenerValor(item) }))
    .filter(({ valor }) => typeof valor === 'number' && Number.isFinite(valor));
  if (conValor.length < 4) return []; // sin cuartiles con sentido no hay atípicos

  const ordenados = conValor.map(({ valor }) => valor).sort((a, b) => a - b);
  const p25 = percentil(ordenados, 25);
  const p75 = percentil(ordenados, 75);
  const iqr = p75 - p25;
  if (iqr === 0) return [];

  const limiteBajo = p25 - FACTOR_IQR_ATIPICO * iqr;
  const limiteAlto = p75 + FACTOR_IQR_ATIPICO * iqr;

  return conValor
    .filter(({ valor }) => valor < limiteBajo || valor > limiteAlto)
    .map(({ item, valor }) => ({
      item,
      valor: redondear(valor),
      lado: valor > limiteAlto ? 'alto' : 'bajo',
    }));
}

/**
 * Coeficiente de correlación de Pearson entre dos variables de los mismos
 * lotes. OJO con cómo se lee: mide si dos variables se mueven juntas, no
 * que una cause la otra — una correlación alta entre temperatura y merma
 * es una pista para el panadero, no una conclusión.
 * @param {{x: number|null, y: number|null}[]} pares
 * @returns {{n: number, r: number|null, datosInsuficientes: boolean}}
 */
function correlacionPearson(pares) {
  const limpios = (pares ?? []).filter(
    ({ x, y }) => Number.isFinite(x) && Number.isFinite(y) && x !== null && y !== null,
  );
  const n = limpios.length;
  if (n < MIN_PARES_CORRELACION) return { n, r: null, datosInsuficientes: true };

  const mediaX = limpios.reduce((s, p) => s + p.x, 0) / n;
  const mediaY = limpios.reduce((s, p) => s + p.y, 0) / n;
  let covarianza = 0;
  let varX = 0;
  let varY = 0;
  for (const { x, y } of limpios) {
    covarianza += (x - mediaX) * (y - mediaY);
    varX += (x - mediaX) ** 2;
    varY += (y - mediaY) ** 2;
  }
  // Una de las dos variables es constante: la correlación no está definida
  // (dividiría por 0), y decir "0" sugeriría "no se relacionan".
  if (varX === 0 || varY === 0) return { n, r: null, datosInsuficientes: true };

  return { n, r: redondear(covarianza / Math.sqrt(varX * varY)), datosInsuficientes: false };
}

/**
 * Recta de mínimos cuadrados y su R² (qué parte de la variación explica).
 * @param {{x: number, y: number}[]} puntos
 * @returns {{pendiente: number, intercepto: number, r2: number}|null}
 */
function regresionLineal(puntos) {
  const limpios = (puntos ?? []).filter(({ x, y }) => Number.isFinite(x) && Number.isFinite(y));
  const n = limpios.length;
  if (n < 2) return null;

  const mediaX = limpios.reduce((s, p) => s + p.x, 0) / n;
  const mediaY = limpios.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const { x, y } of limpios) {
    sxy += (x - mediaX) * (y - mediaY);
    sxx += (x - mediaX) ** 2;
  }
  if (sxx === 0) return null;

  const pendiente = sxy / sxx;
  const intercepto = mediaY - pendiente * mediaX;
  let ssTotal = 0;
  let ssResidual = 0;
  for (const { x, y } of limpios) {
    ssTotal += (y - mediaY) ** 2;
    ssResidual += (y - (pendiente * x + intercepto)) ** 2;
  }
  return {
    pendiente: redondear(pendiente, 4),
    intercepto: redondear(intercepto, 4),
    // Serie plana (ssTotal = 0): la recta la explica entera, R² = 1.
    r2: ssTotal === 0 ? 1 : redondear(Math.max(0, 1 - ssResidual / ssTotal), 4),
  };
}

/**
 * Media móvil centrada en el último punto (promedio de los `ventana` días
 * hasta ese día, inclusive). Los primeros días quedan con valor null:
 * promediar 2 días y llamarlo "media de 7" sería mentirle al gráfico.
 * @param {(number|null)[]} valores en orden cronológico
 * @param {number} [ventana]
 * @returns {(number|null)[]} mismo largo que la entrada
 */
function mediaMovil(valores, ventana = VENTANA_MEDIA_MOVIL_DIAS) {
  const serie = valores ?? [];
  return serie.map((_, i) => {
    if (i + 1 < ventana) return null;
    const tramo = numerosValidos(serie.slice(i + 1 - ventana, i + 1));
    if (tramo.length < ventana) return null;
    return redondear(tramo.reduce((s, v) => s + v, 0) / ventana);
  });
}

/**
 * Tendencia de una serie diaria: ajusta una recta contra el índice del día
 * y traduce la pendiente a algo legible. `direccion` no se decide solo por
 * el signo — una pendiente diminuta sobre una serie ruidosa es 'estable',
 * no "sube": se exige que el cambio acumulado en el período supere el 5%
 * del promedio de la serie.
 * @param {{fecha: string, valor: number|null}[]} serie cronológica
 */
function tendenciaSerie(serie) {
  const puntos = (serie ?? [])
    .map(({ valor }, i) => ({ x: i, y: valor }))
    .filter(({ y }) => Number.isFinite(y));
  if (puntos.length < MIN_DIAS_TENDENCIA) {
    return {
      datosInsuficientes: true,
      dias: puntos.length,
      pendientePorDia: null,
      r2: null,
      direccion: 'sin_datos',
    };
  }

  const recta = regresionLineal(puntos);
  if (!recta) {
    return {
      datosInsuficientes: true,
      dias: puntos.length,
      pendientePorDia: null,
      r2: null,
      direccion: 'sin_datos',
    };
  }

  const promedio = puntos.reduce((s, p) => s + p.y, 0) / puntos.length;
  const cambioAcumulado = recta.pendiente * (puntos.length - 1);
  const esRelevante = promedio !== 0 && Math.abs(cambioAcumulado) > Math.abs(promedio) * 0.05;

  return {
    datosInsuficientes: false,
    dias: puntos.length,
    pendientePorDia: recta.pendiente,
    r2: recta.r2,
    cambioAcumulado: redondear(cambioAcumulado),
    direccion: !esRelevante ? 'estable' : recta.pendiente > 0 ? 'sube' : 'baja',
  };
}

/**
 * Compara los últimos `ventana` días contra los `ventana` anteriores —
 * la lectura rápida que el promedio de todo el período esconde.
 * @param {{fecha: string, valor: number|null}[]} serie cronológica
 * @param {number} [ventana]
 */
function compararVentanas(serie, ventana = VENTANA_MEDIA_MOVIL_DIAS) {
  const valores = (serie ?? []).map(({ valor }) => (Number.isFinite(valor) ? valor : 0));
  if (valores.length < ventana * 2) {
    return { datosInsuficientes: true, actual: null, previa: null, variacionPct: null };
  }
  const promedio = (tramo) => tramo.reduce((s, v) => s + v, 0) / tramo.length;
  const actual = promedio(valores.slice(-ventana));
  const previa = promedio(valores.slice(-ventana * 2, -ventana));

  return {
    datosInsuficientes: false,
    actual: redondear(actual),
    previa: redondear(previa),
    variacionPct: previa === 0 ? null : redondear(((actual - previa) / previa) * 100),
  };
}

/**
 * Agrupa lotes por una clave y resume cada grupo — el corte por producto y
 * por hora de horneado de la vista.
 * @param {object[]} lotes
 * @param {(lote: object) => string} obtenerClave
 * @param {(grupo: object[]) => object} resumir
 */
function agrupar(lotes, obtenerClave, resumir) {
  const grupos = new Map();
  for (const lote of lotes ?? []) {
    const clave = obtenerClave(lote);
    if (clave === null || clave === undefined) continue;
    if (!grupos.has(clave)) grupos.set(clave, []);
    grupos.get(clave).push(lote);
  }
  return [...grupos.entries()].map(([clave, grupo]) => ({ clave, ...resumir(grupo) }));
}

/* ═══════════════════════════════════════════
   VALIDACIÓN DE DATOS
   ═══════════════════════════════════════════
   Dos capas, igual que calidadDatos.js: reglas de coherencia (¿este lote
   se contradice con la receta, con la física o con su propia tanda?) y
   completitud por campo (¿qué columna está tan vacía que no se puede
   analizar?). Ninguna corrige nada: avisan. */

const REGLAS_LOTE = Object.freeze([
  {
    codigo: 'cantidad_invalida',
    severidad: 'alta',
    mensaje: 'Lote sin unidades horneadas: no se puede analizar ni descontar del inventario.',
    evaluar: (lote) => !(Number(lote.cantidad) > 0),
  },
  {
    codigo: 'sin_produccion',
    severidad: 'alta',
    mensaje: 'Lote sin tanda de masa vinculada: la trazabilidad hacia los insumos se corta acá.',
    evaluar: (lote) => !lote.produccionId,
  },
  {
    codigo: 'sin_ingredientes',
    severidad: 'alta',
    mensaje: 'La tanda vinculada no tiene ingredientes registrados: no hay qué rastrear.',
    evaluar: (lote) => Boolean(lote.produccionId) && lote.ingredientesRegistrados === 0,
  },
  {
    codigo: 'merma_fuera_de_rango',
    severidad: 'alta',
    mensaje: `Merma real fuera de rango físico (0-${UMBRALES.mermaPctMaximaFisica}%): revisar la captura.`,
    evaluar: (lote) =>
      Number.isFinite(lote.mermaRealPct) &&
      (lote.mermaRealPct < 0 || lote.mermaRealPct > UMBRALES.mermaPctMaximaFisica),
  },
  {
    codigo: 'peso_incoherente',
    severidad: 'alta',
    mensaje: 'El pan cocido pesa más que la masa cruda de su tanda: uno de los dos pesos está mal.',
    evaluar: (lote) =>
      Number.isFinite(lote.pesoPanCocidoTotalG) &&
      Number.isFinite(lote.pesoTotalMasaG) &&
      lote.pesoPanCocidoTotalG > lote.pesoTotalMasaG,
  },
  {
    codigo: 'merma_sin_registrar',
    severidad: 'media',
    mensaje: 'Sin merma real registrada: el lote no entra en el análisis de pérdida de horneado.',
    evaluar: (lote) => !Number.isFinite(lote.mermaRealPct),
  },
  {
    codigo: 'merma_desviada',
    severidad: 'media',
    mensaje: `La merma real se aparta más de ${UMBRALES.desvioMermaPpAlerta} puntos de la esperada en la receta.`,
    evaluar: (lote) =>
      Number.isFinite(lote.desvioMermaPp) &&
      Math.abs(lote.desvioMermaPp) > UMBRALES.desvioMermaPpAlerta,
  },
  {
    codigo: 'temperatura_desviada',
    severidad: 'media',
    mensaje: `Se horneó a más de ${UMBRALES.desvioTemperaturaCAlerta} °C de la temperatura de la receta.`,
    evaluar: (lote) =>
      Number.isFinite(lote.desvioTemperaturaC) &&
      Math.abs(lote.desvioTemperaturaC) > UMBRALES.desvioTemperaturaCAlerta,
  },
  {
    codigo: 'tiempo_desviado',
    severidad: 'baja',
    mensaje: `El tiempo de horneado se apartó más de ${UMBRALES.desvioTiempoHorneadoPctAlerta}% del de la receta.`,
    evaluar: (lote) =>
      Number.isFinite(lote.desvioTiempoHorneadoPct) &&
      Math.abs(lote.desvioTiempoHorneadoPct) > UMBRALES.desvioTiempoHorneadoPctAlerta,
  },
  {
    codigo: 'segunda_calidad_alta',
    severidad: 'media',
    mensaje: `Más del ${UMBRALES.segundaCalidadPctAlerta}% del lote salió como segunda calidad.`,
    evaluar: (lote) =>
      Number.isFinite(lote.segundaCalidadPct) &&
      lote.segundaCalidadPct > UMBRALES.segundaCalidadPctAlerta,
  },
  {
    codigo: 'rendimiento_desviado',
    severidad: 'baja',
    mensaje: `Se horneó más de ${UMBRALES.desvioRendimientoPctAlerta}% por encima o por debajo de las unidades estimadas en la tanda.`,
    evaluar: (lote) =>
      Number.isFinite(lote.desvioRendimientoPct) &&
      Math.abs(lote.desvioRendimientoPct) > UMBRALES.desvioRendimientoPctAlerta,
  },
  {
    codigo: 'sin_vida_util',
    severidad: 'media',
    mensaje:
      'El producto no tiene vida útil configurada: no se puede evaluar la frescura del lote.',
    evaluar: (lote) => !Number.isFinite(lote.vidaUtilHoras),
  },
  {
    codigo: 'insumos_sin_lote_proveedor',
    severidad: 'media',
    mensaje: 'Hay insumos de la tanda sin lote de proveedor: la trazabilidad queda parcial.',
    evaluar: (lote) => Number(lote.insumosSinLoteProveedor) > 0,
  },
]);

/** Campos que un lote debería tener llenos para poder analizarlo — el
 *  "diccionario de datos" del módulo, mismo patrón que CAMPOS_INSUMOS en
 *  calidadDatos.js: cambiar qué se exige es editar esta lista. */
const CAMPOS_LOTE = Object.freeze([
  { campo: 'mermaRealPct', etiqueta: 'Merma real', severidad: 'alta' },
  { campo: 'produccionId', etiqueta: 'Tanda de masa vinculada', severidad: 'alta' },
  { campo: 'temperaturaHorneadoRealC', etiqueta: 'Temperatura real', severidad: 'media' },
  { campo: 'tiempoHorneadoRealMin', etiqueta: 'Tiempo real', severidad: 'media' },
  { campo: 'pesoPanCocidoTotalG', etiqueta: 'Peso del pan cocido', severidad: 'media' },
  { campo: 'unidadesSegundaCalidad', etiqueta: 'Unidades de segunda', severidad: 'baja' },
  { campo: 'costoEnergiaLote', etiqueta: 'Costo de energía', severidad: 'baja' },
  { campo: 'vidaUtilHoras', etiqueta: 'Vida útil del producto', severidad: 'baja' },
]);

/**
 * Corre todas las reglas contra un lote ya procesado (ver lotes.js).
 * @returns {{codigo: string, severidad: string, mensaje: string}[]} vacío si está sano
 */
function validarLote(lote) {
  return REGLAS_LOTE.filter((regla) => regla.evaluar(lote)).map(
    ({ codigo, severidad, mensaje }) => ({ codigo, severidad, mensaje }),
  );
}

/** Un hallazgo por lote con problemas (los sanos no ensucian la lista) más
 *  el conteo por severidad y por regla, para encabezar la vista. */
function validarLotes(lotes) {
  const hallazgos = [];
  const porRegla = new Map();
  const porSeveridad = { alta: 0, media: 0, baja: 0 };

  for (const lote of lotes ?? []) {
    const problemas = validarLote(lote);
    if (problemas.length === 0) continue;
    hallazgos.push({
      loteId: lote.id,
      codigoLote: lote.codigo,
      productoNombre: lote.productoNombre,
      fecha: lote.fecha,
      problemas,
    });
    for (const { codigo, severidad } of problemas) {
      porRegla.set(codigo, (porRegla.get(codigo) ?? 0) + 1);
      porSeveridad[severidad] += 1;
    }
  }

  const totalLotes = (lotes ?? []).length;
  return {
    totalLotes,
    lotesConHallazgos: hallazgos.length,
    // Qué parte del período se puede analizar sin reparos. 100% cuando no
    // hay lotes: no hay nada objetable, y 0% se leería como "todo mal".
    porcentajeSano:
      totalLotes === 0 ? 100 : redondear(((totalLotes - hallazgos.length) / totalLotes) * 100),
    porSeveridad,
    porRegla: [...porRegla.entries()]
      .map(([codigo, total]) => ({
        codigo,
        total,
        mensaje: REGLAS_LOTE.find((r) => r.codigo === codigo)?.mensaje ?? codigo,
        severidad: REGLAS_LOTE.find((r) => r.codigo === codigo)?.severidad ?? 'baja',
      }))
      .sort((a, b) => b.total - a.total),
    hallazgos,
  };
}

/** Completitud por campo sobre el conjunto de lotes del período. */
function completitudLotes(lotes) {
  const filas = lotes ?? [];
  const total = filas.length;
  return CAMPOS_LOTE.map(({ campo, etiqueta, severidad }) => {
    const llenos = filas.filter(
      (l) => l[campo] !== null && l[campo] !== undefined && l[campo] !== '',
    ).length;
    return {
      campo,
      etiqueta,
      severidad,
      llenos,
      total,
      porcentaje: total === 0 ? 100 : Math.round((llenos / total) * 100),
    };
  });
}

module.exports = {
  MIN_PARES_CORRELACION,
  MIN_DIAS_TENDENCIA,
  VENTANA_MEDIA_MOVIL_DIAS,
  FACTOR_IQR_ATIPICO,
  UMBRALES,
  REGLAS_LOTE,
  CAMPOS_LOTE,
  redondear,
  percentil,
  descriptivas,
  histograma,
  outliersIQR,
  correlacionPearson,
  regresionLineal,
  mediaMovil,
  tendenciaSerie,
  compararVentanas,
  agrupar,
  validarLote,
  validarLotes,
  completitudLotes,
};

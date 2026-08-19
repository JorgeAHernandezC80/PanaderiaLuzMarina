/**
 * AUDITORÍA — ANALÍTICA: la aritmética del módulo de Auditoría, sin base
 * de datos. Mismo criterio que mermasAnalitica.js/mermasModelos.js:
 * funciones puras, para poder probarlas con datos de ejemplo sin levantar
 * SQLite.
 *
 * auditoria.js ya arma y verifica la cadena de hashes; este archivo
 * aplica sobre esa cadena las técnicas pendientes del curso de IU Digital:
 *
 *   · Perfilado de datos        → perfilarCadena() (metadata: qué tan
 *     completo está cada campo del bloque, cuántos valores distintos
 *     tiene, rango de fechas cubierto).
 *   · Análisis descriptivo/EDA  → construirVariablesNumericas() extrae dos
 *     variables numéricas que la cadena no expone directamente (intervalo
 *     entre bloques, tamaño del payload) y analizarNumericas() les aplica
 *     Analitica.descriptivas()/histograma() — reutilizados de
 *     lotesAnalitica.js, no duplicados.
 *   · Limpieza                  → detectarBloquesAtipicos() reutiliza
 *     Analitica.outliersIQR() (regla de Tukey) sobre esas dos variables.
 *     Acá "limpiar" no es borrar bloques (la cadena es append-only e
 *     inmutable por diseño) sino señalar cuáles llaman la atención.
 *   · Codificación/decodificación → codificarCategorica()/
 *     decodificarCategorica() (label encoding tipo sklearn.LabelEncoder:
 *     fit+transform en un paso, con el mapa para poder revertirlo) y
 *     matrizEntidadAccion(), que la usa para armar una tabla de
 *     contingencia entidad×acción y probar si son independientes
 *     (reutiliza Modelos.pruebaChiCuadrado de mermasModelos.js).
 *   · Estandarización            → estandarizar() (z-score, media 0
 *     desviación 1) — necesaria antes de combinar intervalo (segundos) y
 *     tamaño (bytes) en un solo puntaje: son escalas distintas, igual
 *     razón que ya documenta mermasAnalitica.js para no mezclar % de
 *     cocción con unidades.
 *   · Preparación para visualización → prepararDispersion(): ver la nota
 *     "cuarteto de Anscombe" más abajo.
 */

const Analitica = require('./lotesAnalitica');
const Modelos = require('./mermasModelos');

function redondear(n, decimales = 4) {
  const factor = 10 ** decimales;
  return Math.round(n * factor) / factor;
}

/* ═══════════════════════════════════════════
   PERFILADO DE DATOS (data profiling)
   ═══════════════════════════════════════════
   No es un control de calidad con severidad como calidadDatos.js (esos
   campos no son "opcionales que deberían llenarse" — actualizado_por
   null es legítimo para una acción del sistema). Acá el perfilado
   responde una pregunta distinta: "¿qué tan confiable es cada columna de
   esta tabla para hacer análisis sobre ella?". */
function esVacio(valor) {
  return valor === null || valor === undefined || valor === '';
}

const CAMPOS_BLOQUE = [
  { campo: 'entidad', etiqueta: 'Entidad' },
  { campo: 'entidad_id', etiqueta: 'ID de entidad' },
  { campo: 'accion', etiqueta: 'Acción' },
  { campo: 'datos', etiqueta: 'Datos (payload)' },
  { campo: 'actualizado_por', etiqueta: 'Actualizado por' },
];

/**
 * Metadata de la cadena: completitud y cardinalidad por campo, más el
 * rango de fechas cubierto. Es el "diccionario de datos" que responde
 * cuánto se puede confiar en cada columna sin revisarla fila por fila.
 * @param {object[]} bloques filas crudas de auditoria_cadena
 */
function perfilarCadena(bloques) {
  const total = bloques.length;

  const campos = CAMPOS_BLOQUE.map(({ campo, etiqueta }) => {
    const llenos = bloques.filter((b) => !esVacio(b[campo])).length;
    const distintos = new Set(bloques.map((b) => b[campo]).filter((v) => !esVacio(v))).size;
    return {
      campo,
      etiqueta,
      llenos,
      total,
      porcentajeCompletitud: total ? Math.round((llenos / total) * 100) : 100,
      valoresDistintos: distintos,
    };
  });

  const fechas = bloques
    .map((b) => b.creado_en)
    .filter(Boolean)
    .sort();

  return {
    totalBloques: total,
    rangoFechas: fechas.length ? { desde: fechas[0], hasta: fechas[fechas.length - 1] } : null,
    campos,
  };
}

/* ═══════════════════════════════════════════
   VARIABLES NUMÉRICAS DERIVADAS (para EDA, limpieza y visualización)
   ═══════════════════════════════════════════
   La cadena en sí no tiene columnas numéricas más allá del id — para
   poder aplicar descriptivas/histograma/outliers hace falta derivar
   alguna. Estas dos son las que de verdad importan para auditoría:
   ritmo de escritura (intervalo entre bloques) y tamaño del cambio
   (payload), porque ambas delatan comportamiento anómalo (una ráfaga de
   bloques en el mismo segundo, o un payload gigante fuera de lo común)
   que un conteo agregado por entidad/acción no muestra. */

/**
 * @param {object[]} bloques filas crudas de auditoria_cadena, cualquier orden
 * @returns {{id: number, intervaloSeg: number|null, tamanoBytes: number}[]}
 *   ordenado cronológicamente; intervaloSeg es null en el primer bloque
 *   (no hay bloque anterior con el cual medir el intervalo).
 */
function construirVariablesNumericas(bloques) {
  const ordenados = [...bloques].sort((a, b) => new Date(a.creado_en) - new Date(b.creado_en));

  return ordenados.map((bloque, i) => {
    const anterior = i > 0 ? ordenados[i - 1] : null;
    const intervaloSeg = anterior
      ? redondear((new Date(bloque.creado_en) - new Date(anterior.creado_en)) / 1000, 2)
      : null;
    const tamanoBytes = Buffer.byteLength(
      typeof bloque.datos === 'string' ? bloque.datos : JSON.stringify(bloque.datos ?? {}),
      'utf8',
    );
    return { id: bloque.id, intervaloSeg, tamanoBytes };
  });
}

/* ═══════════════════════════════════════════
   ANÁLISIS DESCRIPTIVO / EDA
   ═══════════════════════════════════════════ */

/** Descriptivas + histograma de las dos variables derivadas. Reutiliza
 *  Analitica.descriptivas()/histograma() de lotesAnalitica.js — el mismo
 *  criterio que ya usa mermasModelos.js para no reimplementar percentiles.
 *  @param {ReturnType<typeof construirVariablesNumericas>} variables
 */
function analizarNumericas(variables) {
  const intervalos = variables.map((v) => v.intervaloSeg).filter((v) => v !== null);
  const tamanos = variables.map((v) => v.tamanoBytes);

  return {
    intervaloEntreBloquesSeg: {
      descriptivas: Analitica.descriptivas(intervalos),
      histograma: Analitica.histograma(intervalos, 8),
    },
    tamanoPayloadBytes: {
      descriptivas: Analitica.descriptivas(tamanos),
      histograma: Analitica.histograma(tamanos, 8),
    },
  };
}

/* ═══════════════════════════════════════════
   LIMPIEZA: detección de bloques atípicos
   ═══════════════════════════════════════════
   La cadena es append-only e inmutable por diseño (ver auditoria.js) —
   acá no se imputa ni se borra nada, solo se señala. Un bloque atípico
   sigue siendo un dato real: puede ser una importación masiva legítima
   (muchos bloques casi al mismo segundo) o un payload sospechosamente
   grande que vale la pena revisar. */

/** @param {ReturnType<typeof construirVariablesNumericas>} variables */
function detectarBloquesAtipicos(variables) {
  const conIntervalo = variables.filter((v) => v.intervaloSeg !== null);

  const atipicosIntervalo = Analitica.outliersIQR(conIntervalo, (v) => v.intervaloSeg).map(
    ({ item, valor, lado }) => ({ id: item.id, intervaloSeg: valor, lado }),
  );
  const atipicosTamano = Analitica.outliersIQR(variables, (v) => v.tamanoBytes).map(
    ({ item, valor, lado }) => ({ id: item.id, tamanoBytes: valor, lado }),
  );

  return { atipicosIntervalo, atipicosTamano };
}

/* ═══════════════════════════════════════════
   CODIFICACIÓN Y DECODIFICACIÓN DE DATOS
   ═══════════════════════════════════════════ */

/**
 * Label encoding de una variable categórica: cada valor distinto pasa a
 * un entero 0..k-1 (orden alfabético, para que el mismo conjunto de
 * categorías siempre produzca el mismo código). Mismo patrón fit+transform
 * que sklearn.LabelEncoder — se devuelve el mapa (categorias) junto con
 * los códigos para poder decodificar después.
 * @param {(string|null)[]} valores
 * @returns {{codigos: number[], categorias: string[]}}
 */
function codificarCategorica(valores) {
  const categorias = [...new Set(valores.filter((v) => !esVacio(v)))].sort();
  const mapa = new Map(categorias.map((c, i) => [c, i]));
  const codigos = valores.map((v) => (esVacio(v) ? null : (mapa.get(v) ?? null)));
  return { codigos, categorias };
}

/** Inversa de codificarCategorica(): entero → categoría original.
 *  @param {(number|null)[]} codigos
 *  @param {string[]} categorias el mismo arreglo que devolvió codificarCategorica()
 */
function decodificarCategorica(codigos, categorias) {
  return codigos.map((c) => (c === null || c === undefined ? null : (categorias[c] ?? null)));
}

/**
 * Tabla de contingencia entidad × acción (codificada, ver arriba) más la
 * prueba de independencia χ² (reutiliza Modelos.pruebaChiCuadrado de
 * mermasModelos.js): responde "¿el tipo de acción depende de la entidad,
 * o son independientes?" — ej. si "eliminar" se concentra
 * desproporcionadamente en una sola entidad, vale la pena preguntar por qué.
 * @param {object[]} bloques filas crudas de auditoria_cadena
 */
function matrizEntidadAccion(bloques) {
  const { codigos: codEntidad, categorias: entidades } = codificarCategorica(
    bloques.map((b) => b.entidad),
  );
  const { codigos: codAccion, categorias: acciones } = codificarCategorica(
    bloques.map((b) => b.accion),
  );

  const tabla = entidades.map(() => acciones.map(() => 0));
  for (let i = 0; i < bloques.length; i++) {
    if (codEntidad[i] === null || codAccion[i] === null) continue;
    tabla[codEntidad[i]][codAccion[i]] += 1;
  }

  return {
    entidades,
    acciones,
    tabla,
    independencia: Modelos.pruebaChiCuadrado(tabla),
  };
}

/* ═══════════════════════════════════════════
   ESTANDARIZACIÓN DE DATOS
   ═══════════════════════════════════════════ */

/**
 * Estandarización z-score (media 0, desviación 1). Los valores no
 * numéricos (null, el intervalo del primer bloque) pasan a null en vez de
 * a 0 — 0 en una variable estandarizada significa "justo en la media", no
 * "sin dato", así que confundirlos maquillaría el intervalo faltante
 * del primer bloque como si fuera un valor típico.
 * @param {(number|null)[]} valores
 */
function estandarizar(valores) {
  const limpios = valores.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (limpios.length === 0) return valores.map(() => null);

  const media = limpios.reduce((s, v) => s + v, 0) / limpios.length;
  const varianza = limpios.reduce((s, v) => s + (v - media) ** 2, 0) / limpios.length;
  const desviacion = Math.sqrt(varianza) || 1;

  return valores.map((v) =>
    typeof v === 'number' && Number.isFinite(v) ? redondear((v - media) / desviacion) : null,
  );
}

/* ═══════════════════════════════════════════
   PREPARACIÓN PARA VISUALIZACIÓN
   ═══════════════════════════════════════════
   Nota "cuarteto de Anscombe": Anscombe (1973) construyó cuatro conjuntos
   de datos con la MISMA media, varianza y correlación, pero que al
   graficarse se ven completamente distintos (una línea recta, una curva,
   un outlier solo). La lección es la razón de este bloque: porEntidad y
   porAccion (arriba, en auditoria.js) son agregados — dos períodos con
   el mismo conteo por entidad/acción pueden tener un ritmo de escritura
   completamente distinto (parejo vs. en ráfagas) y esa diferencia es
   invisible en una tabla de conteos. prepararDispersion() arma pares
   (intervalo, tamaño) por bloque, listos para graficarse como dispersión
   real en vez de otro agregado — es lo único que muestra la forma real
   de los datos, no solo su resumen. */

/** @param {ReturnType<typeof construirVariablesNumericas>} variables */
function prepararDispersion(variables) {
  const zIntervalo = estandarizar(variables.map((v) => v.intervaloSeg));
  const zTamano = estandarizar(variables.map((v) => v.tamanoBytes));

  return variables.map((v, i) => ({
    id: v.id,
    intervaloSeg: v.intervaloSeg,
    tamanoBytes: v.tamanoBytes,
    zIntervalo: zIntervalo[i],
    zTamano: zTamano[i],
    // Distancia euclídea en el espacio ya estandarizado: combina ambas
    // señales (ritmo + tamaño) en un solo puntaje comparable. 0 = típico
    // en ambas variables a la vez; más alto = más atípico en conjunto.
    puntajeAnomalia:
      zIntervalo[i] !== null && zTamano[i] !== null
        ? redondear(Math.sqrt(zIntervalo[i] ** 2 + zTamano[i] ** 2))
        : null,
  }));
}

module.exports = {
  CAMPOS_BLOQUE,
  esVacio,
  perfilarCadena,
  construirVariablesNumericas,
  analizarNumericas,
  detectarBloquesAtipicos,
  codificarCategorica,
  decodificarCategorica,
  matrizEntidadAccion,
  estandarizar,
  prepararDispersion,
};

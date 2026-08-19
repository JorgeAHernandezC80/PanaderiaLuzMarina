/**
 * MERMAS — ANALÍTICA: la aritmética del módulo de Mermas, sin base de
 * datos. Mismo criterio que lotesAnalitica.js/estadisticas.js: funciones
 * puras, para poder probarlas con datos de ejemplo sin levantar SQLite.
 *
 * Cubre las fases 3 (procesamiento — la parte que no depende de SQL) y 4
 * (limpieza) del pipeline documentado en mermas.js:
 *
 *   · clasificarNota()      — convierte el texto libre de una nota en una
 *     categoría estructurada (causa probable). Es la pieza que trata el
 *     dato NO ESTRUCTURADO del módulo.
 *   · imputarNulos()        — técnica de imputación por mediana (del
 *     producto, con fallback a la mediana global del tipo) para el
 *     tratamiento de datos ausentes.
 *   · marcarAtipicos()      — reutiliza la regla de Tukey de
 *     lotesAnalitica.js (outliersIQR) para el tratamiento de datos
 *     atípicos, calculada por separado en cada tipo de evento para no
 *     mezclar escalas (% de cocción vs. unidades).
 *   · limpiarDatasetMermas() — orquesta las dos anteriores y devuelve un
 *     reporte auditable: qué se imputó, con qué fuente, y qué quedó
 *     marcado como atípico.
 *
 * La extracción (SQLite) y el ensamblado de los tres tipos de evento
 * (coccion / ajuste_manual / segunda_calidad) viven en mermas.js.
 */

const Analitica = require('./lotesAnalitica');

/* ═══════════════════════════════════════════
   CLASIFICACIÓN DE TEXTO LIBRE (dato no estructurado → estructurado)
   ═══════════════════════════════════════════
   Diccionario de palabras clave por causa probable. Deliberadamente
   simple (no es NLP de verdad): el objetivo es rescatar la nota de texto
   libre que YA se está escribiendo hoy, no pedirle a nadie que llene un
   campo nuevo. La primera categoría que coincide gana — una nota rara
   vez describe dos causas a la vez, y si lo hace, la primera mención
   suele ser la causa principal. */
const PATRONES_CAUSA_MERMA = Object.freeze({
  // "quem" (sin terminación) cubre quemó/quema/quemado/quemada/quemadura
  // en una sola pasada — conjugar cada variante a mano es frágil.
  quemado: [/quem/i, /carboniz/i, /se pas[oó] de horno/i],
  no_fermento: [/no subi[oó]/i, /no ferment/i, /masa muert/i, /no leud/i],
  deformado: [/deform/i, /mal formad/i, /ca[ií]d/i, /cay[oó]/i, /aplast/i],
  empaque: [/empaqu/i, /bolsa rot/i, /rotur/i, /da[ñn]ad. en (transporte|empaque)/i],
  vencido: [/vencid/i, /caduc/i, /pas[oó] de fecha/i],
  error_horno: [/temperatura/i, /horno fall/i, /horno se apag/i, /piso desnivel/i],
  error_receta: [/receta mal/i, /f[oó]rmula/i, /ingrediente equivocad/i],
});

/** Convierte una nota de texto libre en una causa probable estructurada.
 *  Devuelve null si no hay nota (no es lo mismo "sin nota" que "nota sin
 *  palabras clave reconocidas" — esto último es 'sin_clasificar'). */
function clasificarNota(nota) {
  if (typeof nota !== 'string' || nota.trim() === '') return null;
  for (const [causa, patrones] of Object.entries(PATRONES_CAUSA_MERMA)) {
    if (patrones.some((patron) => patron.test(nota))) return causa;
  }
  return 'sin_clasificar';
}

/* ═══════════════════════════════════════════
   LIMPIEZA: datos ausentes (imputación) y datos atípicos
   ═══════════════════════════════════════════
   Dos escalas distintas conviven en el dataset ('%' y 'unidades'), así
   que atípicos e imputación se calculan POR TIPO — mezclar coccion (0-60%)
   con ajuste_manual (unidades enteras) daría cuartiles sin sentido. */
const MIN_EVENTOS_MEDIANA_PRODUCTO = 4;

function mediana(valores) {
  const limpios = valores.filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (limpios.length === 0) return null;
  const ordenados = [...limpios].sort((a, b) => a - b);
  return Analitica.percentil(ordenados, 50);
}

/** Imputa por mediana del grupo (producto+tipo), con al menos
 *  MIN_EVENTOS_MEDIANA_PRODUCTO eventos de ese producto; si no hay
 *  suficiente historial propio, usa la mediana global del tipo. Solo
 *  actúa sobre eventos con valor null/NaN — un valor de 0 es un dato
 *  real (cero merma), no un hueco. */
function imputarNulos(eventos) {
  const porTipo = new Map();
  for (const ev of eventos) {
    if (!porTipo.has(ev.tipo)) porTipo.set(ev.tipo, []);
    porTipo.get(ev.tipo).push(ev);
  }

  const reporte = [];
  const resultado = eventos.map((ev) => {
    if (typeof ev.valor === 'number' && Number.isFinite(ev.valor)) return ev;

    const delTipo = porTipo.get(ev.tipo) ?? [];
    const delProducto = delTipo.filter((e) => e.productoId === ev.productoId);
    let fuente = 'mediana_global_tipo';
    let medianaUsada = mediana(delTipo.map((e) => e.valor));

    if (delProducto.length >= MIN_EVENTOS_MEDIANA_PRODUCTO) {
      const medianaProducto = mediana(delProducto.map((e) => e.valor));
      if (medianaProducto !== null) {
        medianaUsada = medianaProducto;
        fuente = 'mediana_producto';
      }
    }

    reporte.push({
      id: ev.id,
      productoId: ev.productoId,
      tipo: ev.tipo,
      valorImputado: medianaUsada,
      fuente,
    });

    return {
      ...ev,
      valor: medianaUsada,
      esImputado: medianaUsada !== null,
      valorOriginal: ev.valor,
    };
  });

  return { eventos: resultado, imputaciones: reporte };
}

/** Marca (no elimina) los eventos atípicos por tipo, vía la regla de
 *  Tukey ya usada en Lotes (Analitica.outliersIQR). Un atípico sigue
 *  siendo un dato real — puede ser un error de captura o una merma
 *  genuinamente grande; el análisis (fase 5) decide qué hacer con la
 *  marca, acá solo se detecta y se etiqueta. */
function marcarAtipicos(eventos) {
  const porTipo = new Map();
  for (const ev of eventos) {
    if (!porTipo.has(ev.tipo)) porTipo.set(ev.tipo, []);
    porTipo.get(ev.tipo).push(ev);
  }

  const idsAtipicos = new Map();
  for (const [, grupo] of porTipo) {
    for (const { item, lado } of Analitica.outliersIQR(grupo, (ev) => ev.valor)) {
      idsAtipicos.set(item.id, lado);
    }
  }

  return eventos.map((ev) =>
    idsAtipicos.has(ev.id)
      ? { ...ev, esAtipico: true, ladoAtipico: idsAtipicos.get(ev.id) }
      : { ...ev, esAtipico: false },
  );
}

/** Limpieza completa: imputa nulos y luego marca atípicos sobre el
 *  dataset ya imputado (un valor imputado también puede resultar
 *  atípico, y eso es información válida: el grupo entero puede tener
 *  huecos sistemáticos en un producto problemático). Devuelve el
 *  dataset limpio + un reporte auditable de qué se tocó y por qué —
 *  nunca se limpia en silencio. */
function limpiarDatasetMermas(eventosCrudos) {
  const total = eventosCrudos.length;
  const nulos = eventosCrudos.filter((ev) => !Number.isFinite(ev.valor)).length;

  const { eventos: imputados, imputaciones } = imputarNulos(eventosCrudos);
  const eventosLimpios = marcarAtipicos(imputados);
  const atipicos = eventosLimpios.filter((ev) => ev.esAtipico).length;

  return {
    eventos: eventosLimpios,
    reporte: {
      totalEventos: total,
      nulosDetectados: nulos,
      nulosImputados: imputaciones.length,
      imputacionesSinResolver: imputaciones.filter((i) => i.valorImputado === null).length,
      atipicosDetectados: atipicos,
      imputaciones,
    },
  };
}

module.exports = {
  PATRONES_CAUSA_MERMA,
  MIN_EVENTOS_MEDIANA_PRODUCTO,
  clasificarNota,
  mediana,
  imputarNulos,
  marcarAtipicos,
  limpiarDatasetMermas,
};

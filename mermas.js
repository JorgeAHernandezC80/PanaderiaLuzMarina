/**
 * MERMAS — pipeline formal de datos aplicado al fenómeno de la merma.
 *
 * ARQUITECTURA DE DATOS
 * ══════════════════════
 * La merma en Panadería Luz Marina no es un solo número: son TRES señales
 * distintas, de grano y semántica distintos, repartidas en dos tablas que
 * ya existen. Este módulo no crea una tabla `mermas` — duplicaría el dato
 * y abriría una segunda fuente de verdad para el mismo evento (mismo
 * criterio ya documentado en lotes.js). En su lugar, INTEGRA las tres en
 * tiempo de consulta:
 *
 *   1. COCCIÓN     horneadas.merma_real_pct   — % de peso perdido al
 *      hornear (agua que se evapora). Continua, una cifra por lote.
 *      Se compara contra recetas.merma_coccion_pct (la merma ESPERADA
 *      según la ficha técnica) para obtener el desvío real vs. esperado
 *      — el mismo indicador que ya usa el módulo de Lotes.
 *   2. AJUSTE MANUAL   ajustes_inventario (motivo='merma') — unidades
 *      descartadas DESPUÉS de horneadas (caídas, mal empaque, etc.).
 *      Discreta, conteo de unidades, con su propio registro y fecha —
 *      no siempre coincide con el día del horneado.
 *   3. SEGUNDA CALIDAD   horneadas.unidades_segunda_calidad — unidades
 *      que NO se descartan (se venden con descuento) pero sí representan
 *      una pérdida de valor. Discreta, conteo de unidades.
 *
 * Cada una de las tres trae además un componente NO ESTRUCTURADO: el
 * campo `notas`, texto libre escrito por quien registra el evento.
 * MermasAnalitica.clasificarNota() extrae de ahí una categoría
 * estructurada (causaProbable) por palabras clave — sin eso, la causa de
 * la merma quedaría fuera de cualquier análisis cuantitativo el 100% de
 * las veces que no se llena un campo de "motivo" aparte.
 *
 * PIPELINE (los 5 componentes)
 * ══════════════════════════════
 *   1. Recopilación   → consultarMermaCoccion(), consultarAjustesMerma(),
 *                        consultarSegundaCalidad() (acceso a SQLite, acá abajo)
 *   2. Almacenamiento → sin tabla nueva (ver arriba); documentado acá
 *                        porque la decisión de arquitectura ES parte del
 *                        pipeline aunque no genere código propio
 *   3. Procesamiento  → construirDatasetMermas() (ETL: une las 3 fuentes
 *                        en un solo esquema común, acá abajo) +
 *                        MermasAnalitica.clasificarNota() (el texto libre)
 *   4. Limpieza       → MermasAnalitica.limpiarDatasetMermas() (nulos,
 *                        atípicos, imputación — ver mermasAnalitica.js)
 *   5. Análisis       → analizarMermas() (acá abajo): EDA univariado,
 *                        bivariado y multivariado, pruebas de hipótesis y
 *                        modelos descriptivo/predictivo — la aritmética
 *                        vive en mermasModelos.js, acá se decide con qué
 *                        variables de PLM se alimenta cada análisis.
 *
 * Reparto de responsabilidades igual que lotes.js/lotesAnalitica.js:
 * acceso a SQLite y ensamblado acá; toda la aritmética pura (incluida la
 * limpieza) vive en mermasAnalitica.js, para poder probarla sin base de
 * datos. Los endpoints (server.js) solo validan parámetros y llaman.
 */

const db = require('./db');
const Analitica = require('./lotesAnalitica');
const MermasAnalitica = require('./mermasAnalitica');
const MermasModelos = require('./mermasModelos');

const HOUSTON_TZ = 'America/Chicago';
const VENTANA_DIAS_DEFECTO = 30;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function hoyHouston() {
  return new Date().toLocaleDateString('en-CA', { timeZone: HOUSTON_TZ });
}

function restarDias(fechaIso, dias) {
  const d = new Date(`${fechaIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

/** Mismo criterio que lotes.js: sin rango pedido, una ventana de 30 días;
 *  rango invertido se corrige en vez de devolver 0 filas sin explicar por qué. */
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
   1. RECOPILACIÓN
   ═══════════════════════════════════════════ */

/** Merma de cocción: una fila por horneada con merma_real_pct registrada
 *  (NULL se excluye acá — la limpieza decide qué hacer con los huecos,
 *  no la recopilación). Cruza contra recetas para el desvío. */
function consultarMermaCoccion({ desde, hasta, productoId }) {
  const params = [desde, hasta];
  let filtroProducto = '';
  if (productoId) {
    filtroProducto = ' AND h.producto_id = ?';
    params.push(String(productoId));
  }
  return db
    .prepare(
      `SELECT h.id, h.producto_id, h.producto_nombre, h.fecha, h.hora,
              h.merma_real_pct, h.notas, h.registrado_por,
              h.temperatura_horneado_real_c, h.tiempo_horneado_real_min,
              r.merma_coccion_pct AS merma_esperada_pct,
              p.vida_util_horas, p.precio
       FROM horneadas h
       LEFT JOIN recetas r ON r.producto_id = h.producto_id
       LEFT JOIN productos p ON p.id = CAST(h.producto_id AS INTEGER)
       WHERE h.fecha >= ? AND h.fecha <= ?${filtroProducto}
       ORDER BY h.fecha, h.hora`,
    )
    .all(...params);
}

/** Ajustes de inventario cuyo motivo es 'merma' — la pérdida post-horneo.
 *  Los demás motivos (error_conteo, consumo_interno, otro) no son merma;
 *  quedan fuera desde la consulta, no filtrados después. */
function consultarAjustesMerma({ desde, hasta, productoId }) {
  const params = [desde, hasta];
  let filtroProducto = '';
  if (productoId) {
    filtroProducto = ' AND producto_id = ?';
    params.push(String(productoId));
  }
  return db
    .prepare(
      `SELECT id, producto_id, producto_nombre, cantidad, fecha, hora, notas, registrado_por
       FROM ajustes_inventario
       WHERE motivo = 'merma' AND fecha >= ? AND fecha <= ?${filtroProducto}
       ORDER BY fecha, hora`,
    )
    .all(...params);
}

/** Horneadas con unidades de segunda calidad > 0 — degradación de valor
 *  sin descarte. Reutiliza la misma nota de la horneada (una nota, dos
 *  señales posibles: merma de cocción Y segunda calidad pueden compartir
 *  causa, ej. "se deformaron con el calor"). */
function consultarSegundaCalidad({ desde, hasta, productoId }) {
  const params = [desde, hasta];
  let filtroProducto = '';
  if (productoId) {
    filtroProducto = ' AND producto_id = ?';
    params.push(String(productoId));
  }
  return db
    .prepare(
      `SELECT id, producto_id, producto_nombre, cantidad, unidades_segunda_calidad,
              fecha, hora, notas, registrado_por
       FROM horneadas
       WHERE unidades_segunda_calidad IS NOT NULL AND unidades_segunda_calidad > 0
             AND fecha >= ? AND fecha <= ?${filtroProducto}
       ORDER BY fecha, hora`,
    )
    .all(...params);
}

/* ═══════════════════════════════════════════
   3. PROCESAMIENTO — ETL: tres fuentes → un esquema común
   ═══════════════════════════════════════════
   Esquema del evento unificado:
     id             string  único entre las tres fuentes (prefijado por tipo)
     tipo           'coccion' | 'ajuste_manual' | 'segunda_calidad'
     fecha, hora    string  tal como se registraron
     productoId, productoNombre
     valor          number  la magnitud de la merma en la unidad de su tipo
     unidad         '%' | 'unidades'
     mermaEsperadaPct  number|null   solo tipo='coccion' (referencia de receta)
     temperaturaC, tiempoMin, vidaUtilHoras, precio  number|null
                    solo tipo='coccion' — variables para el bivariado y
                    el multivariado (fase 5, ver analizarMermas() abajo)
     notaOriginal   string|null
     causaProbable  string|null   ver MermasAnalitica.clasificarNota()
     registradoPor  string|null
 */
function construirDatasetMermas({ desde, hasta, productoId } = {}) {
  const rango = resolverRango({ desde, hasta });
  const filtros = { ...rango, productoId };

  const coccion = consultarMermaCoccion(filtros)
    .filter((h) => Number.isFinite(h.merma_real_pct))
    .map((h) => ({
      id: `coccion:${h.id}`,
      tipo: 'coccion',
      fecha: h.fecha,
      hora: h.hora,
      productoId: h.producto_id,
      productoNombre: h.producto_nombre,
      valor: h.merma_real_pct,
      unidad: '%',
      mermaEsperadaPct: Number.isFinite(h.merma_esperada_pct) ? h.merma_esperada_pct : null,
      // Variables bivariadas/multivariadas — solo existen para este tipo
      // de evento (la ficha técnica de horneado no aplica a un ajuste
      // manual ni a una unidad de segunda calidad).
      temperaturaC: Number.isFinite(h.temperatura_horneado_real_c)
        ? h.temperatura_horneado_real_c
        : null,
      tiempoMin: Number.isFinite(h.tiempo_horneado_real_min) ? h.tiempo_horneado_real_min : null,
      vidaUtilHoras: Number.isFinite(h.vida_util_horas) ? h.vida_util_horas : null,
      precio: Number.isFinite(h.precio) ? h.precio : null,
      notaOriginal: h.notas ?? null,
      causaProbable: MermasAnalitica.clasificarNota(h.notas),
      registradoPor: h.registrado_por ?? null,
    }));

  const ajustes = consultarAjustesMerma(filtros).map((a) => ({
    id: `ajuste:${a.id}`,
    tipo: 'ajuste_manual',
    fecha: a.fecha,
    hora: a.hora,
    productoId: a.producto_id,
    productoNombre: a.producto_nombre,
    valor: a.cantidad,
    unidad: 'unidades',
    mermaEsperadaPct: null,
    notaOriginal: a.notas ?? null,
    causaProbable: MermasAnalitica.clasificarNota(a.notas),
    registradoPor: a.registrado_por ?? null,
  }));

  const segundaCalidad = consultarSegundaCalidad(filtros).map((h) => ({
    id: `segunda:${h.id}`,
    tipo: 'segunda_calidad',
    fecha: h.fecha,
    hora: h.hora,
    productoId: h.producto_id,
    productoNombre: h.producto_nombre,
    valor: h.unidades_segunda_calidad,
    unidad: 'unidades',
    mermaEsperadaPct: null,
    notaOriginal: h.notas ?? null,
    causaProbable: MermasAnalitica.clasificarNota(h.notas),
    registradoPor: h.registrado_por ?? null,
  }));

  return [...coccion, ...ajustes, ...segundaCalidad].sort(
    (a, b) => a.fecha.localeCompare(b.fecha) || a.hora.localeCompare(b.hora),
  );
}

/* ═══════════════════════════════════════════
   PUNTO DE ENTRADA DEL PIPELINE (recopilación → almacenamiento →
   procesamiento → limpieza). analizarMermas() (más abajo) le suma la
   fase 5 (análisis) sobre este mismo resultado.
   ═══════════════════════════════════════════ */
function ejecutarPipelineMermas(filtros = {}) {
  const crudos = construirDatasetMermas(filtros);
  const { eventos, reporte } = MermasAnalitica.limpiarDatasetMermas(crudos);
  return { rango: resolverRango(filtros), eventos, limpieza: reporte };
}

/* ═══════════════════════════════════════════
   5. ANÁLISIS — EDA (univariado/bivariado/multivariado), pruebas de
   hipótesis y modelos (descriptivo + predictivo), sobre el dataset ya
   limpio. La aritmética vive en mermasModelos.js/lotesAnalitica.js; acá
   solo se decide QUÉ variables entran a cada análisis con los datos que
   PLM realmente tiene.
   ═══════════════════════════════════════════ */

/** Solo los eventos de cocción, y solo los que además traen las tres
 *  variables de contexto (temperatura, tiempo, vida útil) — el bivariado
 *  y el multivariado necesitan las tres a la vez para comparar peras con
 *  peras; un evento con alguna en null se cae de estos análisis (sigue
 *  contando para el univariado y para la limpieza). */
function eventosCoccionConContexto(eventos) {
  return eventos.filter(
    (ev) =>
      ev.tipo === 'coccion' &&
      Number.isFinite(ev.temperaturaC) &&
      Number.isFinite(ev.tiempoMin) &&
      Number.isFinite(ev.vidaUtilHoras),
  );
}

/** Univariado: descriptivas + histograma por tipo de evento (la magnitud
 *  de la merma), y tabla de frecuencias de la causa probable — las dos
 *  preguntas de "¿cómo se distribuye la merma?" (numérica) y "¿cuál es
 *  la causa más común?" (categórica). */
function analizarUnivariado(eventos) {
  const porTipo = {};
  for (const tipo of ['coccion', 'ajuste_manual', 'segunda_calidad']) {
    const valores = eventos.filter((ev) => ev.tipo === tipo).map((ev) => ev.valor);
    porTipo[tipo] = {
      descriptivas: Analitica.descriptivas(valores),
      histograma: Analitica.histograma(valores),
    };
  }
  return {
    porTipo,
    frecuenciaCausas: MermasModelos.segmentarCausas(eventos),
  };
}

/** Bivariado: correlación de Pearson entre cada variable de contexto y
 *  la merma de cocción — responde directamente "¿la merma sube con la
 *  temperatura/el tiempo de horno/la vida útil del producto?". */
function analizarBivariado(eventosConContexto) {
  const par = (obtenerX) => ({
    x: eventosConContexto.map(obtenerX),
    y: eventosConContexto.map((ev) => ev.valor),
  });
  const correlacion = (obtenerX) => {
    const { x, y } = par(obtenerX);
    return Analitica.correlacionPearson(x.map((xi, i) => ({ x: xi, y: y[i] })));
  };
  return {
    mermaVsTemperatura: correlacion((ev) => ev.temperaturaC),
    mermaVsTiempoHorneado: correlacion((ev) => ev.tiempoMin),
    mermaVsVidaUtil: correlacion((ev) => ev.vidaUtilHoras),
  };
}

/** Multivariado: temperatura + tiempo + vida útil, juntas, explicando la
 *  merma de cocción — la pregunta que el bivariado no puede responder
 *  (¿cuál de las tres pesa más cuando las otras dos se mantienen fijas?). */
function analizarMultivariado(eventosConContexto) {
  const filas = eventosConContexto.map((ev) => ({
    x: [ev.temperaturaC, ev.tiempoMin, ev.vidaUtilHoras],
    y: ev.valor,
  }));
  const modelo = MermasModelos.regresionLinealMultiple(filas);
  if (!modelo) return null;
  return {
    ...modelo,
    variables: ['temperaturaC', 'tiempoMin', 'vidaUtilHoras'],
  };
}

/** Hipótesis: ¿el producto con más volumen tiene una merma de cocción
 *  significativamente distinta al segundo? Es la versión operacionable,
 *  con los datos que PLM realmente tiene, de "¿un proveedor/tipo de
 *  almacenamiento incrementa la merma?" — PLM no rastrea proveedor ni
 *  almacenamiento a nivel de lote horneado, pero sí producto, que es la
 *  variable de negocio más directa para esta panadería. */
function analizarHipotesisProducto(eventosCoccion) {
  const porProducto = new Map();
  for (const ev of eventosCoccion) {
    if (!porProducto.has(ev.productoId)) {
      porProducto.set(ev.productoId, { nombre: ev.productoNombre, valores: [] });
    }
    porProducto.get(ev.productoId).valores.push(ev.valor);
  }
  const ranking = [...porProducto.entries()]
    .map(([productoId, datos]) => ({ productoId, ...datos }))
    .sort((a, b) => b.valores.length - a.valores.length);

  if (ranking.length < 2) {
    return { valido: false, motivo: 'Se necesitan al menos 2 productos con eventos de cocción.' };
  }

  const [a, b] = ranking;
  return {
    productoA: { id: a.productoId, nombre: a.nombre, n: a.valores.length },
    productoB: { id: b.productoId, nombre: b.nombre, n: b.valores.length },
    prueba: MermasModelos.pruebaTStudent(a.valores, b.valores),
  };
}

/** Hipótesis: ¿la causa probable de la merma depende del producto, o son
 *  independientes? Tabla de contingencia causa × producto (recortada a
 *  las 5 causas y 5 productos más frecuentes — más que eso, la tabla de
 *  valores críticos de χ² de mermasModelos.js no alcanza, y una tabla
 *  10x10 con celdas casi vacías tampoco sería confiable). */
function analizarHipotesisCausaProducto(eventos) {
  const conCausa = eventos.filter((ev) => ev.causaProbable);
  const causasTop = MermasModelos.frecuencias(conCausa.map((ev) => ev.causaProbable))
    .slice(0, 3)
    .map((f) => f.valor);
  const productosTop = MermasModelos.frecuencias(conCausa.map((ev) => ev.productoId))
    .slice(0, 3)
    .map((f) => f.valor);

  if (causasTop.length < 2 || productosTop.length < 2) {
    return { valido: false, motivo: 'No hay suficiente variedad de causas y productos todavía.' };
  }

  const tabla = causasTop.map((causa) =>
    productosTop.map(
      (productoId) =>
        conCausa.filter((ev) => ev.causaProbable === causa && ev.productoId === productoId).length,
    ),
  );

  return {
    causas: causasTop,
    productos: productosTop,
    tabla,
    prueba: MermasModelos.pruebaChiCuadrado(tabla),
  };
}

/** Predictivo: clasifica un evento de cocción como "alto riesgo" cuando
 *  su merma quedó marcada atípica hacia arriba por la limpieza (fase 4)
 *  — reutiliza esa marca en vez de inventar un segundo umbral que podría
 *  no coincidir con el de limpiarDatasetMermas(). Entrena con
 *  temperatura/tiempo/vida útil, que son datos que SÍ se conocen antes
 *  de que el lote termine de hornearse (a diferencia de la merma misma). */
function analizarModeloPredictivo(eventosConContexto) {
  const muestras = eventosConContexto.map((ev) => ({
    x: [ev.temperaturaC, ev.tiempoMin, ev.vidaUtilHoras],
    y: ev.esAtipico && ev.ladoAtipico === 'alto' ? 1 : 0,
  }));
  const modelo = MermasModelos.entrenarRegresionLogistica(muestras);
  if (!modelo) return null;

  const probabilidades = muestras.map((m) => MermasModelos.predecirProbabilidad(modelo, m.x));
  const reales = muestras.map((m) => m.y);
  return {
    variables: ['temperaturaC', 'tiempoMin', 'vidaUtilHoras'],
    n: modelo.n,
    casosAltoRiesgo: modelo.positivos,
    evaluacion: MermasModelos.evaluarClasificador(probabilidades, reales),
  };
}

/** Orquesta el pipeline completo (fases 1-4) y le suma la fase 5. Cada
 *  pieza puede fallar por falta de datos sin tumbar a las demás — con
 *  pocas horneadas registradas, es normal que el modelo predictivo
 *  todavía no tenga suficientes casos y el resto del análisis sí. */
function analizarMermas(filtros = {}) {
  const pipeline = ejecutarPipelineMermas(filtros);
  const eventosCoccion = pipeline.eventos.filter((ev) => ev.tipo === 'coccion');
  const conContexto = eventosCoccionConContexto(pipeline.eventos);

  return {
    ...pipeline,
    analisis: {
      univariado: analizarUnivariado(pipeline.eventos),
      bivariado: analizarBivariado(conContexto),
      multivariado: analizarMultivariado(conContexto),
      hipotesis: {
        productoConMasMermaVsSegundo: analizarHipotesisProducto(eventosCoccion),
        causaEsIndependienteDelProducto: analizarHipotesisCausaProducto(pipeline.eventos),
      },
      modeloPredictivo: analizarModeloPredictivo(conContexto),
    },
  };
}

module.exports = {
  resolverRango,
  consultarMermaCoccion,
  consultarAjustesMerma,
  consultarSegundaCalidad,
  construirDatasetMermas,
  ejecutarPipelineMermas,
  analizarMermas,
};

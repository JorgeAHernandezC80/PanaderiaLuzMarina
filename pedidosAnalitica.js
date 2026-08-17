/**
 * PEDIDOS — analítica pura del ciclo de vida de una orden.
 *
 * Sin SQLite y sin Express: entra un arreglo de pedidos ya armados (ver
 * pedidos.js) y salen métricas. Igual que lotesAnalitica.js frente a
 * lotes.js — así estas reglas se pueden probar sin base de datos.
 *
 * Lo que resuelve: `ordenes.estado` se sobreescribe en cada paso, así que
 * la duración de cada etapa solo existe si se reconstruye desde el
 * historial de transiciones (orden_status_log). De ahí salen el lead time,
 * el cuello de botella de la cocina y el embudo por estado.
 *
 * La aritmética general (descriptivas, tendencia, media móvil, histograma)
 * no se reimplementa: se reusa lotesAnalitica.js, que ya la tiene probada.
 */

const {
  redondear,
  descriptivas,
  histograma,
  outliersIQR,
  mediaMovil,
  tendenciaSerie,
  compararVentanas,
  agrupar,
} = require('./lotesAnalitica');

/* Flujo lineal del pedido, en orden. Es el mismo ORDER_STATES de
   validation.js, pero acá el ORDEN importa: define qué es "avanzar",
   qué es "retroceder" y qué etapas se saltaron. */
const FLUJO_ESTADOS = Object.freeze(['pendiente', 'en_preparacion', 'preparada', 'entregada']);

const ETIQUETAS_ESTADO = Object.freeze({
  pendiente: 'Recibida',
  en_preparacion: 'En preparación',
  preparada: 'Preparada',
  entregada: 'Entregada',
});

const DISPOSITIVOS = Object.freeze(['movil', 'tablet', 'escritorio', 'bot', 'desconocido']);

const ETIQUETAS_DISPOSITIVO = Object.freeze({
  movil: 'Teléfono',
  tablet: 'Tablet',
  escritorio: 'Escritorio',
  bot: 'Bot / rastreador',
  desconocido: 'Sin dato',
});

/* Un pedido con menos de esto en una etapa casi siempre es el panadero
   pulsando dos botones seguidos para poner al día un pedido ya despachado,
   no la etapa durando de verdad. Se marca como hallazgo, no se descarta:
   descartarlo en silencio inventaría un lead time que nadie midió. */
const MIN_MINUTOS_ETAPA_CREIBLE = 1;

/* Por encima de esto, la transición casi seguro quedó registrada tarde
   (el pedido se entregó y el estado se movió al día siguiente). */
const MAX_HORAS_ETAPA_CREIBLE = 24;

/** Minutos entre dos instantes ISO; null si falta alguno o el orden se
 *  invierte (dos transiciones del mismo segundo dan 0, que es un dato
 *  válido y distinto de "no se sabe"). */
function minutosEntre(desdeIso, hastaIso) {
  if (!desdeIso || !hastaIso) return null;
  const ms = new Date(hastaIso) - new Date(desdeIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return redondear(ms / 60000);
}

/**
 * Clasifica el dispositivo desde el User-Agent. Lista de coincidencias
 * mínima y explícita: el objetivo es la decisión de negocio
 * "¿priorizo la UX móvil?", no un fingerprint del navegador.
 * El orden importa: casi todo UA de tablet contiene también "Mobile" o
 * "Android", así que tablet y bot se evalúan antes que móvil.
 * @param {string|null|undefined} userAgent
 * @returns {'movil'|'tablet'|'escritorio'|'bot'|'desconocido'}
 */
function clasificarDispositivo(userAgent) {
  const ua = String(userAgent ?? '').toLowerCase();
  if (ua.trim() === '') return 'desconocido';
  if (/bot|crawler|spider|curl|wget|python-requests|node-fetch|headless/.test(ua)) return 'bot';
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(ua)) return 'tablet';
  if (/iphone|ipod|android|blackberry|iemobile|opera mini|mobile/.test(ua)) return 'movil';
  return 'escritorio';
}

/**
 * Reconstruye la línea de tiempo de un pedido desde sus transiciones.
 *
 * Cada etapa dura desde que el pedido ENTRA a un estado hasta que sale de
 * él. La última etapa queda abierta (`minutos: null`, `abierta: true`)
 * salvo que el pedido esté entregado: contar "hasta ahora" como duración
 * final haría que un pedido en curso pareciera un récord de lentitud.
 *
 * Un historial reconstruido por la migración (`sesionAdmin: 'migracion'`)
 * no son observaciones: son las dos fechas que tenía la fila del pedido. Si
 * de ahí sale una duración de menos de un minuto no se mide como "cocina
 * instantánea", se deja en null para que no arrastre las medianas.
 *
 * @param {{estadoOrigen: string|null, estadoDestino: string, fechaHora: string, usuarioAdmin: string|null, sesionAdmin: string|null}[]} transiciones
 * @returns {{etapas: object[], transiciones: object[], leadTimeTotalMin: number|null, reconstruida: boolean, entregada: boolean}}
 */
function construirLineaTiempo(transiciones) {
  const ordenadas = [...(transiciones ?? [])]
    .filter((t) => t && t.estadoDestino && t.fechaHora)
    .sort(
      (a, b) => String(a.fechaHora).localeCompare(String(b.fechaHora)) || (a.id ?? 0) - (b.id ?? 0),
    );

  const reconstruida =
    ordenadas.length > 0 && ordenadas.every((t) => t.sesionAdmin === 'migracion');
  const medible = (minutos) =>
    minutos !== null && reconstruida && minutos < MIN_MINUTOS_ETAPA_CREIBLE ? null : minutos;

  const etapas = ordenadas.map((transicion, i) => {
    const siguiente = ordenadas[i + 1];
    return {
      estado: transicion.estadoDestino,
      etiqueta: ETIQUETAS_ESTADO[transicion.estadoDestino] ?? transicion.estadoDestino,
      desde: transicion.fechaHora,
      hasta: siguiente ? siguiente.fechaHora : null,
      minutos: siguiente ? medible(minutosEntre(transicion.fechaHora, siguiente.fechaHora)) : null,
      abierta: !siguiente,
      usuarioAdmin: transicion.usuarioAdmin ?? null,
    };
  });

  const entregada = ordenadas.some((t) => t.estadoDestino === 'entregada');
  const leadTimeTotalMin =
    ordenadas.length > 1
      ? medible(minutosEntre(ordenadas[0].fechaHora, ordenadas[ordenadas.length - 1].fechaHora))
      : null;

  return {
    etapas,
    transiciones: ordenadas,
    reconstruida,
    leadTimeTotalMin: entregada ? leadTimeTotalMin : null,
    // El tiempo transcurrido sirve para los pedidos en curso, pero se
    // devuelve aparte para que nadie lo promedie junto al lead time real.
    transcurridoMin: leadTimeTotalMin,
    entregada,
  };
}

/** Minutos que el pedido pasó en cada estado, solo de las etapas cerradas.
 *  Si el pedido volvió a un estado (se retrocedió por error y se volvió a
 *  avanzar), los tramos se suman: el tiempo total en esa etapa es lo que
 *  costó la cocina, no el último tramo. Los estados sin medición quedan en
 *  null y no en 0 — la etapa abierta o nunca alcanzada no duró cero. */
function minutosPorEstado(lineaTiempo) {
  const acumulado = Object.fromEntries(FLUJO_ESTADOS.map((estado) => [estado, null]));
  for (const etapa of lineaTiempo?.etapas ?? []) {
    if (etapa.minutos === null) continue;
    acumulado[etapa.estado] = redondear((acumulado[etapa.estado] ?? 0) + etapa.minutos);
  }
  return acumulado;
}

/**
 * Lead time por etapa sobre un conjunto de pedidos + cuello de botella.
 *
 * El cuello de botella se elige por MEDIANA, no por promedio: un solo
 * pedido olvidado toda la noche mueve el promedio de una etapa lo
 * suficiente para señalar la etapa equivocada.
 *
 * @param {object[]} pedidos pedidos con `lineaTiempo`
 */
function leadTimePorEtapa(pedidos) {
  const lista = pedidos ?? [];
  const etapas = FLUJO_ESTADOS.map((estado) => {
    const minutos = lista
      .map((p) => minutosPorEstado(p.lineaTiempo)[estado])
      .filter((m) => Number.isFinite(m));
    return {
      estado,
      etiqueta: ETIQUETAS_ESTADO[estado],
      pedidosMedidos: minutos.length,
      ...descriptivas(minutos),
    };
  });

  const medibles = etapas.filter((e) => e.pedidosMedidos > 0 && e.mediana !== null);
  const cuelloDeBotella =
    medibles.length === 0
      ? null
      : medibles.reduce((peor, e) => (e.mediana > peor.mediana ? e : peor), medibles[0]);

  const totales = lista
    .map((p) => p.lineaTiempo?.leadTimeTotalMin)
    .filter((m) => Number.isFinite(m));

  return {
    etapas,
    total: { pedidosMedidos: totales.length, ...descriptivas(totales) },
    cuelloDeBotella: cuelloDeBotella
      ? {
          estado: cuelloDeBotella.estado,
          etiqueta: cuelloDeBotella.etiqueta,
          medianaMin: cuelloDeBotella.mediana,
          pedidosMedidos: cuelloDeBotella.pedidosMedidos,
        }
      : null,
    // Sin transiciones registradas no hay lead time. Se dice explícito en
    // vez de mostrar 0 min, que se leería como "instantáneo".
    datosInsuficientes: medibles.length === 0,
  };
}

/**
 * Embudo por estado: cuántos pedidos alcanzaron cada etapa del flujo.
 * "Alcanzó" se decide por el historial, no por el estado actual: un pedido
 * entregado pasó por preparada aunque su fila solo diga 'entregada'.
 */
function embudoEstados(pedidos) {
  const lista = pedidos ?? [];
  const total = lista.length;

  const alcanzaron = (estado) =>
    lista.filter(
      (p) =>
        (p.lineaTiempo?.transiciones ?? []).some((t) => t.estadoDestino === estado) ||
        FLUJO_ESTADOS.indexOf(p.estado) >= FLUJO_ESTADOS.indexOf(estado),
    ).length;

  let anterior = null;
  return FLUJO_ESTADOS.map((estado) => {
    const pedidosEstado = alcanzaron(estado);
    const fila = {
      estado,
      etiqueta: ETIQUETAS_ESTADO[estado],
      pedidos: pedidosEstado,
      porcentajeDelTotal: total === 0 ? null : redondear((pedidosEstado / total) * 100),
      // Conversión respecto a la etapa anterior: donde se cae el embudo.
      conversionDesdeAnterior:
        anterior === null || anterior === 0 ? null : redondear((pedidosEstado / anterior) * 100),
      abandonoDesdeAnterior: anterior === null ? null : anterior - pedidosEstado,
    };
    anterior = pedidosEstado;
    return fila;
  });
}

/** Corte por dispositivo del checkout: participación en pedidos y en
 *  dinero. El ticket promedio se separa a propósito — el móvil puede
 *  traer más pedidos y menos plata por pedido. */
function porDispositivo(pedidos) {
  const lista = pedidos ?? [];
  const total = lista.length;
  const ingresosTotales = lista.reduce((s, p) => s + (Number(p.total) || 0), 0);

  return agrupar(
    lista,
    (p) => (DISPOSITIVOS.includes(p.dispositivo) ? p.dispositivo : 'desconocido'),
    (grupo) => {
      const ingresos = grupo.reduce((s, p) => s + (Number(p.total) || 0), 0);
      return {
        etiqueta: ETIQUETAS_DISPOSITIVO[grupo[0].dispositivo] ?? 'Sin dato',
        pedidos: grupo.length,
        porcentajePedidos: total === 0 ? null : redondear((grupo.length / total) * 100),
        ingresos: redondear(ingresos),
        porcentajeIngresos:
          ingresosTotales === 0 ? null : redondear((ingresos / ingresosTotales) * 100),
        ticketPromedio: redondear(ingresos / grupo.length),
      };
    },
  ).sort((a, b) => b.pedidos - a.pedidos);
}

/** Pedidos por hora del día en que se recibieron: la curva que dice a qué
 *  hora conviene tener más gente en el mostrador. */
function porHoraDeIngreso(pedidos) {
  return agrupar(
    pedidos ?? [],
    (p) =>
      typeof p.fechaISO === 'string' && p.fechaISO.length >= 13 ? p.fechaISO.slice(11, 13) : null,
    (grupo) => ({
      pedidos: grupo.length,
      ingresos: redondear(grupo.reduce((s, p) => s + (Number(p.total) || 0), 0)),
      unidades: grupo.reduce((s, p) => s + (Number(p.unidades) || 0), 0),
    }),
  ).sort((a, b) => a.clave.localeCompare(b.clave));
}

/** Mismo corte, pero por hora de retiro pactada: sirve para dotar la
 *  cocina, que trabaja contra la hora de entrega, no la de ingreso. */
function porHoraDeRetiro(pedidos) {
  return agrupar(
    pedidos ?? [],
    (p) =>
      typeof p.retiro === 'string' && /^\d{1,2}:\d{2}$/.test(p.retiro)
        ? p.retiro.padStart(5, '0').slice(0, 2)
        : null,
    (grupo) => ({
      pedidos: grupo.length,
      unidades: grupo.reduce((s, p) => s + (Number(p.unidades) || 0), 0),
    }),
  ).sort((a, b) => a.clave.localeCompare(b.clave));
}

/* ═══════════════════════════════════════════
   VALIDACIÓN DE DATOS
   ═══════════════════════════════════════════
   Mismo criterio que lotesAnalitica.js: reglas de coherencia sobre el
   pedido ya armado, sin corregir nada. Un pedido "entregada" sin ninguna
   transición registrada no se arregla inventando horas: se reporta, para
   que el lead time que sale de la vista sea el medido y no el supuesto. */

const REGLAS_PEDIDO = Object.freeze([
  {
    codigo: 'sin_historial',
    severidad: 'alta',
    mensaje:
      'Pedido sin transiciones registradas: no aporta lead time (probablemente anterior al historial de estados).',
    evaluar: (p) => (p.lineaTiempo?.transiciones ?? []).length === 0,
  },
  {
    codigo: 'estado_incoherente',
    severidad: 'alta',
    mensaje: 'El estado guardado del pedido no coincide con la última transición registrada.',
    evaluar: (p) => {
      const transiciones = p.lineaTiempo?.transiciones ?? [];
      if (transiciones.length === 0) return false;
      return transiciones[transiciones.length - 1].estadoDestino !== p.estado;
    },
  },
  {
    codigo: 'etapa_saltada',
    severidad: 'media',
    mensaje:
      'El pedido saltó etapas del flujo (por ejemplo de "Recibida" a "Entregada"): las etapas salteadas no tienen tiempo medible.',
    evaluar: (p) => {
      const destinos = (p.lineaTiempo?.transiciones ?? []).map((t) => t.estadoDestino);
      return destinos.some((estado, i) => {
        if (i === 0) return false;
        return FLUJO_ESTADOS.indexOf(estado) - FLUJO_ESTADOS.indexOf(destinos[i - 1]) > 1;
      });
    },
  },
  {
    codigo: 'retroceso_estado',
    severidad: 'media',
    mensaje: 'El pedido volvió a un estado anterior: revisar si fue una corrección manual.',
    evaluar: (p) => {
      const destinos = (p.lineaTiempo?.transiciones ?? []).map((t) => t.estadoDestino);
      return destinos.some(
        (estado, i) =>
          i > 0 && FLUJO_ESTADOS.indexOf(estado) < FLUJO_ESTADOS.indexOf(destinos[i - 1]),
      );
    },
  },
  {
    codigo: 'historial_reconstruido',
    severidad: 'media',
    mensaje:
      'El historial se reconstruyó al migrar la base: solo consta cuándo entró y cuándo terminó, así que sus etapas no tienen tiempo medible.',
    evaluar: (p) => p.lineaTiempo?.reconstruida === true,
  },
  {
    codigo: 'etapa_instantanea',
    severidad: 'baja',
    mensaje:
      'Alguna etapa duró menos de un minuto: suele ser el panel puesto al día de golpe, no la etapa real.',
    evaluar: (p) =>
      (p.lineaTiempo?.etapas ?? []).some(
        (e) => e.minutos !== null && e.minutos < MIN_MINUTOS_ETAPA_CREIBLE,
      ),
  },
  {
    codigo: 'etapa_muy_larga',
    severidad: 'baja',
    mensaje: `Alguna etapa duró más de ${MAX_HORAS_ETAPA_CREIBLE} h: el cambio de estado probablemente se registró tarde.`,
    evaluar: (p) =>
      (p.lineaTiempo?.etapas ?? []).some(
        (e) => e.minutos !== null && e.minutos > MAX_HORAS_ETAPA_CREIBLE * 60,
      ),
  },
  {
    codigo: 'sin_operario',
    severidad: 'baja',
    mensaje: 'Transiciones sin operario identificado: no se puede atribuir quién movió el pedido.',
    evaluar: (p) =>
      (p.lineaTiempo?.transiciones ?? []).some((t) => t.estadoOrigen !== null && !t.usuarioAdmin),
  },
  {
    codigo: 'sin_dispositivo',
    severidad: 'baja',
    mensaje: 'Pedido sin metadatos de checkout: no cuenta para el análisis móvil vs. escritorio.',
    evaluar: (p) => !p.dispositivo || p.dispositivo === 'desconocido',
  },
]);

const CAMPOS_PEDIDO = Object.freeze([
  { campo: 'estado', etiqueta: 'Estado actual', severidad: 'alta' },
  { campo: 'primeraTransicionIso', etiqueta: 'Historial de estados', severidad: 'alta' },
  { campo: 'retiro', etiqueta: 'Hora de retiro', severidad: 'media' },
  { campo: 'dispositivo', etiqueta: 'Dispositivo del checkout', severidad: 'media' },
  { campo: 'zonaHoraria', etiqueta: 'Zona horaria del cliente', severidad: 'baja' },
  { campo: 'idioma', etiqueta: 'Idioma del navegador', severidad: 'baja' },
  { campo: 'operarios', etiqueta: 'Operario que movió el pedido', severidad: 'baja' },
]);

/** Corre las reglas contra un pedido ya armado (ver pedidos.js). */
function validarPedido(pedido) {
  return REGLAS_PEDIDO.filter((regla) => regla.evaluar(pedido)).map(
    ({ codigo, severidad, mensaje }) => ({ codigo, severidad, mensaje }),
  );
}

/** Un hallazgo por pedido con problemas más el conteo por severidad y por
 *  regla, para encabezar la vista. */
function validarPedidos(pedidos) {
  const hallazgos = [];
  const porRegla = new Map();
  const porSeveridad = { alta: 0, media: 0, baja: 0 };

  for (const pedido of pedidos ?? []) {
    const problemas = validarPedido(pedido);
    if (problemas.length === 0) continue;
    hallazgos.push({
      numero: pedido.numero,
      cliente: pedido.cliente,
      fecha: pedido.fecha,
      estado: pedido.estado,
      problemas,
    });
    for (const { codigo, severidad } of problemas) {
      porRegla.set(codigo, (porRegla.get(codigo) ?? 0) + 1);
      porSeveridad[severidad] += 1;
    }
  }

  const totalPedidos = (pedidos ?? []).length;
  return {
    totalPedidos,
    pedidosConHallazgos: hallazgos.length,
    porcentajeSano:
      totalPedidos === 0
        ? 100
        : redondear(((totalPedidos - hallazgos.length) / totalPedidos) * 100),
    porSeveridad,
    porRegla: [...porRegla.entries()]
      .map(([codigo, total]) => {
        const regla = REGLAS_PEDIDO.find((r) => r.codigo === codigo);
        return {
          codigo,
          total,
          mensaje: regla?.mensaje ?? codigo,
          severidad: regla?.severidad ?? 'baja',
        };
      })
      .sort((a, b) => b.total - a.total),
    hallazgos,
  };
}

/** Completitud por campo sobre los pedidos del período. */
function completitudPedidos(pedidos) {
  const filas = pedidos ?? [];
  const total = filas.length;
  return CAMPOS_PEDIDO.map(({ campo, etiqueta, severidad }) => {
    const llenos = filas.filter((p) => {
      const valor = p[campo];
      if (Array.isArray(valor)) return valor.length > 0;
      // 'desconocido' es la ausencia de dato con otro nombre: contarlo como
      // lleno daría 100% de completitud sobre pedidos sin metadatos.
      if (campo === 'dispositivo') return valor && valor !== 'desconocido';
      return valor !== null && valor !== undefined && valor !== '';
    }).length;
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
  FLUJO_ESTADOS,
  ETIQUETAS_ESTADO,
  DISPOSITIVOS,
  ETIQUETAS_DISPOSITIVO,
  MIN_MINUTOS_ETAPA_CREIBLE,
  MAX_HORAS_ETAPA_CREIBLE,
  REGLAS_PEDIDO,
  CAMPOS_PEDIDO,
  minutosEntre,
  clasificarDispositivo,
  construirLineaTiempo,
  minutosPorEstado,
  leadTimePorEtapa,
  embudoEstados,
  porDispositivo,
  porHoraDeIngreso,
  porHoraDeRetiro,
  validarPedido,
  validarPedidos,
  completitudPedidos,
  // Reexportadas para que pedidos.js y las pruebas no tengan que conocer
  // lotesAnalitica.js: la aritmética general vive allá, no duplicada acá.
  descriptivas,
  histograma,
  outliersIQR,
  mediaMovil,
  tendenciaSerie,
  compararVentanas,
  agrupar,
  redondear,
};

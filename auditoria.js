/**
 * PANADERÍA LUZ MARINA — Backend: Auditoria (cadena de hashes)
 *
 * Registro append-only donde cada bloque incluye sha256(bloque_anterior +
 * contenido_de_este_bloque). Con eso, si alguien edita un bloque viejo
 * directamente en la base de datos (fuera de la API — la API nunca hace
 * UPDATE ni DELETE sobre esta tabla), el hash de ese bloque deja de
 * coincidir con lo que el bloque siguiente tiene guardado como
 * hash_anterior, y verificarCadena() lo detecta recorriendo todo desde
 * el principio.
 *
 * Aclaración honesta: esto NO es una blockchain distribuida (no hay red,
 * no hay nodos, no hay consenso — es una tabla más en la misma base de
 * datos SQLite del proyecto). Es la técnica que la hace posible (hash
 * chain) aplicada a un solo servidor, que es lo que de verdad resuelve
 * "que nadie pueda alterar el historial sin que se note".
 */

const crypto = require('crypto');
const db = require('./db');
const Analitica = require('./auditoriaAnalitica');

const HASH_GENESIS = 'GENESIS';

/**
 * sha256 determinístico del bloque: mismo contenido + mismo hash
 * anterior siempre da el mismo hash.
 */
function calcularHash(hashAnterior, bloque) {
  const contenido = JSON.stringify({
    hashAnterior,
    entidad: bloque.entidad,
    entidadId: bloque.entidadId,
    accion: bloque.accion,
    datos: bloque.datos,
    actualizadoPor: bloque.actualizadoPor,
    creadoEn: bloque.creadoEn,
  });
  return crypto.createHash('sha256').update(contenido).digest('hex');
}

/**
 * Agrega un bloque a la cadena. Sincrónico a propósito (igual que el
 * resto del proyecto con better-sqlite3): leer el último hash e
 * insertar el nuevo bloque sin ningún `await` en el medio evita que dos
 * peticiones concurrentes intercalen sus lecturas y generen una
 * bifurcación en la cadena — Node es de un solo hilo, y mientras no haya
 * un punto de suspensión entre el SELECT y el INSERT, esta función
 * corre de principio a fin sin interrupciones.
 * @param {{entidad: string, entidadId: string|number, accion: 'crear'|'actualizar'|'eliminar', datos: object, actualizadoPor?: string|null}} bloque
 * @returns {string} el hash del bloque recién insertado
 */
function registrarEnCadena({ entidad, entidadId, accion, datos, actualizadoPor = null }) {
  const ultimo = db.prepare('SELECT hash FROM auditoria_cadena ORDER BY id DESC LIMIT 1').get();
  const hashAnterior = ultimo ? ultimo.hash : HASH_GENESIS;
  const creadoEn = new Date().toISOString();

  const contenidoBloque = {
    entidad,
    entidadId: String(entidadId),
    accion,
    datos,
    actualizadoPor,
    creadoEn,
  };
  const hash = calcularHash(hashAnterior, contenidoBloque);

  db.prepare(
    `INSERT INTO auditoria_cadena
       (entidad, entidad_id, accion, datos, actualizado_por, hash_anterior, hash, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entidad,
    contenidoBloque.entidadId,
    accion,
    JSON.stringify(datos),
    actualizadoPor,
    hashAnterior,
    hash,
    creadoEn,
  );

  return hash;
}

/**
 * Recorre toda la cadena desde el primer bloque y recalcula cada hash a
 * partir de su contenido guardado, comparándolo con el hash almacenado.
 * En cuanto uno no coincide (o el hash_anterior de un bloque no es el
 * hash real del bloque previo), la cadena está rota desde ahí en
 * adelante — no hace falta seguir revisando el resto.
 * @returns {{integra: true, totalBloques: number} | {integra: false, rotoEnId: number, motivo: string}}
 */
function verificarCadena() {
  const bloques = db.prepare('SELECT * FROM auditoria_cadena ORDER BY id ASC').all();

  let hashAnterior = HASH_GENESIS;
  for (const bloque of bloques) {
    if (bloque.hash_anterior !== hashAnterior) {
      return {
        integra: false,
        rotoEnId: bloque.id,
        motivo: 'El hash_anterior de este bloque no coincide con el hash real del bloque previo.',
      };
    }

    let datos;
    try {
      datos = JSON.parse(bloque.datos);
    } catch {
      return {
        integra: false,
        rotoEnId: bloque.id,
        motivo: 'El campo datos de este bloque no es JSON válido — fue alterado.',
      };
    }

    const hashCalculado = calcularHash(hashAnterior, {
      entidad: bloque.entidad,
      entidadId: bloque.entidad_id,
      accion: bloque.accion,
      datos,
      actualizadoPor: bloque.actualizado_por,
      creadoEn: bloque.creado_en,
    });

    if (hashCalculado !== bloque.hash) {
      return {
        integra: false,
        rotoEnId: bloque.id,
        motivo: 'El contenido de este bloque no coincide con su hash guardado — fue alterado.',
      };
    }

    hashAnterior = bloque.hash;
  }

  return { integra: true, totalBloques: bloques.length };
}

/** Historial de una entidad puntual (ej. todos los bloques de un
 *  producto), más reciente primero — para mostrar "qué cambió y cuándo"
 *  en el panel. */
function historialDe(entidad, entidadId) {
  return db
    .prepare('SELECT * FROM auditoria_cadena WHERE entidad = ? AND entidad_id = ? ORDER BY id DESC')
    .all(entidad, String(entidadId));
}

/** Inspecciona, agrupa y modela la cadena para representarla
 *  visualmente (Patrón "Análisis de Blockchain" — GET /auditoria/analisis):
 *  cuántos bloques hay por entidad y por tipo de acción, cómo se
 *  distribuye la actividad en el tiempo, y qué registros puntuales
 *  concentran más cambios (candidatos a revisar si algo se ve raro).
 *
 *  Además de esos agregados (que ya existían), agrega el pipeline de
 *  AED/procesamiento/visualización de auditoriaAnalitica.js: perfilado de
 *  la tabla, descriptivas+histograma de dos variables derivadas
 *  (intervalo entre bloques, tamaño del payload), bloques atípicos por
 *  esas variables, la tabla de contingencia entidad×acción con su prueba
 *  de independencia, y los datos de dispersión listos para graficar (ver
 *  la nota "cuarteto de Anscombe" en ese archivo sobre por qué un agregado
 *  no basta). */
function analizarCadena() {
  const porEntidad = db
    .prepare(
      'SELECT entidad, COUNT(*) AS total FROM auditoria_cadena GROUP BY entidad ORDER BY total DESC',
    )
    .all();

  const porAccion = db
    .prepare(
      'SELECT accion, COUNT(*) AS total FROM auditoria_cadena GROUP BY accion ORDER BY total DESC',
    )
    .all();

  // substr(creado_en, 1, 10): creado_en es ISO completo ('2026-08-05T10:00:00.000Z'),
  // los primeros 10 caracteres son la fecha — agrupar por eso arma la
  // línea de tiempo sin tocar la hora exacta.
  const actividadPorDia = db
    .prepare(
      `SELECT substr(creado_en, 1, 10) AS fecha, COUNT(*) AS total
       FROM auditoria_cadena
       GROUP BY fecha
       ORDER BY fecha ASC`,
    )
    .all();

  const entidadesMasModificadas = db
    .prepare(
      `SELECT entidad, entidad_id AS entidadId, COUNT(*) AS total
       FROM auditoria_cadena
       GROUP BY entidad, entidad_id
       ORDER BY total DESC
       LIMIT 10`,
    )
    .all();

  const bloques = db.prepare('SELECT * FROM auditoria_cadena ORDER BY id ASC').all();
  const variablesNumericas = Analitica.construirVariablesNumericas(bloques);

  return {
    integridad: verificarCadena(),
    porEntidad,
    porAccion,
    actividadPorDia,
    entidadesMasModificadas,
    perfilado: Analitica.perfilarCadena(bloques),
    eda: Analitica.analizarNumericas(variablesNumericas),
    atipicos: Analitica.detectarBloquesAtipicos(variablesNumericas),
    matrizEntidadAccion: Analitica.matrizEntidadAccion(bloques),
    dispersion: Analitica.prepararDispersion(variablesNumericas),
  };
}

module.exports = {
  HASH_GENESIS,
  calcularHash,
  registrarEnCadena,
  verificarCadena,
  historialDe,
  analizarCadena,
};

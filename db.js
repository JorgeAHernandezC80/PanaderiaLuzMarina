/**
 * PANADERÍA LUZ MARINA — Backend: Base de datos
 * better-sqlite3: API síncrona, mejor compatibilidad con entornos Linux (Render).
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'luzmarina.db');

let db;
try {
  db = new Database(DB_PATH);

  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ordenes (
      numero      TEXT PRIMARY KEY,
      fecha_iso   TEXT NOT NULL,
      fecha_texto TEXT NOT NULL,
      cliente     TEXT NOT NULL,
      telefono    TEXT NOT NULL,
      retiro      TEXT NOT NULL,
      items_json  TEXT NOT NULL,
      total       REAL NOT NULL,
      estado      TEXT NOT NULL DEFAULT 'pendiente',
      creado_en   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_ordenes_fecha ON ordenes(fecha_iso)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ordenes_estado ON ordenes(estado)');
} catch (err) {
  /* Sin base de datos no hay backend: fallar de forma ruidosa y con contexto,
     en lugar de dejar que un error opaco tumbe el arranque. */
  console.error(`[db] No se pudo inicializar la base de datos en ${DB_PATH}:`, err.message);
  throw err;
}

module.exports = db;

/**
 * PANADERÍA LUZ MARINA — Backend: Base de datos
 * SQLite3, una sola tabla con items serializados como JSON.
 * (Si en el futuro se necesita reportería por producto, se separa
 *  orden_items en su propia tabla — para el panel admin de Sprint 1
 *  esto es suficiente y evita JOINs innecesarios.)
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, 'luzmarina.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[db] Error al abrir la base de datos:', err.message);
    process.exit(1);
  }
});

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
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

  db.run('CREATE INDEX IF NOT EXISTS idx_ordenes_fecha ON ordenes(fecha_iso)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ordenes_estado ON ordenes(estado)');
});

module.exports = db;

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS insumos (
      id             TEXT PRIMARY KEY,
      nombre         TEXT NOT NULL,
      categoria      TEXT NOT NULL DEFAULT 'otros',
      cantidad       REAL NOT NULL,
      unidad         TEXT NOT NULL,
      costo_unitario REAL,
      stock_minimo   REAL,
      proveedor      TEXT,
      notas          TEXT,
      creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_insumos_nombre ON insumos(nombre)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id                     TEXT PRIMARY KEY,
      nombre_legal           TEXT NOT NULL,
      nombre_comercial       TEXT,
      identificacion_fiscal  TEXT,
      giro_comercial         TEXT,
      direccion              TEXT,
      contacto_nombre        TEXT,
      contacto_cargo         TEXT,
      email_general          TEXT,
      email_contacto         TEXT,
      telefono_empresa       TEXT,
      telefono_celular       TEXT,
      banco                  TEXT,
      numero_cuenta          TEXT,
      clabe_iban             TEXT,
      condiciones_pago       TEXT,
      moneda                 TEXT,
      metodo_facturacion     TEXT,
      lead_time_dias         REAL,
      pedido_minimo          REAL,
      politicas_devolucion   TEXT,
      certificaciones        TEXT,
      notas                  TEXT,
      creado_en              TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en         TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_proveedores_nombre ON proveedores(nombre_comercial, nombre_legal)',
  );
} catch (err) {
  /* Sin base de datos no hay backend: fallar de forma ruidosa y con contexto,
     en lugar de dejar que un error opaco tumbe el arranque. */
  console.error(`[db] No se pudo inicializar la base de datos en ${DB_PATH}:`, err.message);
  throw err;
}

module.exports = db;

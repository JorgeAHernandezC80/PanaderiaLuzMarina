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

  /* Migración: la tabla proveedores pudo haber sido creada por una
     implementación anterior con la columna nombre_legal. CREATE TABLE
     IF NOT EXISTS no toca una tabla que ya existe, así que si detectamos
     el esquema viejo la renombramos a un respaldo, dejamos que se cree
     la tabla nueva más abajo, y luego copiamos los datos preservando
     cualquier proveedor ya guardado. */
  const proveedoresInfo = db.prepare('PRAGMA table_info(proveedores)').all();
  const proveedoresColumnas = proveedoresInfo.map((c) => c.name);
  const proveedoresEsquemaViejo =
    proveedoresColumnas.includes('nombre_legal') && !proveedoresColumnas.includes('razon_social');

  if (proveedoresEsquemaViejo) {
    console.log(
      '[db] Migrando tabla proveedores del esquema antiguo (nombre_legal) al nuevo (razon_social)...',
    );
    db.exec('ALTER TABLE proveedores RENAME TO proveedores_legacy_backup');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id                     TEXT PRIMARY KEY,
      razon_social           TEXT NOT NULL,
      nombre_comercial       TEXT,
      identificacion_fiscal  TEXT,
      giro_comercial         TEXT,
      direccion              TEXT,
      codigo_postal          TEXT,
      ciudad                 TEXT,
      pais                   TEXT,
      contacto_nombre        TEXT,
      email_facturacion      TEXT,
      email_contacto         TEXT,
      telefono_fijo          TEXT,
      celular                TEXT,
      banco                  TEXT,
      numero_cuenta          TEXT,
      clabe_iban             TEXT,
      condiciones_pago       TEXT NOT NULL DEFAULT 'contado',
      moneda                 TEXT NOT NULL DEFAULT 'COP',
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

  db.exec('CREATE INDEX IF NOT EXISTS idx_proveedores_razon ON proveedores(razon_social)');

  if (proveedoresEsquemaViejo) {
    db.exec(`
      INSERT INTO proveedores (
        id, razon_social, nombre_comercial, identificacion_fiscal, giro_comercial,
        direccion, contacto_nombre, email_facturacion, email_contacto,
        telefono_fijo, celular, banco, numero_cuenta, clabe_iban,
        condiciones_pago, moneda, metodo_facturacion, lead_time_dias,
        pedido_minimo, politicas_devolucion, certificaciones, notas,
        creado_en, actualizado_en
      )
      SELECT
        id, nombre_legal, nombre_comercial, identificacion_fiscal, giro_comercial,
        direccion, contacto_nombre, email_general, email_contacto,
        telefono_empresa, telefono_celular, banco, numero_cuenta, clabe_iban,
        COALESCE(NULLIF(condiciones_pago, ''), 'contado'),
        COALESCE(NULLIF(moneda, ''), 'COP'),
        metodo_facturacion, lead_time_dias, pedido_minimo, politicas_devolucion,
        certificaciones, notas, creado_en, actualizado_en
      FROM proveedores_legacy_backup
    `);
    console.log(
      '[db] Migración completada. Respaldo conservado en la tabla proveedores_legacy_backup.',
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS horneadas (
      id               TEXT PRIMARY KEY,
      producto_id      TEXT NOT NULL,
      producto_nombre  TEXT NOT NULL,
      cantidad         INTEGER NOT NULL,
      fecha            TEXT NOT NULL,
      hora             TEXT NOT NULL,
      registrado_por   TEXT,
      notas            TEXT,
      creado_en        TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_horneadas_fecha ON horneadas(fecha)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_horneadas_producto ON horneadas(producto_id)');

  /* Ajustes de inventario: mermas, errores de conteo, consumo interno, etc.
     Se restan del disponible junto con lo preparado/vendido del día. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS ajustes_inventario (
      id               TEXT PRIMARY KEY,
      producto_id      TEXT NOT NULL,
      producto_nombre  TEXT NOT NULL,
      cantidad         INTEGER NOT NULL,
      motivo           TEXT NOT NULL DEFAULT 'merma',
      fecha            TEXT NOT NULL,
      hora             TEXT NOT NULL,
      registrado_por   TEXT,
      notas            TEXT,
      creado_en        TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_ajustes_inventario_fecha ON ajustes_inventario(fecha)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_ajustes_inventario_producto ON ajustes_inventario(producto_id)',
  );

  /* Stock mínimo configurable por producto, para las alertas de "quiebre de
     stock" en la pestaña Inventario. Una fila por producto; si no existe,
     el backend aplica un default razonable al calcular el inventario. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS producto_stock_minimo (
      producto_id     TEXT PRIMARY KEY,
      stock_minimo    INTEGER NOT NULL DEFAULT 5,
      actualizado_en  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch (err) {
  /* Sin base de datos no hay backend: fallar de forma ruidosa y con contexto,
     en lugar de dejar que un error opaco tumbe el arranque. */
  console.error(`[db] No se pudo inicializar la base de datos en ${DB_PATH}:`, err.message);
  throw err;
}

module.exports = db;

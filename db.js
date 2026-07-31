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

  /* Migración: si la tabla insumos ya existía de una versión anterior (por
     ejemplo, tu base de datos local mientras probabas el panel), le pueden
     faltar columnas agregadas después. A diferencia de proveedores (una
     columna renombrada), aquí solo se agregan columnas nuevas —
     ALTER TABLE ADD COLUMN es seguro y nunca toca los datos existentes. */
  const insumosExiste = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'insumos'")
    .get();
  if (insumosExiste) {
    const columnasActuales = db
      .prepare('PRAGMA table_info(insumos)')
      .all()
      .map((c) => c.name);
    const columnasNuevas = {
      marca: 'TEXT',
      fecha_vencimiento: 'TEXT',
      ubicacion: 'TEXT',
      sku: 'TEXT',
      stock_maximo: 'REAL',
      presentacion_compra: 'TEXT',
      condiciones_almacenamiento: 'TEXT',
      lote_proveedor: 'TEXT',
      vida_util_abierto_dias: 'INTEGER',
      proveedor_secundario: 'TEXT',
      lead_time_dias: 'INTEGER',
      impuesto_porcentaje: 'REAL',
      alergenos: 'TEXT',
      equivalencia_gramos: 'REAL',
    };
    for (const [columna, tipo] of Object.entries(columnasNuevas)) {
      if (!columnasActuales.includes(columna)) {
        console.log(`[db] Agregando columna insumos.${columna} (migración)...`);
        db.exec(`ALTER TABLE insumos ADD COLUMN ${columna} ${tipo}`);
      }
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS insumos (
      id                          TEXT PRIMARY KEY,
      nombre                      TEXT NOT NULL,
      categoria                   TEXT NOT NULL DEFAULT 'otros',
      cantidad                    REAL NOT NULL,
      unidad                      TEXT NOT NULL,
      costo_unitario              REAL,
      stock_minimo                REAL,
      stock_maximo                REAL,
      proveedor                   TEXT,
      proveedor_secundario        TEXT,
      marca                       TEXT,
      sku                         TEXT,
      fecha_vencimiento           TEXT,
      ubicacion                   TEXT,
      presentacion_compra         TEXT,
      condiciones_almacenamiento  TEXT,
      lote_proveedor              TEXT,
      vida_util_abierto_dias      INTEGER,
      lead_time_dias              INTEGER,
      impuesto_porcentaje         REAL,
      alergenos                   TEXT,
      equivalencia_gramos         REAL,
      notas                       TEXT,
      creado_en                   TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en              TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_insumos_nombre ON insumos(nombre)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_insumos_fecha_vencimiento ON insumos(fecha_vencimiento)');

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
      produccion_id    TEXT,
      creado_en        TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_horneadas_fecha ON horneadas(fecha)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_horneadas_producto ON horneadas(producto_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_horneadas_produccion ON horneadas(produccion_id)');

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

  /* ═══════════════════════════════════════════
     RECETAS — ficha técnica por producto: qué ingredientes lleva, en qué
     proporción, y cuánto pesa cada unidad. Es la base de la que depende
     Producción (no registra nada del día a día por sí sola).
     ═══════════════════════════════════════════ */
  db.exec(`
    CREATE TABLE IF NOT EXISTS recetas (
      id                       TEXT PRIMARY KEY,
      producto_id              TEXT NOT NULL UNIQUE,
      producto_nombre          TEXT NOT NULL,
      peso_masa_por_unidad_g   REAL NOT NULL,
      tiempo_fermentacion_min  INTEGER,
      notas                    TEXT,
      creado_en                TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  /* Ingredientes de una receta, referenciando el catálogo de Insumos por id
     (no por texto libre) para que el costo y las unidades siempre crucen
     bien — el mismo problema que ya resolvimos entre órdenes y catálogo. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS receta_ingredientes (
      id                    TEXT PRIMARY KEY,
      receta_id             TEXT NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
      insumo_id             TEXT NOT NULL,
      insumo_nombre         TEXT NOT NULL,
      gramos                 REAL NOT NULL,
      orden                 INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_receta_ingredientes_receta ON receta_ingredientes(receta_id)',
  );

  /* ═══════════════════════════════════════════
     PRODUCCIÓN — una tanda de masa: desde que se pesan los ingredientes
     hasta que queda lista para hornear (etapas 1-8). La etapa 9 (horneado)
     ya la cubre la tabla horneadas, ligada por produccion_id.
     ═══════════════════════════════════════════ */
  db.exec(`
    CREATE TABLE IF NOT EXISTS producciones (
      id                    TEXT PRIMARY KEY,
      producto_id           TEXT NOT NULL,
      producto_nombre       TEXT NOT NULL,
      receta_id             TEXT REFERENCES recetas(id),
      fecha                 TEXT NOT NULL,
      hora_inicio            TEXT NOT NULL,
      peso_total_masa_g     REAL NOT NULL,
      unidades_estimadas    INTEGER NOT NULL,
      registrado_por        TEXT,
      notas                 TEXT,
      creado_en             TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en        TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_producciones_fecha ON producciones(fecha)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_producciones_producto ON producciones(producto_id)');

  /* Gramos reales usados en ESA tanda (pueden diferir de la receta base:
     la ejecución diaria es libre aunque la fórmula sea fija). */
  db.exec(`
    CREATE TABLE IF NOT EXISTS produccion_ingredientes (
      id             TEXT PRIMARY KEY,
      produccion_id  TEXT NOT NULL REFERENCES producciones(id) ON DELETE CASCADE,
      insumo_id      TEXT NOT NULL,
      insumo_nombre  TEXT NOT NULL,
      gramos         REAL NOT NULL
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_produccion_ingredientes_produccion ON produccion_ingredientes(produccion_id)',
  );

  /* Las 8 etapas del proceso (pesado → segunda fermentación), cada una con
     hora de inicio y, cuando termina, hora de fin. Una fila por etapa por
     producción — se van creando/actualizando a medida que el panadero
     avanza, no todas de una vez. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS produccion_etapas (
      id             TEXT PRIMARY KEY,
      produccion_id  TEXT NOT NULL REFERENCES producciones(id) ON DELETE CASCADE,
      etapa          TEXT NOT NULL,
      hora_inicio    TEXT NOT NULL,
      hora_fin       TEXT,
      notas          TEXT
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_produccion_etapas_produccion ON produccion_etapas(produccion_id)',
  );
} catch (err) {
  /* Sin base de datos no hay backend: fallar de forma ruidosa y con contexto,
     en lugar de dejar que un error opaco tumbe el arranque. */
  console.error(`[db] No se pudo inicializar la base de datos en ${DB_PATH}:`, err.message);
  throw err;
}

module.exports = db;

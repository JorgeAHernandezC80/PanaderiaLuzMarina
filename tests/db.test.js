/**
 * @jest-environment node
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

function tmpDbPath(suffix) {
  return path.join(
    os.tmpdir(),
    `plm-db-test-${suffix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanup(dbPath) {
  for (const ext of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + ext);
    } catch {
      /* ignore */
    }
  }
}

describe('db.js — inicialización del esquema', () => {
  let dbPath;

  afterEach(() => {
    delete process.env.DB_PATH;
    if (dbPath) cleanup(dbPath);
    dbPath = undefined;
    jest.restoreAllMocks();
  });

  test('crea todas las tablas e índices esperados en una base de datos nueva', () => {
    dbPath = tmpDbPath('fresh');
    process.env.DB_PATH = dbPath;
    jest.resetModules();

    const db = require('../db');

    const tablas = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);

    expect(tablas).toEqual(
      expect.arrayContaining(['ordenes', 'insumos', 'proveedores', 'horneadas']),
    );
    // Sin esquema viejo que migrar, no debe crearse el respaldo.
    expect(tablas).not.toContain('proveedores_legacy_backup');

    const indices = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => r.name);
    expect(indices).toEqual(
      expect.arrayContaining([
        'idx_ordenes_fecha',
        'idx_ordenes_estado',
        'idx_insumos_nombre',
        'idx_proveedores_razon',
        'idx_horneadas_fecha',
        'idx_horneadas_producto',
      ]),
    );

    db.close();
  });

  test('migra la tabla proveedores del esquema antiguo (nombre_legal) preservando los datos', () => {
    dbPath = tmpDbPath('legacy');

    // Pre-sembramos proveedores con el esquema viejo antes de que db.js la
    // vea por primera vez, simulando un despliegue existente.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE proveedores (
        id TEXT PRIMARY KEY,
        nombre_legal TEXT,
        nombre_comercial TEXT,
        identificacion_fiscal TEXT,
        giro_comercial TEXT,
        direccion TEXT,
        contacto_nombre TEXT,
        email_general TEXT,
        email_contacto TEXT,
        telefono_empresa TEXT,
        telefono_celular TEXT,
        banco TEXT,
        numero_cuenta TEXT,
        clabe_iban TEXT,
        condiciones_pago TEXT,
        moneda TEXT,
        metodo_facturacion TEXT,
        lead_time_dias REAL,
        pedido_minimo REAL,
        politicas_devolucion TEXT,
        certificaciones TEXT,
        notas TEXT,
        creado_en TEXT,
        actualizado_en TEXT
      )
    `);
    seed
      .prepare(
        `INSERT INTO proveedores (id, nombre_legal, nombre_comercial, creado_en, actualizado_en)
         VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run('prov-legacy-1', 'Molinos Antiguos S.A.', 'Molinos Antiguos');
    seed.close();

    process.env.DB_PATH = dbPath;
    jest.resetModules();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const db = require('../db');

    // El esquema nuevo quedó activo, con razon_social en vez de nombre_legal.
    const columnas = db
      .prepare('PRAGMA table_info(proveedores)')
      .all()
      .map((c) => c.name);
    expect(columnas).toContain('razon_social');
    expect(columnas).not.toContain('nombre_legal');

    // El respaldo del esquema viejo se conservó con su nombre esperado.
    const backup = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'proveedores_legacy_backup'",
      )
      .all();
    expect(backup).toHaveLength(1);

    // El proveedor existente se migró con sus datos intactos.
    const migrado = db.prepare('SELECT * FROM proveedores WHERE id = ?').get('prov-legacy-1');
    expect(migrado.razon_social).toBe('Molinos Antiguos S.A.');
    expect(migrado.nombre_comercial).toBe('Molinos Antiguos');
    expect(migrado.condiciones_pago).toBe('contado'); // default aplicado por COALESCE/NULLIF

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Migrando tabla proveedores'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Migración completada'));

    db.close();
  });

  test('lanza un error con contexto si no puede inicializar la base de datos', () => {
    // Directorio padre inexistente: better-sqlite3 no puede crear el archivo ahí.
    dbPath = path.join(os.tmpdir(), `plm-db-test-noexiste-${Date.now()}`, 'sub', 'luzmarina.db');
    process.env.DB_PATH = dbPath;
    jest.resetModules();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => require('../db')).toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('No se pudo inicializar la base de datos'),
      expect.any(String),
    );

    // La ruta nunca llegó a crearse: nada que limpiar.
    dbPath = undefined;
  });
});

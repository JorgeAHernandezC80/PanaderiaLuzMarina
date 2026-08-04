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

  test('siembra los 9 productos históricos con sus ids y precios originales', () => {
    dbPath = tmpDbPath('productos-seed');
    process.env.DB_PATH = dbPath;
    jest.resetModules();

    const db = require('../db');

    // Ids y precios tienen que ser los mismos que ya usaban catalogo.html y
    // los productoId guardados en órdenes/horneadas/recetas: si cambian, se
    // rompe la trazabilidad de todo lo que ya está en la base de datos.
    const productos = db
      .prepare('SELECT id, nombre, precio, estado FROM productos ORDER BY id')
      .all();
    expect(productos).toEqual([
      { id: 1, nombre: 'Donuts Glaseadas', precio: 1.5, estado: 'activo' },
      { id: 2, nombre: 'Buñuelos', precio: 2.5, estado: 'activo' },
      { id: 3, nombre: 'Roscón de Arequipe', precio: 2.5, estado: 'activo' },
      { id: 4, nombre: 'Croissant', precio: 2, estado: 'activo' },
      { id: 5, nombre: 'Almojábanas', precio: 2.5, estado: 'activo' },
      { id: 6, nombre: 'Pandebono', precio: 2.5, estado: 'activo' },
      { id: 7, nombre: 'Pan de Yuca', precio: 2.5, estado: 'activo' },
      { id: 8, nombre: 'Conchas', precio: 1.75, estado: 'activo' },
      { id: 9, nombre: 'Pan mariquiteño', precio: 2.5, estado: 'activo' },
    ]);

    db.close();
  });

  test('no vuelve a sembrar ni pisa los productos editados en un arranque posterior', () => {
    dbPath = tmpDbPath('productos-reseed');
    process.env.DB_PATH = dbPath;

    jest.resetModules();
    const primera = require('../db');
    primera.prepare("UPDATE productos SET precio = 9.99, estado = 'agotado' WHERE id = 6").run();
    primera.prepare('DELETE FROM productos WHERE id = 9').run();
    primera.close();

    jest.resetModules();
    const segunda = require('../db');

    const pandebono = segunda.prepare('SELECT precio, estado FROM productos WHERE id = 6').get();
    expect(pandebono).toEqual({ precio: 9.99, estado: 'agotado' });
    // El seed usa INSERT OR IGNORE, así que un producto borrado a propósito
    // sí vuelve a aparecer — es el precio de no perder los ids históricos.
    expect(segunda.prepare('SELECT id FROM productos WHERE id = 9').get()).toBeTruthy();

    segunda.close();
  });

  test('migra la tabla productos del esquema antiguo (activo 0/1) a estado', () => {
    dbPath = tmpDbPath('productos-legacy');

    // Esquema anterior: activo booleano, sin sku/descripcion/actualizado_por.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE productos (
        id             INTEGER PRIMARY KEY,
        nombre         TEXT NOT NULL,
        categoria      TEXT NOT NULL,
        precio         REAL NOT NULL,
        activo         INTEGER NOT NULL DEFAULT 1,
        creado_en      TEXT NOT NULL DEFAULT (datetime('now')),
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    seed
      .prepare(
        'INSERT INTO productos (id, nombre, categoria, precio, activo) VALUES (?, ?, ?, ?, ?)',
      )
      .run(6, 'Pandebono editado', 'panaderia', 3.75, 1);
    seed
      .prepare(
        'INSERT INTO productos (id, nombre, categoria, precio, activo) VALUES (?, ?, ?, ?, ?)',
      )
      .run(50, 'Pan desactivado', 'panaderia', 4.5, 0);
    seed.close();

    process.env.DB_PATH = dbPath;
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const db = require('../db');

    const columnas = db
      .prepare('PRAGMA table_info(productos)')
      .all()
      .map((c) => c.name);
    expect(columnas).toEqual(
      expect.arrayContaining(['estado', 'sku', 'descripcion', 'actualizado_por']),
    );
    expect(columnas).not.toContain('activo');

    // Los datos ya editados sobreviven: nombre y precio no se pisan con el seed.
    expect(db.prepare('SELECT * FROM productos WHERE id = 6').get()).toMatchObject({
      nombre: 'Pandebono editado',
      precio: 3.75,
      estado: 'activo',
    });
    // activo = 0 -> 'agotado' (la lectura más conservadora del booleano).
    expect(db.prepare('SELECT estado FROM productos WHERE id = 50').get().estado).toBe('agotado');
    // Los productos del seed que faltaban se agregan igual.
    expect(db.prepare('SELECT COUNT(*) AS n FROM productos').get().n).toBe(10);

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

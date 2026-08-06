/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

// calidadDatos.js depende de db.js, que abre el archivo apuntado por
// DB_PATH en cuanto se hace el require() — si esto se importara acá
// arriba (antes de que beforeAll fije DB_PATH a un archivo temporal),
// abriría el luzmarina.db real del proyecto. Se declara sin asignar y
// se completa dentro de beforeAll, igual que auditoria.test.js.
let esVacio;
let calcularCompletitud;
let calcularHallazgo;

describe('esVacio (función pura)', () => {
  test.each([
    [null, true],
    [undefined, true],
    ['', true],
    [0, false],
    [false, false],
    ['algo', false],
  ])('esVacio(%p) === %p', (valor, esperado) => {
    expect(esVacio(valor)).toBe(esperado);
  });
});

describe('calcularCompletitud (función pura)', () => {
  const campos = [{ campo: 'imagen_base', etiqueta: 'Imagen', severidad: 'media' }];

  test('calcula el porcentaje de filas con el campo lleno', () => {
    const filas = [{ imagen_base: 'x' }, { imagen_base: null }, { imagen_base: '' }];
    const [resultado] = calcularCompletitud(filas, campos);
    expect(resultado).toMatchObject({ llenos: 1, total: 3, porcentaje: 33 });
  });

  test('sin filas, da 100% (no hay nada incompleto sobre un conjunto vacío)', () => {
    const [resultado] = calcularCompletitud([], campos);
    expect(resultado.porcentaje).toBe(100);
  });

  test('todas las filas completas da 100%', () => {
    const filas = [{ imagen_base: 'a' }, { imagen_base: 'b' }];
    const [resultado] = calcularCompletitud(filas, campos);
    expect(resultado.porcentaje).toBe(100);
  });
});

describe('calcularHallazgo (función pura)', () => {
  const campos = [
    { campo: 'proveedor', etiqueta: 'Proveedor', severidad: 'alta' },
    { campo: 'stock_minimo', etiqueta: 'Stock mínimo', severidad: 'alta' },
  ];

  test('null si no le falta nada', () => {
    const fila = { id: '1', nombre: 'Harina', proveedor: 'Molinos SA', stock_minimo: 10 };
    expect(calcularHallazgo(fila, campos, 'id', 'nombre')).toBeNull();
  });

  test('lista los campos faltantes con su severidad', () => {
    const fila = { id: '1', nombre: 'Harina', proveedor: null, stock_minimo: 10 };
    const hallazgo = calcularHallazgo(fila, campos, 'id', 'nombre');
    expect(hallazgo.id).toBe('1');
    expect(hallazgo.faltantes).toEqual([
      { campo: 'proveedor', etiqueta: 'Proveedor', severidad: 'alta' },
    ]);
  });
});

/* ═══════════════════════════════════════════
   Integración: evaluarProductos/evaluarInsumos + GET /calidad-datos
   ═══════════════════════════════════════════ */

const ADMIN_TOKEN = 'test-token-calidad';

let app;
let server;
let wss;
let db;
let CalidadDatos;
let dbPath;
let sessionToken;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-calidad-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.AUTH_MAX_ATTEMPTS = '100000';
  process.env.ORDERS_MAX_PER_WINDOW = '100000';

  ({ app, server, wss } = require('../server'));
  db = require('../db');
  CalidadDatos = require('../calidadDatos');
  ({ esVacio, calcularCompletitud, calcularHallazgo } = CalidadDatos);

  const res = await request(app).post('/auth').send({ password: ADMIN_TOKEN });
  sessionToken = res.body.token;
});

afterAll(() => {
  wss.close();
  server.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      /* ignore */
    }
  }
});

function auth() {
  return `Bearer ${sessionToken}`;
}

describe('evaluarProductos', () => {
  test('detecta precios sospechosos (por encima del umbral, pero dentro del CHECK de la BD)', () => {
    // No se puede probar con precio > 1000: productos.precio tiene
    // CHECK (precio <= 1000) en la propia base de datos, así que ni
    // siquiera un INSERT directo lo dejaría pasar. 35 sí es válido para
    // el esquema y sigue siendo mucho más de lo que cuesta cualquier
    // producto real de esta panadería — el caso que la regla debe
    // atrapar (un precio mal escrito, no un ataque a la validación).
    db.prepare(
      `INSERT INTO productos (nombre, categoria, precio, estado)
       VALUES ('Producto con precio inconsistente', 'panaderia', 35, 'activo')`,
    ).run();

    const reporte = CalidadDatos.evaluarProductos();
    expect(
      reporte.alertas.preciosSospechosos.some(
        (p) => p.nombre === 'Producto con precio inconsistente',
      ),
    ).toBe(true);
  });

  test('los 9 productos sembrados no generan hallazgos de imagen/descripción (ya vienen completos)', () => {
    const reporte = CalidadDatos.evaluarProductos();
    const completitudImagen = reporte.completitud.find((c) => c.campo === 'imagen_base');
    expect(completitudImagen.llenos).toBeGreaterThanOrEqual(9);
  });

  test('los 9 productos sembrados (precios entre $1.50 y $2.50) no disparan la alerta', () => {
    const reporte = CalidadDatos.evaluarProductos();
    const sembrados = reporte.alertas.preciosSospechosos.filter((p) => p.id <= 9);
    expect(sembrados).toHaveLength(0);
  });

  test('documenta el supuesto: la base de datos ya rechaza precio > 1000, incluso por INSERT directo', () => {
    expect(() => {
      db.prepare(
        `INSERT INTO productos (nombre, categoria, precio, estado)
         VALUES ('Precio imposible', 'panaderia', 5000, 'activo')`,
      ).run();
    }).toThrow(/CHECK/);
  });
});

describe('evaluarInsumos', () => {
  test('devuelve completitud y hallazgos con la forma esperada', () => {
    const reporte = CalidadDatos.evaluarInsumos();
    expect(reporte.entidad).toBe('insumos');
    expect(Array.isArray(reporte.completitud)).toBe(true);
    expect(Array.isArray(reporte.hallazgos)).toBe(true);
    expect(Array.isArray(reporte.alertas.vencidos)).toBe(true);
  });
});

describe('GET /calidad-datos', () => {
  test('requiere sesión de admin', async () => {
    const res = await request(app).get('/calidad-datos');
    expect(res.status).toBe(401);
  });

  test('devuelve el reporte de productos e insumos', async () => {
    const res = await request(app).get('/calidad-datos').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('productos');
    expect(res.body).toHaveProperty('insumos');
    expect(res.body).toHaveProperty('generadoEn');
  });
});

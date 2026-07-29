/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const ADMIN_TOKEN = 'test-token-inventario';

let app;
let server;
let wss;
let db;
let dbPath;
let sessionToken;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-inventario-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.AUTH_MAX_ATTEMPTS = '100000';
  process.env.ORDERS_MAX_PER_WINDOW = '100000';

  ({ app, server, wss } = require('../server'));
  db = require('../db');

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

beforeEach(() => {
  db.exec('DELETE FROM ordenes');
  db.exec('DELETE FROM horneadas');
  db.exec('DELETE FROM ajustes_inventario');
  db.exec('DELETE FROM producto_stock_minimo');
});

function auth() {
  return `Bearer ${sessionToken}`;
}

const FECHA = '2026-07-28';

async function crearOrden({ numero, productoId, nombre, cantidad, estado }) {
  await request(app)
    .post('/ordenes')
    .send({
      numero,
      fechaISO: `${FECHA}T10:00:00.000Z`,
      fechaTexto: '28 de julio, 2026',
      cliente: 'Cliente de prueba',
      telefono: '3001234567',
      retiro: '11:00',
      items: [{ productoId, nombre, cantidad, precio: 1.5 }],
      total: cantidad * 1.5,
    });
  if (estado) {
    await request(app).patch(`/ordenes/${numero}`).set('Authorization', auth()).send({ estado });
  }
}

async function hornear(cantidad, overrides = {}) {
  return request(app)
    .post('/horneadas')
    .set('Authorization', auth())
    .send({
      productoId: 6,
      cantidad,
      fecha: FECHA,
      hora: '06:00',
      ...overrides,
    });
}

describe('GET /inventario', () => {
  test('exige token de sesión', async () => {
    const res = await request(app).get('/inventario');
    expect(res.status).toBe(401);
  });

  test('sin actividad, todos los productos del catálogo aparecen en cero', async () => {
    const res = await request(app).get(`/inventario?fecha=${FECHA}`).set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.fecha).toBe(FECHA);
    expect(res.body.productos).toHaveLength(8); // 8 productos en PRODUCTOS_CATALOGO
    const pandebono = res.body.productos.find((p) => p.productoNombre === 'Pandebono');
    expect(pandebono).toMatchObject({
      horneado: 0,
      preparado: 0,
      vendido: 0,
      ajustes: 0,
      disponible: 0,
    });
  });

  test('disponible sube con lo horneado del día', async () => {
    await hornear(24);
    const res = await request(app).get(`/inventario?fecha=${FECHA}`).set('Authorization', auth());
    const pandebono = res.body.productos.find((p) => p.productoNombre === 'Pandebono');
    expect(pandebono.horneado).toBe(24);
    expect(pandebono.disponible).toBe(24);
  });

  test('cruza por productoId aunque el nombre del item no coincida con el catálogo actual', async () => {
    // Este es justo el escenario que motivó el fix: el nombre guardado en la
    // orden quedó desincronizado del catálogo (ej. se renombró el producto),
    // pero el productoId sigue siendo la fuente de verdad.
    await hornear(24);
    await crearOrden({
      numero: 'LM-20260728-0001',
      productoId: 6,
      nombre: 'Pandebono (nombre viejo)',
      cantidad: 5,
      estado: 'entregada',
    });

    const res = await request(app).get(`/inventario?fecha=${FECHA}`).set('Authorization', auth());
    const pandebono = res.body.productos.find((p) => p.productoNombre === 'Pandebono');
    expect(pandebono.vendido).toBe(5);
    expect(pandebono.disponible).toBe(19); // 24 horneado − 5 vendido
  });

  test('cae de vuelta al cruce por nombre cuando el item no trae productoId (orden anterior al fix)', async () => {
    await hornear(24);
    await crearOrden({
      numero: 'LM-20260728-0002',
      productoId: undefined,
      nombre: 'Pandebono',
      cantidad: 3,
      estado: 'entregada',
    });

    const res = await request(app).get(`/inventario?fecha=${FECHA}`).set('Authorization', auth());
    const pandebono = res.body.productos.find((p) => p.productoNombre === 'Pandebono');
    expect(pandebono.vendido).toBe(3);
    expect(pandebono.disponible).toBe(21);
  });

  test('preparada resta a "preparado" pero no a "vendido"', async () => {
    await hornear(24);
    await crearOrden({
      numero: 'LM-20260728-0003',
      productoId: 6,
      nombre: 'Pandebono',
      cantidad: 4,
      estado: 'preparada',
    });

    const res = await request(app).get(`/inventario?fecha=${FECHA}`).set('Authorization', auth());
    const pandebono = res.body.productos.find((p) => p.productoNombre === 'Pandebono');
    expect(pandebono.preparado).toBe(4);
    expect(pandebono.vendido).toBe(0);
    expect(pandebono.disponible).toBe(20); // 24 − 4 preparado
  });

  test('órdenes pendientes o en preparación no afectan el disponible', async () => {
    await hornear(24);
    await crearOrden({
      numero: 'LM-20260728-0004',
      productoId: 6,
      nombre: 'Pandebono',
      cantidad: 10,
      estado: null, // se queda en "pendiente"
    });

    const res = await request(app).get(`/inventario?fecha=${FECHA}`).set('Authorization', auth());
    const pandebono = res.body.productos.find((p) => p.productoNombre === 'Pandebono');
    expect(pandebono.disponible).toBe(24);
  });

  test('los ajustes (mermas) restan del disponible', async () => {
    await hornear(24);
    await request(app)
      .post('/ajustes-inventario')
      .set('Authorization', auth())
      .send({ productoId: 6, cantidad: 2, motivo: 'merma', fecha: FECHA, hora: '07:00' });

    const res = await request(app).get(`/inventario?fecha=${FECHA}`).set('Authorization', auth());
    const pandebono = res.body.productos.find((p) => p.productoNombre === 'Pandebono');
    expect(pandebono.ajustes).toBe(2);
    expect(pandebono.disponible).toBe(22);
  });

  test('bajoStock usa el default de 5 cuando no hay stock mínimo configurado', async () => {
    await hornear(3);
    const res = await request(app).get(`/inventario?fecha=${FECHA}`).set('Authorization', auth());
    const pandebono = res.body.productos.find((p) => p.productoNombre === 'Pandebono');
    expect(pandebono.stockMinimo).toBe(5);
    expect(pandebono.bajoStock).toBe(true); // 3 disponible < 5 default
  });

  test('bajoStock respeta el stock mínimo configurado vía PUT /productos/:id/stock-minimo', async () => {
    await hornear(3);
    await request(app)
      .put('/productos/6/stock-minimo')
      .set('Authorization', auth())
      .send({ stockMinimo: 2 });

    const res = await request(app).get(`/inventario?fecha=${FECHA}`).set('Authorization', auth());
    const pandebono = res.body.productos.find((p) => p.productoNombre === 'Pandebono');
    expect(pandebono.stockMinimo).toBe(2);
    expect(pandebono.bajoStock).toBe(false); // 3 disponible >= 2
  });
});

describe('PUT /productos/:id/stock-minimo', () => {
  test('exige token de sesión', async () => {
    const res = await request(app).put('/productos/6/stock-minimo').send({ stockMinimo: 10 });
    expect(res.status).toBe(401);
  });

  test('rechaza un producto que no existe en el catálogo', async () => {
    const res = await request(app)
      .put('/productos/999/stock-minimo')
      .set('Authorization', auth())
      .send({ stockMinimo: 10 });
    expect(res.status).toBe(400);
  });

  test.each([[-1], [1000], [1.5], ['muchos']])(
    'rechaza stockMinimo inválido: %p',
    async (stockMinimo) => {
      const res = await request(app)
        .put('/productos/6/stock-minimo')
        .set('Authorization', auth())
        .send({ stockMinimo });
      expect(res.status).toBe(400);
    },
  );
});

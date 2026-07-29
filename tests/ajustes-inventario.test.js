/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const ADMIN_TOKEN = 'test-token-ajustes';

let app;
let server;
let wss;
let db;
let dbPath;
let sessionToken;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-ajustes-${process.pid}-${Date.now()}.db`);
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
  db.exec('DELETE FROM ajustes_inventario');
});

function auth() {
  return `Bearer ${sessionToken}`;
}

function ajusteValido(overrides = {}) {
  return {
    productoId: 6, // Pandebono
    cantidad: 3,
    motivo: 'merma',
    fecha: '2026-07-28',
    hora: '19:00',
    registradoPor: 'Luz Marina',
    notas: 'Se cayeron al piso',
    ...overrides,
  };
}

async function crear(overrides = {}) {
  return request(app)
    .post('/ajustes-inventario')
    .set('Authorization', auth())
    .send(ajusteValido(overrides));
}

describe('Autenticación de /ajustes-inventario', () => {
  test.each([
    ['get', '/ajustes-inventario'],
    ['post', '/ajustes-inventario'],
    ['put', '/ajustes-inventario/abc'],
    ['delete', '/ajustes-inventario/abc'],
  ])('%s %s exige token de sesión', async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(401);
  });
});

describe('POST /ajustes-inventario', () => {
  test('crea el ajuste y resuelve el nombre del producto contra el catálogo', async () => {
    const res = await crear();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      productoId: '6',
      productoNombre: 'Pandebono',
      cantidad: 3,
      motivo: 'merma',
      registradoPor: 'Luz Marina',
    });
  });

  test('rechaza un producto que no existe en el catálogo', async () => {
    const res = await crear({ productoId: 999 });
    expect(res.status).toBe(400);
  });

  test('rechaza un motivo fuera de la lista blanca', async () => {
    const res = await crear({ motivo: 'porque sí' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/motivo/i);
  });

  test.each(['merma', 'error_conteo', 'consumo_interno', 'otro'])(
    'acepta el motivo "%s"',
    async (motivo) => {
      const res = await crear({ motivo });
      expect(res.status).toBe(201);
    },
  );

  test.each([0, -1, 3.5, 'muchas'])('rechaza cantidad inválida: %p', async (cantidad) => {
    const res = await crear({ cantidad });
    expect(res.status).toBe(400);
  });
});

describe('GET /ajustes-inventario', () => {
  test('filtra por fecha', async () => {
    await crear({ fecha: '2026-07-28' });
    await crear({ fecha: '2026-07-20' });

    const res = await request(app)
      .get('/ajustes-inventario?fecha=2026-07-28')
      .set('Authorization', auth());
    expect(res.body).toHaveLength(1);
  });
});

describe('PUT /ajustes-inventario/:id', () => {
  test('actualiza el ajuste', async () => {
    const { body } = await crear();
    const res = await request(app)
      .put(`/ajustes-inventario/${body.id}`)
      .set('Authorization', auth())
      .send(ajusteValido({ cantidad: 7, motivo: 'error_conteo' }));

    expect(res.status).toBe(200);
    expect(res.body.cantidad).toBe(7);
    expect(res.body.motivo).toBe('error_conteo');
  });

  test('devuelve 404 si el ajuste no existe', async () => {
    const res = await request(app)
      .put('/ajustes-inventario/no-existe')
      .set('Authorization', auth())
      .send(ajusteValido());
    expect(res.status).toBe(404);
  });
});

describe('DELETE /ajustes-inventario/:id', () => {
  test('elimina el ajuste', async () => {
    const { body } = await crear();
    const res = await request(app)
      .delete(`/ajustes-inventario/${body.id}`)
      .set('Authorization', auth());
    expect(res.status).toBe(204);

    const lista = await request(app).get('/ajustes-inventario').set('Authorization', auth());
    expect(lista.body).toHaveLength(0);
  });

  test('devuelve 404 si el ajuste no existe', async () => {
    const res = await request(app)
      .delete('/ajustes-inventario/no-existe')
      .set('Authorization', auth());
    expect(res.status).toBe(404);
  });
});

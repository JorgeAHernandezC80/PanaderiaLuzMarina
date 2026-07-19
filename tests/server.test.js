/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const ADMIN_TOKEN = 'test-token-123';
const FRONTEND_ORIGIN = 'https://frontend.example';

let app;
let server;
let wss;
let db;
let dbPath;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `plm-test-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.FRONTEND_ORIGIN = FRONTEND_ORIGIN;

  ({ app, server, wss } = require('../server'));
  db = require('../db');
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
});

function ordenValida(overrides = {}) {
  return {
    numero: 'LM-20260117-1234',
    fechaISO: '2026-01-17T10:30:00.000Z',
    fechaTexto: 'sábado 17 de enero, 2026 · 10:30 a. m.',
    cliente: 'Ana Pérez',
    telefono: '+57 300 123 4567',
    retiro: '10:30',
    items: [{ nombre: 'Pan', cantidad: 2, precio: 2.5 }],
    total: 5,
    ...overrides,
  };
}

function auth() {
  return `Bearer ${ADMIN_TOKEN}`;
}

describe('GET /health', () => {
  test('devuelve estado ok con timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.ts).toBe('string');
  });
});

describe('CORS', () => {
  test('refleja el origin permitido', async () => {
    const res = await request(app).get('/health').set('Origin', FRONTEND_ORIGIN);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND_ORIGIN);
  });

  test('no refleja un origin no permitido', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('responde 204 a preflight OPTIONS', async () => {
    const res = await request(app).options('/ordenes').set('Origin', FRONTEND_ORIGIN);
    expect(res.status).toBe(204);
  });
});

describe('POST /auth', () => {
  test('devuelve el token con la contraseña correcta', async () => {
    const res = await request(app).post('/auth').send({ password: ADMIN_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe(ADMIN_TOKEN);
  });

  test('rechaza contraseña incorrecta con 401', async () => {
    const res = await request(app).post('/auth').send({ password: 'mala' });
    expect(res.status).toBe(401);
  });

  test('rechaza cuando falta la contraseña con 400', async () => {
    const res = await request(app).post('/auth').send({});
    expect(res.status).toBe(400);
  });

  test('rechaza contraseña no-string con 400', async () => {
    const res = await request(app).post('/auth').send({ password: 12345 });
    expect(res.status).toBe(400);
  });
});

describe('POST /ordenes', () => {
  test('crea una orden válida y la persiste', async () => {
    const res = await request(app).post('/ordenes').send(ordenValida());
    expect(res.status).toBe(201);
    expect(res.body.numero).toBe('LM-20260117-1234');
    expect(res.body.estado).toBe('pendiente');

    const row = db.prepare('SELECT * FROM ordenes WHERE numero = ?').get('LM-20260117-1234');
    expect(row).toBeTruthy();
    expect(row.cliente).toBe('Ana Pérez');
  });

  test('rechaza una orden inválida con 400', async () => {
    const res = await request(app)
      .post('/ordenes')
      .send(ordenValida({ numero: 'malo' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Número de orden/);
  });

  test('devuelve 409 ante número de orden duplicado', async () => {
    await request(app).post('/ordenes').send(ordenValida());
    const res = await request(app).post('/ordenes').send(ordenValida());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Ya existe/);
  });
});

describe('GET /ordenes (protegido)', () => {
  beforeEach(async () => {
    await request(app)
      .post('/ordenes')
      .send(
        ordenValida({
          numero: 'LM-20260117-1111',
          fechaISO: '2026-01-17T09:00:00.000Z',
        }),
      );
    await request(app)
      .post('/ordenes')
      .send(
        ordenValida({
          numero: 'LM-20260118-2222',
          fechaISO: '2026-01-18T09:00:00.000Z',
        }),
      );
  });

  test('rechaza sin autorización con 401', async () => {
    const res = await request(app).get('/ordenes');
    expect(res.status).toBe(401);
  });

  test('rechaza con token incorrecto con 401', async () => {
    const res = await request(app).get('/ordenes').set('Authorization', 'Bearer malo');
    expect(res.status).toBe(401);
  });

  test('lista las órdenes autenticado', async () => {
    const res = await request(app).get('/ordenes').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].items).toBeInstanceOf(Array);
  });

  test('filtra por fecha', async () => {
    const res = await request(app).get('/ordenes?fecha=2026-01-18').set('Authorization', auth());
    expect(res.body).toHaveLength(1);
    expect(res.body[0].numero).toBe('LM-20260118-2222');
  });

  test('filtra por estado', async () => {
    const res = await request(app).get('/ordenes?estado=pendiente').set('Authorization', auth());
    expect(res.body).toHaveLength(2);
    const vacio = await request(app).get('/ordenes?estado=preparada').set('Authorization', auth());
    expect(vacio.body).toHaveLength(0);
  });

  test('ignora filtros con formato inválido', async () => {
    const res = await request(app)
      .get('/ordenes?fecha=xx&estado=raro')
      .set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe('PATCH /ordenes/:numero (protegido)', () => {
  beforeEach(async () => {
    await request(app).post('/ordenes').send(ordenValida());
  });

  test('rechaza sin autorización con 401', async () => {
    const res = await request(app).patch('/ordenes/LM-20260117-1234').send({ estado: 'preparada' });
    expect(res.status).toBe(401);
  });

  test('actualiza el estado de una orden existente', async () => {
    const res = await request(app)
      .patch('/ordenes/LM-20260117-1234')
      .set('Authorization', auth())
      .send({ estado: 'preparada' });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('preparada');

    const row = db.prepare('SELECT estado FROM ordenes WHERE numero = ?').get('LM-20260117-1234');
    expect(row.estado).toBe('preparada');
  });

  test('rechaza número de orden con formato inválido con 400', async () => {
    const res = await request(app)
      .patch('/ordenes/malo')
      .set('Authorization', auth())
      .send({ estado: 'preparada' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Número de orden/);
  });

  test('rechaza estado inválido con 400', async () => {
    const res = await request(app)
      .patch('/ordenes/LM-20260117-1234')
      .set('Authorization', auth())
      .send({ estado: 'enviada' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Estado inválido/);
  });

  test('devuelve 404 para una orden inexistente', async () => {
    const res = await request(app)
      .patch('/ordenes/LM-20990101-9999')
      .set('Authorization', auth())
      .send({ estado: 'preparada' });
    expect(res.status).toBe(404);
  });
});

describe('rutas desconocidas', () => {
  test('devuelve 404 con mensaje', async () => {
    const res = await request(app).get('/no-existe');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no encontrada/);
  });
});

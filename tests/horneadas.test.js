/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const ADMIN_TOKEN = 'test-token-horneadas';

let app;
let server;
let wss;
let db;
let dbPath;
let sessionToken;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-horneadas-${process.pid}-${Date.now()}.db`);
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
  db.exec('DELETE FROM horneadas');
});

function auth() {
  return `Bearer ${sessionToken}`;
}

function horneadaValida(overrides = {}) {
  return {
    productoId: 6, // Pandebono
    cantidad: 24,
    fecha: '2026-07-28',
    hora: '07:30',
    registradoPor: 'María',
    notas: 'Horno grande, primera tanda',
    ...overrides,
  };
}

async function crear(overrides = {}) {
  return request(app)
    .post('/horneadas')
    .set('Authorization', auth())
    .send(horneadaValida(overrides));
}

describe('Autenticación de /horneadas', () => {
  test.each([
    ['get', '/horneadas'],
    ['post', '/horneadas'],
    ['put', '/horneadas/abc'],
    ['delete', '/horneadas/abc'],
  ])('%s %s exige token de sesión', async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(401);
  });
});

describe('POST /horneadas', () => {
  test('crea la horneada y resuelve el nombre del producto contra el catálogo', async () => {
    const res = await crear();
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body).toMatchObject({
      productoId: '6',
      productoNombre: 'Pandebono',
      cantidad: 24,
      fecha: '2026-07-28',
      hora: '07:30',
      registradoPor: 'María',
      notas: 'Horno grande, primera tanda',
    });
    expect(res.body.creadoEn).toBeTruthy();
    expect(res.body.actualizadoEn).toBeTruthy();
  });

  test('ignora el nombre de producto que mande el cliente y usa el del catálogo', async () => {
    const res = await request(app)
      .post('/horneadas')
      .set('Authorization', auth())
      .send({ ...horneadaValida(), productoNombre: 'Producto inventado' });
    expect(res.status).toBe(201);
    expect(res.body.productoNombre).toBe('Pandebono');
  });

  test('rechaza un producto que no existe en el catálogo', async () => {
    const res = await crear({ productoId: 999 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/producto/i);
  });

  test.each([
    ['cantidad cero', { cantidad: 0 }],
    ['cantidad negativa', { cantidad: -5 }],
    ['cantidad decimal', { cantidad: 3.5 }],
    ['cantidad no numérica', { cantidad: 'muchas' }],
    ['cantidad excesiva', { cantidad: 100000 }],
  ])('rechaza %s', async (_caso, overrides) => {
    const res = await crear(overrides);
    expect(res.status).toBe(400);
  });

  test.each([
    ['fecha con formato inválido', { fecha: '28/07/2026' }],
    ['fecha vacía', { fecha: '' }],
    ['hora con formato inválido', { hora: '7:30 am' }],
    ['hora vacía', { hora: '' }],
  ])('rechaza %s', async (_caso, overrides) => {
    const res = await crear(overrides);
    expect(res.status).toBe(400);
  });

  test('acepta notas y registradoPor vacíos u omitidos', async () => {
    const res = await request(app)
      .post('/horneadas')
      .set('Authorization', auth())
      .send({ productoId: 1, cantidad: 10, fecha: '2026-07-28', hora: '06:00' });
    expect(res.status).toBe(201);
    expect(res.body.notas).toBe('');
    expect(res.body.registradoPor).toBe('');
  });
});

describe('GET /horneadas', () => {
  test('filtra por fecha y no mezcla otros días', async () => {
    await crear({ fecha: '2026-07-28', hora: '06:00' });
    await crear({ fecha: '2026-07-27', hora: '06:00' });

    const res = await request(app).get('/horneadas?fecha=2026-07-28').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].fecha).toBe('2026-07-28');
  });

  test('dentro del mismo día ordena cronológicamente por hora (línea de tiempo de producción)', async () => {
    await crear({ fecha: '2026-07-28', hora: '10:00', cantidad: 12 });
    await crear({ fecha: '2026-07-28', hora: '06:00', cantidad: 24 });
    await crear({ fecha: '2026-07-28', hora: '08:00', cantidad: 18 });

    const res = await request(app).get('/horneadas?fecha=2026-07-28').set('Authorization', auth());
    expect(res.body.map((h) => h.hora)).toEqual(['06:00', '08:00', '10:00']);
  });

  test('sin filtro de fecha devuelve todos los registros', async () => {
    await crear({ fecha: '2026-07-28' });
    await crear({ fecha: '2026-07-20' });

    const res = await request(app).get('/horneadas').set('Authorization', auth());
    expect(res.body).toHaveLength(2);
  });
});

describe('PUT /horneadas/:id', () => {
  test('actualiza los datos de la horneada', async () => {
    const { body } = await crear();
    const res = await request(app)
      .put(`/horneadas/${body.id}`)
      .set('Authorization', auth())
      .send(horneadaValida({ cantidad: 30, registradoPor: 'Luz Marina' }));

    expect(res.status).toBe(200);
    expect(res.body.cantidad).toBe(30);
    expect(res.body.registradoPor).toBe('Luz Marina');
  });

  test('deja rastro de auditoría: actualizadoEn cambia aunque creadoEn no', async () => {
    const { body } = await crear();

    // Retrocedemos artificialmente creado_en para no depender de un delay
    // real de reloj entre el POST y el PUT dentro del test.
    db.prepare('UPDATE horneadas SET creado_en = ? WHERE id = ?').run(
      '2020-01-01 00:00:00',
      body.id,
    );

    const res = await request(app)
      .put(`/horneadas/${body.id}`)
      .set('Authorization', auth())
      .send(horneadaValida({ cantidad: 30 }));

    expect(res.status).toBe(200);
    expect(res.body.creadoEn).toBe('2020-01-01 00:00:00');
    expect(res.body.actualizadoEn).not.toBe(res.body.creadoEn);
  });

  test('devuelve 404 si la horneada no existe', async () => {
    const res = await request(app)
      .put('/horneadas/no-existe')
      .set('Authorization', auth())
      .send(horneadaValida());
    expect(res.status).toBe(404);
  });

  test('devuelve 400 con un id de formato inválido', async () => {
    const res = await request(app)
      .put('/horneadas/id%20invalido')
      .set('Authorization', auth())
      .send(horneadaValida());
    expect(res.status).toBe(400);
  });

  test('devuelve 400 si los datos actualizados son inválidos', async () => {
    const { body } = await crear();
    const res = await request(app)
      .put(`/horneadas/${body.id}`)
      .set('Authorization', auth())
      .send(horneadaValida({ cantidad: -1 }));
    expect(res.status).toBe(400);
  });
});

describe('DELETE /horneadas/:id', () => {
  test('elimina la horneada', async () => {
    const { body } = await crear();
    const res = await request(app).delete(`/horneadas/${body.id}`).set('Authorization', auth());
    expect(res.status).toBe(204);

    const lista = await request(app).get('/horneadas').set('Authorization', auth());
    expect(lista.body).toHaveLength(0);
  });

  test('devuelve 404 si la horneada no existe', async () => {
    const res = await request(app).delete('/horneadas/no-existe').set('Authorization', auth());
    expect(res.status).toBe(404);
  });
});

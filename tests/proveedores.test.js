/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const ADMIN_TOKEN = 'test-token-proveedores';

let app;
let server;
let wss;
let db;
let dbPath;
let sessionToken;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-prov-${process.pid}-${Date.now()}.db`);
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
  db.exec('DELETE FROM proveedores');
});

function auth() {
  return `Bearer ${sessionToken}`;
}

function proveedorValido(overrides = {}) {
  return {
    razonSocial: 'Molinos del Valle S.A.S.',
    nombreComercial: 'Molinos del Valle',
    identificacionFiscal: '900.123.456-7',
    giroComercial: 'Molienda de cereales',
    direccion: 'Cra. 45 # 12-34',
    codigoPostal: '110111',
    ciudad: 'Bogotá',
    pais: 'Colombia',
    contactoNombre: 'Laura Gómez',
    emailFacturacion: 'facturacion@molinos.com',
    emailContacto: 'ventas@molinos.com',
    telefonoFijo: '+57 601 2345678',
    celular: '+57 300 1234567',
    banco: 'Bancolombia',
    numeroCuenta: '12345678901',
    clabeIban: 'CO12345678901234567890',
    condicionesPago: 'credito_30',
    moneda: 'COP',
    metodoFacturacion: 'Factura electrónica al correo de facturación',
    leadTimeDias: 3,
    pedidoMinimo: 250000,
    politicasDevolucion: 'Cambios dentro de las 48 horas',
    certificaciones: 'ISO 9001',
    notas: 'Entrega los martes',
    ...overrides,
  };
}

async function crear(overrides = {}) {
  return request(app)
    .post('/proveedores')
    .set('Authorization', auth())
    .send(proveedorValido(overrides));
}

describe('Autenticación de /proveedores', () => {
  test.each([
    ['get', '/proveedores'],
    ['post', '/proveedores'],
    ['put', '/proveedores/abc'],
    ['delete', '/proveedores/abc'],
  ])('%s %s exige token de sesión', async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(401);
  });
});

describe('POST /proveedores', () => {
  test('crea el proveedor con todos los bloques de información', async () => {
    const res = await crear();
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body).toMatchObject({
      razonSocial: 'Molinos del Valle S.A.S.',
      identificacionFiscal: '900.123.456-7',
      contactoNombre: 'Laura Gómez',
      clabeIban: 'CO12345678901234567890',
      condicionesPago: 'credito_30',
      moneda: 'COP',
      leadTimeDias: 3,
      pedidoMinimo: 250000,
      certificaciones: 'ISO 9001',
    });
  });

  test('rechaza razón social vacía', async () => {
    const res = await crear({ razonSocial: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/raz[oó]n social/i);
  });

  test.each([
    ['condicionesPago', { condicionesPago: 'credito_365' }],
    ['moneda', { moneda: 'BTC' }],
    ['emailFacturacion', { emailFacturacion: 'no-es-un-correo' }],
    ['leadTimeDias', { leadTimeDias: -1 }],
    ['pedidoMinimo', { pedidoMinimo: 'mucho' }],
  ])('rechaza %s inválido', async (_campo, overrides) => {
    const res = await crear(overrides);
    expect(res.status).toBe(400);
  });

  test('deja opcionales vacíos como cadena o null', async () => {
    const res = await request(app)
      .post('/proveedores')
      .set('Authorization', auth())
      .send({ razonSocial: 'Proveedor mínimo', condicionesPago: 'contado', moneda: 'USD' });
    expect(res.status).toBe(201);
    expect(res.body.nombreComercial).toBe('');
    expect(res.body.leadTimeDias).toBeNull();
    expect(res.body.pedidoMinimo).toBeNull();
  });
});

describe('GET /proveedores', () => {
  test('devuelve la lista ordenada por razón social', async () => {
    await crear({ razonSocial: 'Zeta Insumos' });
    await crear({ razonSocial: 'Alfa Empaques' });

    const res = await request(app).get('/proveedores').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.razonSocial)).toEqual(['Alfa Empaques', 'Zeta Insumos']);
  });
});

describe('PUT /proveedores/:id', () => {
  test('actualiza los datos del proveedor', async () => {
    const { body } = await crear();
    const res = await request(app)
      .put(`/proveedores/${body.id}`)
      .set('Authorization', auth())
      .send(proveedorValido({ razonSocial: 'Molinos del Valle S.A.', condicionesPago: 'contado' }));

    expect(res.status).toBe(200);
    expect(res.body.razonSocial).toBe('Molinos del Valle S.A.');
    expect(res.body.condicionesPago).toBe('contado');
  });

  test('devuelve 404 si el proveedor no existe', async () => {
    const res = await request(app)
      .put('/proveedores/no-existe')
      .set('Authorization', auth())
      .send(proveedorValido());
    expect(res.status).toBe(404);
  });

  test('devuelve 400 con un id de formato inválido', async () => {
    const res = await request(app)
      .put('/proveedores/id%20invalido')
      .set('Authorization', auth())
      .send(proveedorValido());
    expect(res.status).toBe(400);
  });
});

describe('DELETE /proveedores/:id', () => {
  test('elimina el proveedor', async () => {
    const { body } = await crear();
    const res = await request(app).delete(`/proveedores/${body.id}`).set('Authorization', auth());
    expect(res.status).toBe(204);

    const lista = await request(app).get('/proveedores').set('Authorization', auth());
    expect(lista.body).toHaveLength(0);
  });

  test('devuelve 404 si el proveedor no existe', async () => {
    const res = await request(app).delete('/proveedores/no-existe').set('Authorization', auth());
    expect(res.status).toBe(404);
  });
});

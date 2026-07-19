/**
 * @jest-environment node
 *
 * Pruebas de endurecimiento de seguridad: cabeceras HTTP, rate limiting de
 * autenticación y tokens de sesión firmados. Vive en su propio archivo para no
 * interferir con los contadores de rate limiting de la suite funcional.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const request = require('supertest');

const ADMIN_TOKEN = 'sec-token-123';
const SESSION_SECRET = 'sec-secret-xyz';
const AUTH_MAX = 5;

let app;
let server;
let wss;
let db;
let dbPath;
let issueSessionToken;
let verifySessionToken;
let resetRateLimits;

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `plm-sec-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.FRONTEND_ORIGIN = 'https://frontend.example';
  process.env.AUTH_MAX_ATTEMPTS = String(AUTH_MAX);

  ({
    app,
    server,
    wss,
    issueSessionToken,
    verifySessionToken,
    resetRateLimits,
  } = require('../server'));
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

beforeEach(() => resetRateLimits());

describe('cabeceras de seguridad', () => {
  test('todas las respuestas incluyen las cabeceras de seguridad', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['permissions-policy']).toMatch(/camera=\(\)/);
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('rate limiting de /auth (anti fuerza bruta)', () => {
  test('devuelve 429 tras superar el límite de intentos', async () => {
    let last;
    for (let i = 0; i < AUTH_MAX + 1; i += 1) {
      last = await request(app).post('/auth').send({ password: 'incorrecta' });
    }
    expect(last.status).toBe(429);
    expect(last.headers['retry-after']).toBeDefined();
  });
});

describe('tokens de sesión firmados', () => {
  test('acepta un token recién emitido', () => {
    expect(verifySessionToken(issueSessionToken())).toBe(true);
  });

  test('rechaza tokens manipulados o malformados', () => {
    expect(verifySessionToken(`${issueSessionToken()}x`)).toBe(false);
    expect(verifySessionToken('a.b')).toBe(false);
    expect(verifySessionToken('sin-punto')).toBe(false);
    expect(verifySessionToken('')).toBe(false);
    expect(verifySessionToken(null)).toBe(false);
  });

  test('rechaza un token expirado aunque la firma sea válida', () => {
    const body = Buffer.from(JSON.stringify({ exp: Date.now() - 1000 })).toString('base64url');
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    expect(verifySessionToken(`${body}.${sig}`)).toBe(false);
  });

  test('un endpoint protegido acepta el token de sesión y rechaza el ADMIN_TOKEN crudo', async () => {
    const ok = await request(app)
      .get('/ordenes')
      .set('Authorization', `Bearer ${issueSessionToken()}`);
    expect(ok.status).toBe(200);

    const bad = await request(app).get('/ordenes').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(bad.status).toBe(401);
  });
});

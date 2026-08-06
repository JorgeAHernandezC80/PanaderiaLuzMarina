/**
 * @jest-environment node
 */

const {
  MIN_PUNTOS_BACKTEST,
  promedioSimple,
  mediaMovil,
  suavizadoExponencial,
  regresionLineal,
  backtestModelo,
  seleccionarMejorModelo,
} = require('../autoML');

describe('modelos individuales (funciones puras)', () => {
  test('promedioSimple', () => {
    expect(promedioSimple([10, 20, 30])).toBe(20);
    expect(promedioSimple([])).toBe(0);
  });

  test('mediaMovil usa solo los últimos N puntos', () => {
    expect(mediaMovil([100, 100, 10, 20, 30], 3)).toBeCloseTo(20, 5); // solo 10,20,30
    expect(mediaMovil([5, 5], 7)).toBe(5); // menos puntos que la ventana: usa los que hay
  });

  test('suavizadoExponencial con alpha=1 sigue exactamente al último valor', () => {
    expect(suavizadoExponencial([10, 20, 30], 1)).toBe(30);
  });

  test('suavizadoExponencial con alpha=0 se queda en el primer valor (no reacciona)', () => {
    expect(suavizadoExponencial([10, 20, 30], 0)).toBe(10);
  });

  test('regresionLineal predice el siguiente punto de una recta perfecta', () => {
    expect(regresionLineal([1, 2, 3, 4, 5])).toBe(6);
  });

  test('regresionLineal en una serie plana no proyecta tendencia falsa', () => {
    expect(regresionLineal([5, 5, 5, 5])).toBeCloseTo(5, 5);
  });

  test('regresionLineal nunca predice negativo', () => {
    expect(regresionLineal([5, 3, 1])).toBeGreaterThanOrEqual(0);
  });
});

describe('backtestModelo (walk-forward)', () => {
  test('un modelo perfecto da error 0', () => {
    const serieConstante = Array(10).fill(7);
    const error = backtestModelo(serieConstante, (s) => promedioSimple(s), 3);
    expect(error).toBe(0);
  });

  test('sin puntos evaluables devuelve null', () => {
    expect(backtestModelo([1, 2], (s) => promedioSimple(s), 5)).toBeNull();
  });

  test('nunca usa datos futuros para predecir el pasado (solo ve hasta t-1)', () => {
    let vioElFuturo = false;
    const serie = [1, 2, 3, 4, 5, 6, 7, 8];
    backtestModelo(
      serie,
      (entrenamiento) => {
        // Si el "futuro" (valores después del punto que se está
        // prediciendo) se colara en el entrenamiento, este predictor lo
        // notaría comparando longitudes.
        if (entrenamiento.length >= serie.length) vioElFuturo = true;
        return promedioSimple(entrenamiento);
      },
      3,
    );
    expect(vioElFuturo).toBe(false);
  });
});

describe('seleccionarMejorModelo (función pura)', () => {
  test(`con menos de ${MIN_PUNTOS_BACKTEST} puntos evaluables, marca datosInsuficientes`, () => {
    const resultado = seleccionarMejorModelo([1, 2, 3]);
    expect(resultado.datosInsuficientes).toBe(true);
    expect(resultado.modeloElegido).toBeNull();
    expect(resultado.candidatos).toEqual([]);
  });

  test('una serie con tendencia clara y sostenida elige regresión lineal', () => {
    const serie = Array.from({ length: 20 }, (_, i) => 5 + i); // 5,6,7,...,24
    const resultado = seleccionarMejorModelo(serie);
    expect(resultado.datosInsuficientes).toBe(false);
    expect(resultado.modeloElegido).toBe('Regresión lineal');
    expect(resultado.prediccion).toBeCloseTo(25, 0);
    expect(resultado.errorPromedio).toBeCloseTo(0, 5);
  });

  test('una serie constante elige el promedio simple con error 0', () => {
    const serie = Array(20).fill(10);
    const resultado = seleccionarMejorModelo(serie);
    expect(resultado.modeloElegido).toBe('Promedio simple');
    expect(resultado.prediccion).toBe(10);
    expect(resultado.errorPromedio).toBe(0);
  });

  test('los candidatos vienen ordenados de menor a mayor error', () => {
    const serie = Array.from({ length: 20 }, (_, i) => 5 + i);
    const { candidatos } = seleccionarMejorModelo(serie);
    for (let i = 1; i < candidatos.length; i++) {
      expect(candidatos[i].errorPromedio).toBeGreaterThanOrEqual(candidatos[i - 1].errorPromedio);
    }
  });

  test('devuelve todas las variantes de suavizado exponencial como candidatos separados', () => {
    const serie = Array.from({ length: 20 }, () => 8);
    const { candidatos } = seleccionarMejorModelo(serie);
    const variantes = candidatos.filter((c) => c.nombre.startsWith('Suavizado exponencial'));
    expect(variantes.length).toBe(5); // ALPHAS_SUAVIZADO tiene 5 valores
  });
});

/* ═══════════════════════════════════════════
   Integración: GET /productos/:id/prediccion-automl
   ═══════════════════════════════════════════ */
const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const ADMIN_TOKEN = 'test-token-automl';

let app;
let server;
let wss;
let db;
let dbPath;
let sessionToken;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-automl-${process.pid}-${Date.now()}.db`);
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

function auth() {
  return `Bearer ${sessionToken}`;
}

function crearProducto(overrides = {}) {
  return request(app)
    .post('/productos')
    .set('Authorization', auth())
    .send({ nombre: 'Producto de prueba AutoML', categoria: 'panaderia', precio: 2, ...overrides });
}

function hoyHouston() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function fechaHace(diasAtras) {
  const [y, m, d] = hoyHouston().split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() - diasAtras);
  return base.toISOString().slice(0, 10);
}

function backdatearProducto(id, diasAtras) {
  const sqliteFecha = `${fechaHace(diasAtras)} 12:00:00`;
  db.prepare('UPDATE productos SET creado_en = ? WHERE id = ?').run(sqliteFecha, id);
}

function insertarOrdenEntregada({ fechaIso, productoId, cantidad }) {
  const numero = `TEST-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO ordenes (numero, fecha_iso, fecha_texto, cliente, telefono, retiro, items_json, total, estado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'entregada')`,
  ).run(
    numero,
    `${fechaIso}T12:00:00.000Z`,
    fechaIso,
    'Cliente de prueba',
    '2810000000',
    'Hoy',
    JSON.stringify([
      { nombre: 'Producto de prueba AutoML', cantidad, precio: 2, productoId: String(productoId) },
    ]),
    cantidad * 2,
  );
}

describe('GET /productos/:id/prediccion-automl', () => {
  test('requiere sesión de admin', async () => {
    const { body: creado } = await crearProducto();
    const res = await request(app).get(`/productos/${creado.id}/prediccion-automl`);
    expect(res.status).toBe(401);
  });

  test('404 si el producto no existe', async () => {
    const res = await request(app)
      .get('/productos/999999/prediccion-automl')
      .set('Authorization', auth());
    expect(res.status).toBe(404);
  });

  test('producto recién creado: datosInsuficientes (no tiene historial)', async () => {
    const { body: creado } = await crearProducto();
    const res = await request(app)
      .get(`/productos/${creado.id}/prediccion-automl`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.datosInsuficientes).toBe(true);
    expect(res.body.modeloElegido).toBeNull();
  });

  test('con historial suficiente, elige un modelo real y da una predicción', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 25);

    for (let dias = 24; dias >= 0; dias--) {
      insertarOrdenEntregada({ fechaIso: fechaHace(dias), productoId: creado.id, cantidad: 8 });
    }

    const res = await request(app)
      .get(`/productos/${creado.id}/prediccion-automl`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.datosInsuficientes).toBe(false);
    expect(res.body.modeloElegido).toBeTruthy();
    expect(res.body.prediccion).toBeCloseTo(8, 0);
    expect(Array.isArray(res.body.candidatos)).toBe(true);
    expect(res.body.candidatos.length).toBeGreaterThan(1);
  });
});

describe('GET /productos/prediccion-automl (lote)', () => {
  test('requiere sesión de admin', async () => {
    const res = await request(app).get('/productos/prediccion-automl');
    expect(res.status).toBe(401);
  });

  test('devuelve un registro por cada producto activo', async () => {
    const res = await request(app).get('/productos/prediccion-automl').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.productos)).toBe(true);
    expect(res.body.productos.length).toBeGreaterThan(0);
    expect(res.body.productos[0]).toHaveProperty('productoId');
    expect(res.body.productos[0]).toHaveProperty('modeloElegido');
  });
});

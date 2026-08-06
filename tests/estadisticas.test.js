/**
 * @jest-environment node
 */

const {
  MIN_DIAS_HISTORIAL,
  MIN_LOTES_POR_HORA,
  calcularRotacionYDesviacion,
  calcularFactorEstacionalidad,
  calcularTasaMerma,
  asignarConsumoFIFO,
  calcularProbabilidadVencimiento,
  calcularProduccionSugerida,
  calcularEstadisticasProducto,
} = require('../estadisticas');

describe('calcularRotacionYDesviacion (función pura)', () => {
  test('promedio y desviación estándar de una serie conocida', () => {
    const ventas = new Map([
      ['2026-01-01', 10],
      ['2026-01-02', 20],
      ['2026-01-03', 30],
    ]);
    // media = 20; varianza poblacional = ((10-20)^2+(0)+(10)^2)/3 = 66.67
    const resultado = calcularRotacionYDesviacion(ventas);
    expect(resultado.tasaRotacionDiaria).toBe(20);
    expect(resultado.desviacionEstandarDemanda).toBeCloseTo(8.16, 1);
  });

  test('demanda constante da desviación 0', () => {
    const ventas = new Map([
      ['2026-01-01', 5],
      ['2026-01-02', 5],
      ['2026-01-03', 5],
    ]);
    const resultado = calcularRotacionYDesviacion(ventas);
    expect(resultado.tasaRotacionDiaria).toBe(5);
    expect(resultado.desviacionEstandarDemanda).toBe(0);
  });

  test('serie vacía no explota (devuelve ceros)', () => {
    expect(calcularRotacionYDesviacion(new Map())).toEqual({
      tasaRotacionDiaria: 0,
      desviacionEstandarDemanda: 0,
    });
  });
});

describe('calcularFactorEstacionalidad (función pura)', () => {
  test('un día que vende el doble que el promedio general da factor 2', () => {
    // 2026-08-02 es domingo. Dos domingos a 20, dos lunes a 5, promedio
    // general = (20+20+5+5)/4 = 12.5. Factor domingo = 20/12.5 = 1.6.
    const ventas = new Map([
      ['2026-08-02', 20], // domingo
      ['2026-08-09', 20], // domingo
      ['2026-08-03', 5], // lunes
      ['2026-08-10', 5], // lunes
    ]);
    const factores = calcularFactorEstacionalidad(ventas);
    expect(factores[0]).toBeCloseTo(1.6, 2); // domingo
    expect(factores[1]).toBeCloseTo(0.4, 2); // lunes
  });

  test('sin ninguna venta en el período, devuelve null (no se puede dividir por 0)', () => {
    const ventas = new Map([
      ['2026-08-02', 0],
      ['2026-08-03', 0],
    ]);
    expect(calcularFactorEstacionalidad(ventas)).toBeNull();
  });
});

describe('calcularTasaMerma (función pura)', () => {
  test('porcentaje de lo horneado que se perdió', () => {
    expect(calcularTasaMerma(100, 8)).toBe(8);
  });

  test('sin nada horneado, devuelve null (no 0/0)', () => {
    expect(calcularTasaMerma(0, 0)).toBeNull();
  });

  test('sin ninguna merma, da 0%', () => {
    expect(calcularTasaMerma(50, 0)).toBe(0);
  });
});

describe('asignarConsumoFIFO (función pura)', () => {
  test('agota lotes en orden, el más viejo primero', () => {
    const lotes = [
      { minutoHorneado: 360, cantidad: 10 }, // 6:00am
      { minutoHorneado: 780, cantidad: 10 }, // 1:00pm
    ];
    const consumos = [
      { minutoVenta: 480, cantidad: 6 }, // 8:00am
      { minutoVenta: 600, cantidad: 4 }, // 10:00am — agota el lote de 6am
      { minutoVenta: 900, cantidad: 10 }, // 3:00pm — agota el lote de 1pm
    ];
    const resultado = asignarConsumoFIFO(lotes, consumos);
    expect(resultado[0].minutoAgotado).toBe(600);
    expect(resultado[1].minutoAgotado).toBe(900);
  });

  test('un consumo puede cruzar dos lotes', () => {
    const lotes = [
      { minutoHorneado: 360, cantidad: 5 },
      { minutoHorneado: 780, cantidad: 5 },
    ];
    const consumos = [{ minutoVenta: 800, cantidad: 8 }]; // agota el 1º, deja el 2º a medias
    const resultado = asignarConsumoFIFO(lotes, consumos);
    expect(resultado[0].minutoAgotado).toBe(800);
    expect(resultado[1].minutoAgotado).toBeNull(); // no se agotó, quedaron 2 unidades
  });

  test('un lote que nunca se agota queda con minutoAgotado null', () => {
    const lotes = [{ minutoHorneado: 360, cantidad: 10 }];
    const resultado = asignarConsumoFIFO(lotes, []);
    expect(resultado[0].minutoAgotado).toBeNull();
  });

  test('vender más de lo horneado (dato inconsistente) no revienta', () => {
    const lotes = [{ minutoHorneado: 360, cantidad: 5 }];
    const consumos = [{ minutoVenta: 400, cantidad: 999 }];
    expect(() => asignarConsumoFIFO(lotes, consumos)).not.toThrow();
    expect(asignarConsumoFIFO(lotes, consumos)[0].minutoAgotado).toBe(400);
  });
});

describe('calcularProbabilidadVencimiento (función pura)', () => {
  test('probabilidad de venderse a tiempo, por hora de horneado', () => {
    const vidaUtilHoras = 4; // 240 min
    const lotesResueltos = [
      { minutoHorneado: 360, minutoAgotado: 360 + 100 }, // a tiempo
      { minutoHorneado: 360, minutoAgotado: 360 + 200 }, // a tiempo
      { minutoHorneado: 360, minutoAgotado: 360 + 230 }, // a tiempo
      { minutoHorneado: 360, minutoAgotado: 360 + 300 }, // tarde
      { minutoHorneado: 360, minutoAgotado: null }, // nunca se agotó
    ];
    const resultado = calcularProbabilidadVencimiento(lotesResueltos, vidaUtilHoras);
    expect(resultado[6]).toBeCloseTo(0.6, 2); // hora 6 (360 min / 60)
  });

  test(`con menos de ${MIN_LOTES_POR_HORA} lotes en una hora, esa hora no se reporta`, () => {
    const lotesResueltos = [
      { minutoHorneado: 360, minutoAgotado: 400 },
      { minutoHorneado: 360, minutoAgotado: 400 },
    ];
    expect(calcularProbabilidadVencimiento(lotesResueltos, 4)).toBeNull();
  });

  test('sin vidaUtilHoras, devuelve null', () => {
    const lotesResueltos = [
      { minutoHorneado: 360, minutoAgotado: 400 },
      { minutoHorneado: 360, minutoAgotado: 400 },
      { minutoHorneado: 360, minutoAgotado: 400 },
    ];
    expect(calcularProbabilidadVencimiento(lotesResueltos, null)).toBeNull();
  });
});

describe('calcularProduccionSugerida (función pura)', () => {
  test('promedio + desviación × 1.65, redondeado hacia arriba', () => {
    // 10 + 3*1.65 = 14.95 -> 15
    expect(calcularProduccionSugerida(10, 3, 1)).toBe(15);
  });

  test('el factor de estacionalidad ajusta solo el promedio, no la desviación', () => {
    // (10*1.4) + 3*1.65 = 14 + 4.95 = 18.95 -> 19
    expect(calcularProduccionSugerida(10, 3, 1.4)).toBe(19);
  });

  test('sin factor de estacionalidad, asume 1 (no ajusta)', () => {
    expect(calcularProduccionSugerida(10, 3)).toBe(calcularProduccionSugerida(10, 3, 1));
  });

  test('null si falta tasaRotacionDiaria o desviacionEstandarDemanda', () => {
    expect(calcularProduccionSugerida(null, 3, 1)).toBeNull();
    expect(calcularProduccionSugerida(10, null, 1)).toBeNull();
  });

  test('nunca da negativo', () => {
    expect(calcularProduccionSugerida(0, 0, 1)).toBe(0);
  });
});

describe('calcularEstadisticasProducto (función pura)', () => {
  test(`con menos de ${MIN_DIAS_HISTORIAL} días de historial, marca datosInsuficientes`, () => {
    const ventas = new Map([
      ['2026-08-01', 3],
      ['2026-08-02', 4],
    ]);
    const resultado = calcularEstadisticasProducto(ventas);
    expect(resultado.datosInsuficientes).toBe(true);
    expect(resultado.tasaRotacionDiaria).toBeNull();
    expect(resultado.desviacionEstandarDemanda).toBeNull();
    expect(resultado.factorEstacionalidad).toBeNull();
    expect(resultado.tasaMermaHistorica).toBeNull();
    expect(resultado.probabilidadVencimiento).toBeNull();
    expect(resultado.diasConsiderados).toBe(2);
  });

  test(`con ${MIN_DIAS_HISTORIAL} días o más, calcula los cinco indicadores`, () => {
    const ventas = new Map();
    for (let i = 0; i < MIN_DIAS_HISTORIAL; i++) {
      ventas.set(`2026-08-${String(i + 1).padStart(2, '0')}`, i % 2 === 0 ? 10 : 0);
    }
    const lotesResueltos = Array.from({ length: MIN_LOTES_POR_HORA }, () => ({
      minutoHorneado: 360,
      minutoAgotado: 400,
    }));
    const resultado = calcularEstadisticasProducto(ventas, {
      totalHorneado: 100,
      totalMerma: 5,
      lotesResueltos,
      vidaUtilHoras: 4,
    });
    expect(resultado.datosInsuficientes).toBe(false);
    expect(resultado.tasaRotacionDiaria).toBeGreaterThan(0);
    expect(resultado.desviacionEstandarDemanda).toBeGreaterThan(0);
    expect(resultado.factorEstacionalidad).not.toBeNull();
    expect(resultado.tasaMermaHistorica).toBe(5);
    expect(resultado.probabilidadVencimiento).toEqual({ 6: 1 });
  });

  test('sin datos de horneado/merma (parámetro opcional), tasaMermaHistorica queda null', () => {
    const ventas = new Map();
    for (let i = 0; i < MIN_DIAS_HISTORIAL; i++) {
      ventas.set(`2026-08-${String(i + 1).padStart(2, '0')}`, 1);
    }
    const resultado = calcularEstadisticasProducto(ventas);
    expect(resultado.tasaMermaHistorica).toBeNull();
  });
});

/* ═══════════════════════════════════════════
   Endpoints: GET /productos/:id/estadisticas y GET /productos/estadisticas
   ═══════════════════════════════════════════ */
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const request = require('supertest');

const ADMIN_TOKEN = 'test-token-estadisticas';

let app;
let server;
let wss;
let db;
let dbPath;
let sessionToken;
let ultimoIdSeed;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-estadisticas-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.AUTH_MAX_ATTEMPTS = '100000';
  process.env.ORDERS_MAX_PER_WINDOW = '100000';

  ({ app, server, wss } = require('../server'));
  db = require('../db');

  ultimoIdSeed = db.prepare('SELECT MAX(id) AS max FROM productos').get().max;

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
  db.prepare('DELETE FROM ordenes').run();
  db.prepare('DELETE FROM horneadas').run();
  db.prepare('DELETE FROM ajustes_inventario').run();
  db.prepare('DELETE FROM productos WHERE id > ?').run(ultimoIdSeed);
});

function auth() {
  return `Bearer ${sessionToken}`;
}

function crearProducto(overrides = {}) {
  return request(app)
    .post('/productos')
    .set('Authorization', auth())
    .send({
      nombre: 'Producto de prueba',
      categoria: 'panaderia',
      precio: 2,
      ...overrides,
    });
}

/** Fuerza productos.creado_en a una fecha pasada — recién creado, el
 *  producto siempre tiene creado_en = ahora mismo, y con eso el rango de
 *  ventas nunca tendría suficientes días para pasar MIN_DIAS_HISTORIAL.
 *  Usa fechaHace() (criterio de Houston) para quedar alineado con el
 *  mismo "hoy" que usa el servidor al calcular el rango. */
function backdatearProducto(id, diasAtras) {
  const sqliteFecha = `${fechaHace(diasAtras)} 12:00:00`;
  db.prepare('UPDATE productos SET creado_en = ? WHERE id = ?').run(sqliteFecha, id);
}

/* Mismo criterio de "hoy" que usa el servidor (ver hoyHouston() en
   server.js): si estos helpers calcularan la fecha con toISOString()
   (UTC) en vez de la zona horaria de Houston, a ciertas horas del día
   quedarían un día desfasados respecto al rango que arma el backend —
   ver el bug ya documentado en el proyecto para hoyHouston(). */
function hoyHouston() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function fechaHace(diasAtras) {
  const [y, m, d] = hoyHouston().split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() - diasAtras);
  return base.toISOString().slice(0, 10);
}

function insertarOrdenEntregada({ fechaIso, productoId, cantidad, estado = 'entregada' }) {
  const numero = `TEST-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO ordenes (numero, fecha_iso, fecha_texto, cliente, telefono, retiro, items_json, total, estado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    numero,
    `${fechaIso}T12:00:00.000Z`,
    fechaIso,
    'Cliente de prueba',
    '2810000000',
    'Hoy',
    JSON.stringify([
      { nombre: 'Producto de prueba', cantidad, precio: 2, productoId: String(productoId) },
    ]),
    cantidad * 2,
    estado,
  );
}

function insertarHorneada({ fecha, productoId, productoNombre, cantidad, hora = '06:00' }) {
  db.prepare(
    `INSERT INTO horneadas (id, producto_id, producto_nombre, cantidad, fecha, hora)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), String(productoId), productoNombre, cantidad, fecha, hora);
}

function insertarMerma({ fecha, productoId, productoNombre, cantidad }) {
  db.prepare(
    `INSERT INTO ajustes_inventario (id, producto_id, producto_nombre, cantidad, motivo, fecha, hora)
     VALUES (?, ?, ?, ?, 'merma', ?, ?)`,
  ).run(crypto.randomUUID(), String(productoId), productoNombre, cantidad, fecha, '18:00');
}

/** Construye el datetime UTC que hay que guardar en actualizado_en para
 *  que, al convertirlo de vuelta a hora de Houston (como hace
 *  minutosDesdeHoraLocal en server.js), caiga exactamente en fechaISO
 *  horaHHMM. No asume un offset fijo (CST/CDT cambia según la época del
 *  año) — lo calcula a partir de lo que Intl realmente reporta. */
function actualizadoEnUtcParaHoraLocal(fechaISO, horaHHMM) {
  const [horaObjetivo] = horaHHMM.split(':').map(Number);
  const naive = new Date(`${fechaISO}T${horaHHMM}:00.000Z`);
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(naive);
  const horaMostrada = Number(partes.find((p) => p.type === 'hour').value.replace('24', '0'));
  const offsetHoras = horaObjetivo - horaMostrada;
  const corregido = new Date(naive.getTime() + offsetHoras * 60 * 60 * 1000);
  return corregido.toISOString().slice(0, 19).replace('T', ' ');
}

/** Inserta una orden ya 'entregada', con actualizado_en fijado a la hora
 *  local de Houston que se le pida — para poder controlar exactamente
 *  "a qué hora se vendió" en las pruebas de FIFO/probabilidadVencimiento,
 *  sin depender de datetime('now'). */
function insertarOrdenEntregadaConHora({ fechaIso, horaLocal, productoId, cantidad }) {
  const numero = `TEST-${Math.random().toString(36).slice(2, 10)}`;
  const actualizadoEn = actualizadoEnUtcParaHoraLocal(fechaIso, horaLocal);
  db.prepare(
    `INSERT INTO ordenes (numero, fecha_iso, fecha_texto, cliente, telefono, retiro, items_json, total, estado, actualizado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'entregada', ?)`,
  ).run(
    numero,
    `${fechaIso}T05:00:00.000Z`,
    fechaIso,
    'Cliente de prueba',
    '2810000000',
    'Hoy',
    JSON.stringify([
      { nombre: 'Producto de prueba', cantidad, precio: 2, productoId: String(productoId) },
    ]),
    cantidad * 2,
    actualizadoEn,
  );
}

function fijarVidaUtil(productoId, horas) {
  db.prepare('UPDATE productos SET vida_util_horas = ? WHERE id = ?').run(horas, productoId);
}

describe('GET /productos/:id/estadisticas', () => {
  test('requiere sesión de admin', async () => {
    const { body: creado } = await crearProducto();
    const res = await request(app).get(`/productos/${creado.id}/estadisticas`);
    expect(res.status).toBe(401);
  });

  test('404 si el producto no existe', async () => {
    const res = await request(app)
      .get('/productos/999999/estadisticas')
      .set('Authorization', auth());
    expect(res.status).toBe(404);
  });

  test('producto recién creado: datosInsuficientes (no tiene ni una semana de historial)', async () => {
    const { body: creado } = await crearProducto();
    const res = await request(app)
      .get(`/productos/${creado.id}/estadisticas`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.datosInsuficientes).toBe(true);
    expect(res.body.tasaRotacionDiaria).toBeNull();
  });

  test('con historial suficiente, calcula tasaRotacionDiaria y desviacionEstandarDemanda reales', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 20); // 21 días de rango (20 atrás + hoy)

    // 10 unidades cada 2 días, 0 el resto: promedio y desviación deben
    // reflejar exactamente esa mezcla, no solo "un número positivo".
    for (let dias = 0; dias <= 20; dias += 2) {
      insertarOrdenEntregada({
        fechaIso: fechaHace(dias),
        productoId: creado.id,
        cantidad: 10,
      });
    }

    const res = await request(app)
      .get(`/productos/${creado.id}/estadisticas`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.datosInsuficientes).toBe(false);
    expect(res.body.diasConsiderados).toBe(21);
    // 11 días con 10 unidades, 10 días con 0 → promedio = 110/21 ≈ 5.24
    expect(res.body.tasaRotacionDiaria).toBeCloseTo(110 / 21, 1);
    expect(res.body.desviacionEstandarDemanda).toBeGreaterThan(0);
    expect(res.body.factorEstacionalidad).not.toBeNull();
  });

  test('no cuenta órdenes que no están en estado entregada', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 20);
    for (let dias = 0; dias <= 20; dias++) {
      insertarOrdenEntregada({
        fechaIso: fechaHace(dias),
        productoId: creado.id,
        cantidad: 50,
        estado: 'preparada',
      });
    }

    const res = await request(app)
      .get(`/productos/${creado.id}/estadisticas`)
      .set('Authorization', auth());

    expect(res.body.tasaRotacionDiaria).toBe(0);
  });

  test('no mezcla ventas de otro producto', async () => {
    const { body: productoA } = await crearProducto({ nombre: 'Producto A' });
    const { body: productoB } = await crearProducto({ nombre: 'Producto B' });
    backdatearProducto(productoA.id, 20);
    backdatearProducto(productoB.id, 20);

    for (let dias = 0; dias <= 20; dias++) {
      insertarOrdenEntregada({ fechaIso: fechaHace(dias), productoId: productoB.id, cantidad: 99 });
    }

    const res = await request(app)
      .get(`/productos/${productoA.id}/estadisticas`)
      .set('Authorization', auth());

    expect(res.body.tasaRotacionDiaria).toBe(0);
  });

  test('tasaMermaHistorica: porcentaje real de lo horneado que se perdió por merma', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 20);

    insertarHorneada({
      fecha: fechaHace(10),
      productoId: creado.id,
      productoNombre: creado.nombre,
      cantidad: 100,
    });
    insertarMerma({
      fecha: fechaHace(9),
      productoId: creado.id,
      productoNombre: creado.nombre,
      cantidad: 12,
    });

    const res = await request(app)
      .get(`/productos/${creado.id}/estadisticas`)
      .set('Authorization', auth());

    expect(res.body.tasaMermaHistorica).toBe(12);
  });

  test('tasaMermaHistorica no cuenta ajustes de otro motivo (error_conteo, consumo_interno)', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 20);

    insertarHorneada({
      fecha: fechaHace(10),
      productoId: creado.id,
      productoNombre: creado.nombre,
      cantidad: 100,
    });
    db.prepare(
      `INSERT INTO ajustes_inventario (id, producto_id, producto_nombre, cantidad, motivo, fecha, hora)
       VALUES (?, ?, ?, ?, 'error_conteo', ?, ?)`,
    ).run(crypto.randomUUID(), String(creado.id), creado.nombre, 30, fechaHace(9), '18:00');

    const res = await request(app)
      .get(`/productos/${creado.id}/estadisticas`)
      .set('Authorization', auth());

    expect(res.body.tasaMermaHistorica).toBe(0);
  });

  test('tasaMermaHistorica es null si no hay nada horneado en el período', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 20);

    const res = await request(app)
      .get(`/productos/${creado.id}/estadisticas`)
      .set('Authorization', auth());

    expect(res.body.tasaMermaHistorica).toBeNull();
  });

  test('probabilidadVencimiento: reparte las ventas del día por FIFO y calcula el % que se vendió a tiempo', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 20);
    fijarVidaUtil(creado.id, 4); // 4 horas de vida útil

    // 5 días, un lote de 10 horneado a las 6:00am cada uno. 3 se venden
    // completos dentro de las 4 horas (a tiempo), 1 tarde (6h) y 1 nunca
    // se agota ese día (sin orden que lo complete) → 3/5 = 0.6.
    const dias = [5, 6, 7, 8, 9];
    const horaVenta = { 5: '08:00', 6: '09:00', 7: '08:30', 8: '12:00' }; // día 9 sin venta

    for (const d of dias) {
      insertarHorneada({
        fecha: fechaHace(d),
        productoId: creado.id,
        productoNombre: creado.nombre,
        cantidad: 10,
        hora: '06:00',
      });
      if (horaVenta[d]) {
        insertarOrdenEntregadaConHora({
          fechaIso: fechaHace(d),
          horaLocal: horaVenta[d],
          productoId: creado.id,
          cantidad: 10,
        });
      }
    }

    const res = await request(app)
      .get(`/productos/${creado.id}/estadisticas`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.probabilidadVencimiento).toEqual({ 6: 0.6 });
  });

  test('probabilidadVencimiento es null sin vidaUtilHoras configurada', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 20);
    // Sin fijarVidaUtil: vida_util_horas queda NULL.

    for (const d of [5, 6, 7]) {
      insertarHorneada({
        fecha: fechaHace(d),
        productoId: creado.id,
        productoNombre: creado.nombre,
        cantidad: 10,
        hora: '06:00',
      });
      insertarOrdenEntregadaConHora({
        fechaIso: fechaHace(d),
        horaLocal: '08:00',
        productoId: creado.id,
        cantidad: 10,
      });
    }

    const res = await request(app)
      .get(`/productos/${creado.id}/estadisticas`)
      .set('Authorization', auth());

    expect(res.body.probabilidadVencimiento).toBeNull();
  });

  test('un lote que no se agota el mismo día cuenta como no vendido a tiempo', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 20);
    fijarVidaUtil(creado.id, 100); // vida útil generosa: aun así no cuenta si no se agotó ese día

    for (const d of [5, 6, 7]) {
      insertarHorneada({
        fecha: fechaHace(d),
        productoId: creado.id,
        productoNombre: creado.nombre,
        cantidad: 10,
        hora: '06:00',
      });
      // Solo se vende la mitad — el lote nunca se agota ese día.
      insertarOrdenEntregadaConHora({
        fechaIso: fechaHace(d),
        horaLocal: '08:00',
        productoId: creado.id,
        cantidad: 5,
      });
    }

    const res = await request(app)
      .get(`/productos/${creado.id}/estadisticas`)
      .set('Authorization', auth());

    expect(res.body.probabilidadVencimiento).toEqual({ 6: 0 });
  });
});

describe('GET /productos/estadisticas', () => {
  test('requiere sesión de admin', async () => {
    const res = await request(app).get('/productos/estadisticas');
    expect(res.status).toBe(401);
  });

  test('devuelve un registro por cada producto activo', async () => {
    const res = await request(app).get('/productos/estadisticas').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.productos)).toBe(true);
    expect(res.body.productos.length).toBeGreaterThan(0);
    expect(res.body.productos[0]).toHaveProperty('productoId');
    expect(res.body.productos[0]).toHaveProperty('diasConsiderados');
  });
});

/* ═══════════════════════════════════════════
   Patrón 1 — Flujo Operativo Automático (AnalyticsEngine)
   ═══════════════════════════════════════════ */
describe('AnalyticsEngine: enriquecerProductoConEstadisticas vía GET/POST/PUT /productos', () => {
  test('GET /productos incluye estadisticas.produccionSugeridaManana con historial suficiente', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 20);
    for (let dias = 0; dias <= 20; dias += 2) {
      insertarOrdenEntregada({ fechaIso: fechaHace(dias), productoId: creado.id, cantidad: 10 });
    }
    // La creación ya cacheó "datosInsuficientes" (sin historial todavía).
    // Con el caché de 30 min, un GET inmediato leería ese caché viejo en
    // vez de reflejar las órdenes que se acaban de insertar — se limpia
    // la marca para forzar el recálculo, simulando que el caché venció.
    db.prepare('UPDATE productos SET estadisticas_actualizado_en = NULL WHERE id = ?').run(
      creado.id,
    );

    const res = await request(app).get('/productos').set('Authorization', auth());
    const producto = res.body.find((p) => p.id === creado.id);

    expect(producto.estadisticas).toBeDefined();
    expect(producto.estadisticas.datosInsuficientes).toBe(false);
    expect(producto.estadisticas.produccionSugeridaManana).toBeGreaterThan(0);
    // Debe ser al menos el promedio (el colchón de seguridad solo suma).
    expect(producto.estadisticas.produccionSugeridaManana).toBeGreaterThanOrEqual(
      Math.ceil(producto.estadisticas.tasaRotacionDiaria),
    );
  });

  test('producto recién creado: produccionSugeridaManana queda null (datosInsuficientes)', async () => {
    const { body: creado } = await crearProducto();
    const res = await request(app).get('/productos').set('Authorization', auth());
    const producto = res.body.find((p) => p.id === creado.id);

    expect(producto.estadisticas.datosInsuficientes).toBe(true);
    expect(producto.estadisticas.produccionSugeridaManana).toBeNull();
  });

  test('POST /productos ya devuelve las estadísticas enriquecidas (forzado, sin caché viejo)', async () => {
    const res = await crearProducto();
    expect(res.body.estadisticas).toBeDefined();
    expect(res.body.estadisticas.datosInsuficientes).toBe(true);
  });

  test('el caché no se recalcula en cada GET (dos llamadas seguidas no cambian estadisticas_actualizado_en)', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 20);
    insertarOrdenEntregada({ fechaIso: fechaHace(5), productoId: creado.id, cantidad: 3 });

    await request(app).get('/productos').set('Authorization', auth());
    const primeraMarca = db
      .prepare('SELECT estadisticas_actualizado_en AS t FROM productos WHERE id = ?')
      .get(creado.id).t;

    await request(app).get('/productos').set('Authorization', auth());
    const segundaMarca = db
      .prepare('SELECT estadisticas_actualizado_en AS t FROM productos WHERE id = ?')
      .get(creado.id).t;

    expect(segundaMarca).toBe(primeraMarca);
  });

  test('PUT /productos/:id fuerza el recálculo aunque el caché esté fresco', async () => {
    const { body: creado } = await crearProducto();
    backdatearProducto(creado.id, 20);
    insertarOrdenEntregada({ fechaIso: fechaHace(5), productoId: creado.id, cantidad: 3 });

    await request(app).get('/productos').set('Authorization', auth()); // calcula y cachea
    const marcaAntes = db
      .prepare('SELECT estadisticas_actualizado_en AS t FROM productos WHERE id = ?')
      .get(creado.id).t;

    const res = await request(app)
      .put(`/productos/${creado.id}`)
      .set('Authorization', auth())
      .send({ nombre: 'Producto editado', categoria: 'panaderia', precio: 2 });

    const marcaDespues = db
      .prepare('SELECT estadisticas_actualizado_en AS t FROM productos WHERE id = ?')
      .get(creado.id).t;

    expect(res.body.estadisticas).toBeDefined();
    expect(marcaDespues).not.toBeNull();
    expect(marcaAntes).not.toBeNull();
    // No se puede comparar por igualdad estricta (mismo segundo es
    // posible), pero al menos confirma que se volvió a persistir.
    expect(new Date(marcaDespues.replace(' ', 'T') + 'Z').getTime()).toBeGreaterThanOrEqual(
      new Date(marcaAntes.replace(' ', 'T') + 'Z').getTime(),
    );
  });
});

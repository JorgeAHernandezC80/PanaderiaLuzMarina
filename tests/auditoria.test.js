/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const ADMIN_TOKEN = 'test-token-auditoria';

let app;
let server;
let wss;
let db;
let Auditoria;
let dbPath;
let sessionToken;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-auditoria-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.AUTH_MAX_ATTEMPTS = '100000';
  process.env.ORDERS_MAX_PER_WINDOW = '100000';

  ({ app, server, wss } = require('../server'));
  db = require('../db');
  Auditoria = require('../auditoria');

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

describe('calcularHash (función pura)', () => {
  test('es determinístico: mismo contenido, mismo hash', () => {
    const bloque = {
      entidad: 'productos',
      entidadId: '1',
      accion: 'crear',
      datos: { precio: 2.5 },
      actualizadoPor: 'Ana',
      creadoEn: '2026-08-05T10:00:00.000Z',
    };
    const h1 = Auditoria.calcularHash(Auditoria.HASH_GENESIS, bloque);
    const h2 = Auditoria.calcularHash(Auditoria.HASH_GENESIS, bloque);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
  });

  test('cualquier cambio en el contenido cambia el hash', () => {
    const base = {
      entidad: 'productos',
      entidadId: '1',
      accion: 'crear',
      datos: { precio: 2.5 },
      actualizadoPor: 'Ana',
      creadoEn: '2026-08-05T10:00:00.000Z',
    };
    const hOriginal = Auditoria.calcularHash(Auditoria.HASH_GENESIS, base);
    const hPrecioDistinto = Auditoria.calcularHash(Auditoria.HASH_GENESIS, {
      ...base,
      datos: { precio: 1.0 },
    });
    expect(hPrecioDistinto).not.toBe(hOriginal);
  });

  test('un hash anterior distinto también cambia el resultado', () => {
    const bloque = {
      entidad: 'productos',
      entidadId: '1',
      accion: 'crear',
      datos: { precio: 2.5 },
      actualizadoPor: 'Ana',
      creadoEn: '2026-08-05T10:00:00.000Z',
    };
    const h1 = Auditoria.calcularHash('hash-anterior-a', bloque);
    const h2 = Auditoria.calcularHash('hash-anterior-b', bloque);
    expect(h1).not.toBe(h2);
  });
});

describe('registrarEnCadena + verificarCadena', () => {
  test('cada bloque nuevo enlaza con el hash del anterior', () => {
    const antes = db.prepare('SELECT hash FROM auditoria_cadena ORDER BY id DESC LIMIT 1').get();

    const hash1 = Auditoria.registrarEnCadena({
      entidad: 'test',
      entidadId: 'a1',
      accion: 'crear',
      datos: { x: 1 },
      actualizadoPor: 'Test',
    });
    const hash2 = Auditoria.registrarEnCadena({
      entidad: 'test',
      entidadId: 'a1',
      accion: 'actualizar',
      datos: { x: 2 },
      actualizadoPor: 'Test',
    });

    const filaHash2 = db
      .prepare('SELECT hash_anterior FROM auditoria_cadena WHERE hash = ?')
      .get(hash2);
    expect(filaHash2.hash_anterior).toBe(hash1);

    const filaHash1 = db
      .prepare('SELECT hash_anterior FROM auditoria_cadena WHERE hash = ?')
      .get(hash1);
    expect(filaHash1.hash_anterior).toBe(antes ? antes.hash : Auditoria.HASH_GENESIS);
  });

  test('una cadena sin alterar se verifica como íntegra', () => {
    Auditoria.registrarEnCadena({
      entidad: 'test',
      entidadId: 'a2',
      accion: 'crear',
      datos: { y: 1 },
      actualizadoPor: null,
    });
    const resultado = Auditoria.verificarCadena();
    expect(resultado.integra).toBe(true);
    expect(resultado.totalBloques).toBeGreaterThan(0);
  });

  test('alterar el campo datos de un bloque viejo (fuera de la API) rompe la verificación', () => {
    const hash = Auditoria.registrarEnCadena({
      entidad: 'test',
      entidadId: 'a3',
      accion: 'crear',
      datos: { z: 100 },
      actualizadoPor: null,
    });
    // Alguien mete la mano directo en la base de datos, sin pasar por la
    // API — exactamente lo que esto tiene que detectar.
    db.prepare('UPDATE auditoria_cadena SET datos = ? WHERE hash = ?').run(
      JSON.stringify({ z: 999999 }),
      hash,
    );

    const resultado = Auditoria.verificarCadena();
    expect(resultado.integra).toBe(false);
    expect(resultado.motivo).toMatch(/alterad/i);
  });

  test('historialDe filtra por entidad y entidadId', () => {
    Auditoria.registrarEnCadena({
      entidad: 'test',
      entidadId: 'filtro-1',
      accion: 'crear',
      datos: {},
      actualizadoPor: null,
    });
    Auditoria.registrarEnCadena({
      entidad: 'test',
      entidadId: 'filtro-2',
      accion: 'crear',
      datos: {},
      actualizadoPor: null,
    });
    const historial = Auditoria.historialDe('test', 'filtro-1');
    expect(historial.length).toBe(1);
    expect(historial[0].entidad_id).toBe('filtro-1');
  });
});

describe('analizarCadena (agrupar/modelar)', () => {
  test('agrupa por entidad y por acción, y arma la línea de tiempo', () => {
    Auditoria.registrarEnCadena({
      entidad: 'grafico-test',
      entidadId: 'g1',
      accion: 'crear',
      datos: {},
      actualizadoPor: null,
    });
    Auditoria.registrarEnCadena({
      entidad: 'grafico-test',
      entidadId: 'g1',
      accion: 'actualizar',
      datos: {},
      actualizadoPor: null,
    });
    Auditoria.registrarEnCadena({
      entidad: 'grafico-test',
      entidadId: 'g2',
      accion: 'crear',
      datos: {},
      actualizadoPor: null,
    });

    const analisis = Auditoria.analizarCadena();

    const entidadTest = analisis.porEntidad.find((e) => e.entidad === 'grafico-test');
    expect(entidadTest.total).toBe(3);

    const accionCrear = analisis.porAccion.find((a) => a.accion === 'crear');
    expect(accionCrear.total).toBeGreaterThanOrEqual(2);

    expect(Array.isArray(analisis.actividadPorDia)).toBe(true);
    expect(analisis.actividadPorDia.length).toBeGreaterThan(0);
    // Formato de fecha YYYY-MM-DD, no el datetime completo.
    expect(analisis.actividadPorDia[0].fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('entidadesMasModificadas identifica el registro con más cambios primero', () => {
    Auditoria.registrarEnCadena({
      entidad: 'ranking-test',
      entidadId: 'r-mucho',
      accion: 'actualizar',
      datos: {},
      actualizadoPor: null,
    });
    Auditoria.registrarEnCadena({
      entidad: 'ranking-test',
      entidadId: 'r-mucho',
      accion: 'actualizar',
      datos: {},
      actualizadoPor: null,
    });
    Auditoria.registrarEnCadena({
      entidad: 'ranking-test',
      entidadId: 'r-mucho',
      accion: 'actualizar',
      datos: {},
      actualizadoPor: null,
    });
    Auditoria.registrarEnCadena({
      entidad: 'ranking-test',
      entidadId: 'r-poco',
      accion: 'crear',
      datos: {},
      actualizadoPor: null,
    });

    const analisis = Auditoria.analizarCadena();
    const top = analisis.entidadesMasModificadas[0];
    expect(top.entidad).toBe('ranking-test');
    expect(top.entidadId).toBe('r-mucho');
    expect(top.total).toBe(3);
  });

  test('incluye el resultado de verificarCadena bajo "integridad"', () => {
    const analisis = Auditoria.analizarCadena();
    expect(analisis.integridad).toEqual(Auditoria.verificarCadena());
  });
});

describe('GET /auditoria/analisis', () => {
  test('requiere sesión de admin', async () => {
    const res = await request(app).get('/auditoria/analisis');
    expect(res.status).toBe(401);
  });

  test('devuelve la misma forma que Auditoria.analizarCadena()', async () => {
    const res = await request(app).get('/auditoria/analisis').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('integridad');
    expect(res.body).toHaveProperty('porEntidad');
    expect(res.body).toHaveProperty('porAccion');
    expect(res.body).toHaveProperty('actividadPorDia');
    expect(res.body).toHaveProperty('entidadesMasModificadas');
  });
});

describe('Integración: cada módulo escribe en la cadena', () => {
  test('crear y editar un producto genera dos bloques enlazados', async () => {
    const { body: creado } = await request(app)
      .post('/productos')
      .set('Authorization', auth())
      .send({ nombre: 'Producto auditado', categoria: 'panaderia', precio: 3 });

    await request(app)
      .put(`/productos/${creado.id}`)
      .set('Authorization', auth())
      .send({ nombre: 'Producto auditado', categoria: 'panaderia', precio: 5 });

    const res = await request(app)
      .get(`/auditoria?entidad=productos&entidadId=${creado.id}`)
      .set('Authorization', auth());

    expect(res.body.bloques.length).toBe(2);
    const [masReciente, original] = res.body.bloques; // más reciente primero
    expect(masReciente.accion).toBe('actualizar');
    expect(masReciente.datos.despues.precio).toBe(5);
    expect(masReciente.datos.antes.precio).toBe(3);
    expect(original.accion).toBe('crear');
    expect(masReciente.hashAnterior).toBe(original.hash);
  });

  test('crear, editar y borrar una horneada genera tres bloques', async () => {
    const { body: horneada } = await request(app)
      .post('/horneadas')
      .set('Authorization', auth())
      .send({
        productoId: '1',
        productoNombre: 'Donuts Glaseadas',
        cantidad: 20,
        fecha: '2026-08-01',
        hora: '06:00',
      });

    await request(app).put(`/horneadas/${horneada.id}`).set('Authorization', auth()).send({
      productoId: '1',
      productoNombre: 'Donuts Glaseadas',
      cantidad: 25,
      fecha: '2026-08-01',
      hora: '06:00',
    });

    await request(app).delete(`/horneadas/${horneada.id}`).set('Authorization', auth());

    const res = await request(app)
      .get(`/auditoria?entidad=horneadas&entidadId=${horneada.id}`)
      .set('Authorization', auth());

    expect(res.body.bloques.map((b) => b.accion)).toEqual(['eliminar', 'actualizar', 'crear']);
  });

  test('crear un ajuste de inventario genera un bloque', async () => {
    const { body: ajuste } = await request(app)
      .post('/ajustes-inventario')
      .set('Authorization', auth())
      .send({
        productoId: '1',
        productoNombre: 'Donuts Glaseadas',
        cantidad: 3,
        motivo: 'merma',
        fecha: '2026-08-01',
        hora: '18:00',
      });

    const res = await request(app)
      .get(`/auditoria?entidad=ajustes_inventario&entidadId=${ajuste.id}`)
      .set('Authorization', auth());

    expect(res.body.bloques.length).toBe(1);
    expect(res.body.bloques[0].datos.motivo).toBe('merma');
  });
});

describe('GET /auditoria y GET /auditoria/verificar', () => {
  test('ambos requieren sesión de admin', async () => {
    expect((await request(app).get('/auditoria')).status).toBe(401);
    expect((await request(app).get('/auditoria/verificar')).status).toBe(401);
  });

  test('GET /auditoria sin filtro trae los bloques más recientes primero', async () => {
    const res = await request(app).get('/auditoria').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.bloques)).toBe(true);
    if (res.body.bloques.length > 1) {
      const [primero, segundo] = res.body.bloques;
      expect(primero.id).toBeGreaterThan(segundo.id);
    }
  });

  test('GET /auditoria/verificar refleja el estado real de la cadena', async () => {
    const res = await request(app).get('/auditoria/verificar').set('Authorization', auth());
    expect(res.status).toBe(200);
    // El bloque de la prueba "alterar el campo datos..." de arriba dejó
    // la cadena de este archivo de pruebas rota a propósito y sin
    // reparar — el endpoint tiene que seguir reportándolo como tal, no
    // solo la función interna.
    expect(res.body.integra).toBe(false);
    expect(res.body).toHaveProperty('rotoEnId');
  });
});

/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const ADMIN_TOKEN = 'test-token-recetas';

let app;
let server;
let wss;
let db;
let dbPath;
let sessionToken;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-recetas-${process.pid}-${Date.now()}.db`);
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
  db.exec('DELETE FROM produccion_etapas');
  db.exec('DELETE FROM produccion_ingredientes');
  db.exec('DELETE FROM producciones');
  db.exec('DELETE FROM receta_ingredientes');
  db.exec('DELETE FROM recetas');
  db.exec('DELETE FROM horneadas');
  db.exec('DELETE FROM insumos');
});

function auth() {
  return `Bearer ${sessionToken}`;
}

/** Crea un insumo real vía la API (Recetas/Producción exigen que cada
 *  ingrediente exista de verdad en el catálogo, no aceptan texto libre). */
async function crearInsumo(overrides = {}) {
  const res = await request(app)
    .post('/insumos')
    .set('Authorization', auth())
    .send({
      nombre: 'Harina de trigo',
      categoria: 'harinas',
      cantidad: 50,
      unidad: 'kg',
      costoUnitario: 0.88,
      stockMinimo: 10,
      ...overrides,
    });
  return res.body;
}

function recetaValida(insumoId, overrides = {}) {
  return {
    productoId: 6, // Pandebono
    pesoMasaPorUnidadG: 50,
    tiempoFermentacionMin: 90,
    notas: 'Receta base',
    ingredientes: [{ insumoId, gramos: 500 }],
    ...overrides,
  };
}

function produccionValida(insumoId, overrides = {}) {
  return {
    productoId: 6,
    fecha: '2026-07-28',
    horaInicio: '05:00',
    registradoPor: 'María',
    notas: '',
    ingredientes: [{ insumoId, gramos: 1000 }],
    ...overrides,
  };
}

describe('Autenticación de Recetas y Producción', () => {
  test.each([
    ['get', '/recetas'],
    ['post', '/recetas'],
    ['put', '/recetas/abc'],
    ['delete', '/recetas/abc'],
    ['get', '/producciones'],
    ['post', '/producciones'],
    ['delete', '/producciones/abc'],
    ['post', '/producciones/abc/etapas'],
    ['put', '/producciones/abc/etapas/def'],
  ])('%s %s exige token de sesión', async (method, url) => {
    const res = await request(app)[method](url);
    expect(res.status).toBe(401);
  });
});

describe('POST /recetas', () => {
  test('crea la receta con sus ingredientes', async () => {
    const insumo = await crearInsumo();
    const res = await request(app)
      .post('/recetas')
      .set('Authorization', auth())
      .send(recetaValida(insumo.id));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      productoId: '6',
      productoNombre: 'Pandebono',
      pesoMasaPorUnidadG: 50,
      tiempoFermentacionMin: 90,
    });
    expect(res.body.ingredientes).toHaveLength(1);
    expect(res.body.ingredientes[0]).toMatchObject({
      insumoId: insumo.id,
      insumoNombre: 'Harina de trigo',
      gramos: 500,
    });
  });

  test('rechaza un ingrediente cuyo insumo no existe en el catálogo', async () => {
    const res = await request(app)
      .post('/recetas')
      .set('Authorization', auth())
      .send(recetaValida('id-inventado'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no existe/i);
  });

  test('rechaza un producto inválido', async () => {
    const insumo = await crearInsumo();
    const res = await request(app)
      .post('/recetas')
      .set('Authorization', auth())
      .send(recetaValida(insumo.id, { productoId: 999 }));
    expect(res.status).toBe(400);
  });

  test('rechaza una receta sin ingredientes', async () => {
    const res = await request(app)
      .post('/recetas')
      .set('Authorization', auth())
      .send(recetaValida('x', { ingredientes: [] }));
    expect(res.status).toBe(400);
  });

  test('rechaza crear una segunda receta para el mismo producto', async () => {
    const insumo = await crearInsumo();
    await request(app).post('/recetas').set('Authorization', auth()).send(recetaValida(insumo.id));
    const res = await request(app)
      .post('/recetas')
      .set('Authorization', auth())
      .send(recetaValida(insumo.id));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ya existe/i);
  });
});

describe('PUT /recetas/:id', () => {
  test('actualiza los ingredientes (reemplaza la lista completa)', async () => {
    const insumo1 = await crearInsumo({ nombre: 'Harina de trigo' });
    const insumo2 = await crearInsumo({ nombre: 'Azúcar' });

    const creada = await request(app)
      .post('/recetas')
      .set('Authorization', auth())
      .send(recetaValida(insumo1.id));

    const res = await request(app)
      .put(`/recetas/${creada.body.id}`)
      .set('Authorization', auth())
      .send(
        recetaValida(insumo1.id, {
          ingredientes: [
            { insumoId: insumo1.id, gramos: 500 },
            { insumoId: insumo2.id, gramos: 70 },
          ],
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.ingredientes).toHaveLength(2);
  });

  test('devuelve 404 si la receta no existe', async () => {
    const insumo = await crearInsumo();
    const res = await request(app)
      .put('/recetas/no-existe')
      .set('Authorization', auth())
      .send(recetaValida(insumo.id));
    expect(res.status).toBe(404);
  });
});

describe('DELETE /recetas/:id', () => {
  test('elimina la receta y sus ingredientes', async () => {
    const insumo = await crearInsumo();
    const creada = await request(app)
      .post('/recetas')
      .set('Authorization', auth())
      .send(recetaValida(insumo.id));

    const res = await request(app)
      .delete(`/recetas/${creada.body.id}`)
      .set('Authorization', auth());
    expect(res.status).toBe(204);

    const lista = await request(app).get('/recetas').set('Authorization', auth());
    expect(lista.body).toHaveLength(0);
  });
});

describe('POST /producciones', () => {
  test('calcula el peso total de masa y las unidades estimadas a partir de la receta', async () => {
    const insumo = await crearInsumo();
    await request(app).post('/recetas').set('Authorization', auth()).send(recetaValida(insumo.id));

    const res = await request(app)
      .post('/producciones')
      .set('Authorization', auth())
      .send(produccionValida(insumo.id, { ingredientes: [{ insumoId: insumo.id, gramos: 1000 }] }));

    expect(res.status).toBe(201);
    expect(res.body.pesoTotalMasaG).toBe(1000);
    expect(res.body.unidadesEstimadas).toBe(20); // 1000g / 50g por unidad
    expect(res.body.horneadas).toEqual([]);
  });

  test('rechaza crear una producción si el producto no tiene receta todavía', async () => {
    const insumo = await crearInsumo();
    const res = await request(app)
      .post('/producciones')
      .set('Authorization', auth())
      .send(produccionValida(insumo.id));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no existe una receta/i);
  });

  test('rechaza un ingrediente cuyo insumo no existe', async () => {
    const insumo = await crearInsumo();
    await request(app).post('/recetas').set('Authorization', auth()).send(recetaValida(insumo.id));

    const res = await request(app)
      .post('/producciones')
      .set('Authorization', auth())
      .send(
        produccionValida(insumo.id, { ingredientes: [{ insumoId: 'no-existe', gramos: 500 }] }),
      );
    expect(res.status).toBe(400);
  });

  test('no confía en un peso total o unidades que mande el cliente', async () => {
    const insumo = await crearInsumo();
    await request(app).post('/recetas').set('Authorization', auth()).send(recetaValida(insumo.id));

    const res = await request(app)
      .post('/producciones')
      .set('Authorization', auth())
      .send({
        ...produccionValida(insumo.id, { ingredientes: [{ insumoId: insumo.id, gramos: 500 }] }),
        pesoTotalMasaG: 999999,
        unidadesEstimadas: 999999,
      });

    expect(res.status).toBe(201);
    expect(res.body.pesoTotalMasaG).toBe(500);
    expect(res.body.unidadesEstimadas).toBe(10);
  });
});

describe('GET /producciones', () => {
  test('filtra por fecha', async () => {
    const insumo = await crearInsumo();
    await request(app).post('/recetas').set('Authorization', auth()).send(recetaValida(insumo.id));

    await request(app)
      .post('/producciones')
      .set('Authorization', auth())
      .send(produccionValida(insumo.id, { fecha: '2026-07-28' }));
    await request(app)
      .post('/producciones')
      .set('Authorization', auth())
      .send(produccionValida(insumo.id, { fecha: '2026-07-20' }));

    const res = await request(app)
      .get('/producciones?fecha=2026-07-28')
      .set('Authorization', auth());
    expect(res.body).toHaveLength(1);
  });
});

describe('DELETE /producciones/:id', () => {
  test('elimina la producción y en cascada sus ingredientes y etapas', async () => {
    const insumo = await crearInsumo();
    await request(app).post('/recetas').set('Authorization', auth()).send(recetaValida(insumo.id));
    const creada = await request(app)
      .post('/producciones')
      .set('Authorization', auth())
      .send(produccionValida(insumo.id));

    const res = await request(app)
      .delete(`/producciones/${creada.body.id}`)
      .set('Authorization', auth());
    expect(res.status).toBe(204);

    const restante = db
      .prepare('SELECT COUNT(*) AS n FROM produccion_ingredientes WHERE produccion_id = ?')
      .get(creada.body.id);
    expect(restante.n).toBe(0);
  });
});

describe('Etapas de producción', () => {
  async function crearProduccion() {
    const insumo = await crearInsumo();
    await request(app).post('/recetas').set('Authorization', auth()).send(recetaValida(insumo.id));
    const res = await request(app)
      .post('/producciones')
      .set('Authorization', auth())
      .send(produccionValida(insumo.id));
    return res.body;
  }

  test('inicia una etapa válida', async () => {
    const produccion = await crearProduccion();
    const res = await request(app)
      .post(`/producciones/${produccion.id}/etapas`)
      .set('Authorization', auth())
      .send({ etapa: 'pesado_dosificacion', horaInicio: '05:00' });

    expect(res.status).toBe(201);
    expect(res.body.etapas).toHaveLength(1);
    expect(res.body.etapas[0]).toMatchObject({
      etapa: 'pesado_dosificacion',
      horaInicio: '05:00',
      horaFin: null,
    });
  });

  test('rechaza una etapa fuera de la lista blanca', async () => {
    const produccion = await crearProduccion();
    const res = await request(app)
      .post(`/producciones/${produccion.id}/etapas`)
      .set('Authorization', auth())
      .send({ etapa: 'horneado', horaInicio: '05:00' }); // el horneado no es una etapa de Producción
    expect(res.status).toBe(400);
  });

  test('rechaza iniciar la misma etapa dos veces para la misma producción', async () => {
    const produccion = await crearProduccion();
    await request(app)
      .post(`/producciones/${produccion.id}/etapas`)
      .set('Authorization', auth())
      .send({ etapa: 'amasado', horaInicio: '05:10' });

    const res = await request(app)
      .post(`/producciones/${produccion.id}/etapas`)
      .set('Authorization', auth())
      .send({ etapa: 'amasado', horaInicio: '05:20' });
    expect(res.status).toBe(400);
  });

  test('cierra una etapa ya iniciada', async () => {
    const produccion = await crearProduccion();
    const inicio = await request(app)
      .post(`/producciones/${produccion.id}/etapas`)
      .set('Authorization', auth())
      .send({ etapa: 'amasado', horaInicio: '05:10' });
    const etapaId = inicio.body.etapas[0].id;

    const res = await request(app)
      .put(`/producciones/${produccion.id}/etapas/${etapaId}`)
      .set('Authorization', auth())
      .send({ horaFin: '05:25' });

    expect(res.status).toBe(200);
    expect(res.body.etapas[0]).toMatchObject({ horaInicio: '05:10', horaFin: '05:25' });
  });

  test('devuelve 404 al cerrar una etapa que no existe', async () => {
    const produccion = await crearProduccion();
    const res = await request(app)
      .put(`/producciones/${produccion.id}/etapas/no-existe`)
      .set('Authorization', auth())
      .send({ horaFin: '05:25' });
    expect(res.status).toBe(404);
  });
});

describe('Vínculo Horneadas ↔ Producción', () => {
  async function crearProduccion(productoId = 6) {
    const insumo = await crearInsumo();
    await request(app)
      .post('/recetas')
      .set('Authorization', auth())
      .send(recetaValida(insumo.id, { productoId }));
    const res = await request(app)
      .post('/producciones')
      .set('Authorization', auth())
      .send(produccionValida(insumo.id, { productoId }));
    return res.body;
  }

  test('una horneada puede ligarse a una producción existente', async () => {
    const produccion = await crearProduccion();
    const res = await request(app).post('/horneadas').set('Authorization', auth()).send({
      productoId: 6,
      cantidad: 20,
      fecha: '2026-07-28',
      hora: '06:30',
      produccionId: produccion.id,
    });

    expect(res.status).toBe(201);
    expect(res.body.produccionId).toBe(produccion.id);
  });

  test('rechaza ligar una horneada a una producción que no existe', async () => {
    const res = await request(app).post('/horneadas').set('Authorization', auth()).send({
      productoId: 6,
      cantidad: 20,
      fecha: '2026-07-28',
      hora: '06:30',
      produccionId: 'no-existe',
    });
    expect(res.status).toBe(400);
  });

  test('rechaza ligar una horneada cuyo producto no coincide con el de la producción', async () => {
    const produccion = await crearProduccion(6); // Pandebono
    const res = await request(app).post('/horneadas').set('Authorization', auth()).send({
      productoId: 1, // Donuts Glaseadas — no coincide
      cantidad: 10,
      fecha: '2026-07-28',
      hora: '06:30',
      produccionId: produccion.id,
    });
    expect(res.status).toBe(400);
  });

  test('una horneada sin produccionId sigue funcionando igual que siempre', async () => {
    const res = await request(app)
      .post('/horneadas')
      .set('Authorization', auth())
      .send({ productoId: 6, cantidad: 20, fecha: '2026-07-28', hora: '06:30' });
    expect(res.status).toBe(201);
    expect(res.body.produccionId).toBeNull();
  });

  test('GET /producciones incluye las horneadas ya ligadas a esa tanda', async () => {
    const produccion = await crearProduccion();
    await request(app).post('/horneadas').set('Authorization', auth()).send({
      productoId: 6,
      cantidad: 20,
      fecha: '2026-07-28',
      hora: '06:30',
      produccionId: produccion.id,
    });

    const res = await request(app)
      .get(`/producciones?fecha=2026-07-28`)
      .set('Authorization', auth());
    expect(res.body[0].horneadas).toHaveLength(1);
    expect(res.body[0].horneadas[0].cantidad).toBe(20);
  });
});

/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const ADMIN_TOKEN = 'test-token-productos';

let app;
let server;
let wss;
let db;
let dbPath;
let sessionToken;
/* Último id sembrado por db.js. Los tests crean productos nuevos por encima
   de ese id y solo borran esos en beforeEach: los del seed no se pueden
   borrar (recetas, horneadas, producciones y órdenes los referencian). */
let ultimoIdSeed;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-productos-${process.pid}-${Date.now()}.db`);
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
  db.prepare('DELETE FROM productos WHERE id > ?').run(ultimoIdSeed);
  db.prepare("UPDATE productos SET estado = 'activo', sku = NULL WHERE id <= ?").run(ultimoIdSeed);
});

function auth() {
  return `Bearer ${sessionToken}`;
}

function productoValido(overrides = {}) {
  return {
    nombre: 'Mogolla integral',
    categoria: 'panaderia',
    precio: 3.25,
    ...overrides,
  };
}

function crear(overrides = {}) {
  return request(app)
    .post('/productos')
    .set('Authorization', auth())
    .send(productoValido(overrides));
}

describe('GET /productos', () => {
  test('exige token de sesión', async () => {
    const res = await request(app).get('/productos');
    expect(res.status).toBe(401);
  });

  test('devuelve el catálogo completo, ordenado por nombre', async () => {
    const res = await request(app).get('/productos').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(ultimoIdSeed);
    const nombres = res.body.map((p) => p.nombre);
    expect(nombres).toEqual([...nombres].sort((a, b) => a.localeCompare(b, 'es')));
    expect(res.body[0]).toHaveProperty('estado');
    expect(res.body[0]).toHaveProperty('creadoEn');
  });

  test('incluye los productos que no están activos (el panel los tiene que poder editar)', async () => {
    await request(app)
      .put(`/productos/${ultimoIdSeed}`)
      .set('Authorization', auth())
      .send(productoValido({ nombre: 'Pan retirado', estado: 'descontinuado' }));

    const res = await request(app).get('/productos').set('Authorization', auth());
    expect(res.body.find((p) => p.id === ultimoIdSeed).estado).toBe('descontinuado');
  });
});

describe('POST /productos', () => {
  test('exige token de sesión', async () => {
    const res = await request(app).post('/productos').send(productoValido());
    expect(res.status).toBe(401);
  });

  test('crea el producto y lo devuelve con estado activo por defecto', async () => {
    const res = await crear();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      nombre: 'Mogolla integral',
      categoria: 'panaderia',
      precio: 3.25,
      estado: 'activo',
      sku: null,
      descripcion: null,
    });
    expect(res.body.id).toBeGreaterThan(ultimoIdSeed);
  });

  test('guarda sku, descripcion y actualizadoPor cuando vienen', async () => {
    const res = await crear({
      sku: 'MOG-01',
      descripcion: 'Con salvado de trigo',
      actualizadoPor: 'Ana',
    });
    expect(res.body).toMatchObject({
      sku: 'MOG-01',
      descripcion: 'Con salvado de trigo',
      actualizadoPor: 'Ana',
    });
  });

  test('permite varios productos sin SKU (el UNIQUE no debe chocar entre vacíos)', async () => {
    expect((await crear({ nombre: 'Sin SKU 1', sku: '' })).status).toBe(201);
    expect((await crear({ nombre: 'Sin SKU 2', sku: '' })).status).toBe(201);
  });

  test('responde 409 cuando el SKU ya existe', async () => {
    await crear({ sku: 'DUP-01' });
    const res = await crear({ nombre: 'Otro pan', sku: 'DUP-01' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/SKU/);
  });

  test.each([
    ['nombre vacío', { nombre: '  ' }],
    ['categoría desconocida', { categoria: 'pasteles' }],
    ['precio cero', { precio: 0 }],
    ['precio negativo', { precio: -3 }],
    ['estado desconocido', { estado: 'inactivo' }],
  ])('responde 400 con %s', async (_caso, overrides) => {
    const res = await crear(overrides);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});

describe('PUT /productos/:id', () => {
  test('exige token de sesión', async () => {
    const res = await request(app).put('/productos/1').send(productoValido());
    expect(res.status).toBe(401);
  });

  test('actualiza nombre, precio y estado', async () => {
    const { body: creado } = await crear();
    const res = await request(app)
      .put(`/productos/${creado.id}`)
      .set('Authorization', auth())
      .send(productoValido({ nombre: 'Mogolla grande', precio: 4, estado: 'agotado' }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ nombre: 'Mogolla grande', precio: 4, estado: 'agotado' });
    expect(res.body.id).toBe(creado.id);
  });

  test('conserva estado, sku y descripcion cuando la petición no los trae', async () => {
    const { body: creado } = await crear({
      estado: 'borrador',
      sku: 'MOG-02',
      descripcion: 'Receta vieja',
    });
    const res = await request(app)
      .put(`/productos/${creado.id}`)
      .set('Authorization', auth())
      .send({ nombre: 'Mogolla', categoria: 'panaderia', precio: 3.5 });

    expect(res.body).toMatchObject({
      estado: 'borrador',
      sku: 'MOG-02',
      descripcion: 'Receta vieja',
    });
  });

  test('responde 404 con un id que no existe', async () => {
    const res = await request(app)
      .put('/productos/999999')
      .set('Authorization', auth())
      .send(productoValido());
    expect(res.status).toBe(404);
  });

  test.each(['abc', '0', '-1'])('responde 400 con un id inválido: %p', async (id) => {
    const res = await request(app)
      .put(`/productos/${id}`)
      .set('Authorization', auth())
      .send(productoValido());
    expect(res.status).toBe(400);
  });

  test('responde 409 cuando el SKU ya lo usa otro producto', async () => {
    await crear({ nombre: 'Con SKU', sku: 'OCUPADO' });
    const { body: otro } = await crear({ nombre: 'Sin SKU' });

    const res = await request(app)
      .put(`/productos/${otro.id}`)
      .set('Authorization', auth())
      .send(productoValido({ nombre: 'Sin SKU', sku: 'OCUPADO' }));
    expect(res.status).toBe(409);
  });

  test('responde 400 con datos inválidos', async () => {
    const { body: creado } = await crear();
    const res = await request(app)
      .put(`/productos/${creado.id}`)
      .set('Authorization', auth())
      .send(productoValido({ categoria: 'pasteles' }));
    expect(res.status).toBe(400);
  });
});

describe('GET /catalogo', () => {
  test('es público (el catálogo del cliente no tiene token)', async () => {
    const res = await request(app).get('/catalogo');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.productos)).toBe(true);
  });

  test('expone solo id, nombre, categoria y precio', async () => {
    const res = await request(app).get('/catalogo');
    expect(Object.keys(res.body.productos[0]).sort()).toEqual([
      'categoria',
      'id',
      'nombre',
      'precio',
    ]);
  });

  test('deja fuera los productos que no están activos', async () => {
    const { body: borrador } = await crear({ nombre: 'En pruebas', estado: 'borrador' });
    const { body: activo } = await crear({ nombre: 'A la venta' });

    const res = await request(app).get('/catalogo');
    const ids = res.body.productos.map((p) => p.id);
    expect(ids).toContain(activo.id);
    expect(ids).not.toContain(borrador.id);
  });
});

describe('productos y pedidos', () => {
  /** Pedido de un solo item, con el precio que le pasen. */
  function orden(productoId, nombre, precio) {
    return {
      numero: 'LM-20260728-0001',
      fechaISO: '2026-07-28T10:00:00.000Z',
      fechaTexto: '28 de julio, 2026',
      cliente: 'Cliente de prueba',
      telefono: '3001234567',
      retiro: '11:00',
      items: [{ productoId, nombre, cantidad: 1, precio }],
      total: precio,
    };
  }

  test('acepta un pedido con el precio del catálogo', async () => {
    const { body: producto } = await crear();
    const res = await request(app)
      .post('/ordenes')
      .send(orden(producto.id, producto.nombre, producto.precio));
    expect(res.status).toBe(201);
  });

  test('rechaza un pedido con un precio distinto al del catálogo', async () => {
    const { body: producto } = await crear();
    const res = await request(app)
      .post('/ordenes')
      .send(orden(producto.id, producto.nombre, 0.01));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/precio/i);
  });

  test('rechaza un pedido de un producto que no está activo', async () => {
    const { body: producto } = await crear({ estado: 'agotado' });
    const res = await request(app)
      .post('/ordenes')
      .send(orden(producto.id, producto.nombre, producto.precio));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no disponible/i);
  });
});

describe('inventario y productos', () => {
  test('un producto nuevo aparece en el inventario del día', async () => {
    const { body: producto } = await crear();
    const res = await request(app).get('/inventario').set('Authorization', auth());
    expect(res.body.productos.map((p) => p.productoId)).toContain(String(producto.id));
  });

  test('un producto que deja de estar activo desaparece del inventario', async () => {
    const { body: producto } = await crear();
    await request(app)
      .put(`/productos/${producto.id}`)
      .set('Authorization', auth())
      .send(productoValido({ estado: 'descontinuado' }));

    const res = await request(app).get('/inventario').set('Authorization', auth());
    expect(res.body.productos.map((p) => p.productoId)).not.toContain(String(producto.id));
  });
});

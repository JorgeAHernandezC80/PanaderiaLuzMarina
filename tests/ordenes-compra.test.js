/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const ADMIN_TOKEN = 'test-token-ordenes-compra';

let app;
let server;
let wss;
let db;
let dbPath;
let sessionToken;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-oc-${process.pid}-${Date.now()}.db`);
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
  db.exec('DELETE FROM ordenes_compra');
  db.exec('DELETE FROM insumos');
  db.exec('DELETE FROM proveedores');
  db.exec('DELETE FROM auditoria_cadena');

  db.prepare(
    `INSERT INTO proveedores (id, razon_social, condiciones_pago, moneda)
     VALUES ('prov-1', 'Molinos del Valle S.A.S.', 'credito_30', 'COP')`,
  ).run();

  db.prepare(
    `INSERT INTO insumos (id, nombre, categoria, cantidad, unidad, costo_unitario)
     VALUES ('ins-harina', 'Harina de trigo', 'harinas', 10, 'kg', 3000)`,
  ).run();
  db.prepare(
    `INSERT INTO insumos (id, nombre, categoria, cantidad, unidad, costo_unitario, equivalencia_gramos)
     VALUES ('ins-levadura', 'Levadura fresca', 'levaduras', 4, 'paquete', 5000, 500)`,
  ).run();
});

function auth() {
  return `Bearer ${sessionToken}`;
}

function ordenValida(overrides = {}) {
  return {
    proveedorId: 'prov-1',
    fechaEmision: '2026-03-10',
    fechaEntregaEstimada: '2026-03-15',
    condicionesPago: 'credito_30',
    moneda: 'COP',
    flete: 0,
    solicitadoPor: 'Jorge',
    lugarEntrega: 'Panadería Luz Marina',
    notas: '',
    items: [
      {
        insumoId: 'ins-harina',
        cantidadPedida: 100,
        unidad: 'kg',
        costoUnitario: 3000,
        impuestoPorcentaje: 19,
        descuentoPorcentaje: 0,
      },
    ],
    ...overrides,
  };
}

async function crearOrden(overrides = {}) {
  const res = await request(app)
    .post('/ordenes-compra')
    .set('Authorization', auth())
    .send(ordenValida(overrides));
  expect(res.status).toBe(201);
  return res.body;
}

describe('POST /ordenes-compra', () => {
  it('rechaza sin autenticación', async () => {
    const res = await request(app).post('/ordenes-compra').send(ordenValida());
    expect(res.status).toBe(401);
  });

  it('crea la orden en borrador, con número correlativo y totales calculados en el servidor', async () => {
    const orden = await crearOrden({
      // Los totales que mande el cliente se ignoran a propósito.
      total: 999999,
      subtotal: 1,
    });

    expect(orden.numero).toBe('OC-20260310-0001');
    expect(orden.estado).toBe('borrador');
    expect(orden.proveedorRazonSocial).toBe('Molinos del Valle S.A.S.');
    expect(orden.subtotal).toBe(300000);
    expect(orden.impuestos).toBe(57000);
    expect(orden.total).toBe(357000);
    expect(orden.items[0].insumoNombre).toBe('Harina de trigo');
    expect(orden.items[0].cantidadPendiente).toBe(100);
    expect(orden.avanceRecepcionPct).toBe(0);

    const segunda = await crearOrden();
    expect(segunda.numero).toBe('OC-20260310-0002');
  });

  it('aplica descuento por línea y flete de cabecera', async () => {
    const orden = await crearOrden({
      flete: 15000,
      items: [
        {
          insumoId: 'ins-harina',
          cantidadPedida: 10,
          unidad: 'kg',
          costoUnitario: 1000,
          impuestoPorcentaje: 10,
          descuentoPorcentaje: 50,
        },
      ],
    });

    expect(orden.subtotal).toBe(10000);
    expect(orden.descuento).toBe(5000);
    expect(orden.impuestos).toBe(500);
    expect(orden.total).toBe(20500);
  });

  it('puede emitirse de una vez y deja registrado quién aprobó', async () => {
    const orden = await crearOrden({ emitir: true });
    expect(orden.estado).toBe('emitida');
    expect(orden.aprobadoPor).toBe('Jorge');
    expect(orden.eventos.map((e) => e.tipo)).toEqual(['creada', 'emitida']);
  });

  it('rechaza proveedor e insumo inexistentes, líneas repetidas y cantidades inválidas', async () => {
    const casos = [
      [{ proveedorId: 'no-existe' }, /proveedor no existe/i],
      [
        { items: [{ insumoId: 'fantasma', cantidadPedida: 1, unidad: 'kg', costoUnitario: 10 }] },
        /no existe en el catálogo de Insumos/i,
      ],
      [
        {
          items: [
            { insumoId: 'ins-harina', cantidadPedida: 1, unidad: 'kg', costoUnitario: 10 },
            { insumoId: 'ins-harina', cantidadPedida: 2, unidad: 'kg', costoUnitario: 10 },
          ],
        },
        /repetido/i,
      ],
      [
        { items: [{ insumoId: 'ins-harina', cantidadPedida: 0, unidad: 'kg', costoUnitario: 10 }] },
        /cantidad/i,
      ],
      [
        {
          items: [{ insumoId: 'ins-harina', cantidadPedida: -5, unidad: 'kg', costoUnitario: 10 }],
        },
        /cantidad/i,
      ],
      [
        {
          items: [
            { insumoId: 'ins-harina', cantidadPedida: 1, unidad: 'barril', costoUnitario: 1 },
          ],
        },
        /unidad/i,
      ],
      [{ items: [] }, /al menos un insumo/i],
      [{ condicionesPago: 'trueque' }, /condiciones de pago/i],
      [{ moneda: 'XYZ' }, /moneda/i],
      [{ fechaEmision: '10-03-2026' }, /fecha de emisión/i],
      [{ fechaEntregaEstimada: '2026-03-01' }, /anterior a la emisión/i],
    ];

    for (const [override, mensaje] of casos) {
      const res = await request(app)
        .post('/ordenes-compra')
        .set('Authorization', auth())
        .send(ordenValida(override));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(mensaje);
    }
  });

  it('escribe un bloque en la cadena de auditoría', async () => {
    const orden = await crearOrden();
    const bloques = db
      .prepare("SELECT * FROM auditoria_cadena WHERE entidad = 'ordenes_compra'")
      .all();
    expect(bloques).toHaveLength(1);
    expect(JSON.parse(bloques[0].datos).numero).toBe(orden.numero);
  });
});

describe('PUT /ordenes-compra/:id', () => {
  it('edita un borrador, recalcula totales y deja el evento con el antes/después', async () => {
    const orden = await crearOrden();
    const res = await request(app)
      .put(`/ordenes-compra/${orden.id}`)
      .set('Authorization', auth())
      .send(
        ordenValida({
          items: [
            {
              insumoId: 'ins-harina',
              cantidadPedida: 50,
              unidad: 'kg',
              costoUnitario: 3000,
              impuestoPorcentaje: 0,
              descuentoPorcentaje: 0,
            },
          ],
        }),
      );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(150000);
    const editado = res.body.eventos.find((e) => e.tipo === 'editada');
    expect(editado.datos).toEqual({ antes: { total: 357000 }, despues: { total: 150000 } });
  });

  it('no deja editar una orden ya emitida', async () => {
    const orden = await crearOrden({ emitir: true });
    const res = await request(app)
      .put(`/ordenes-compra/${orden.id}`)
      .set('Authorization', auth())
      .send(ordenValida());
    expect(res.status).toBe(409);
  });
});

describe('PATCH /ordenes-compra/:id/estado', () => {
  it('recorre el ciclo borrador → emitida → confirmada', async () => {
    const orden = await crearOrden();

    const emitida = await request(app)
      .patch(`/ordenes-compra/${orden.id}/estado`)
      .set('Authorization', auth())
      .send({ estado: 'emitida', usuario: 'Jorge' });
    expect(emitida.status).toBe(200);
    expect(emitida.body.estado).toBe('emitida');
    expect(emitida.body.aprobadoPor).toBe('Jorge');

    const confirmada = await request(app)
      .patch(`/ordenes-compra/${orden.id}/estado`)
      .set('Authorization', auth())
      .send({ estado: 'confirmada', usuario: 'Jorge' });
    expect(confirmada.status).toBe(200);
    expect(confirmada.body.estado).toBe('confirmada');
  });

  it('rechaza transiciones imposibles y estados desconocidos', async () => {
    const orden = await crearOrden();

    const salto = await request(app)
      .patch(`/ordenes-compra/${orden.id}/estado`)
      .set('Authorization', auth())
      .send({ estado: 'cerrada' });
    expect(salto.status).toBe(400);
    expect(salto.body.error).toMatch(/No se puede pasar de "borrador" a "cerrada"/);

    const inventado = await request(app)
      .patch(`/ordenes-compra/${orden.id}/estado`)
      .set('Authorization', auth())
      .send({ estado: 'pagada' });
    expect(inventado.status).toBe(400);
  });

  it('exige motivo al cancelar', async () => {
    const orden = await crearOrden();
    const sinMotivo = await request(app)
      .patch(`/ordenes-compra/${orden.id}/estado`)
      .set('Authorization', auth())
      .send({ estado: 'cancelada' });
    expect(sinMotivo.status).toBe(400);

    const conMotivo = await request(app)
      .patch(`/ordenes-compra/${orden.id}/estado`)
      .set('Authorization', auth())
      .send({ estado: 'cancelada', motivo: 'El proveedor no tiene existencias.' });
    expect(conMotivo.status).toBe(200);
    expect(conMotivo.body.motivoCancelacion).toBe('El proveedor no tiene existencias.');
  });
});

describe('POST /ordenes-compra/:id/recepciones', () => {
  function recepcion(itemId, overrides = {}) {
    return {
      fecha: '2026-03-15',
      hora: '08:30',
      recibidoPor: 'Marina',
      documentoReferencia: 'REM-4471',
      items: [
        {
          itemId,
          cantidadRecibida: 40,
          loteProveedor: 'L-2026-A',
          fechaVencimiento: '2026-09-30',
          ...overrides,
        },
      ],
    };
  }

  it('no admite recepciones sobre un borrador', async () => {
    const orden = await crearOrden();
    const res = await request(app)
      .post(`/ordenes-compra/${orden.id}/recepciones`)
      .set('Authorization', auth())
      .send(recepcion(orden.items[0].id));
    expect(res.status).toBe(409);
  });

  it('registra una entrega parcial, sube el inventario y copia lote y vencimiento al insumo', async () => {
    const orden = await crearOrden({ emitir: true });
    const res = await request(app)
      .post(`/ordenes-compra/${orden.id}/recepciones`)
      .set('Authorization', auth())
      .send(recepcion(orden.items[0].id));

    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('recibida_parcial');
    expect(res.body.items[0].cantidadRecibida).toBe(40);
    expect(res.body.items[0].cantidadPendiente).toBe(60);
    expect(res.body.avanceRecepcionPct).toBe(40);

    const insumo = db.prepare('SELECT * FROM insumos WHERE id = ?').get('ins-harina');
    expect(insumo.cantidad).toBe(50); // 10 iniciales + 40 recibidos
    expect(insumo.lote_proveedor).toBe('L-2026-A');
    expect(insumo.fecha_vencimiento).toBe('2026-09-30');
  });

  it('pasa a "recibida" cuando se completa lo pedido', async () => {
    const orden = await crearOrden({ emitir: true });
    await request(app)
      .post(`/ordenes-compra/${orden.id}/recepciones`)
      .set('Authorization', auth())
      .send(recepcion(orden.items[0].id));

    const res = await request(app)
      .post(`/ordenes-compra/${orden.id}/recepciones`)
      .set('Authorization', auth())
      .send(recepcion(orden.items[0].id, { cantidadRecibida: 60 }));

    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('recibida');
    expect(res.body.recepciones).toHaveLength(2);

    const cerrada = await request(app)
      .patch(`/ordenes-compra/${orden.id}/estado`)
      .set('Authorization', auth())
      .send({ estado: 'cerrada', usuario: 'Jorge' });
    expect(cerrada.body.estado).toBe('cerrada');
  });

  it('rechaza recibir más de lo pendiente y no toca el inventario', async () => {
    const orden = await crearOrden({ emitir: true });
    const res = await request(app)
      .post(`/ordenes-compra/${orden.id}/recepciones`)
      .set('Authorization', auth())
      .send(recepcion(orden.items[0].id, { cantidadRecibida: 101 }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/solo faltan 100 kg/);
    expect(db.prepare('SELECT cantidad FROM insumos WHERE id = ?').get('ins-harina').cantidad).toBe(
      10,
    );
  });

  it('exige motivo cuando se rechaza mercancía y admite la línea solo con rechazo', async () => {
    const orden = await crearOrden({ emitir: true });

    const sinMotivo = await request(app)
      .post(`/ordenes-compra/${orden.id}/recepciones`)
      .set('Authorization', auth())
      .send(recepcion(orden.items[0].id, { cantidadRecibida: 0, cantidadRechazada: 5 }));
    expect(sinMotivo.status).toBe(400);
    expect(sinMotivo.body.error).toMatch(/motivo del rechazo/i);

    const conMotivo = await request(app)
      .post(`/ordenes-compra/${orden.id}/recepciones`)
      .set('Authorization', auth())
      .send(
        recepcion(orden.items[0].id, {
          cantidadRecibida: 0,
          cantidadRechazada: 5,
          motivoRechazo: 'Bultos rotos',
        }),
      );
    expect(conMotivo.status).toBe(201);
    expect(conMotivo.body.estado).toBe('emitida'); // nada recibido todavía
    expect(conMotivo.body.recepciones[0].items[0].cantidadRechazada).toBe(5);
  });

  it('convierte la unidad de la orden a la unidad del insumo', async () => {
    const orden = await crearOrden({
      emitir: true,
      items: [
        {
          insumoId: 'ins-levadura', // se inventaría en paquetes de 500 g
          cantidadPedida: 10000,
          unidad: 'g',
          costoUnitario: 10,
        },
      ],
    });

    const res = await request(app)
      .post(`/ordenes-compra/${orden.id}/recepciones`)
      .set('Authorization', auth())
      .send(recepcion(orden.items[0].id, { cantidadRecibida: 10000 }));

    expect(res.status).toBe(201);
    // 10 000 g / 500 g por paquete = 20 paquetes, sobre los 4 que ya había.
    expect(
      db.prepare('SELECT cantidad FROM insumos WHERE id = ?').get('ins-levadura').cantidad,
    ).toBe(24);
  });

  it('no permite cancelar una orden que ya recibió mercancía', async () => {
    const orden = await crearOrden({ emitir: true });
    await request(app)
      .post(`/ordenes-compra/${orden.id}/recepciones`)
      .set('Authorization', auth())
      .send(recepcion(orden.items[0].id));

    const res = await request(app)
      .patch(`/ordenes-compra/${orden.id}/estado`)
      .set('Authorization', auth())
      .send({ estado: 'cancelada', motivo: 'Ya no la necesitamos.' });
    expect(res.status).toBe(409);
  });

  it('rechaza una línea que no pertenece a la orden', async () => {
    const orden = await crearOrden({ emitir: true });
    const otra = await crearOrden({ emitir: true });

    const res = await request(app)
      .post(`/ordenes-compra/${orden.id}/recepciones`)
      .set('Authorization', auth())
      .send(recepcion(otra.items[0].id));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no pertenece a esta orden/i);
  });
});

describe('GET /ordenes-compra', () => {
  it('filtra por estado y por proveedor', async () => {
    await crearOrden();
    await crearOrden({ emitir: true });

    const borradores = await request(app)
      .get('/ordenes-compra?estado=borrador')
      .set('Authorization', auth());
    expect(borradores.body).toHaveLength(1);

    const delProveedor = await request(app)
      .get('/ordenes-compra?proveedorId=prov-1')
      .set('Authorization', auth());
    expect(delProveedor.body).toHaveLength(2);

    const inventado = await request(app)
      .get('/ordenes-compra?estado=pagada')
      .set('Authorization', auth());
    expect(inventado.status).toBe(400);
  });
});

describe('GET /ordenes-compra/:id/trazabilidad', () => {
  it('devuelve la bitácora completa, los bloques encadenados y el veredicto de integridad', async () => {
    const orden = await crearOrden({ emitir: true });
    await request(app)
      .post(`/ordenes-compra/${orden.id}/recepciones`)
      .set('Authorization', auth())
      .send({
        fecha: '2026-03-15',
        hora: '08:30',
        recibidoPor: 'Marina',
        items: [{ itemId: orden.items[0].id, cantidadRecibida: 100, loteProveedor: 'L-1' }],
      });

    const res = await request(app)
      .get(`/ordenes-compra/${orden.id}/trazabilidad`)
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.eventos.map((e) => e.tipo)).toEqual([
      'creada',
      'emitida',
      'recepcion_registrada',
    ]);
    expect(res.body.eventos.at(-1).usuario).toBe('Marina');
    expect(res.body.recepciones[0].items[0].loteProveedor).toBe('L-1');
    expect(res.body.bloques).toHaveLength(2);
    expect(res.body.integridadCadena.integra).toBe(true);
  });

  it('responde 404 para una orden inexistente', async () => {
    const res = await request(app)
      .get('/ordenes-compra/no-existe/trazabilidad')
      .set('Authorization', auth());
    expect(res.status).toBe(404);
  });
});

describe('DELETE /ordenes-compra/:id', () => {
  it('elimina un borrador y arrastra sus líneas', async () => {
    const orden = await crearOrden();
    const res = await request(app)
      .delete(`/ordenes-compra/${orden.id}`)
      .set('Authorization', auth());

    expect(res.status).toBe(204);
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM orden_compra_items WHERE orden_compra_id = ?')
        .get(orden.id).n,
    ).toBe(0);
  });

  it('no elimina una orden emitida', async () => {
    const orden = await crearOrden({ emitir: true });
    const res = await request(app)
      .delete(`/ordenes-compra/${orden.id}`)
      .set('Authorization', auth());
    expect(res.status).toBe(409);
  });
});

/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const Analitica = require('../pedidosAnalitica');

/* ═══════════════════════════════════════════
   Analítica pura (sin base de datos)
   ═══════════════════════════════════════════ */

describe('clasificarDispositivo (función pura)', () => {
  test('reconoce teléfonos por el User-Agent', () => {
    expect(
      Analitica.clasificarDispositivo(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      ),
    ).toBe('movil');
    expect(
      Analitica.clasificarDispositivo('Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile Safari'),
    ).toBe('movil');
  });

  test('reconoce escritorio y tablet, que no son lo mismo', () => {
    expect(
      Analitica.clasificarDispositivo(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      ),
    ).toBe('escritorio');
    expect(Analitica.clasificarDispositivo('Mozilla/5.0 (iPad; CPU OS 17_0) Safari')).toBe(
      'tablet',
    );
    // Android sin "Mobile" es una tablet: es el único indicio disponible.
    expect(Analitica.clasificarDispositivo('Mozilla/5.0 (Linux; Android 13) Safari')).toBe(
      'tablet',
    );
  });

  test('separa bots y la ausencia de dato, sin contarlos como escritorio', () => {
    expect(Analitica.clasificarDispositivo('curl/8.4.0')).toBe('bot');
    expect(Analitica.clasificarDispositivo('')).toBe('desconocido');
    expect(Analitica.clasificarDispositivo(null)).toBe('desconocido');
  });
});

describe('construirLineaTiempo (función pura)', () => {
  const transiciones = [
    { id: 1, estadoDestino: 'pendiente', fechaHora: '2026-01-05T08:00:00.000Z' },
    { id: 2, estadoDestino: 'en_preparacion', fechaHora: '2026-01-05T08:10:00.000Z' },
    { id: 3, estadoDestino: 'preparada', fechaHora: '2026-01-05T08:40:00.000Z' },
    { id: 4, estadoDestino: 'entregada', fechaHora: '2026-01-05T09:00:00.000Z' },
  ];

  test('cada etapa dura hasta la transición siguiente y el lead time es el total', () => {
    const linea = Analitica.construirLineaTiempo(transiciones);
    const minutos = Analitica.minutosPorEstado(linea);

    expect(minutos.pendiente).toBe(10);
    expect(minutos.en_preparacion).toBe(30);
    expect(minutos.preparada).toBe(20);
    // La última etapa está abierta: no se le puede asignar duración.
    expect(minutos.entregada).toBeNull();
    expect(linea.leadTimeTotalMin).toBe(60);
    expect(linea.entregada).toBe(true);
  });

  test('ordena por fecha aunque las transiciones lleguen desordenadas', () => {
    const linea = Analitica.construirLineaTiempo([
      transiciones[2],
      transiciones[0],
      transiciones[1],
    ]);
    expect(linea.etapas.map((e) => e.estado)).toEqual(['pendiente', 'en_preparacion', 'preparada']);
  });

  test('un pedido en curso no tiene lead time: null, no 0', () => {
    const linea = Analitica.construirLineaTiempo(transiciones.slice(0, 2));
    expect(linea.leadTimeTotalMin).toBeNull();
    expect(linea.entregada).toBe(false);
    // El tiempo transcurrido sí se conoce y se reporta aparte.
    expect(linea.transcurridoMin).toBe(10);
  });

  test('un historial reconstruido por la migración no aporta duraciones falsas', () => {
    // La migración solo tiene las dos fechas de la fila del pedido: ese lapso
    // no es el tiempo que el pedido pasó en la primera etapa, así que ninguna
    // etapa se mide y el lapso queda solo como dato informativo.
    const linea = Analitica.construirLineaTiempo([
      {
        id: 1,
        estadoDestino: 'pendiente',
        fechaHora: '2026-01-05T08:00:00.000Z',
        sesionAdmin: 'migracion',
      },
      {
        id: 2,
        estadoDestino: 'entregada',
        fechaHora: '2026-01-05T18:00:00.000Z',
        sesionAdmin: 'migracion',
      },
    ]);

    expect(linea.reconstruida).toBe(true);
    expect(linea.leadTimeTotalMin).toBeNull();
    expect(linea.transcurridoMin).toBe(600);
    expect(Analitica.minutosPorEstado(linea).pendiente).toBeNull();
    expect(
      Analitica.validarPedido({ estado: 'entregada', lineaTiempo: linea }).map((h) => h.codigo),
    ).toContain('historial_reconstruido');
  });

  test('los pedidos migrados no mueven el cuello de botella ni las medianas', () => {
    const reconstruido = Analitica.construirLineaTiempo([
      {
        id: 1,
        estadoDestino: 'pendiente',
        fechaHora: '2026-01-05T08:00:00.000Z',
        sesionAdmin: 'migracion',
      },
      {
        id: 2,
        estadoDestino: 'entregada',
        fechaHora: '2026-01-05T18:00:00.000Z',
        sesionAdmin: 'migracion',
      },
    ]);
    const real = Analitica.construirLineaTiempo(transiciones);

    const leadTime = Analitica.leadTimePorEtapa([
      { lineaTiempo: reconstruido },
      { lineaTiempo: real },
    ]);

    // Las 10 h del pedido migrado se habrían anotado en "Recibida".
    expect(leadTime.cuelloDeBotella.estado).toBe('en_preparacion');
    expect(leadTime.etapas.find((e) => e.estado === 'pendiente').pedidosMedidos).toBe(1);
    expect(leadTime.total.pedidosMedidos).toBe(1);
    expect(leadTime.total.mediana).toBe(60);
  });

  test('un historial real de duración cero sí se mide: 0 min es una medición', () => {
    const linea = Analitica.construirLineaTiempo([
      {
        id: 1,
        estadoDestino: 'pendiente',
        fechaHora: '2026-01-05T08:00:00.000Z',
        sesionAdmin: 'checkout',
      },
      {
        id: 2,
        estadoDestino: 'entregada',
        fechaHora: '2026-01-05T08:00:00.000Z',
        sesionAdmin: 'abc123',
      },
    ]);
    expect(linea.reconstruida).toBe(false);
    expect(linea.leadTimeTotalMin).toBe(0);
  });

  test('sin transiciones no se inventa nada', () => {
    const linea = Analitica.construirLineaTiempo([]);
    expect(linea.etapas).toEqual([]);
    expect(linea.leadTimeTotalMin).toBeNull();
    expect(Analitica.minutosPorEstado(linea).en_preparacion).toBeNull();
  });
});

describe('leadTimePorEtapa (función pura)', () => {
  /** Pedido mínimo con la línea de tiempo ya armada. */
  const pedidoCon = (minutos) => {
    const base = new Date('2026-01-05T08:00:00.000Z').getTime();
    let acumulado = 0;
    const transiciones = ['pendiente', 'en_preparacion', 'preparada', 'entregada'].map(
      (estado, i) => {
        if (i > 0) acumulado += minutos[i - 1];
        return {
          id: i + 1,
          estadoDestino: estado,
          fechaHora: new Date(base + acumulado * 60000).toISOString(),
        };
      },
    );
    return {
      estado: 'entregada',
      lineaTiempo: Analitica.construirLineaTiempo(transiciones),
    };
  };

  test('el cuello de botella es la etapa con la mediana más alta', () => {
    const analisis = Analitica.leadTimePorEtapa([
      pedidoCon([5, 40, 10]),
      pedidoCon([5, 50, 10]),
      pedidoCon([5, 45, 10]),
    ]);

    expect(analisis.datosInsuficientes).toBe(false);
    expect(analisis.cuelloDeBotella.estado).toBe('en_preparacion');
    expect(analisis.cuelloDeBotella.medianaMin).toBe(45);
    expect(analisis.total.mediana).toBe(60);
    expect(analisis.total.pedidosMedidos).toBe(3);
  });

  test('un solo pedido lentísimo no mueve la mediana a la etapa equivocada', () => {
    const analisis = Analitica.leadTimePorEtapa([
      pedidoCon([5, 30, 10]),
      pedidoCon([5, 30, 10]),
      pedidoCon([5, 30, 600]), // uno olvidado en el mostrador
    ]);
    expect(analisis.cuelloDeBotella.estado).toBe('en_preparacion');
  });

  test('sin historial lo dice explícitamente en vez de reportar 0 min', () => {
    const analisis = Analitica.leadTimePorEtapa([
      { estado: 'pendiente', lineaTiempo: Analitica.construirLineaTiempo([]) },
    ]);
    expect(analisis.datosInsuficientes).toBe(true);
    expect(analisis.cuelloDeBotella).toBeNull();
    expect(analisis.total.mediana).toBeNull();
  });

  test('nunca devuelve NaN ni Infinity, ni con la lista vacía', () => {
    const analisis = Analitica.leadTimePorEtapa([]);
    const numeros = [analisis.total.media, analisis.total.mediana, analisis.total.maximo];
    numeros.forEach((n) => expect(n === null || Number.isFinite(n)).toBe(true));
  });
});

describe('embudoEstados (función pura)', () => {
  test('un pedido entregado cuenta como que pasó por todas las etapas previas', () => {
    const embudo = Analitica.embudoEstados([
      { estado: 'entregada', lineaTiempo: { transiciones: [] } },
      { estado: 'pendiente', lineaTiempo: { transiciones: [] } },
    ]);
    const por = Object.fromEntries(embudo.map((e) => [e.estado, e.pedidos]));
    expect(por).toEqual({ pendiente: 2, en_preparacion: 1, preparada: 1, entregada: 1 });
    expect(embudo[1].conversionDesdeAnterior).toBe(50);
  });

  test('la primera etapa no tiene conversión anterior (null, no 100%)', () => {
    const embudo = Analitica.embudoEstados([{ estado: 'pendiente', lineaTiempo: {} }]);
    expect(embudo[0].conversionDesdeAnterior).toBeNull();
  });
});

describe('porDispositivo (función pura)', () => {
  const pedido = (dispositivo, total) => ({ dispositivo, total });

  test('reparte pedidos e ingresos y calcula el ticket de cada dispositivo', () => {
    const cortes = Analitica.porDispositivo([
      pedido('movil', 10),
      pedido('movil', 20),
      pedido('escritorio', 60),
    ]);
    const movil = cortes.find((c) => c.clave === 'movil');
    const escritorio = cortes.find((c) => c.clave === 'escritorio');

    expect(movil.pedidos).toBe(2);
    expect(movil.porcentajePedidos).toBeCloseTo(66.67, 1);
    expect(movil.ticketPromedio).toBe(15);
    // El móvil trae más pedidos pero menos dinero: los dos cortes se
    // reportan por separado justamente por esto.
    expect(movil.porcentajeIngresos).toBeCloseTo(33.33, 1);
    expect(escritorio.ticketPromedio).toBe(60);
  });

  test('los pedidos sin dato quedan como "desconocido", no repartidos', () => {
    const cortes = Analitica.porDispositivo([pedido(null, 10), pedido('movil', 10)]);
    expect(cortes.find((c) => c.clave === 'desconocido').pedidos).toBe(1);
  });

  test('sin pedidos no hay cortes (y no divide por cero)', () => {
    expect(Analitica.porDispositivo([])).toEqual([]);
  });
});

describe('validarPedidos / completitudPedidos (funciones puras)', () => {
  test('marca el pedido entregado sin historial en vez de suponerle un lead time', () => {
    const calidad = Analitica.validarPedidos([
      {
        numero: 'PED-1',
        estado: 'entregada',
        total: 10,
        unidades: 1,
        lineaTiempo: Analitica.construirLineaTiempo([]),
        minutosPorEstado: {},
      },
    ]);
    expect(calidad.porRegla.map((r) => r.codigo)).toContain('sin_historial');
    expect(calidad.pedidosConHallazgos).toBe(1);
    expect(calidad.porcentajeSano).toBe(0);
  });

  test('la completitud señala el campo que falta, sin inventar el valor', () => {
    const completitud = Analitica.completitudPedidos([
      { dispositivo: 'movil', total: 10, unidades: 2, retiro: '08:00', lineaTiempo: {} },
      { dispositivo: null, total: 10, unidades: 2, retiro: '08:00', lineaTiempo: {} },
    ]);
    const dispositivo = completitud.find((c) => c.campo === 'dispositivo');
    expect(dispositivo.porcentaje).toBe(50);
  });
});

/* ═══════════════════════════════════════════
   Integración: db.js + pedidos.js + endpoints
   ═══════════════════════════════════════════
   Igual que en lotes.test.js: db.js abre el archivo de DB_PATH en el propio
   require(), así que server/db/pedidos se importan dentro de beforeAll. */

const ADMIN_TOKEN = 'test-token-pedidos';
const UA_MOVIL =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const UA_ESCRITORIO =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

let app;
let server;
let wss;
let db;
let Pedidos;
let dbPath;
let sessionToken;

/* El número y la fecha los genera el frontend (checkout.js), así que el
   payload los trae hechos. Cada pedido de la suite lleva un número propio
   para no chocar con la clave primaria, y la fecha es la de hoy para caer
   dentro de la ventana de 30 días que analiza el módulo por defecto. */
let secuencia = 1000;
const HOY_ISO = new Date().toISOString().slice(0, 10);

function ordenValida(extra = {}) {
  secuencia += 1;
  return {
    numero: `LM-${HOY_ISO.replace(/-/g, '')}-${secuencia}`,
    fechaISO: `${HOY_ISO}T10:30:00.000Z`,
    fechaTexto: 'pedido de prueba · 10:30 a. m.',
    cliente: 'Cliente de prueba',
    telefono: '+57 300 123 4567',
    retiro: '08:30',
    items: [{ nombre: 'Pan', cantidad: 2, precio: 5 }],
    total: 10,
    ...extra,
  };
}

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-pedidos-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.AUTH_MAX_ATTEMPTS = '100000';
  process.env.ORDERS_MAX_PER_WINDOW = '100000';

  ({ app, server, wss } = require('../server'));
  db = require('../db');
  Pedidos = require('../pedidos');

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

/** Crea un pedido por HTTP y devuelve su número. */
async function crearPedido(userAgent, extra = {}) {
  const res = await request(app)
    .post('/ordenes')
    .set('User-Agent', userAgent)
    .send(ordenValida(extra));
  expect(res.status).toBe(201);
  return res.body.numero;
}

function historialDe(numero) {
  return db
    .prepare(
      'SELECT estado_origen, estado_destino, usuario_admin, sesion_admin FROM orden_status_log WHERE orden_numero = ? ORDER BY id',
    )
    .all(numero);
}

describe('resolverRango', () => {
  test('sin filtros analiza la ventana por defecto, en días completos', () => {
    const { desde, hasta } = Pedidos.resolverRango();
    expect(desde).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(hasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(desde < hasta).toBe(true);
  });

  test('un rango al revés se endereza en vez de devolver cero pedidos', () => {
    const { desde, hasta } = Pedidos.resolverRango({
      desde: '2026-02-10',
      hasta: '2026-02-01',
    });
    expect({ desde, hasta }).toEqual({ desde: '2026-02-01', hasta: '2026-02-10' });
  });
});

describe('POST /ordenes — metadatos del checkout', () => {
  test('guarda el User-Agent, lo clasifica y abre el historial en pendiente', async () => {
    const numero = await crearPedido(UA_MOVIL, {
      metadata: { zonaHoraria: 'America/Chicago', idioma: 'es-CO' },
    });

    const fila = db
      .prepare('SELECT user_agent, dispositivo, zona_horaria, idioma FROM ordenes WHERE numero = ?')
      .get(numero);
    expect(fila.dispositivo).toBe('movil');
    expect(fila.user_agent).toContain('iPhone');
    expect(fila.zona_horaria).toBe('America/Chicago');
    expect(fila.idioma).toBe('es-CO');

    // El estado inicial también se registra: sin él la primera etapa no
    // tendría punto de partida y el lead time no se podría medir.
    expect(historialDe(numero)).toEqual([
      {
        estado_origen: null,
        estado_destino: 'pendiente',
        usuario_admin: null,
        sesion_admin: 'checkout',
      },
    ]);
  });

  test('una zona horaria o idioma con basura se descarta en vez de guardarse', async () => {
    const numero = await crearPedido(UA_ESCRITORIO, {
      metadata: { zonaHoraria: '<script>x</script>', idioma: 'no es un idioma' },
    });
    const fila = db
      .prepare('SELECT dispositivo, zona_horaria, idioma FROM ordenes WHERE numero = ?')
      .get(numero);
    expect(fila.dispositivo).toBe('escritorio');
    expect(fila.zona_horaria).toBeNull();
    expect(fila.idioma).toBeNull();
  });

  test('sin metadatos el pedido se crea igual: el checkout no se bloquea', async () => {
    const res = await request(app).post('/ordenes').send(ordenValida());
    expect(res.status).toBe(201);
  });
});

describe('PATCH /ordenes/:numero — historial de estados', () => {
  test('cada avance inserta una fila con origen, destino y operario', async () => {
    const numero = await crearPedido(UA_MOVIL);

    for (const estado of ['en_preparacion', 'preparada', 'entregada']) {
      const res = await request(app)
        .patch(`/ordenes/${numero}`)
        .set('Authorization', auth())
        .send({ estado, usuario: 'Panadero Ana' });
      expect(res.status).toBe(200);
    }

    const log = historialDe(numero);
    expect(log.map((f) => [f.estado_origen, f.estado_destino])).toEqual([
      [null, 'pendiente'],
      ['pendiente', 'en_preparacion'],
      ['en_preparacion', 'preparada'],
      ['preparada', 'entregada'],
    ]);
    expect(log[3].usuario_admin).toBe('Panadero Ana');
    // La sesión se identifica por huella del token, nunca por el token.
    expect(log[3].sesion_admin).toMatch(/^[0-9a-f]{12}$/);
    expect(log[3].sesion_admin).not.toContain(sessionToken);
  });

  test('reenviar el mismo estado no duplica el historial', async () => {
    const numero = await crearPedido(UA_MOVIL);
    await request(app)
      .patch(`/ordenes/${numero}`)
      .set('Authorization', auth())
      .send({ estado: 'en_preparacion' });
    await request(app)
      .patch(`/ordenes/${numero}`)
      .set('Authorization', auth())
      .send({ estado: 'en_preparacion' });

    expect(historialDe(numero)).toHaveLength(2);
  });

  test('el pedido avanza aunque nadie declare el operario', async () => {
    const numero = await crearPedido(UA_ESCRITORIO);
    const res = await request(app)
      .patch(`/ordenes/${numero}`)
      .set('Authorization', auth())
      .send({ estado: 'en_preparacion' });

    expect(res.status).toBe(200);
    expect(historialDe(numero)[1].usuario_admin).toBeNull();
  });

  test('una orden inexistente da 404 y no escribe historial', async () => {
    const res = await request(app)
      .patch('/ordenes/LM-20260117-9999')
      .set('Authorization', auth())
      .send({ estado: 'entregada' });

    expect(res.status).toBe(404);
    expect(historialDe('LM-20260117-9999')).toHaveLength(0);
  });

  test('un estado fuera del flujo se rechaza y no deja rastro', async () => {
    const numero = await crearPedido(UA_MOVIL);
    const res = await request(app)
      .patch(`/ordenes/${numero}`)
      .set('Authorization', auth())
      .send({ estado: 'cancelada_por_el_perro' });

    expect(res.status).toBe(400);
    expect(historialDe(numero)).toHaveLength(1);
  });
});

describe('GET /ordenes/analisis', () => {
  test('exige token', async () => {
    expect((await request(app).get('/ordenes/analisis')).status).toBe(401);
  });

  test('rechaza fechas con formato inválido', async () => {
    const res = await request(app).get('/ordenes/analisis?desde=ayer').set('Authorization', auth());
    expect(res.status).toBe(400);
  });

  test('mide el lead time del pedido recién completado y el reparto por dispositivo', async () => {
    const numero = await crearPedido(UA_MOVIL, {
      metadata: { zonaHoraria: 'America/Chicago', idioma: 'es-CO' },
    });
    for (const estado of ['en_preparacion', 'preparada', 'entregada']) {
      await request(app)
        .patch(`/ordenes/${numero}`)
        .set('Authorization', auth())
        .send({ estado, usuario: 'Ana' });
    }

    const res = await request(app).get('/ordenes/analisis').set('Authorization', auth());
    expect(res.status).toBe(200);

    const { resumen, leadTime, porDispositivo, embudo, calidad } = res.body;
    expect(resumen.pedidos).toBeGreaterThan(0);
    expect(resumen.porcentajeMovil).not.toBeNull();
    // Las transiciones ocurren en el mismo segundo: 0 min es una medición
    // real, no un dato faltante — lo importante es que sea finito.
    expect(Number.isFinite(leadTime.total.mediana)).toBe(true);
    expect(leadTime.datosInsuficientes).toBe(false);
    expect(porDispositivo.some((d) => d.clave === 'movil')).toBe(true);
    expect(embudo).toHaveLength(4);
    expect(calidad.totalPedidos).toBe(resumen.pedidos);

    const pedido = res.body.pedidos.find((p) => p.numero === numero);
    expect(pedido.entregada).toBe(true);
    expect(pedido.operarios).toContain('Ana');
  });

  test('cada pedido atípico dice de qué pedido habla', async () => {
    const res = await request(app).get('/ordenes/analisis').set('Authorization', auth());
    expect(res.status).toBe(200);
    for (const atipico of res.body.atipicos) {
      expect(typeof atipico.numero).toBe('string');
      expect(atipico.numero).not.toBe('');
      expect(atipico.fecha).toBeTruthy();
      expect(Number.isFinite(atipico.valor)).toBe(true);
    }
  });

  test('el filtro por estado deja solo los pedidos en ese estado', async () => {
    const res = await request(app)
      .get('/ordenes/analisis?estado=entregada')
      .set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.pedidos.every((p) => p.estado === 'entregada')).toBe(true);
  });

  test('un período sin pedidos responde con métricas nulas, no con ceros engañosos', async () => {
    const res = await request(app)
      .get('/ordenes/analisis?desde=2020-01-01&hasta=2020-01-07')
      .set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.resumen.pedidos).toBe(0);
    expect(res.body.resumen.ticketPromedio).toBeNull();
    expect(res.body.resumen.porcentajeMovil).toBeNull();
    expect(res.body.leadTime.datosInsuficientes).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('null,"NaN"');
  });
});

describe('GET /ordenes/:numero/historial', () => {
  test('exige token', async () => {
    expect((await request(app).get('/ordenes/LM-20260117-0001/historial')).status).toBe(401);
  });

  test('devuelve la línea de tiempo con quién movió cada paso', async () => {
    const numero = await crearPedido(UA_MOVIL);
    await request(app)
      .patch(`/ordenes/${numero}`)
      .set('Authorization', auth())
      .send({ estado: 'en_preparacion', usuario: 'Ana' });

    const res = await request(app).get(`/ordenes/${numero}/historial`).set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.lineaTiempo.etapas.map((e) => e.estado)).toEqual([
      'pendiente',
      'en_preparacion',
    ]);
    expect(res.body.lineaTiempo.etapas[1].abierta).toBe(true);
    expect(res.body.lineaTiempo.etapas[1].usuarioAdmin).toBe('Ana');
    expect(res.body.leadTimeTotalMin).toBeNull();
  });

  test('un pedido que no existe da 404', async () => {
    const res = await request(app)
      .get('/ordenes/LM-20260117-9999/historial')
      .set('Authorization', auth());
    expect(res.status).toBe(404);
  });
});

describe('migración de una base ya existente', () => {
  test('agrega columnas y siembra el historial sin inventar pasos intermedios', () => {
    // Base con el esquema viejo de ordenes: sin metadatos ni tabla de
    // historial, y con un pedido ya entregado.
    const legacyPath = path.join(os.tmpdir(), `plm-legacy-${process.pid}-${Date.now()}.db`);
    const Database = require('better-sqlite3');
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE ordenes (
        numero        TEXT PRIMARY KEY,
        fecha_iso     TEXT NOT NULL,
        fecha_texto   TEXT NOT NULL,
        cliente       TEXT NOT NULL,
        telefono      TEXT NOT NULL,
        retiro        TEXT NOT NULL,
        items_json    TEXT NOT NULL,
        total         REAL NOT NULL,
        estado        TEXT NOT NULL DEFAULT 'pendiente',
        creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
        actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO ordenes (numero, fecha_iso, fecha_texto, cliente, telefono, retiro, items_json, total, estado)
      VALUES ('LM-20260105-0001', '2026-01-05T08:00:00.000Z', '5 de enero', 'Cliente', '3000000000',
              '08:30', '[{"cantidad":2}]', 10, 'entregada');
    `);
    legacy.close();

    // db.js corre las migraciones al abrir: se ejecuta en un proceso
    // aparte para no reemplazar el módulo ya cargado por esta suite.
    const { execFileSync } = require('child_process');
    const salida = execFileSync(
      process.execPath,
      [
        '-e',
        `const db = require(${JSON.stringify(path.join(__dirname, '..', 'db.js'))});
         const cols = db.prepare('PRAGMA table_info(ordenes)').all().map((c) => c.name);
         const log = db.prepare('SELECT estado_origen, estado_destino, sesion_admin FROM orden_status_log ORDER BY id').all();
         console.log(JSON.stringify({ cols, log }));`,
      ],
      { env: { ...process.env, DB_PATH: legacyPath }, encoding: 'utf8' },
    );

    const { cols, log } = JSON.parse(salida.trim().split('\n').pop());
    expect(cols).toEqual(
      expect.arrayContaining(['user_agent', 'dispositivo', 'zona_horaria', 'idioma']),
    );
    // Del pedido viejo solo consta lo demostrable: que entró y que terminó
    // entregado. Las etapas intermedias no se fabrican, y el origen de la
    // última queda en null porque no se sabe desde qué estado se movió.
    expect(log).toEqual([
      { estado_origen: null, estado_destino: 'pendiente', sesion_admin: 'migracion' },
      { estado_origen: null, estado_destino: 'entregada', sesion_admin: 'migracion' },
    ]);

    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(legacyPath + suffix);
      } catch {
        /* ignore */
      }
    }
  });
});

/**
 * @jest-environment node
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const request = require('supertest');

const Analitica = require('../lotesAnalitica');

/* ═══════════════════════════════════════════
   Analítica pura (sin base de datos)
   ═══════════════════════════════════════════ */

describe('descriptivas (función pura)', () => {
  test('media, mediana, desviación y cuartiles de una serie conocida', () => {
    const d = Analitica.descriptivas([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(d.n).toBe(8);
    expect(d.media).toBe(5);
    expect(d.mediana).toBe(4.5);
    expect(d.desviacion).toBe(2); // desviación poblacional
    expect(d.minimo).toBe(2);
    expect(d.maximo).toBe(9);
  });

  test('ignora null/undefined/NaN en vez de contarlos como 0', () => {
    const d = Analitica.descriptivas([10, null, undefined, NaN, 20]);
    expect(d.n).toBe(2);
    expect(d.media).toBe(15);
  });

  test('sin ningún dato válido, todo queda en null (no en 0)', () => {
    const d = Analitica.descriptivas([null, null]);
    expect(d).toMatchObject({ n: 0, media: null, mediana: null, desviacion: null });
  });
});

describe('histograma (función pura)', () => {
  test('reparte los valores en tramos y el máximo cae en el último', () => {
    const tramos = Analitica.histograma([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(tramos).toHaveLength(5);
    expect(tramos.reduce((s, t) => s + t.total, 0)).toBe(11);
    expect(tramos[4].total).toBeGreaterThan(0);
  });

  test('todos los valores iguales dan un solo tramo (no divide por 0)', () => {
    const tramos = Analitica.histograma([7, 7, 7]);
    expect(tramos).toEqual([{ desde: 7, hasta: 7, total: 3 }]);
  });

  test('sin datos, no hay tramos', () => {
    expect(Analitica.histograma([null])).toEqual([]);
  });
});

describe('outliersIQR (función pura)', () => {
  test('marca el valor muy alto y devuelve el lote de origen', () => {
    const lotes = [
      { id: 'a', merma: 10 },
      { id: 'b', merma: 11 },
      { id: 'c', merma: 12 },
      { id: 'd', merma: 11 },
      { id: 'e', merma: 90 },
    ];
    const atipicos = Analitica.outliersIQR(lotes, (l) => l.merma);
    expect(atipicos).toHaveLength(1);
    expect(atipicos[0].item.id).toBe('e');
    expect(atipicos[0].lado).toBe('alto');
  });

  test('con menos de 4 observaciones no se declaran atípicos', () => {
    const lotes = [{ v: 1 }, { v: 2 }, { v: 99 }];
    expect(Analitica.outliersIQR(lotes, (l) => l.v)).toEqual([]);
  });
});

describe('correlacionPearson (función pura)', () => {
  test('relación lineal perfecta da r = 1', () => {
    const pares = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 3 * i + 1 }));
    expect(Analitica.correlacionPearson(pares).r).toBe(1);
  });

  test(`con menos de ${Analitica.MIN_PARES_CORRELACION} pares no se calcula`, () => {
    const pares = Array.from({ length: 4 }, (_, i) => ({ x: i, y: i }));
    expect(Analitica.correlacionPearson(pares)).toMatchObject({
      r: null,
      datosInsuficientes: true,
    });
  });

  test('una variable constante no da r = 0 (no está definida)', () => {
    const pares = Array.from({ length: 10 }, (_, i) => ({ x: 5, y: i }));
    expect(Analitica.correlacionPearson(pares).r).toBeNull();
  });
});

describe('mediaMovil y tendenciaSerie (funciones puras)', () => {
  test('la media móvil deja null hasta completar la ventana', () => {
    const mm = Analitica.mediaMovil([1, 2, 3, 4, 5, 6, 7, 8], 7);
    expect(mm.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(mm[6]).toBe(4); // media de 1..7
    expect(mm[7]).toBe(5); // media de 2..8
  });

  test('serie creciente: tendencia "sube" con pendiente positiva', () => {
    const serie = Array.from({ length: 10 }, (_, i) => ({
      fecha: `2026-01-${String(i + 1).padStart(2, '0')}`,
      valor: 10 + i * 5,
    }));
    const t = Analitica.tendenciaSerie(serie);
    expect(t.direccion).toBe('sube');
    expect(t.pendientePorDia).toBeCloseTo(5, 5);
    expect(t.r2).toBeCloseTo(1, 5);
  });

  test('un cambio mínimo respecto al promedio se reporta como "estable"', () => {
    const serie = Array.from({ length: 10 }, (_, i) => ({
      fecha: `2026-01-${String(i + 1).padStart(2, '0')}`,
      valor: 100 + i * 0.01,
    }));
    expect(Analitica.tendenciaSerie(serie).direccion).toBe('estable');
  });

  test(`con menos de ${Analitica.MIN_DIAS_TENDENCIA} días no se afirma tendencia`, () => {
    const serie = [
      { fecha: '2026-01-01', valor: 1 },
      { fecha: '2026-01-02', valor: 50 },
    ];
    expect(Analitica.tendenciaSerie(serie)).toMatchObject({
      datosInsuficientes: true,
      direccion: 'sin_datos',
    });
  });
});

describe('compararVentanas (función pura)', () => {
  test('compara los últimos 7 días contra los 7 anteriores', () => {
    const serie = [...Array(7).fill(10), ...Array(7).fill(20)].map((valor, i) => ({
      fecha: `2026-01-${String(i + 1).padStart(2, '0')}`,
      valor,
    }));
    expect(Analitica.compararVentanas(serie)).toMatchObject({
      actual: 20,
      previa: 10,
      variacionPct: 100,
    });
  });

  test('con menos de dos ventanas completas no se compara', () => {
    const serie = Array.from({ length: 8 }, (_, i) => ({ fecha: `d${i}`, valor: 1 }));
    expect(Analitica.compararVentanas(serie).datosInsuficientes).toBe(true);
  });
});

describe('validarLote (reglas de coherencia)', () => {
  /** Un lote que no dispara ninguna regla, para ir rompiéndolo de a una. */
  function loteSano() {
    return {
      id: 'lote-1',
      cantidad: 100,
      produccionId: 'prod-1',
      ingredientesRegistrados: 3,
      insumosSinLoteProveedor: 0,
      mermaRealPct: 10,
      desvioMermaPp: 1,
      desvioTemperaturaC: 2,
      desvioTiempoHorneadoPct: 5,
      segundaCalidadPct: 2,
      desvioRendimientoPct: 3,
      pesoPanCocidoTotalG: 9000,
      pesoTotalMasaG: 10_000,
      vidaUtilHoras: 24,
    };
  }

  test('un lote completo y coherente no genera hallazgos', () => {
    expect(Analitica.validarLote(loteSano())).toEqual([]);
  });

  test.each([
    ['cantidad_invalida', { cantidad: 0 }],
    ['sin_produccion', { produccionId: null }],
    ['sin_ingredientes', { ingredientesRegistrados: 0 }],
    ['merma_fuera_de_rango', { mermaRealPct: 95 }],
    ['peso_incoherente', { pesoPanCocidoTotalG: 12_000 }],
    ['merma_sin_registrar', { mermaRealPct: null }],
    ['merma_desviada', { desvioMermaPp: 9 }],
    ['temperatura_desviada', { desvioTemperaturaC: -40 }],
    ['tiempo_desviado', { desvioTiempoHorneadoPct: 60 }],
    ['segunda_calidad_alta', { segundaCalidadPct: 25 }],
    ['rendimiento_desviado', { desvioRendimientoPct: -35 }],
    ['sin_vida_util', { vidaUtilHoras: null }],
    ['insumos_sin_lote_proveedor', { insumosSinLoteProveedor: 2 }],
  ])('detecta %s', (codigo, cambio) => {
    const codigos = Analitica.validarLote({ ...loteSano(), ...cambio }).map((h) => h.codigo);
    expect(codigos).toContain(codigo);
  });

  test('el resumen cuenta lotes con hallazgos, severidades y porcentaje sano', () => {
    const resumen = Analitica.validarLotes([
      loteSano(),
      { ...loteSano(), id: 'lote-2', cantidad: 0 },
    ]);
    expect(resumen).toMatchObject({ totalLotes: 2, lotesConHallazgos: 1, porcentajeSano: 50 });
    expect(resumen.porSeveridad.alta).toBeGreaterThanOrEqual(1);
    expect(resumen.hallazgos[0].loteId).toBe('lote-2');
  });

  test('sin lotes, el porcentaje sano es 100 (no hay nada objetable)', () => {
    expect(Analitica.validarLotes([]).porcentajeSano).toBe(100);
  });
});

describe('completitudLotes (función pura)', () => {
  test('cuenta el porcentaje de lotes con cada campo lleno', () => {
    const filas = [{ mermaRealPct: 10 }, { mermaRealPct: null }];
    const merma = Analitica.completitudLotes(filas).find((c) => c.campo === 'mermaRealPct');
    expect(merma).toMatchObject({ llenos: 1, total: 2, porcentaje: 50 });
  });
});

/* ═══════════════════════════════════════════
   Integración: lotes.js + GET /lotes*
   ═══════════════════════════════════════════
   lotes.js depende de db.js, que abre el archivo de DB_PATH en el propio
   require() — por eso se importa dentro de beforeAll, después de apuntar
   DB_PATH a un archivo temporal (mismo patrón que calidadDatos.test.js). */

const ADMIN_TOKEN = 'test-token-lotes';
const PRODUCTO_ID = '1';

let app;
let server;
let wss;
let db;
let Lotes;
let dbPath;
let sessionToken;

/** Fecha ISO de hace `dias` días, para sembrar un historial que caiga
 *  dentro de la ventana por defecto del módulo. */
function haceDias(dias) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `plm-lotes-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.AUTH_MAX_ATTEMPTS = '100000';
  process.env.ORDERS_MAX_PER_WINDOW = '100000';

  ({ app, server, wss } = require('../server'));
  db = require('../db');
  Lotes = require('../lotes');

  // Vida útil del producto: sin esto ningún lote puede evaluar frescura.
  db.prepare('UPDATE productos SET vida_util_horas = 24 WHERE id = ?').run(Number(PRODUCTO_ID));

  db.prepare(
    `INSERT INTO recetas (id, producto_id, producto_nombre, peso_masa_por_unidad_g,
                          tiempo_horneado_min, temperatura_horneado_c, merma_coccion_pct)
     VALUES ('rec-1', ?, 'Pan de prueba', 100, 30, 200, 10)`,
  ).run(PRODUCTO_ID);

  db.prepare(
    `INSERT INTO insumos (id, nombre, categoria, cantidad, unidad, lote_proveedor)
     VALUES ('ins-1', 'Harina de prueba', 'harinas', 50, 'kg', NULL)`,
  ).run();

  // 12 días de historial: una tanda de masa y una horneada por día, con
  // merma que va subiendo (para que la tendencia tenga algo que detectar).
  for (let i = 0; i < 12; i++) {
    const fecha = haceDias(11 - i);
    db.prepare(
      `INSERT INTO producciones (id, producto_id, producto_nombre, receta_id, fecha, hora_inicio,
                                 peso_total_masa_g, unidades_estimadas, temperatura_ambiente_c)
       VALUES (?, ?, 'Pan de prueba', 'rec-1', ?, '04:00', 5000, 50, ?)`,
    ).run(`prod-${i}`, PRODUCTO_ID, fecha, 24 + i);
    db.prepare(
      `INSERT INTO produccion_ingredientes (id, produccion_id, insumo_id, insumo_nombre, gramos)
       VALUES (?, ?, 'ins-1', 'Harina de prueba', 3000)`,
    ).run(`pi-${i}`, `prod-${i}`);
    db.prepare(
      `INSERT INTO horneadas (id, producto_id, producto_nombre, cantidad, fecha, hora,
                              produccion_id, temperatura_horneado_real_c, tiempo_horneado_real_min,
                              merma_real_pct, peso_pan_cocido_total_g, unidades_segunda_calidad,
                              costo_estimado_energia_lote)
       VALUES (?, ?, 'Pan de prueba', ?, ?, '06:00', ?, 202, 30, ?, 4500, 1, 3.5)`,
    ).run(`horn-${i}`, PRODUCTO_ID, 48 + i, fecha, `prod-${i}`, 8 + i * 0.5);
  }

  // Un lote roto a propósito: sin tanda de masa ni merma registrada.
  db.prepare(
    `INSERT INTO horneadas (id, producto_id, producto_nombre, cantidad, fecha, hora)
     VALUES ('horn-roto', ?, 'Pan de prueba', 30, ?, '07:30')`,
  ).run(PRODUCTO_ID, haceDias(1));

  // Una venta entregada del día de ayer, para que el FIFO tenga qué repartir.
  db.prepare(
    `INSERT INTO ordenes (numero, fecha_iso, fecha_texto, cliente, telefono, retiro,
                          items_json, total, estado)
     VALUES ('PED-LOTES-1', ?, 'ayer', 'Cliente', '3000000000', '08:00', ?, 20, 'entregada')`,
  ).run(haceDias(1), JSON.stringify([{ productoId: Number(PRODUCTO_ID), cantidad: 10 }]));

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

describe('resolverRango', () => {
  test('sin fechas, usa la ventana por defecto que termina hoy', () => {
    const { desde, hasta } = Lotes.resolverRango();
    const dias = (new Date(`${hasta}T00:00:00Z`) - new Date(`${desde}T00:00:00Z`)) / 86400000;
    expect(dias).toBe(Lotes.VENTANA_DIAS_DEFECTO - 1);
  });

  test('un rango invertido se endereza en vez de devolver 0 lotes', () => {
    expect(Lotes.resolverRango({ desde: '2026-03-10', hasta: '2026-03-01' })).toEqual({
      desde: '2026-03-01',
      hasta: '2026-03-10',
    });
  });

  test('una fecha con formato inválido se descarta (no rompe la consulta)', () => {
    expect(Lotes.resolverRango({ desde: 'ayer', hasta: '2026-03-05' }).hasta).toBe('2026-03-05');
  });
});

describe('calcularEstadoFrescura y calcularVencimientoIso', () => {
  test('el vencimiento es el horneado más la vida útil', () => {
    expect(Lotes.calcularVencimientoIso('2026-03-01', '06:00', 8)).toBe('2026-03-01T14:00:00');
  });

  test('sin vida útil configurada no se puede calcular vencimiento', () => {
    expect(Lotes.calcularVencimientoIso('2026-03-01', '06:00', null)).toBeNull();
  });

  test('un lote agotado no se reporta como vencido: ya se vendió', () => {
    const estado = Lotes.calcularEstadoFrescura({
      fecha: '2026-03-01',
      hora: '06:00',
      vidaUtilHoras: 8,
      seAgoto: true,
      ahoraFecha: '2026-03-05',
      ahoraHora: '10:00',
    });
    expect(estado).toBe('agotado');
  });

  test.each([
    ['fresco', '10:00', 8],
    ['por_vencer', '13:30', 8],
    ['vencido', '15:00', 8],
    ['sin_dato', '10:00', null],
  ])('a las %s del mismo día, el estado es %s', (esperado, ahoraHora, vidaUtilHoras) => {
    expect(
      Lotes.calcularEstadoFrescura({
        fecha: '2026-03-01',
        hora: '06:00',
        vidaUtilHoras,
        seAgoto: false,
        ahoraFecha: '2026-03-01',
        ahoraHora,
      }),
    ).toBe(esperado);
  });
});

describe('construirSerieDiaria', () => {
  test('incluye los días sin lotes en 0, para no sesgar la tendencia', () => {
    const lotes = [{ fecha: '2026-03-01', cantidad: 10, unidadesVendidas: 5, mermaRealPct: 8 }];
    const serie = Lotes.construirSerieDiaria(lotes, { desde: '2026-03-01', hasta: '2026-03-03' });
    expect(serie).toHaveLength(3);
    expect(serie[0]).toMatchObject({ lotes: 1, unidades: 10, unidadesVendidas: 5 });
    expect(serie[1]).toMatchObject({ lotes: 0, unidades: 0, mermaPromedioPct: null });
  });
});

describe('obtenerLotes (procesamiento sobre la base real)', () => {
  test('cada horneada se convierte en un lote con código legible', () => {
    const { lotes } = Lotes.obtenerLotes({ productoId: PRODUCTO_ID });
    expect(lotes.length).toBeGreaterThanOrEqual(13);
    expect(lotes.every((l) => /^L-\d{8}-\d{4}-[A-Z0-9]+$/.test(l.codigo))).toBe(true);
  });

  test('los desvíos se calculan contra la receta y la tanda de masa', () => {
    const { lotes } = Lotes.obtenerLotes({ productoId: PRODUCTO_ID });
    const lote = lotes.find((l) => l.id === 'horn-0');
    expect(lote).toMatchObject({
      mermaEsperadaPct: 10,
      temperaturaRecetaC: 200,
      desvioTemperaturaC: 2,
      tiempoRecetaMin: 30,
      desvioTiempoHorneadoPct: 0,
      unidadesEstimadas: 50,
      pesoTotalMasaG: 5000,
    });
    expect(lote.desvioMermaPp).toBeCloseTo(-2, 5);
    expect(lote.segundaCalidadPct).toBeGreaterThan(0);
  });

  test('la trazabilidad llega al insumo, y si no hay lote de proveedor se dice', () => {
    const { lotes } = Lotes.obtenerLotes({ productoId: PRODUCTO_ID });
    const lote = lotes.find((l) => l.id === 'horn-0');
    expect(lote.ingredientesRegistrados).toBe(1);
    expect(lote.trazabilidad[0]).toMatchObject({
      insumoNombre: 'Harina de prueba',
      loteProveedor: null,
      origen: 'sin_dato',
    });
    expect(lote.insumosSinLoteProveedor).toBe(1);
  });

  test('las ventas del día se reparten FIFO entre los lotes de ese producto', () => {
    const fecha = haceDias(1);
    const { lotes } = Lotes.obtenerLotes({ desde: fecha, hasta: fecha, productoId: PRODUCTO_ID });
    const vendidas = lotes.reduce((s, l) => s + (l.unidadesVendidas ?? 0), 0);
    expect(vendidas).toBe(10);
    // El más viejo del día (06:00) se lleva la venta antes que el de 07:30.
    expect(lotes.find((l) => l.hora === '06:00').unidadesVendidas).toBe(10);
    expect(lotes.find((l) => l.hora === '07:30').unidadesVendidas).toBe(0);
  });

  test('el lote sin tanda ni merma queda con sus hallazgos, no corregido', () => {
    const fecha = haceDias(1);
    const { lotes } = Lotes.obtenerLotes({ desde: fecha, hasta: fecha, productoId: PRODUCTO_ID });
    const roto = lotes.find((l) => l.id === 'horn-roto');
    expect(roto.mermaRealPct).toBeNull();
    expect(roto.produccionId).toBeNull();
    const codigos = roto.hallazgos.map((h) => h.codigo);
    expect(codigos).toContain('sin_produccion');
    expect(codigos).toContain('merma_sin_registrar');
  });

  test('filtrar por otro producto no devuelve los lotes sembrados', () => {
    const { lotes } = Lotes.obtenerLotes({ productoId: '2' });
    expect(lotes).toHaveLength(0);
  });
});

describe('analizarLotes (reporte completo)', () => {
  test('resumen, descriptivas, tendencias y validación sobre el mismo conjunto', () => {
    const analisis = Lotes.analizarLotes({ productoId: PRODUCTO_ID });

    expect(analisis.resumen.totalLotes).toBe(analisis.lotes.length);
    expect(analisis.resumen.totalUnidades).toBeGreaterThan(0);
    expect(analisis.resumen.mermaPromedioPct).toBeGreaterThan(0);

    const merma = analisis.descriptivas.find((d) => d.campo === 'mermaRealPct');
    expect(merma.n).toBe(12); // el lote roto no tiene merma registrada
    expect(merma.histograma.length).toBeGreaterThan(0);

    expect(analisis.tendencias.serie.length).toBe(analisis.periodo.dias);
    expect(analisis.tendencias.merma.direccion).toBe('sube');

    expect(analisis.calidad.totalLotes).toBe(analisis.lotes.length);
    expect(analisis.calidad.porRegla.some((r) => r.codigo === 'sin_produccion')).toBe(true);
    const completitudMerma = analisis.calidad.completitud.find((c) => c.campo === 'mermaRealPct');
    expect(completitudMerma.porcentaje).toBeLessThan(100);
  });

  test('los cortes por producto y por hora suman lo mismo que el total', () => {
    const analisis = Lotes.analizarLotes({ productoId: PRODUCTO_ID });
    const porProducto = analisis.porProducto.reduce((s, p) => s + p.unidades, 0);
    const porHora = analisis.porHora.reduce((s, h) => s + h.unidades, 0);
    expect(porProducto).toBe(analisis.resumen.totalUnidades);
    expect(porHora).toBe(analisis.resumen.totalUnidades);
  });

  test('sin lotes en el rango, el reporte no revienta ni inventa ceros', () => {
    const analisis = Lotes.analizarLotes({ desde: '2020-01-01', hasta: '2020-01-31' });
    expect(analisis.resumen.totalLotes).toBe(0);
    expect(analisis.resumen.mermaPromedioPct).toBeNull();
    expect(analisis.resumen.tasaVentaPct).toBeNull();
    expect(analisis.atipicos).toEqual([]);
    expect(analisis.calidad.porcentajeSano).toBe(100);
  });
});

describe('obtenerLote (trazabilidad puntual)', () => {
  test('devuelve el lote con su trazabilidad', () => {
    const lote = Lotes.obtenerLote('horn-0');
    expect(lote.id).toBe('horn-0');
    expect(lote.trazabilidad).toHaveLength(1);
  });

  test('un id que no existe devuelve null', () => {
    expect(Lotes.obtenerLote('no-existe')).toBeNull();
  });
});

describe('endpoints de lotes', () => {
  test.each(['/lotes', '/lotes/analisis', '/lotes/horn-0'])('%s requiere sesión', async (ruta) => {
    const res = await request(app).get(ruta);
    expect(res.status).toBe(401);
  });

  test('GET /lotes devuelve período y lotes', async () => {
    const res = await request(app)
      .get(`/lotes?productoId=${PRODUCTO_ID}`)
      .set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body.periodo).toHaveProperty('desde');
    expect(Array.isArray(res.body.lotes)).toBe(true);
  });

  test('GET /lotes/analisis devuelve el reporte completo', async () => {
    const res = await request(app).get('/lotes/analisis').set('Authorization', auth());
    expect(res.status).toBe(200);
    for (const clave of [
      'periodo',
      'resumen',
      'descriptivas',
      'atipicos',
      'porProducto',
      'porHora',
      'correlaciones',
      'tendencias',
      'calidad',
      'lotes',
    ]) {
      expect(res.body).toHaveProperty(clave);
    }
  });

  test('/lotes/analisis no se confunde con un id de lote', async () => {
    const res = await request(app).get('/lotes/analisis').set('Authorization', auth());
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('resumen');
  });

  test('GET /lotes/:id devuelve la trazabilidad, y 404 si no existe', async () => {
    const ok = await request(app).get('/lotes/horn-0').set('Authorization', auth());
    expect(ok.status).toBe(200);
    expect(ok.body.trazabilidad).toHaveLength(1);

    const noExiste = await request(app).get('/lotes/horn-999').set('Authorization', auth());
    expect(noExiste.status).toBe(404);
  });

  test.each([
    ['?desde=ayer', 400],
    ['?hasta=2026-13-99x', 400],
    ['?productoId=abc', 400],
  ])('GET /lotes%s responde %i', async (query, esperado) => {
    const res = await request(app).get(`/lotes${query}`).set('Authorization', auth());
    expect(res.status).toBe(esperado);
  });
});

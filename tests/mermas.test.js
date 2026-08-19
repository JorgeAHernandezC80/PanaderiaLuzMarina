/**
 * @jest-environment node
 */

const {
  clasificarNota,
  imputarNulos,
  marcarAtipicos,
  limpiarDatasetMermas,
  MIN_EVENTOS_MEDIANA_PRODUCTO,
} = require('../mermasAnalitica');

function evento(overrides = {}) {
  return {
    id: 'coccion:1',
    tipo: 'coccion',
    fecha: '2026-08-01',
    hora: '06:00',
    productoId: 'p1',
    productoNombre: 'Pan francés',
    valor: 8,
    unidad: '%',
    mermaEsperadaPct: 7,
    notaOriginal: null,
    causaProbable: null,
    registradoPor: 'jorge',
    ...overrides,
  };
}

describe('clasificarNota (dato no estructurado → categoría)', () => {
  test('reconoce una causa por palabra clave', () => {
    expect(clasificarNota('Se quemó la base del pan')).toBe('quemado');
    expect(clasificarNota('la masa no subió, quedó plana')).toBe('no_fermento');
    expect(clasificarNota('bolsa rota en el empaque')).toBe('empaque');
  });

  test('nota sin palabra clave reconocida es sin_clasificar, no null', () => {
    expect(clasificarNota('algo raro pasó hoy')).toBe('sin_clasificar');
  });

  test('sin nota devuelve null (distinto de sin_clasificar)', () => {
    expect(clasificarNota(null)).toBeNull();
    expect(clasificarNota(undefined)).toBeNull();
    expect(clasificarNota('   ')).toBeNull();
  });

  test('la primera causa que coincide gana', () => {
    // "quemado" antes que "error_horno" en el diccionario
    expect(clasificarNota('se quemó por la temperatura del horno')).toBe('quemado');
  });
});

describe('imputarNulos', () => {
  test('no toca eventos con valor numérico válido, incluido 0', () => {
    const eventos = [evento({ id: 'a', valor: 5 }), evento({ id: 'b', valor: 0 })];
    const { eventos: resultado, imputaciones } = imputarNulos(eventos);
    expect(resultado[0].valor).toBe(5);
    expect(resultado[1].valor).toBe(0);
    expect(imputaciones).toHaveLength(0);
  });

  test('imputa con la mediana del producto cuando hay suficientes eventos', () => {
    const mismoProducto = Array.from({ length: MIN_EVENTOS_MEDIANA_PRODUCTO }, (_, i) =>
      evento({ id: `p${i}`, productoId: 'p1', valor: 10 }),
    );
    const conHueco = evento({ id: 'hueco', productoId: 'p1', valor: null });
    const { eventos: resultado, imputaciones } = imputarNulos([...mismoProducto, conHueco]);

    const imputado = resultado.find((e) => e.id === 'hueco');
    expect(imputado.valor).toBe(10);
    expect(imputado.esImputado).toBe(true);
    expect(imputado.valorOriginal).toBeNull();
    expect(imputaciones[0].fuente).toBe('mediana_producto');
  });

  test('usa la mediana global del tipo cuando el producto no tiene suficiente historial', () => {
    const otrosProductos = [
      evento({ id: 'x1', productoId: 'pX', valor: 4 }),
      evento({ id: 'x2', productoId: 'pY', valor: 6 }),
    ];
    const conHueco = evento({ id: 'hueco', productoId: 'pZ', valor: null });
    const { eventos: resultado, imputaciones } = imputarNulos([...otrosProductos, conHueco]);

    const imputado = resultado.find((e) => e.id === 'hueco');
    expect(imputado.valor).toBe(5); // mediana de [4, 6]
    expect(imputaciones[0].fuente).toBe('mediana_global_tipo');
  });

  test('sin ningún dato válido en el tipo, queda sin resolver (null), no inventado', () => {
    const soloHuecos = [evento({ id: 'a', valor: null }), evento({ id: 'b', valor: null })];
    const { eventos: resultado, imputaciones } = imputarNulos(soloHuecos);
    expect(resultado.every((e) => e.valor === null)).toBe(true);
    expect(imputaciones.every((i) => i.valorImputado === null)).toBe(true);
  });
});

describe('marcarAtipicos', () => {
  test('marca un valor muy alejado del grupo por la regla de Tukey', () => {
    const normales = [10, 11, 9, 10, 12, 9, 11, 10].map((v, i) =>
      evento({ id: `n${i}`, valor: v }),
    );
    const extremo = evento({ id: 'raro', valor: 80 });
    const resultado = marcarAtipicos([...normales, extremo]);

    const marcado = resultado.find((e) => e.id === 'raro');
    expect(marcado.esAtipico).toBe(true);
    expect(marcado.ladoAtipico).toBe('alto');
    expect(resultado.filter((e) => e.id !== 'raro').every((e) => e.esAtipico === false)).toBe(true);
  });

  test('no mezcla escalas entre tipos (unidades vs. porcentaje)', () => {
    const coccion = [8, 9, 7, 8, 9, 7, 8].map((v, i) =>
      evento({ id: `c${i}`, tipo: 'coccion', unidad: '%', valor: v }),
    );
    // 40 unidades sería atípico si se comparara contra el % de cocción,
    // pero es un valor normal dentro de su propio tipo (ajuste_manual).
    const ajustes = [38, 40, 42, 39, 41, 40, 39].map((v, i) =>
      evento({ id: `a${i}`, tipo: 'ajuste_manual', unidad: 'unidades', valor: v }),
    );
    const resultado = marcarAtipicos([...coccion, ...ajustes]);
    expect(resultado.every((e) => e.esAtipico === false)).toBe(true);
  });
});

describe('limpiarDatasetMermas (pipeline de limpieza completo)', () => {
  test('reporta totales coherentes de nulos, imputaciones y atípicos', () => {
    const base = [10, 11, 9, 10, 12].map((v, i) => evento({ id: `b${i}`, valor: v }));
    const hueco = evento({ id: 'hueco', valor: null });
    const { eventos, reporte } = limpiarDatasetMermas([...base, hueco]);

    expect(reporte.totalEventos).toBe(6);
    expect(reporte.nulosDetectados).toBe(1);
    expect(reporte.nulosImputados).toBe(1);
    expect(eventos.find((e) => e.id === 'hueco').valor).not.toBeNull();
  });
});

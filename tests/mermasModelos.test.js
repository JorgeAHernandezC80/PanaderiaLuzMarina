/**
 * @jest-environment node
 */

const {
  frecuencias,
  regresionLinealMultiple,
  betaIncompletaRegularizada,
  varianzaMuestral,
  pruebaTStudent,
  pruebaChiCuadrado,
  segmentarCausas,
  entrenarRegresionLogistica,
  predecirProbabilidad,
  evaluarClasificador,
} = require('../mermasModelos');

describe('frecuencias (univariado categórico)', () => {
  test('cuenta, porcentaje y porcentaje acumulado, ordenado de mayor a menor', () => {
    const tabla = frecuencias(['a', 'a', 'a', 'b', 'b', 'c']);
    expect(tabla).toEqual([
      { valor: 'a', conteo: 3, porcentaje: 50, porcentajeAcumulado: 50 },
      { valor: 'b', conteo: 2, porcentaje: 33.33, porcentajeAcumulado: 83.33 },
      { valor: 'c', conteo: 1, porcentaje: 16.67, porcentajeAcumulado: 100 },
    ]);
  });

  test('null/undefined se agrupan como sin_dato', () => {
    const tabla = frecuencias([null, undefined, 'x']);
    expect(tabla.find((f) => f.valor === 'sin_dato').conteo).toBe(2);
  });
});

describe('segmentarCausas (modelo descriptivo)', () => {
  test('agrupa por causaProbable, tratando null como sin_nota', () => {
    const eventos = [
      { causaProbable: 'quemado' },
      { causaProbable: 'quemado' },
      { causaProbable: null },
    ];
    const resultado = segmentarCausas(eventos);
    expect(resultado[0]).toMatchObject({ valor: 'quemado', conteo: 2 });
    expect(resultado.find((r) => r.valor === 'sin_nota').conteo).toBe(1);
  });
});

describe('betaIncompletaRegularizada (motor numérico de la prueba t)', () => {
  test('t≈1.96 con grados de libertad grandes da p≈0.05 (converge a la normal)', () => {
    const p = betaIncompletaRegularizada(100000 / (100000 + 1.96 * 1.96), 100000 / 2, 0.5);
    expect(p).toBeCloseTo(0.05, 2);
  });

  test('t=0 da p=1 (sin ninguna diferencia)', () => {
    expect(betaIncompletaRegularizada(30 / 30, 15, 0.5)).toBe(1);
  });
});

describe('varianzaMuestral', () => {
  test('usa n-1 (corrección de Bessel), no n', () => {
    // [2,4,4,4,5,5,7,9]: varianza poblacional=4, muestral = 4*8/7 ≈ 4.5714
    const v = varianzaMuestral([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(v).toBeCloseTo(4.5714, 3);
  });

  test('con un solo dato no está definida', () => {
    expect(varianzaMuestral([5])).toBeNull();
  });
});

describe('pruebaTStudent (Welch, dos muestras)', () => {
  test('estadístico y p-valor coherentes contra un cálculo manual', () => {
    const a = [23, 25, 21, 22, 24, 25, 26, 23, 22, 24];
    const b = [19, 20, 18, 17, 21, 19, 20, 18, 19, 20];
    const r = pruebaTStudent(a, b);
    expect(r.valido).toBe(true);
    expect(r.mediaA).toBe(23.5);
    expect(r.mediaB).toBe(19.1);
    expect(r.diferenciaMedias).toBe(4.4);
    expect(r.pValor).toBeLessThan(0.001); // diferencia muy marcada, poca varianza
    expect(r.hipotesisNulaRechazada).toBe(true);
  });

  test('dos muestras idénticas dan t=0 y no rechazan H0', () => {
    const r = pruebaTStudent([10, 12, 11, 13], [10, 12, 11, 13]);
    expect(r.estadisticoT).toBe(0);
    expect(r.pValor).toBe(1);
    expect(r.hipotesisNulaRechazada).toBe(false);
  });

  test('con menos de 2 datos en un grupo, no es válida', () => {
    const r = pruebaTStudent([5], [1, 2, 3]);
    expect(r.valido).toBe(false);
  });
});

describe('pruebaChiCuadrado (independencia)', () => {
  test('estadístico exacto contra un cálculo manual (tabla 2x2 de libro)', () => {
    const r = pruebaChiCuadrado([
      [10, 20],
      [30, 40],
    ]);
    expect(r.valido).toBe(true);
    expect(r.estadistico).toBeCloseTo(0.7937, 3);
    expect(r.gradosLibertad).toBe(1);
    expect(r.valorCritico).toBe(3.841);
    expect(r.hipotesisNulaRechazada).toBe(false);
  });

  test('una dependencia fuerte y evidente sí rechaza H0', () => {
    // Causa A ocurre casi solo en el grupo 1; causa B casi solo en el grupo 2.
    const r = pruebaChiCuadrado([
      [95, 5],
      [5, 95],
    ]);
    expect(r.hipotesisNulaRechazada).toBe(true);
  });

  test('menos de 2x2 no es válida', () => {
    expect(pruebaChiCuadrado([[10]]).valido).toBe(false);
  });
});

describe('regresionLinealMultiple', () => {
  test('recupera exactamente los coeficientes reales sin ruido', () => {
    const filas = [];
    for (let i = 0; i < 12; i++) {
      const x1 = i;
      const x2 = (i * 7) % 5;
      filas.push({ x: [x1, x2], y: 3 + 2 * x1 - 1 * x2 });
    }
    const modelo = regresionLinealMultiple(filas);
    expect(modelo.intercepto).toBeCloseTo(3, 4);
    expect(modelo.coeficientes[0]).toBeCloseTo(2, 4);
    expect(modelo.coeficientes[1]).toBeCloseTo(-1, 4);
    expect(modelo.r2).toBe(1);
  });

  test('sin suficientes filas para el número de predictores, devuelve null', () => {
    expect(regresionLinealMultiple([{ x: [1, 2], y: 5 }])).toBeNull();
  });
});

describe('entrenarRegresionLogistica + predecirProbabilidad + evaluarClasificador', () => {
  test('separa perfectamente dos grupos claramente distintos', () => {
    const muestras = [];
    for (let i = 0; i < 30; i++) {
      const x1 = i < 15 ? 10 + i : 60 + i;
      muestras.push({ x: [x1], y: i < 15 ? 0 : 1 });
    }
    const modelo = entrenarRegresionLogistica(muestras);
    expect(modelo).not.toBeNull();

    const probs = muestras.map((m) => predecirProbabilidad(modelo, m.x));
    const reales = muestras.map((m) => m.y);
    const evaluacion = evaluarClasificador(probs, reales);
    expect(evaluacion.exactitud).toBe(1);
    expect(evaluacion.matrizConfusion.falsosPositivos).toBe(0);
    expect(evaluacion.matrizConfusion.falsosNegativos).toBe(0);
  });

  test('con muy pocos datos para el número de predictores, devuelve null', () => {
    expect(
      entrenarRegresionLogistica([
        { x: [1], y: 0 },
        { x: [2], y: 1 },
      ]),
    ).toBeNull();
  });

  test('con una sola clase presente, devuelve null (nada que separar)', () => {
    const soloUnaClase = Array.from({ length: 15 }, (_, i) => ({ x: [i], y: 0 }));
    expect(entrenarRegresionLogistica(soloUnaClase)).toBeNull();
  });
});

/**
 * @jest-environment node
 */

const { validarOrden, ValidationError } = require('../validation');

/** Construye una orden válida base; sobrescribe con overrides. */
function ordenValida(overrides = {}) {
  const base = {
    numero: 'LM-20260117-1234',
    fechaISO: '2026-01-17T10:30:00.000Z',
    fechaTexto: 'sábado 17 de enero, 2026 · 10:30 a. m.',
    cliente: 'Ana Pérez',
    telefono: '+57 300 123 4567',
    retiro: '10:30',
    items: [
      { nombre: 'Pan francés', cantidad: 2, precio: 1.5 },
      { nombre: 'Croissant', cantidad: 1, precio: 2 },
    ],
    total: 5,
  };
  return { ...base, ...overrides };
}

describe('ValidationError', () => {
  test('es una instancia de Error con statusCode 400', () => {
    const err = new ValidationError('algo');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ValidationError');
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe('algo');
  });
});

describe('validarOrden — orden válida', () => {
  test('acepta una orden bien formada y devuelve datos saneados', () => {
    const out = validarOrden(ordenValida());
    expect(out.numero).toBe('LM-20260117-1234');
    // el teléfono se normaliza a solo dígitos
    expect(out.telefono).toBe('573001234567');
    expect(out.items).toHaveLength(2);
    expect(out.total).toBe(5);
  });

  test('recorta espacios en fechaTexto, cliente y nombres de items', () => {
    const out = validarOrden(ordenValida({
      fechaTexto: '  hoy  ',
      cliente: '  Ana  ',
      items: [{ nombre: '  Pan  ', cantidad: 1, precio: 5 }],
      total: 5,
    }));
    expect(out.fechaTexto).toBe('hoy');
    expect(out.cliente).toBe('Ana');
    expect(out.items[0].nombre).toBe('Pan');
  });

  test('normaliza precio de string numérico a number', () => {
    const out = validarOrden(ordenValida({
      items: [{ nombre: 'Pan', cantidad: 2, precio: '2.5' }],
      total: 5,
    }));
    expect(out.items[0].precio).toBe(2.5);
    expect(typeof out.items[0].precio).toBe('number');
  });

  test('acepta total como string numérico coherente', () => {
    const out = validarOrden(ordenValida({ total: '5' }));
    expect(out.total).toBe(5);
  });
});

describe('validarOrden — cuerpo/estructura', () => {
  test.each([null, undefined, 'texto', 42, []])(
    'rechaza cuerpo no-objeto: %p',
    (body) => {
      expect(() => validarOrden(body)).toThrow(ValidationError);
    }
  );

  test('el error lanzado es ValidationError con statusCode 400', () => {
    expect.assertions(2);
    try {
      validarOrden(null);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.statusCode).toBe(400);
    }
  });
});

describe('validarOrden — numero', () => {
  test.each([
    ['LM-2026011-1234', 'fecha muy corta'],
    ['LM-20260117-123', 'sufijo muy corto'],
    ['XX-20260117-1234', 'prefijo incorrecto'],
    ['LM-20260117-1234-1', 'extra'],
    ['', 'vacío'],
  ])('rechaza numero inválido %p (%s)', (numero) => {
    expect(() => validarOrden(ordenValida({ numero }))).toThrow('Número de orden');
  });

  test('rechaza numero no-string', () => {
    expect(() => validarOrden(ordenValida({ numero: 12345 }))).toThrow(ValidationError);
  });
});

describe('validarOrden — fechas', () => {
  test('rechaza fechaISO con formato incorrecto', () => {
    expect(() => validarOrden(ordenValida({ fechaISO: '2026/01/17' }))).toThrow('fechaISO');
  });

  test('rechaza fechaISO no-string', () => {
    expect(() => validarOrden(ordenValida({ fechaISO: 12345 }))).toThrow('fechaISO');
  });

  test('rechaza fechaTexto vacía', () => {
    expect(() => validarOrden(ordenValida({ fechaTexto: '   ' }))).toThrow('fechaTexto');
  });

  test('rechaza fechaTexto demasiado larga', () => {
    expect(() => validarOrden(ordenValida({ fechaTexto: 'x'.repeat(201) }))).toThrow('fechaTexto');
  });
});

describe('validarOrden — cliente', () => {
  test('rechaza cliente vacío', () => {
    expect(() => validarOrden(ordenValida({ cliente: '   ' }))).toThrow('cliente');
  });

  test('rechaza cliente demasiado largo (>80)', () => {
    expect(() => validarOrden(ordenValida({ cliente: 'a'.repeat(81) }))).toThrow('cliente');
  });

  test('rechaza cliente no-string', () => {
    expect(() => validarOrden(ordenValida({ cliente: 123 }))).toThrow('cliente');
  });
});

describe('validarOrden — telefono', () => {
  test('rechaza teléfono con menos de 7 dígitos', () => {
    expect(() => validarOrden(ordenValida({ telefono: '12345' }))).toThrow('Teléfono');
  });

  test('rechaza teléfono con más de 15 dígitos', () => {
    expect(() => validarOrden(ordenValida({ telefono: '1234567890123456' }))).toThrow('Teléfono');
  });

  test('rechaza teléfono nulo/indefinido', () => {
    expect(() => validarOrden(ordenValida({ telefono: null }))).toThrow('Teléfono');
    expect(() => validarOrden(ordenValida({ telefono: undefined }))).toThrow('Teléfono');
  });

  test('acepta teléfono con separadores y los elimina', () => {
    const out = validarOrden(ordenValida({ telefono: '(300) 123-4567' }));
    expect(out.telefono).toBe('3001234567');
  });
});

describe('validarOrden — retiro', () => {
  test.each(['1030', '100:30', '10-30', '', 'abc', '10:5'])(
    'rechaza horario de retiro con formato inválido: %p',
    (retiro) => {
      expect(() => validarOrden(ordenValida({ retiro }))).toThrow('retiro');
    }
  );

  test('acepta hora de un solo dígito', () => {
    const out = validarOrden(ordenValida({ retiro: '9:05' }));
    expect(out.retiro).toBe('9:05');
  });

  test('valida solo el formato, no el rango horario (comportamiento actual)', () => {
    // El regex actual permite valores fuera de rango como 25:99.
    const out = validarOrden(ordenValida({ retiro: '25:99' }));
    expect(out.retiro).toBe('25:99');
  });
});

describe('validarOrden — items', () => {
  test('rechaza items que no son array', () => {
    expect(() => validarOrden(ordenValida({ items: 'nope' }))).toThrow('Lista de items');
  });

  test('rechaza lista de items vacía', () => {
    expect(() => validarOrden(ordenValida({ items: [], total: 5 }))).toThrow('Lista de items');
  });

  test('rechaza más de 50 items', () => {
    const items = Array.from({ length: 51 }, () => ({ nombre: 'Pan', cantidad: 1, precio: 1 }));
    expect(() => validarOrden(ordenValida({ items, total: 51 }))).toThrow('Lista de items');
  });

  test('rechaza item que no es objeto', () => {
    expect(() => validarOrden(ordenValida({ items: ['x'], total: 5 }))).toThrow('se esperaba un objeto');
  });

  test('rechaza nombre de item vacío', () => {
    expect(() => validarOrden(ordenValida({ items: [{ nombre: '  ', cantidad: 1, precio: 5 }], total: 5 })))
      .toThrow('nombre inválido');
  });

  test('rechaza nombre de item demasiado largo', () => {
    expect(() => validarOrden(ordenValida({ items: [{ nombre: 'a'.repeat(121), cantidad: 1, precio: 5 }], total: 5 })))
      .toThrow('nombre inválido');
  });

  test.each([0, -1, 1000, 1.5, '2'])(
    'rechaza cantidad de item inválida: %p',
    (cantidad) => {
      expect(() => validarOrden(ordenValida({ items: [{ nombre: 'Pan', cantidad, precio: 5 }], total: 5 })))
        .toThrow('cantidad inválida');
    }
  );

  test.each([0, -5, 1001, NaN, 'abc'])(
    'rechaza precio de item inválido: %p',
    (precio) => {
      expect(() => validarOrden(ordenValida({ items: [{ nombre: 'Pan', cantidad: 1, precio }], total: 5 })))
        .toThrow('precio inválido');
    }
  );
});

describe('validarOrden — total', () => {
  test.each([0, -1, 50001, NaN, 'abc'])(
    'rechaza total inválido: %p',
    (total) => {
      expect(() => validarOrden(ordenValida({ total }))).toThrow('Total inválido');
    }
  );

  test('rechaza total que no coincide con la suma de items', () => {
    expect(() => validarOrden(ordenValida({ total: 999 }))).toThrow('no coincide');
  });

  test('acepta pequeña diferencia de redondeo (<= 0.01)', () => {
    const out = validarOrden(ordenValida({
      items: [{ nombre: 'Pan', cantidad: 3, precio: 0.1 }],
      total: 0.30,
    }));
    expect(out.total).toBe(0.30);
  });
});

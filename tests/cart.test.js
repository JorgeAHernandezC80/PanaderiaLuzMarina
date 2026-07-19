/**
 * @jest-environment jsdom
 */

import {
  validateProductData,
  escapeHTML,
  getCart,
  addToCart,
  updateQuantity,
  removeFromCart,
  clearCart,
  getCartCount,
  getCartTotal,
} from '../JS/core/cart.js';
import { formatPrice } from '../JS/core/format.js';

const CART_KEY = 'plm_cart';

const producto = (overrides = {}) => ({
  id: 'p1',
  nombre: 'Pan francés',
  precio: 2.5,
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  jest.restoreAllMocks();
});

describe('validateProductData', () => {
  test('acepta un producto válido', () => {
    expect(validateProductData(producto())).toBe(true);
  });

  test.each([null, undefined, 'x', 42])('rechaza no-objeto: %p', (v) => {
    expect(() => validateProductData(v)).toThrow('se esperaba un objeto');
  });

  test.each([undefined, null, '', '   '])('rechaza id ausente: %p', (id) => {
    expect(() => validateProductData(producto({ id }))).toThrow('falta el id');
  });

  test('acepta id numérico', () => {
    expect(validateProductData(producto({ id: 5 }))).toBe(true);
  });

  test.each(['', '   ', 123, null])('rechaza nombre inválido: %p', (nombre) => {
    expect(() => validateProductData(producto({ nombre }))).toThrow(/nombre/);
  });

  test('rechaza nombre demasiado largo', () => {
    expect(() => validateProductData(producto({ nombre: 'a'.repeat(121) }))).toThrow(
      'demasiado largo',
    );
  });

  test.each([0, -1, NaN, 'abc'])('rechaza precio no positivo/no numérico: %p', (precio) => {
    expect(() => validateProductData(producto({ precio }))).toThrow('mayor que 0');
  });

  test('rechaza precio fuera de rango (>1000)', () => {
    expect(() => validateProductData(producto({ precio: 1001 }))).toThrow('fuera de rango');
  });
});

describe('escapeHTML', () => {
  test('escapa caracteres especiales de HTML', () => {
    expect(escapeHTML(`<script>"x"&'y'</script>`)).toBe(
      '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;',
    );
  });

  test('convierte null/undefined en cadena vacía', () => {
    expect(escapeHTML(null)).toBe('');
    expect(escapeHTML(undefined)).toBe('');
  });

  test('convierte números a string', () => {
    expect(escapeHTML(42)).toBe('42');
  });
});

describe('getCart', () => {
  test('devuelve [] cuando no hay nada guardado', () => {
    expect(getCart()).toEqual([]);
  });

  test('devuelve [] con JSON corrupto', () => {
    localStorage.setItem(CART_KEY, '{no es json');
    expect(getCart()).toEqual([]);
  });

  test('devuelve [] cuando el valor almacenado no es un array', () => {
    localStorage.setItem(CART_KEY, JSON.stringify({ foo: 'bar' }));
    expect(getCart()).toEqual([]);
  });

  test('filtra items inválidos y persiste la versión limpia', () => {
    const valido = { id: 'p1', nombre: 'Pan', precio: 2, cantidad: 1 };
    const invalido = { id: 'p2', nombre: '', precio: 2, cantidad: 1 };
    localStorage.setItem(CART_KEY, JSON.stringify([valido, invalido]));

    const result = getCart();
    expect(result).toEqual([valido]);
    // La versión limpia se persiste
    expect(JSON.parse(localStorage.getItem(CART_KEY))).toEqual([valido]);
  });

  test('descarta items con cantidad no entera o fuera de rango', () => {
    localStorage.setItem(
      CART_KEY,
      JSON.stringify([
        { id: 'a', nombre: 'A', precio: 1, cantidad: 1.5 },
        { id: 'b', nombre: 'B', precio: 1, cantidad: 1000 },
        { id: 'c', nombre: 'C', precio: 1, cantidad: 2 },
      ]),
    );
    expect(getCart().map((i) => i.id)).toEqual(['c']);
  });

  test('descarta items con imagen de tipo inválido', () => {
    localStorage.setItem(
      CART_KEY,
      JSON.stringify([{ id: 'a', nombre: 'A', precio: 1, cantidad: 1, imagen: 123 }]),
    );
    expect(getCart()).toEqual([]);
  });
});

describe('addToCart', () => {
  test('agrega un producto nuevo con cantidad por defecto 1', () => {
    addToCart(producto());
    const cart = getCart();
    expect(cart).toHaveLength(1);
    expect(cart[0]).toMatchObject({
      id: 'p1',
      nombre: 'Pan francés',
      precio: 2.5,
      cantidad: 1,
      imagen: '',
    });
  });

  test('normaliza id a string y usa imagen provista', () => {
    addToCart(producto({ id: 7, imagen: 'x.png' }));
    const cart = getCart();
    expect(cart[0].id).toBe('7');
    expect(cart[0].imagen).toBe('x.png');
  });

  test('incrementa la cantidad si el producto ya existe', () => {
    addToCart(producto(), 2);
    addToCart(producto(), 3);
    const cart = getCart();
    expect(cart).toHaveLength(1);
    expect(cart[0].cantidad).toBe(5);
  });

  test.each([0, -1, 1.5, 1000])('rechaza cantidad inválida: %p', (cant) => {
    expect(() => addToCart(producto(), cant)).toThrow('Cantidad inválida');
  });

  test('lanza si al sumar se excede la cantidad máxima (999)', () => {
    addToCart(producto(), 999);
    expect(() => addToCart(producto(), 1)).toThrow('máxima');
  });

  test('propaga error de producto inválido', () => {
    expect(() => addToCart(producto({ precio: -1 }))).toThrow(/precio/);
  });

  test('dispara el evento cart:updated', () => {
    const handler = jest.fn();
    window.addEventListener('cart:updated', handler);
    addToCart(producto());
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener('cart:updated', handler);
  });
});

describe('updateQuantity', () => {
  beforeEach(() => addToCart(producto(), 2));

  test('actualiza la cantidad de un item existente', () => {
    updateQuantity('p1', 5);
    expect(getCart()[0].cantidad).toBe(5);
  });

  test('trunca cantidades decimales', () => {
    updateQuantity('p1', 3.9);
    expect(getCart()[0].cantidad).toBe(3);
  });

  test('limita a un máximo de 999', () => {
    updateQuantity('p1', 5000);
    expect(getCart()[0].cantidad).toBe(999);
  });

  test('elimina el item cuando la cantidad es <= 0', () => {
    updateQuantity('p1', 0);
    expect(getCart()).toHaveLength(0);
  });

  test('ignora cantidades no numéricas', () => {
    updateQuantity('p1', 'abc');
    expect(getCart()[0].cantidad).toBe(2);
  });

  test('no falla si el id no existe', () => {
    updateQuantity('inexistente', 5);
    expect(getCart()[0].cantidad).toBe(2);
  });
});

describe('removeFromCart', () => {
  test('elimina el item indicado', () => {
    addToCart(producto());
    addToCart(producto({ id: 'p2', nombre: 'Croissant' }));
    removeFromCart('p1');
    expect(getCart().map((i) => i.id)).toEqual(['p2']);
  });
});

describe('clearCart', () => {
  test('vacía el carrito', () => {
    addToCart(producto());
    clearCart();
    expect(getCart()).toEqual([]);
  });
});

describe('getCartCount', () => {
  test('devuelve 0 con carrito vacío', () => {
    expect(getCartCount()).toBe(0);
  });

  test('suma las cantidades de todos los items', () => {
    addToCart(producto(), 2);
    addToCart(producto({ id: 'p2', nombre: 'Croissant' }), 3);
    expect(getCartCount()).toBe(5);
  });
});

describe('getCartTotal', () => {
  test('devuelve 0 con carrito vacío', () => {
    expect(getCartTotal()).toBe(0);
  });

  test('suma precio * cantidad de todos los items', () => {
    addToCart(producto({ precio: 2 }), 2); // 4
    addToCart(producto({ id: 'p2', nombre: 'Croissant', precio: 3 }), 1); // 3
    expect(getCartTotal()).toBe(7);
  });
});

describe('formatPrice', () => {
  test('formatea como moneda USD con 2 decimales', () => {
    expect(formatPrice(2.5)).toBe('$2.50');
    expect(formatPrice(1000)).toBe('$1,000.00');
  });

  test('acepta strings numéricos', () => {
    expect(formatPrice('3')).toBe('$3.00');
  });
});

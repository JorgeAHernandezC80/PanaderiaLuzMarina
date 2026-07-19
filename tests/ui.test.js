/**
 * @jest-environment jsdom
 */

import { updateCartBadges, initUI } from '../JS/core/ui.js';
import { addToCart, clearCart } from '../JS/core/cart.js';

function mockMatchMedia(matches = false) {
  window.matchMedia = jest.fn().mockImplementation(() => ({
    matches,
    media: '',
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
}

const producto = (overrides = {}) => ({ id: 'p1', nombre: 'Pan', precio: 2, ...overrides });

beforeEach(() => {
  localStorage.clear();
  mockMatchMedia(false);
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
});

describe('updateCartBadges', () => {
  test('escribe el conteo y el aria-label en cada badge', () => {
    document.body.innerHTML = `
      <span data-cart-count></span>
      <span data-cart-count></span>
    `;
    addToCart(producto(), 3);
    updateCartBadges();
    document.querySelectorAll('[data-cart-count]').forEach(el => {
      expect(el.textContent).toBe('3');
      expect(el.getAttribute('aria-label')).toBe('3 productos en el carrito');
    });
  });

  test('muestra el header__badge cuando hay items', () => {
    document.body.innerHTML = `<span class="header__badge" data-cart-count hidden></span>`;
    addToCart(producto(), 1);
    updateCartBadges();
    expect(document.querySelector('[data-cart-count]').hasAttribute('hidden')).toBe(false);
  });

  test('oculta el header__badge cuando el carrito está vacío', () => {
    document.body.innerHTML = `<span class="header__badge" data-cart-count></span>`;
    clearCart();
    updateCartBadges();
    expect(document.querySelector('[data-cart-count]').hasAttribute('hidden')).toBe(true);
  });

  test('no falla cuando no hay badges en el DOM', () => {
    expect(() => updateCartBadges()).not.toThrow();
  });
});

describe('initUI — menú móvil', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button data-header-toggle aria-expanded="false"></button>
      <nav data-header-menu></nav>
      <div data-header-overlay></div>
    `;
    initUI();
  });

  const toggle = () => document.querySelector('[data-header-toggle]');
  const menu = () => document.querySelector('[data-header-menu]');
  const overlay = () => document.querySelector('[data-header-overlay]');

  test('abre el menú al hacer clic en el toggle', () => {
    toggle().click();
    expect(menu().classList.contains('is-open')).toBe(true);
    expect(overlay().classList.contains('is-visible')).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
  });

  test('cierra el menú con un segundo clic', () => {
    toggle().click();
    toggle().click();
    expect(menu().classList.contains('is-open')).toBe(false);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(document.body.style.overflow).toBe('');
  });

  test('cierra el menú al hacer clic en el overlay', () => {
    toggle().click();
    overlay().click();
    expect(menu().classList.contains('is-open')).toBe(false);
  });

  test('cierra el menú al presionar Escape', () => {
    toggle().click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(menu().classList.contains('is-open')).toBe(false);
  });

  test('cierra el menú al redimensionar por encima de 768px', () => {
    toggle().click();
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(menu().classList.contains('is-open')).toBe(false);
  });
});

describe('initUI — sin menú', () => {
  test('no falla cuando faltan el toggle y el menú', () => {
    document.body.innerHTML = '';
    expect(() => initUI()).not.toThrow();
  });
});

describe('initUI — actualización reactiva de badges', () => {
  test('actualiza los badges al dispararse cart:updated', () => {
    document.body.innerHTML = `<span data-cart-count></span>`;
    initUI();
    expect(document.querySelector('[data-cart-count]').textContent).toBe('0');
    addToCart(producto(), 2); // dispara cart:updated
    expect(document.querySelector('[data-cart-count]').textContent).toBe('2');
  });

  test('actualiza los badges ante un evento storage de plm_cart', () => {
    document.body.innerHTML = `<span data-cart-count></span>`;
    initUI();
    addToCart(producto(), 4);
    // Simular cambio desde otra pestaña
    document.querySelector('[data-cart-count]').textContent = 'stale';
    window.dispatchEvent(Object.assign(new Event('storage'), { key: 'plm_cart' }));
    expect(document.querySelector('[data-cart-count]').textContent).toBe('4');
  });
});

describe('initUI — header scroll', () => {
  test('aplica la clase header--scrolled según el scroll', () => {
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { cb(); return 0; });
    document.body.innerHTML = `<header data-header></header>`;
    Object.defineProperty(window, 'scrollY', { value: 50, configurable: true });
    initUI();
    const header = document.querySelector('[data-header]');
    expect(header.classList.contains('header--scrolled')).toBe(true);

    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    expect(header.classList.contains('header--scrolled')).toBe(false);
    window.requestAnimationFrame.mockRestore();
  });
});

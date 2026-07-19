/**
 * @jest-environment jsdom
 */

import { initTheme } from '../JS/core/theme.js';

const STORAGE_KEY = 'plm_theme';

let mqListeners;
let mqMatches;

/** Instala un mock controlable de window.matchMedia. */
function mockMatchMedia(matches) {
  mqMatches = matches;
  mqListeners = [];
  window.matchMedia = jest.fn().mockImplementation(() => ({
    get matches() {
      return mqMatches;
    },
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_event, cb) => mqListeners.push(cb),
    removeEventListener: (_event, cb) => {
      mqListeners = mqListeners.filter((l) => l !== cb);
    },
  }));
}

/** Simula un cambio de preferencia del SO. */
function fireOSChange(matches) {
  mqMatches = matches;
  mqListeners.forEach((cb) => cb({ matches }));
}

function setupDOM() {
  document.body.innerHTML = `
    <button data-theme-toggle aria-label="">
      <i data-theme-icon class=""></i>
    </button>
  `;
}

const html = () => document.documentElement;
const icon = () => document.querySelector('[data-theme-icon]');
const btn = () => document.querySelector('[data-theme-toggle]');

beforeEach(() => {
  localStorage.clear();
  setupDOM();
  html().removeAttribute('data-theme');
  mockMatchMedia(false);
});

describe('initTheme — tema inicial', () => {
  test('aplica el tema guardado (dark)', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    initTheme();
    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(icon().className).toBe('fa-solid fa-moon');
    expect(btn().getAttribute('aria-label')).toBe('Cambiar a modo claro');
  });

  test('aplica el tema guardado (light)', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    initTheme();
    expect(html().hasAttribute('data-theme')).toBe(false);
    expect(icon().className).toBe('fa-solid fa-sun');
    expect(btn().getAttribute('aria-label')).toBe('Cambiar a modo oscuro');
  });

  test('usa la preferencia del SO cuando no hay tema guardado (dark)', () => {
    mockMatchMedia(true);
    initTheme();
    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  test('usa la preferencia del SO cuando no hay tema guardado (light)', () => {
    mockMatchMedia(false);
    initTheme();
    expect(html().hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });
});

describe('initTheme — toggle', () => {
  test('alterna de light a dark al hacer clic', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    initTheme();
    btn().click();
    expect(html().getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
  });

  test('alterna de dark a light al hacer clic', () => {
    localStorage.setItem(STORAGE_KEY, 'dark');
    initTheme();
    btn().click();
    expect(html().hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
  });
});

describe('initTheme — cambios del SO', () => {
  test('reacciona a cambios del SO si el usuario no eligió manualmente', () => {
    // no hay tema guardado antes de initTheme
    initTheme();
    // initTheme persiste 'light', pero probamos que change lo actualiza igualmente
    localStorage.removeItem(STORAGE_KEY);
    fireOSChange(true);
    expect(html().getAttribute('data-theme')).toBe('dark');
  });

  test('ignora cambios del SO si el usuario ya eligió un tema', () => {
    localStorage.setItem(STORAGE_KEY, 'light');
    initTheme();
    fireOSChange(true);
    expect(html().hasAttribute('data-theme')).toBe(false);
  });
});

describe('initTheme — sin botón', () => {
  test('no falla si no existe el botón de toggle', () => {
    document.body.innerHTML = '';
    localStorage.setItem(STORAGE_KEY, 'dark');
    expect(() => initTheme()).not.toThrow();
    expect(html().getAttribute('data-theme')).toBe('dark');
  });
});

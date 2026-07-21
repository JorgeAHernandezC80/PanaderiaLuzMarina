/**
 * @jest-environment jsdom
 */

import { initI18n, t, getCurrentLang } from '../JS/core/i18n.js';

const STORAGE_KEY = 'plm_lang';

function setupDOM() {
  document.body.innerHTML = `
    <button data-lang-toggle>
      <span data-lang-label>ES</span>
    </button>
    <a data-i18n="nav_home">x</a>
    <a data-i18n="nav_catalog">x</a>
    <span data-i18n="clave_inexistente">no-cambiar</span>
    <input data-i18n-placeholder="checkout_name_ph" placeholder="x" />
    <nav data-i18n-aria-label="nav_aria" aria-label="x"></nav>
  `;
}

function setNavigatorLanguage(lang) {
  Object.defineProperty(window.navigator, 'language', {
    value: lang,
    configurable: true,
  });
}

beforeEach(() => {
  localStorage.clear();
  setupDOM();
  setNavigatorLanguage('en-US');
  document.documentElement.removeAttribute('lang');
});

describe('initI18n — idioma inicial', () => {
  test('usa el idioma guardado en localStorage', () => {
    localStorage.setItem(STORAGE_KEY, 'es');
    initI18n();
    expect(document.querySelector('[data-i18n="nav_home"]').textContent).toBe('Inicio');
    expect(document.documentElement.lang).toBe('es');
    expect(document.querySelector('[data-lang-label]').textContent).toBe('ES');
  });

  test('ignora un idioma guardado no soportado y cae al navegador', () => {
    localStorage.setItem(STORAGE_KEY, 'fr');
    setNavigatorLanguage('es-CO');
    initI18n();
    expect(document.querySelector('[data-i18n="nav_home"]').textContent).toBe('Inicio');
  });

  test('detecta español desde navigator.language', () => {
    setNavigatorLanguage('es-ES');
    initI18n();
    expect(document.querySelector('[data-i18n="nav_home"]').textContent).toBe('Inicio');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('es');
  });

  test('cae a inglés para idiomas no soportados', () => {
    setNavigatorLanguage('de-DE');
    initI18n();
    expect(document.querySelector('[data-i18n="nav_home"]').textContent).toBe('Home');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('en');
  });

  test('maneja navigator.language ausente cayendo a inglés', () => {
    setNavigatorLanguage(undefined);
    initI18n();
    expect(document.querySelector('[data-i18n="nav_home"]').textContent).toBe('Home');
  });
});

describe('initI18n — aplicación al DOM', () => {
  test('no modifica elementos con claves inexistentes', () => {
    initI18n();
    expect(document.querySelector('[data-i18n="clave_inexistente"]').textContent).toBe(
      'no-cambiar',
    );
  });

  test('actualiza el aria-label del botón según el idioma', () => {
    localStorage.setItem(STORAGE_KEY, 'es');
    initI18n();
    expect(document.querySelector('[data-lang-toggle]').getAttribute('aria-label')).toBe(
      'Switch to English',
    );
  });
});

describe('initI18n — toggle', () => {
  test('alterna de español a inglés al hacer clic', () => {
    localStorage.setItem(STORAGE_KEY, 'es');
    initI18n();
    document.querySelector('[data-lang-toggle]').click();
    expect(document.querySelector('[data-i18n="nav_home"]').textContent).toBe('Home');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('en');
    expect(document.querySelector('[data-lang-label]').textContent).toBe('EN');
  });

  test('alterna de inglés a español al hacer clic', () => {
    localStorage.setItem(STORAGE_KEY, 'en');
    initI18n();
    document.querySelector('[data-lang-toggle]').click();
    expect(document.querySelector('[data-i18n="nav_home"]').textContent).toBe('Inicio');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('es');
  });
});

describe('initI18n — sin botón de toggle', () => {
  test('aplica traducciones aunque no exista el botón', () => {
    document.body.innerHTML = `<a data-i18n="nav_home">x</a>`;
    localStorage.setItem(STORAGE_KEY, 'es');
    expect(() => initI18n()).not.toThrow();
    expect(document.querySelector('[data-i18n="nav_home"]').textContent).toBe('Inicio');
  });
});

describe('initI18n — traducción de atributos', () => {
  test('traduce placeholder con data-i18n-placeholder', () => {
    localStorage.setItem(STORAGE_KEY, 'es');
    initI18n();
    expect(document.querySelector('[data-i18n-placeholder]').getAttribute('placeholder')).toBe(
      'Tu nombre completo',
    );
    document.querySelector('[data-lang-toggle]').click();
    expect(document.querySelector('[data-i18n-placeholder]').getAttribute('placeholder')).toBe(
      'Your full name',
    );
  });

  test('traduce aria-label con data-i18n-aria-label', () => {
    localStorage.setItem(STORAGE_KEY, 'en');
    initI18n();
    expect(document.querySelector('[data-i18n-aria-label]').getAttribute('aria-label')).toBe(
      'Main navigation',
    );
  });
});

describe('t() y getCurrentLang()', () => {
  test('t() devuelve la traducción del idioma activo', () => {
    localStorage.setItem(STORAGE_KEY, 'es');
    initI18n();
    expect(t('nav_home')).toBe('Inicio');
    expect(getCurrentLang()).toBe('es');
    document.querySelector('[data-lang-toggle]').click();
    expect(t('nav_home')).toBe('Home');
    expect(getCurrentLang()).toBe('en');
  });

  test('t() devuelve la clave si no existe traducción', () => {
    initI18n();
    expect(t('clave_inexistente_total')).toBe('clave_inexistente_total');
  });
});

describe('evento lang:changed', () => {
  test('emite lang:changed con el idioma al aplicar', () => {
    const handler = jest.fn();
    window.addEventListener('lang:changed', handler);
    localStorage.setItem(STORAGE_KEY, 'es');
    initI18n();
    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0].detail.lang).toBe('es');
    window.removeEventListener('lang:changed', handler);
  });
});

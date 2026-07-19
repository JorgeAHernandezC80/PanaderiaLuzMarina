/**
 * PANADERÍA LUZ MARINA — Core: Theme
 * Toggle dark / light mode.
 * - Persiste en localStorage ('plm_theme')
 * - Aplica data-theme="dark" en <html>
 * - Cambia ícono sol ↔ luna en el botón
 */

const STORAGE_KEY = 'plm_theme';

/** Obtiene el tema guardado o el preferido por el SO */
function getSavedTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Aplica el tema al documento y actualiza el botón */
function applyTheme(theme) {
  const html = document.documentElement;
  const btn = document.querySelector('[data-theme-toggle]');
  const icon = btn?.querySelector('[data-theme-icon]');

  if (theme === 'dark') {
    html.setAttribute('data-theme', 'dark');
  } else {
    html.removeAttribute('data-theme');
  }

  if (icon) {
    /* fa-sun en light, fa-moon en dark */
    icon.className = theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
  }

  if (btn) {
    btn.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro',
    );
  }

  localStorage.setItem(STORAGE_KEY, theme);
}

/** Inicializa el toggle de tema */
export function initTheme() {
  /* Aplicar tema guardado inmediatamente para evitar flash */
  const theme = getSavedTheme();
  applyTheme(theme);

  /* Escuchar clic en el botón */
  const btn = document.querySelector('[data-theme-toggle]');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    applyTheme(current === 'dark' ? 'light' : 'dark');
  });

  /* Reaccionar a cambios del SO en tiempo real */
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    /* Solo si el usuario no ha elegido manualmente */
    if (!localStorage.getItem(STORAGE_KEY)) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
}

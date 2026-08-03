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

/** Aplica el tema al documento y actualiza TODOS los botones de tema que
 *  haya en la página — normalmente hay uno solo (sitio público), pero
 *  admin.html tiene dos (topbar móvil + sidebar de escritorio, nunca
 *  visibles los dos a la vez, pero ambos deben quedar sincronizados). */
function applyTheme(theme) {
  const html = document.documentElement;

  if (theme === 'dark') {
    html.setAttribute('data-theme', 'dark');
  } else {
    html.removeAttribute('data-theme');
  }

  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    const icon = btn.querySelector('[data-theme-icon]');
    if (icon) {
      /* fa-sun en light, fa-moon en dark */
      icon.className = theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    }
    btn.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro',
    );
  });

  localStorage.setItem(STORAGE_KEY, theme);
}

/** Inicializa el/los toggle(s) de tema */
export function initTheme() {
  /* Aplicar tema guardado inmediatamente para evitar flash */
  const theme = getSavedTheme();
  applyTheme(theme);

  /* Escuchar clic en CADA botón de tema que haya en la página */
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });
  });

  /* Reaccionar a cambios del SO en tiempo real */
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    /* Solo si el usuario no ha elegido manualmente */
    if (!localStorage.getItem(STORAGE_KEY)) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  });
}

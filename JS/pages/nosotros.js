/**
 * PANADERÍA LUZ MARINA — Página: Nosotros
 *
 * Reemplaza los antiguos manejadores `onerror` en línea (bloqueados por la CSP
 * `script-src 'self'`) por listeners registrados desde este módulo:
 *   - [data-img-hide]      → oculta la imagen si no carga.
 *   - [data-img-fallback]  → sustituye la imagen por un emoji de reemplazo.
 */

import { initUI } from '../core/ui.js';

/** Marca de fallo de carga: la imagen ya terminó pero no tiene dimensiones. */
function hasFailed(img) {
  return img.complete && img.naturalWidth === 0;
}

/** Registra el handler ahora o al fallar; cubre el caso de error ya ocurrido. */
function onLoadError(img, handler) {
  if (hasFailed(img)) {
    handler();
    return;
  }
  img.addEventListener('error', handler, { once: true });
}

function initImageFallbacks() {
  document.querySelectorAll('img[data-img-hide]').forEach((img) => {
    onLoadError(img, () => {
      img.style.display = 'none';
    });
  });

  document.querySelectorAll('img[data-img-fallback]').forEach((img) => {
    onLoadError(img, () => {
      const wrapper = img.parentElement;
      if (!wrapper) return;
      const span = document.createElement('span');
      span.className = 'miembro__foto-emoji';
      span.setAttribute('aria-hidden', 'true');
      span.textContent = img.dataset.imgFallback;
      wrapper.replaceChildren(span);
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initUI();
  initImageFallbacks();
});

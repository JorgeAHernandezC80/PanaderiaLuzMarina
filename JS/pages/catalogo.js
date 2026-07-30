/**
 * PANADERÍA LUZ MARINA — Página: Catálogo
 * - Filtros por categoría
 * - Añadir al carrito con feedback visual
 */

import { initUI, updateCartBadges } from '../core/ui.js';
import { addToCart } from '../core/cart.js';
import { t } from '../core/i18n.js';
import { apiFetch } from '../core/api.js';

/** Trae el disponible real de cada producto (GET /inventario/disponible,
 *  público, sin token) y reemplaza el texto estático "Quedan N" de cada
 *  tarjeta por el número real. Si el producto no viene en la respuesta (o
 *  la petición falla), se deja el contenido que ya trae el HTML tal cual,
 *  para no romper la página por un problema de red. */
let _disponiblePorId = null;

async function initStockDisponible() {
  let productos;
  try {
    const res = await apiFetch('/inventario/disponible', { timeout: 8000 });
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    ({ productos } = await res.json());
  } catch (err) {
    console.warn('[catalogo] No se pudo obtener el disponible en tiempo real:', err.message);
    return;
  }

  _disponiblePorId = new Map(productos.map((p) => [String(p.productoId), p.disponible]));
  renderStockDisponible();
}

/** Aplica _disponiblePorId al DOM. Se llama al cargar y de nuevo cada vez
 *  que cambia el idioma (evento `lang:changed`), ya que "Quedan"/"Agotado"
 *  se arman en JS y no a través de data-i18n declarativo. */
function renderStockDisponible() {
  if (!_disponiblePorId) return;

  document.querySelectorAll('.producto-card').forEach((card) => {
    const btn = card.querySelector('[data-producto-id]');
    const stockEl = card.querySelector('.producto-card__stock');
    if (!btn || !stockEl) return;

    const disponible = _disponiblePorId.get(String(btn.dataset.productoId));
    if (disponible === undefined) return; // producto fuera del catálogo del backend

    if (disponible > 0) {
      stockEl.textContent = `🟢 ${t('stock_quedan')} ${disponible}`;
      stockEl.classList.remove('producto-card__stock--agotado');
      stockEl.classList.add('producto-card__stock--disponible');
      btn.disabled = false;
    } else {
      stockEl.textContent = `🔴 ${t('stock_agotado')}`;
      stockEl.classList.remove('producto-card__stock--disponible');
      stockEl.classList.add('producto-card__stock--agotado');
      btn.disabled = true;
    }
  });
}

window.addEventListener('lang:changed', renderStockDisponible);

/** Maneja los filtros de categoría */
function initFiltros() {
  const btns = document.querySelectorAll('[data-filter]');
  const cards = document.querySelectorAll('[data-categoria]');
  const vacio = document.querySelector('[data-productos-vacio]');

  if (!btns.length) return;

  btns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const filtro = btn.dataset.filter;

      // Estado activo
      btns.forEach((b) => {
        b.classList.remove('filtro-btn--active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('filtro-btn--active');
      btn.setAttribute('aria-pressed', 'true');

      // Visibilidad de cards
      let visibles = 0;
      cards.forEach((card) => {
        const match = filtro === 'todos' || card.dataset.categoria === filtro;
        card.hidden = !match;
        if (match) visibles++;
      });

      if (vacio) vacio.hidden = visibles > 0;
    });
  });
}

/** Añadir al carrito desde el catálogo */
function initAddToCart() {
  document.querySelector('[data-productos-grid]')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-producto-id]');
    if (!btn) return;

    const { productoId, productoNombre, productoPrecio } = btn.dataset;

    /* Capturar la imagen del card */
    const card = btn.closest('.producto-card');
    const imgEl = card?.querySelector('.producto-card__imagen img');
    const imagen = imgEl?.getAttribute('src') ?? '';

    try {
      addToCart({
        id: productoId,
        nombre: productoNombre,
        precio: Number(productoPrecio),
        imagen: imagen,
      });

      // Feedback visual — éxito
      const originalText = btn.textContent;
      btn.textContent = t('toast_added');
      btn.classList.add('is-added');
      btn.disabled = true;

      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('is-added');
        btn.disabled = false;
      }, 1200);

      updateCartBadges();
    } catch (err) {
      // Feedback visual — error (datos de producto inválidos)
      console.warn('[catalogo] addToCart falló:', err.message);
      const originalText = btn.textContent;
      btn.textContent = t('toast_error');
      btn.classList.add('is-error');
      setTimeout(() => {
        btn.textContent = originalText;
        btn.classList.remove('is-error');
      }, 1500);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initUI();
  initFiltros();
  initAddToCart();
  initStockDisponible();
});

/**
 * PANADERÍA LUZ MARINA — Página: Catálogo
 * - Filtros por categoría
 * - Añadir al carrito con feedback visual
 */

import { initUI, updateCartBadges } from '../core/ui.js';
import { addToCart } from '../core/cart.js';

/** Maneja los filtros de categoría */
function initFiltros() {
  const btns  = document.querySelectorAll('[data-filter]');
  const cards = document.querySelectorAll('[data-categoria]');
  const vacio = document.querySelector('[data-productos-vacio]');

  if (!btns.length) return;

  btns.forEach(btn => {
    btn.addEventListener('click', () => {
      const filtro = btn.dataset.filter;

      // Estado activo
      btns.forEach(b => {
        b.classList.remove('filtro-btn--active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('filtro-btn--active');
      btn.setAttribute('aria-pressed', 'true');

      // Visibilidad de cards
      let visibles = 0;
      cards.forEach(card => {
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
  document.querySelector('[data-productos-grid]')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-producto-id]');
    if (!btn) return;

    const { productoId, productoNombre, productoPrecio } = btn.dataset;

    /* Capturar la imagen del card */
    const card    = btn.closest('.producto-card');
    const imgEl   = card?.querySelector('.producto-card__imagen img');
    const imagen  = imgEl?.getAttribute('src') ?? '';

    addToCart({
      id:     productoId,
      nombre: productoNombre,
      precio: Number(productoPrecio),
      imagen: imagen,
    });

    // Feedback visual
    const originalText = btn.textContent;
    btn.textContent = '✓ Añadido';
    btn.classList.add('is-added');
    btn.disabled = true;

    setTimeout(() => {
      btn.textContent = originalText;
      btn.classList.remove('is-added');
      btn.disabled = false;
    }, 1200);

    updateCartBadges();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initUI();
  initFiltros();
  initAddToCart();
});

/**
 * PANADERÍA LUZ MARINA — Página: Carrito
 * - Renderiza items desde localStorage
 * - Controles de cantidad y eliminar
 * - Vaciar canasta
 * - Habilita botón "Proceder al Pago"
 */

import { initUI } from '../core/ui.js';
import {
  getCart, updateQuantity, removeFromCart,
  clearCart, getCartTotal, escapeHTML
} from '../core/cart.js';
import { formatPrice, pluralizeEs } from '../core/format.js';

/* ---- Elementos del DOM ---- */
const els = {
  itemsWrapper: () => document.querySelector('[data-carrito-items]'),
  vacio:        () => document.querySelector('[data-carrito-vacio]'),
  subtotal:     () => document.querySelector('[data-resumen-subtotal]'),
  total:        () => document.querySelector('[data-resumen-total]'),
  proceder:     () => document.querySelector('[data-btn-proceder-pago]'),
  vaciar:       () => document.querySelector('[data-btn-vaciar-carrito]'),
  cantidadTexto:() => document.querySelector('[data-carrito-cantidad-texto]'),
};

/** Genera el HTML de un item del carrito */
function renderItem(item) {
  const subtotal    = item.precio * item.cantidad;
  const imgSrc      = item.imagen || '';
  const nombreSafe  = escapeHTML(item.nombre);
  const idSafe      = escapeHTML(String(item.id));
  const imgEl       = imgSrc
    ? `<img src="${escapeHTML(imgSrc)}" alt="${nombreSafe}" loading="lazy">`
    : `<span class="producto-card__imagen-fallback" aria-hidden="true">🍞</span>`;

  return `
    <article class="carrito-item" data-item-id="${idSafe}">
      <div class="carrito-item__imagen">${imgEl}</div>
      <div class="carrito-item__info">
        <h3 class="carrito-item__nombre">${nombreSafe}</h3>
        <p class="carrito-item__precio">${formatPrice(item.precio)} × ${item.cantidad} = ${formatPrice(subtotal)}</p>
      </div>
      <div class="carrito-item__cantidad-control">
        <button type="button" class="carrito-item__btn" data-action="decrement" aria-label="Disminuir cantidad de ${nombreSafe}">−</button>
        <span class="carrito-item__cantidad" data-item-cantidad>${Number(item.cantidad)}</span>
        <button type="button" class="carrito-item__btn" data-action="increment" aria-label="Aumentar cantidad de ${nombreSafe}">+</button>
      </div>
      <button type="button" class="carrito-item__eliminar" data-action="remove" aria-label="Eliminar ${nombreSafe}">🗑️</button>
    </article>
  `;
}

/** Re-renderiza toda la vista del carrito */
function renderCarrito() {
  const items   = getCart();
  const wrapper = els.itemsWrapper();
  const vacio   = els.vacio();
  const hay     = items.length > 0;

  if (!wrapper) return;

  wrapper.innerHTML = items.map(renderItem).join('');
  if (vacio) vacio.hidden = hay;   /* ocultar "vacío" cuando hay items */

  const total = getCartTotal();
  const count = items.reduce((s, i) => s + i.cantidad, 0);

  if (els.subtotal())      els.subtotal().textContent      = formatPrice(total);
  if (els.total())         els.total().textContent         = formatPrice(total);
  if (els.cantidadTexto()) els.cantidadTexto().textContent = pluralizeEs(count, 'producto');
  if (els.proceder())      els.proceder().disabled          = !hay;
  if (els.vaciar())        els.vaciar().hidden               = !hay;
}

/** Delegación de eventos en la lista de items */
function initItemControls() {
  document.addEventListener('click', e => {
    const btn    = e.target.closest('[data-action]');
    if (!btn) return;

    const article = btn.closest('[data-item-id]');
    if (!article) return;

    const id  = article.dataset.itemId;
    const act = btn.dataset.action;
    const items = getCart();
    const item  = items.find(i => i.id === id);
    if (!item) return;

    if (act === 'increment') updateQuantity(id, item.cantidad + 1);
    if (act === 'decrement') updateQuantity(id, item.cantidad - 1);
    if (act === 'remove')    removeFromCart(id);

    renderCarrito();
  });
}

/** Vaciar canasta */
function initVaciar() {
  els.vaciar()?.addEventListener('click', () => {
    if (confirm('¿Vaciar toda la canasta?')) {
      clearCart();
      renderCarrito();
    }
  });
}

/** Redirige a checkout */
function initProceder() {
  els.proceder()?.addEventListener('click', () => {
    window.location.href = 'checkout.html';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initUI();
  renderCarrito();
  initItemControls();
  initVaciar();
  initProceder();
  window.addEventListener('cart:updated', renderCarrito);
});

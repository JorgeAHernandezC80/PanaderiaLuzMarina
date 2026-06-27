/**
 * PANADERÍA LUZ MARINA — Core: UI
 * Comportamientos compartidos en todas las páginas:
 *   - Contador del carrito en el header
 *   - Menú hamburguesa (móvil)
 */

import { getCartCount } from './cart.js';

/** Actualiza todos los badges del carrito en el DOM */
export function updateCartBadges() {
  const count = getCartCount();
  document.querySelectorAll('[data-cart-count]').forEach(el => {
    el.textContent = count;
    el.setAttribute('aria-label', `${count} productos en el carrito`);
  });
}

/** Inicializa el menú hamburguesa */
function initMobileMenu() {
  const toggle  = document.querySelector('[data-header-toggle]');
  const menu    = document.querySelector('[data-header-menu]');
  const overlay = document.querySelector('[data-header-overlay]');

  if (!toggle || !menu) return;

  function openMenu() {
    menu.classList.add('is-open');
    overlay?.classList.add('is-visible');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Cerrar menú');
    document.body.style.overflow = 'hidden';
  }

  function closeMenu() {
    menu.classList.remove('is-open');
    overlay?.classList.remove('is-visible');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Abrir menú');
    document.body.style.overflow = '';
  }

  toggle.addEventListener('click', () => {
    const isOpen = toggle.getAttribute('aria-expanded') === 'true';
    isOpen ? closeMenu() : openMenu();
  });

  overlay?.addEventListener('click', closeMenu);

  // Cerrar con Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenu();
  });

  // Cerrar al redimensionar a desktop
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeMenu();
  });
}

/** Punto de entrada — llamar una vez por página */
export function initUI() {
  updateCartBadges();
  initMobileMenu();

  // Actualizar badges cuando el carrito cambie (desde otras pestañas o misma página)
  window.addEventListener('cart:updated', updateCartBadges);
  window.addEventListener('storage', e => {
    if (e.key === 'plm_cart') updateCartBadges();
  });
}

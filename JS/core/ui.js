/**
 * PANADERÍA LUZ MARINA — Core: UI
 * Comportamientos compartidos en todas las páginas:
 *   - Contador del carrito en el header
 *   - Menú hamburguesa (móvil)
 *   - Clase scrolled en header
 *   - Toggle de tema dark/light
 *   - Toggle de idioma ES/EN
 */

import { getCartCount } from './cart.js';
import { initTheme } from './theme.js';
import { initI18n } from './i18n.js';

/** Actualiza todos los badges del carrito en el DOM */
export function updateCartBadges() {
  const count = getCartCount();
  document.querySelectorAll('[data-cart-count]').forEach((el) => {
    el.textContent = count;
    el.setAttribute('aria-label', `${count} productos en el carrito`);
    if (el.classList.contains('header__badge')) {
      if (count > 0) {
        el.removeAttribute('hidden');
      } else {
        el.setAttribute('hidden', '');
      }
    }
  });
}

/** Inicializa el menú hamburguesa */
function initMobileMenu() {
  const toggle = document.querySelector('[data-header-toggle]');
  const menu = document.querySelector('[data-header-menu]');
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeMenu();
  });
}

/** Agrega clase al header al hacer scroll */
function initHeaderScroll() {
  const header = document.querySelector('[data-header]');
  if (!header) return;

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      header.classList.toggle('header--scrolled', window.scrollY > 10);
      ticking = false;
    });
  };

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/** Punto de entrada — llamar una vez por página */
export function initUI() {
  initTheme();
  initI18n();
  updateCartBadges();
  initMobileMenu();
  initHeaderScroll();

  window.addEventListener('cart:updated', updateCartBadges);
  window.addEventListener('storage', (e) => {
    if (e.key === 'plm_cart') updateCartBadges();
  });
}

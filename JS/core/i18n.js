/**
 * PANADERÍA LUZ MARINA — Core: i18n
 * Toggle de idioma ES / EN.
 * - Persiste en localStorage ('plm_lang')
 * - Actualiza todos los elementos con data-i18n="clave"
 * - Actualiza el label del botón de idioma
 */

const STORAGE_KEY = 'plm_lang';

/** Diccionario de traducciones */
const translations = {
  es: {
    /* Nav */
    nav_home:    'Inicio',
    nav_catalog: 'Catálogo',
    nav_us:      'Nosotros',
    nav_contact: 'Contacto',

    /* Hero */
    hero_badge:    'Horno Abierto',
    hero_units:    'unidades disponibles',
    hero_title:    'El pan de siempre, hecho con cariño.',
    hero_subtitle: 'Horneamos hoy lo que comerás mañana.',
    hero_cta_stock:'Ver Stock en Vivo',
    hero_cta_wa:   'Reservar por WhatsApp',

    /* Valores */
    valores_title:    '¿Por qué elegirnos?',
    valor_fresh:      'Pan fresco cada día',
    valor_fresh_desc: 'Horneamos desde temprano para que tengas pan recién hecho.',
    valor_recipes:    'Recetas de familia',
    valor_recipes_desc:'Las recetas de siempre, sin ingredientes raros ni complicaciones.',
    valor_service:    'Atención cercana',
    valor_service_desc:'Te conocemos por nombre. Aquí no eres un número.',

    /* CTA */
    cta_title: '¿Listo para probar nuestro pan?',
    cta_text:  'Visítanos o haz tu pedido por WhatsApp',
    cta_btn:   'Ver Catálogo',

    /* Catálogo */
    catalog_title:   'Nuestra Hornada Diaria',
    catalog_subtitle:'Productos frescos horneados cada mañana',
    filter_all:   'Todos',
    filter_bread: 'Panadería',
    filter_pastry:'Bollería',
    filter_sweets:'Repostería',
    filter_fried: 'Frituras',
    add_cart:     'Añadir al carrito',

    /* Carrito */
    cart_title:   'Tu Canasta',
    cart_empty:   'Tu canasta está vacía',
    cart_empty_sub:'Aún no has añadido nada. ¡Explora el catálogo!',
    cart_go:      'Ir al catálogo',
    cart_summary: 'Resumen del pedido',
    cart_subtotal:'Subtotal',
    cart_pickup:  'Retiro en local',
    cart_free:    'Gratis',
    cart_total:   'Total a pagar',
    cart_proceed: 'Proceder al Pago',
    cart_continue:'← Seguir comprando',
    cart_clear:   'Vaciar canasta',
    cart_note:    '🔒 Pago en efectivo contra entrega',

    /* Footer */
    footer_schedule: 'Horario de Atención',
    footer_contact:  'Contacto',
    footer_links:    'Enlaces',
    footer_copy:     '© 2026 Panadería Luz Marina. Hecho con cariño.',
  },

  en: {
    /* Nav */
    nav_home:    'Home',
    nav_catalog: 'Catalog',
    nav_us:      'About Us',
    nav_contact: 'Contact',

    /* Hero */
    hero_badge:    'Oven Open',
    hero_units:    'units available',
    hero_title:    'Traditional bread, made with love.',
    hero_subtitle: 'We bake today what you\'ll enjoy tomorrow.',
    hero_cta_stock:'View Live Stock',
    hero_cta_wa:   'Reserve via WhatsApp',

    /* Valores */
    valores_title:    'Why choose us?',
    valor_fresh:      'Fresh bread every day',
    valor_fresh_desc: 'We bake early every morning so you always get fresh bread.',
    valor_recipes:    'Family recipes',
    valor_recipes_desc:'Traditional recipes, simple ingredients, no shortcuts.',
    valor_service:    'Personal service',
    valor_service_desc:'We know our customers by name. You\'re not just a number here.',

    /* CTA */
    cta_title: 'Ready to try our bread?',
    cta_text:  'Visit us or place your order on WhatsApp',
    cta_btn:   'View Catalog',

    /* Catálogo */
    catalog_title:   'Today\'s Bake',
    catalog_subtitle:'Fresh products baked every morning',
    filter_all:   'All',
    filter_bread: 'Bread',
    filter_pastry:'Pastry',
    filter_sweets:'Sweets',
    filter_fried: 'Fried',
    add_cart:     'Add to cart',

    /* Carrito */
    cart_title:   'Your Basket',
    cart_empty:   'Your basket is empty',
    cart_empty_sub:'You haven\'t added anything yet. Explore the catalog!',
    cart_go:      'Go to catalog',
    cart_summary: 'Order summary',
    cart_subtotal:'Subtotal',
    cart_pickup:  'Pick up in store',
    cart_free:    'Free',
    cart_total:   'Total',
    cart_proceed: 'Proceed to Checkout',
    cart_continue:'← Continue shopping',
    cart_clear:   'Clear basket',
    cart_note:    '🔒 Cash on pickup',

    /* Footer */
    footer_schedule: 'Business Hours',
    footer_contact:  'Contact',
    footer_links:    'Links',
    footer_copy:     '© 2026 Panadería Luz Marina. Made with love.',
  }
};

/** Obtiene el idioma guardado o el del navegador */
function getSavedLang() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && translations[saved]) return saved;
  const nav = (navigator.language ?? '').slice(0, 2).toLowerCase();
  return nav === 'es' ? 'es' : 'en';
}

/** Aplica el idioma al DOM */
function applyLang(lang) {
  const dict = translations[lang];
  if (!dict) return;

  /* Actualizar elementos con data-i18n */
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] !== undefined) el.textContent = dict[key];
  });

  /* Actualizar label del botón de idioma */
  const label = document.querySelector('[data-lang-label]');
  if (label) label.textContent = lang.toUpperCase();

  const btn = document.querySelector('[data-lang-toggle]');
  if (btn) {
    btn.setAttribute('aria-label',
      lang === 'es' ? 'Switch to English' : 'Cambiar a Español'
    );
  }

  /* Actualizar atributo lang del documento */
  document.documentElement.lang = lang === 'es' ? 'es' : 'en';

  localStorage.setItem(STORAGE_KEY, lang);
}

/** Inicializa el toggle de idioma */
export function initI18n() {
  const lang = getSavedLang();
  applyLang(lang);

  const btn = document.querySelector('[data-lang-toggle]');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const current = localStorage.getItem(STORAGE_KEY) ?? 'es';
    applyLang(current === 'es' ? 'en' : 'es');
  });
}

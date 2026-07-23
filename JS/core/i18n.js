/**
 * PANADERÍA LUZ MARINA — Core: i18n
 * Toggle de idioma ES / EN.
 * - Persiste en localStorage ('plm_lang')
 * - Traduce el texto de los elementos con data-i18n="clave"
 * - Traduce atributos con data-i18n-placeholder / data-i18n-aria-label
 * - Actualiza el label del botón de idioma y <html lang>
 * - Expone t() / getCurrentLang() para el contenido generado por JS
 * - Emite el evento 'lang:changed' para que las vistas dinámicas se re-rendericen
 */

const STORAGE_KEY = 'plm_lang';

/** Diccionario de traducciones */
const translations = {
  es: {
    /* Accesibilidad / genérico */
    skip_link: 'Saltar al contenido principal',
    nav_aria: 'Navegación principal',

    /* Nav */
    nav_home: 'Inicio',
    nav_catalog: 'Catálogo',
    nav_us: 'Nosotros',
    nav_contact: 'Contacto',

    /* Hero (inicio) */
    hero_badge: 'Horno Abierto',
    hero_stock_available: 'Hornada de hoy disponible',
    hero_units: 'unidades disponibles',
    hero_title: 'El pan de siempre, hecho con cariño.',
    hero_subtitle: 'Horneamos hoy lo que comerás mañana.',
    hero_cta_stock: 'Ver Stock en Vivo',
    hero_cta_wa: 'Reservar por WhatsApp',
    /* Acción dual (hero) */
    hero_actions_aria: 'Formas de comprar',
    hero_cta_order: 'Encargar en línea',
    hero_cta_order_aria: 'Encargar en línea desde el catálogo',
    hero_cta_counter: 'Escribir al mostrador',
    hero_cta_counter_aria: 'Escribir al mostrador por WhatsApp',
    hero_actions_note: 'Encargas aquí y pagas al recoger. No cobramos nada en la web.',

    /* Ganchos (inicio) */
    features_title: 'Así funciona la panadería',
    features_subtitle: 'Tres cosas que conviene saber antes de pedir.',
    feature_fresh_title: 'Horneado cada mañana',
    feature_fresh_text:
      'La primera hornada sale a las 7:00. En el catálogo verás lo que hay hoy, no una lista genérica.',
    feature_fresh_link: 'Ver la hornada de hoy →',
    feature_fresh_link_aria: 'Ver la hornada de hoy en el catálogo',
    feature_order_title: 'Encargas y recoges',
    feature_order_text:
      'Armas tu canasta en la web, confirmas por WhatsApp y te decimos a qué hora está listo.',
    feature_order_link: 'Abrir mi canasta →',
    feature_order_link_aria: 'Abrir mi canasta',
    feature_pay_title: 'Pagas en el mostrador',
    feature_pay_text:
      'Sin tarjetas ni pasarelas en la web. Pagas cuando recoges y así confirmamos tu pedido de viva voz.',
    feature_pay_link: 'Horarios y cómo llegar →',
    feature_pay_link_aria: 'Ver horarios y cómo llegar',

    /* Valores (inicio) */
    valores_title: '¿Por qué elegirnos?',
    valor_fresh: 'Pan fresco cada día',
    valor_fresh_desc: 'Horneamos desde temprano para que tengas pan recién hecho.',
    valor_recipes: 'Recetas de familia',
    valor_recipes_desc: 'Las recetas de siempre, sin ingredientes raros ni complicaciones.',
    valor_service: 'Atención cercana',
    valor_service_desc: 'Te conocemos por nombre. Aquí no eres un número.',

    /* CTA (inicio) */
    cta_title: '¿Listo para probar nuestro pan?',
    cta_text: 'Visítanos o haz tu pedido por WhatsApp',
    cta_btn: 'Ver Catálogo',

    /* Catálogo */
    catalog_title: 'Nuestra Hornada Diaria',
    catalog_subtitle: 'Productos frescos horneados cada mañana',
    catalog_filter_heading: 'Filtrar por categoría',

    /* Instructivo (catálogo) */
    steps_eyebrow: 'Cómo pedir',
    steps_title: 'De la canasta al mostrador en tres pasos',
    steps_subtitle: 'El pedido se confirma por WhatsApp. Aquí no se cobra nada.',
    step_pick_title: 'Elige tus panes',
    step_pick_text:
      'Toca «Añadir al carrito» en cada producto. El contador del menú lleva la cuenta mientras sigues navegando.',
    step_review_title: 'Revisa tu canasta',
    step_review_text:
      'Ajusta cantidades y comprueba el total. Puedes cambiar lo que quieras antes de enviar nada.',
    step_send_title: 'Confirma por WhatsApp',
    step_send_text:
      'Al finalizar se abre un chat con tu pedido ya escrito. Te respondemos con la hora de recogida.',
    steps_note: 'Pagas al recoger, en efectivo o transferencia.',
    filter_all: 'Todos',
    filter_bread: 'Panadería',
    filter_pastry: 'Bollería',
    filter_sweets: 'Repostería',
    filter_fried: 'Frituras',
    add_cart: 'Añadir al carrito',
    catalog_empty: 'No hay productos en esta categoría.',
    prod_donuts_desc: 'Suaves por dentro, crujientes por fuera, con glaseado de vainilla.',
    prod_bunuelos_desc:
      'Buñuelos dorados de masa de queso, crujientes por fuera y suaves por dentro. Un clásico colombiano para acompañar el café.',
    prod_almojabanas_desc:
      'Panecillos tradicionales de harina de maíz y queso. Crujientes por fuera, esponjosos por dentro. Perfectas con café o chocolate.',
    prod_pandebono_desc:
      'Panecillo del Valle del Cauca, hecho con almidón de yuca y queso costeño. Crujiente por fuera, esponjoso por dentro.',
    prod_panyuca_desc:
      'Hecho con almidón de yuca, queso y huevo. Suave, esponjoso y con delicioso sabor a queso. Perfecto solo o con chocolate.',
    prod_roscon_desc:
      'Suave y esponjoso, relleno de arequipe o guayaba. Ideal para acompañar el café o la merienda.',
    prod_conchas_desc:
      'Pan dulce tradicional con su clásica cubierta crujiente de vainilla o chocolate. Perfectas para el desayuno o la merienda.',
    prod_croissant_desc: 'Hojaldre crujiente con mantequilla, acompañado de dulce de leche.',

    /* Carrito */
    cart_title: 'Tu Canasta',
    cart_empty: 'Tu canasta está vacía',
    cart_empty_sub: 'Aún no has añadido nada. ¡Explora el catálogo y elige tu pan favorito!',
    cart_go: 'Ir al catálogo',
    cart_summary: 'Resumen del pedido',
    cart_subtotal: 'Subtotal',
    cart_pickup: 'Retiro en local',
    cart_free: 'Gratis',
    cart_total: 'Total a pagar',
    cart_proceed: 'Proceder al Pago',
    cart_continue: '← Seguir comprando',
    cart_clear: 'Vaciar canasta',
    cart_note: '🔒 Pago en efectivo contra entrega',
    product_singular: 'producto',
    product_plural: 'productos',
    confirm_clear: '¿Vaciar toda la canasta?',
    aria_decrease: 'Disminuir cantidad de',
    aria_increase: 'Aumentar cantidad de',
    aria_remove: 'Eliminar',
    toast_added: '✓ Añadido',
    toast_error: '✗ Error',

    /* Nosotros */
    about_hero_title: 'Nuestra Historia',
    about_hero_subtitle: 'Pan horneado cada mañana, con la receta de siempre',
    about_story_1:
      'Nuestra panadería lleva con orgullo el nombre de nuestra fundadora, Luz Marina. Lo que comenzó como una forma de llevar pan fresco y casero a nuestra propia familia, pronto se convirtió en el sustento y la alegría de nuestros vecinos.',
    about_story_2:
      'Hoy continuamos con esa misma pasión. No usamos procesos industriales ni ingredientes complicados. Solo harina, agua, queso, huevos y el tiempo necesario para que cada producto salga perfecto.',
    about_values_title: 'Lo que nos define',
    about_v_fresh_desc:
      'Horneamos desde temprano para que tengas pan recién hecho cuando nos visites.',
    about_v_recipes_desc:
      'Usamos las recetas que han funcionado por años, sin ingredientes raros ni atajos.',
    about_v_service_desc:
      'Conocemos a nuestros clientes por nombre. Aquí no eres un número, eres parte de la familia.',
    about_v_fair: 'Precios justos',
    about_v_fair_desc:
      'Pan de calidad al precio que corresponde. Sin inflar costos ni sorpresas en la cuenta.',
    about_team_title: 'Las personas detrás del pan',
    role_founder: 'Fundadora',
    role_baker: 'Panadero',
    about_quote_1: '"El pan se hace con paciencia y cariño."',
    about_quote_2: '"Cuido que cada cliente se vaya contento con su pan."',
    about_cta_text: 'Visítanos en el local o haz tu pedido por WhatsApp',
    about_cta_wa: 'Pedir por WhatsApp',

    /* Contacto */
    contact_hero_title: 'Contáctanos',
    contact_hero_subtitle: 'Estamos aquí para atenderte con el mismo cariño de siempre',
    contact_info_heading: 'Información de contacto',
    contact_address_title: 'Nuestra Dirección',
    contact_map_link: 'Ver en Google Maps',
    contact_map_link_arrow: 'Ver en Google Maps →',
    contact_phone_title: 'Teléfono',
    contact_phone_sub: 'Llámanos o escríbenos por WhatsApp',
    contact_wa_title: '¿Quieres hacer un pedido?',
    contact_wa_text:
      'La forma más rápida de reservar tu pan es escribiéndonos directamente. Te confirmamos el stock y te lo dejamos listo para retirar.',
    contact_wa_btn: 'Escríbenos por WhatsApp',

    /* Horarios compartidos (footer + tarjetas) */
    days_weekday: 'Lunes a Viernes:',
    days_saturday: 'Sábados:',
    days_sunday: 'Domingos:',

    /* Checkout */
    checkout_title: 'Finalizar Pedido',
    checkout_subtitle: 'Ingresa los datos del cliente para confirmarle el pedido por WhatsApp',
    checkout_step1: 'Tu pedido',
    checkout_step2: 'Datos de entrega',
    checkout_step3: 'Método de pago',
    checkout_modify: '← Añadir o modificar productos',
    checkout_empty: 'Tu carrito está vacío.',
    checkout_empty_link: 'Volver al catálogo',
    checkout_name_label: 'Nombre de contacto',
    checkout_name_ph: 'Tu nombre completo',
    checkout_name_err: 'Por favor ingresa tu nombre.',
    checkout_phone_label: 'Teléfono (WhatsApp)',
    checkout_phone_err: 'Ingresa un teléfono válido.',
    checkout_pickup_time_label: 'Horario de retiro',
    checkout_hour: 'Hora',
    checkout_minutes: 'Minutos',
    checkout_hour_err: 'Selecciona una hora.',
    checkout_minute_err: 'Selecciona los minutos.',
    checkout_time_err: 'Selecciona un horario completo.',
    checkout_pickup_note: 'Retiro en local:',
    pay_card_desc: 'Tarjeta de crédito / débito',
    pay_unavailable: 'No disponible',
    pay_cash: 'Efectivo contra entrega',
    pay_cash_desc: 'Paga al retirar tu pedido en el local',
    checkout_pay_note: 'ℹ️ Por ahora solo aceptamos efectivo al momento de la entrega.',
    checkout_back: '← Atrás',
    checkout_confirm: 'Confirmar pedido',
    checkout_security:
      'Tu pedido se enviará directamente por WhatsApp. Pago en efectivo al retirar.',
    checkout_sent_title: '¡Pedido enviado!',
    checkout_sent_subtitle: 'Tu pedido fue enviado por WhatsApp a la panadería.',
    conf_order_label: 'Número de orden',
    conf_date_label: 'Fecha y hora',
    conf_client_label: 'Cliente',
    conf_pickup_label: 'Retiro',
    conf_note: 'Guarda tu número de orden. La panadería te confirmará el pedido pronto.',
    conf_continue: 'Seguir comprando',

    /* Footer */
    footer_schedule: 'Horario de Atención',
    footer_contact: 'Contacto',
    footer_links: 'Enlaces',
    footer_copy: '© 2026 Panadería Luz Marina. Hecho con cariño.',
  },

  en: {
    /* Accesibilidad / genérico */
    skip_link: 'Skip to main content',
    nav_aria: 'Main navigation',

    /* Nav */
    nav_home: 'Home',
    nav_catalog: 'Catalog',
    nav_us: 'About Us',
    nav_contact: 'Contact',

    /* Hero (inicio) */
    hero_badge: 'Oven Open',
    hero_stock_available: "Today's bake available",
    hero_units: 'units available',
    hero_title: 'Traditional bread, made with love.',
    hero_subtitle: "We bake today what you'll enjoy tomorrow.",
    hero_cta_stock: 'View Live Stock',
    hero_cta_wa: 'Reserve via WhatsApp',
    /* Dual action (hero) */
    hero_actions_aria: 'Ways to buy',
    hero_cta_order: 'Order online',
    hero_cta_order_aria: 'Order online from the catalog',
    hero_cta_counter: 'Message the counter',
    hero_cta_counter_aria: 'Message the counter on WhatsApp',
    hero_actions_note: 'Order here, pay when you pick up. Nothing is charged on the site.',

    /* Hooks (home) */
    features_title: 'How the bakery works',
    features_subtitle: 'Three things worth knowing before you order.',
    feature_fresh_title: 'Baked every morning',
    feature_fresh_text:
      'The first batch comes out at 7:00. The catalog shows what we have today, not a generic list.',
    feature_fresh_link: "See today's batch →",
    feature_fresh_link_aria: "See today's batch in the catalog",
    feature_order_title: 'Order and pick up',
    feature_order_text:
      'Fill your basket on the site, confirm on WhatsApp, and we tell you when it will be ready.',
    feature_order_link: 'Open my basket →',
    feature_order_link_aria: 'Open my basket',
    feature_pay_title: 'Pay at the counter',
    feature_pay_text:
      'No cards or payment gateways here. You pay at pickup, so we confirm your order in person.',
    feature_pay_link: 'Hours and directions →',
    feature_pay_link_aria: 'See hours and directions',

    /* Valores (inicio) */
    valores_title: 'Why choose us?',
    valor_fresh: 'Fresh bread every day',
    valor_fresh_desc: 'We bake early every morning so you always get fresh bread.',
    valor_recipes: 'Family recipes',
    valor_recipes_desc: 'Traditional recipes, simple ingredients, no shortcuts.',
    valor_service: 'Personal service',
    valor_service_desc: "We know our customers by name. You're not just a number here.",

    /* CTA (inicio) */
    cta_title: 'Ready to try our bread?',
    cta_text: 'Visit us or place your order on WhatsApp',
    cta_btn: 'View Catalog',

    /* Catálogo */
    catalog_title: "Today's Bake",
    catalog_subtitle: 'Fresh products baked every morning',
    catalog_filter_heading: 'Filter by category',

    /* Instructional (catalog) */
    steps_eyebrow: 'How to order',
    steps_title: 'From basket to counter in three steps',
    steps_subtitle: 'Orders are confirmed on WhatsApp. Nothing is charged here.',
    step_pick_title: 'Pick your bread',
    step_pick_text:
      'Tap "Add to cart" on each product. The menu counter keeps track while you keep browsing.',
    step_review_title: 'Review your basket',
    step_review_text:
      'Adjust quantities and check the total. You can change anything before sending it.',
    step_send_title: 'Confirm on WhatsApp',
    step_send_text:
      'At checkout a chat opens with your order already written out. We reply with your pickup time.',
    steps_note: 'Pay at pickup, in cash or by transfer.',
    filter_all: 'All',
    filter_bread: 'Bread',
    filter_pastry: 'Pastry',
    filter_sweets: 'Sweets',
    filter_fried: 'Fried',
    add_cart: 'Add to cart',
    catalog_empty: 'No products in this category.',
    prod_donuts_desc: 'Soft inside, crispy outside, with vanilla glaze.',
    prod_bunuelos_desc:
      'Golden cheese-dough fritters, crispy outside and soft inside. A Colombian classic to go with coffee.',
    prod_almojabanas_desc:
      'Traditional corn-flour and cheese rolls. Crispy outside, fluffy inside. Perfect with coffee or hot chocolate.',
    prod_pandebono_desc:
      'A roll from the Valle del Cauca, made with cassava starch and costeño cheese. Crispy outside, fluffy inside.',
    prod_panyuca_desc:
      'Made with cassava starch, cheese and egg. Soft, fluffy and full of cheese flavor. Great on its own or with hot chocolate.',
    prod_roscon_desc:
      'Soft and fluffy, filled with dulce de leche or guava. Perfect with coffee or as an afternoon snack.',
    prod_conchas_desc:
      'Traditional sweet bread with its classic crunchy vanilla or chocolate topping. Perfect for breakfast or a snack.',
    prod_croissant_desc: 'Crispy buttery puff pastry, served with dulce de leche.',

    /* Carrito */
    cart_title: 'Your Basket',
    cart_empty: 'Your basket is empty',
    cart_empty_sub: "You haven't added anything yet. Explore the catalog and pick your favorite!",
    cart_go: 'Go to catalog',
    cart_summary: 'Order summary',
    cart_subtotal: 'Subtotal',
    cart_pickup: 'Pick up in store',
    cart_free: 'Free',
    cart_total: 'Total',
    cart_proceed: 'Proceed to Checkout',
    cart_continue: '← Continue shopping',
    cart_clear: 'Clear basket',
    cart_note: '🔒 Cash on pickup',
    product_singular: 'item',
    product_plural: 'items',
    confirm_clear: 'Clear the whole basket?',
    aria_decrease: 'Decrease quantity of',
    aria_increase: 'Increase quantity of',
    aria_remove: 'Remove',
    toast_added: '✓ Added',
    toast_error: '✗ Error',

    /* Nosotros */
    about_hero_title: 'Our Story',
    about_hero_subtitle: 'Bread baked every morning, with the recipe of always',
    about_story_1:
      'Our bakery proudly bears the name of our founder, Luz Marina. What began as a way to bring fresh, homemade bread to our own family soon became the livelihood and joy of our neighbors.',
    about_story_2:
      'Today we carry on with that same passion. We use no industrial processes or complicated ingredients. Just flour, water, cheese, eggs and the time each product needs to turn out perfect.',
    about_values_title: 'What defines us',
    about_v_fresh_desc: 'We bake early so you get fresh bread whenever you visit us.',
    about_v_recipes_desc:
      'We use the recipes that have worked for years, with no strange ingredients or shortcuts.',
    about_v_service_desc:
      "We know our customers by name. Here you're not a number, you're part of the family.",
    about_v_fair: 'Fair prices',
    about_v_fair_desc:
      'Quality bread at the right price. No inflated costs or surprises on the bill.',
    about_team_title: 'The people behind the bread',
    role_founder: 'Founder',
    role_baker: 'Baker',
    about_quote_1: '"Bread is made with patience and love."',
    about_quote_2: '"I make sure every customer leaves happy with their bread."',
    about_cta_text: 'Visit our store or place your order on WhatsApp',
    about_cta_wa: 'Order on WhatsApp',

    /* Contacto */
    contact_hero_title: 'Contact Us',
    contact_hero_subtitle: "We're here to help you with the same care as always",
    contact_info_heading: 'Contact information',
    contact_address_title: 'Our Address',
    contact_map_link: 'View on Google Maps',
    contact_map_link_arrow: 'View on Google Maps →',
    contact_phone_title: 'Phone',
    contact_phone_sub: 'Call us or message us on WhatsApp',
    contact_wa_title: 'Want to place an order?',
    contact_wa_text:
      'The fastest way to reserve your bread is to message us directly. We confirm stock and leave it ready for pickup.',
    contact_wa_btn: 'Message us on WhatsApp',

    /* Horarios compartidos (footer + tarjetas) */
    days_weekday: 'Monday to Friday:',
    days_saturday: 'Saturdays:',
    days_sunday: 'Sundays:',

    /* Checkout */
    checkout_title: 'Complete Order',
    checkout_subtitle: "Enter the customer's details to confirm the order via WhatsApp",
    checkout_step1: 'Your order',
    checkout_step2: 'Delivery details',
    checkout_step3: 'Payment method',
    checkout_modify: '← Add or edit products',
    checkout_empty: 'Your cart is empty.',
    checkout_empty_link: 'Back to catalog',
    checkout_name_label: 'Contact name',
    checkout_name_ph: 'Your full name',
    checkout_name_err: 'Please enter your name.',
    checkout_phone_label: 'Phone (WhatsApp)',
    checkout_phone_err: 'Enter a valid phone number.',
    checkout_pickup_time_label: 'Pickup time',
    checkout_hour: 'Hour',
    checkout_minutes: 'Minutes',
    checkout_hour_err: 'Select an hour.',
    checkout_minute_err: 'Select the minutes.',
    checkout_time_err: 'Select a complete time.',
    checkout_pickup_note: 'Pick up in store:',
    pay_card_desc: 'Credit / debit card',
    pay_unavailable: 'Unavailable',
    pay_cash: 'Cash on pickup',
    pay_cash_desc: 'Pay when you pick up your order in store',
    checkout_pay_note: 'ℹ️ For now we only accept cash at pickup.',
    checkout_back: '← Back',
    checkout_confirm: 'Confirm order',
    checkout_security: 'Your order will be sent directly via WhatsApp. Cash payment at pickup.',
    checkout_sent_title: 'Order sent!',
    checkout_sent_subtitle: 'Your order was sent to the bakery via WhatsApp.',
    conf_order_label: 'Order number',
    conf_date_label: 'Date and time',
    conf_client_label: 'Customer',
    conf_pickup_label: 'Pickup',
    conf_note: 'Save your order number. The bakery will confirm your order soon.',
    conf_continue: 'Continue shopping',

    /* Footer */
    footer_schedule: 'Business Hours',
    footer_contact: 'Contact',
    footer_links: 'Links',
    footer_copy: '© 2026 Panadería Luz Marina. Made with love.',
  },
};

/** Atributos traducibles: data-i18n-<suffix> -> nombre real del atributo */
const ATTR_MAP = {
  'data-i18n-placeholder': 'placeholder',
  'data-i18n-aria-label': 'aria-label',
};

/** Idioma actualmente aplicado */
let currentLang = 'es';

/** Idioma activo ('es' | 'en') */
export function getCurrentLang() {
  return currentLang;
}

/** Traduce una clave al idioma activo; si no existe, devuelve la clave */
export function t(key) {
  return translations[currentLang]?.[key] ?? key;
}

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

  currentLang = lang;

  /* Texto de elementos con data-i18n */
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (dict[key] !== undefined) el.textContent = dict[key];
  });

  /* Atributos traducibles (placeholder, aria-label) */
  Object.entries(ATTR_MAP).forEach(([dataAttr, realAttr]) => {
    document.querySelectorAll(`[${dataAttr}]`).forEach((el) => {
      const key = el.getAttribute(dataAttr);
      if (dict[key] !== undefined) el.setAttribute(realAttr, dict[key]);
    });
  });

  /* Label del botón de idioma */
  const label = document.querySelector('[data-lang-label]');
  if (label) label.textContent = lang.toUpperCase();

  const btn = document.querySelector('[data-lang-toggle]');
  if (btn) {
    btn.setAttribute('aria-label', lang === 'es' ? 'Switch to English' : 'Cambiar a Español');
  }

  /* Atributo lang del documento */
  document.documentElement.lang = lang === 'es' ? 'es' : 'en';

  localStorage.setItem(STORAGE_KEY, lang);

  /* Notificar a las vistas dinámicas (carrito, catálogo, checkout) */
  window.dispatchEvent(new CustomEvent('lang:changed', { detail: { lang } }));
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

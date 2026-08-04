/**
 * PANADERÍA LUZ MARINA — Página: Catálogo
 * - Arma las tarjetas de producto desde GET /catalogo. Antes las 9
 *   tarjetas vivían escritas a mano en catalogo.html y este archivo solo
 *   sincronizaba precio/nombre encima de ellas — un producto nuevo creado
 *   desde el panel nunca aparecía acá (ver PR #21, pendiente "Importante").
 *   Ahora la tabla productos es la única fuente: lo que no está ahí no
 *   se ve en el catálogo del cliente.
 * - Filtros por categoría
 * - Añadir al carrito con feedback visual
 */

import { initUI, updateCartBadges } from '../core/ui.js';
import { addToCart } from '../core/cart.js';
import { t, tOrNull, getCurrentLang } from '../core/i18n.js';
import { apiFetch, fetchCatalogo } from '../core/api.js';
import { formatPrice } from '../core/format.js';

const IMG_SIZES =
  '(max-width: 480px) calc(100vw - 2rem), (max-width: 900px) calc(50vw - 1.5rem), (max-width: 1200px) calc(33.3vw - 2rem), 282px';

/** Último catálogo recibido de GET /catalogo. Se guarda para poder
 *  re-pintar solo lo que depende del idioma (descripción, botón) cuando
 *  cambia el idioma, sin volver a pedirlo ni perder lo que ya pintó
 *  initStockDisponible sobre las tarjetas. */
let _productos = null;

/** Descripción del producto en el idioma activo. La traducción al inglés
 *  vive en i18n.js por id de producto (prod_desc_<id> — ver ese archivo).
 *  Si no existe (por ejemplo un producto nuevo creado desde el panel que
 *  todavía no se tradujo), cae a productos.descripcion (español) en vez
 *  de dejar la tarjeta sin texto. */
function descripcionProducto(producto) {
  if (getCurrentLang() === 'en') {
    return tOrNull(`prod_desc_${producto.id}`) ?? producto.descripcion ?? '';
  }
  return producto.descripcion ?? '';
}

/** Llena el <img> de la tarjeta a partir de imagenBase (ver GET /catalogo).
 *  Si el producto todavía no tiene imagen asignada desde el panel, en vez
 *  de un ícono roto se muestra un placeholder con el logo de la marca
 *  (ver .producto-card__imagen--placeholder en _cards.css). */
function llenarImagen(imgEl, producto) {
  const contenedor = imgEl.closest('.producto-card__imagen');

  if (producto.imagenBase) {
    const base = `./IMG/webp/${producto.imagenBase}`;
    imgEl.src = `${base}-400.webp`;
    imgEl.srcset = `${base}-400.webp 400w, ${base}-800.webp 800w`;
    imgEl.sizes = IMG_SIZES;
    imgEl.alt = producto.altImagen || producto.nombre;
    imgEl.hidden = false;
    contenedor?.classList.remove('producto-card__imagen--placeholder');
    return;
  }

  imgEl.removeAttribute('src');
  imgEl.removeAttribute('srcset');
  imgEl.alt = '';
  imgEl.hidden = true;
  contenedor?.classList.add('producto-card__imagen--placeholder');

  // Ícono de la marca en vez de una imagen rota — solo se agrega una vez
  // (crearTarjeta clona la plantilla de cero en cada render de la grilla).
  if (contenedor && !contenedor.querySelector('.producto-card__imagen-icono')) {
    const icono = document.createElement('i');
    icono.className = 'fa-solid fa-bread-slice producto-card__imagen-icono';
    icono.setAttribute('aria-hidden', 'true');
    contenedor.appendChild(icono);
  }
}

/** Clona la plantilla #tpl-producto-card y la llena con un producto de
 *  GET /catalogo. Todo el texto se asigna con textContent (nunca
 *  innerHTML) para que un nombre/descripción con caracteres especiales
 *  nunca se interprete como HTML. */
function crearTarjeta(producto) {
  const tpl = document.querySelector('#tpl-producto-card');
  const card = tpl.content.firstElementChild.cloneNode(true);

  card.dataset.categoria = producto.categoria;

  llenarImagen(card.querySelector('[data-producto-img]'), producto);

  card.querySelector('[data-producto-nombre]').textContent = producto.nombre;
  card.querySelector('[data-producto-descripcion]').textContent = descripcionProducto(producto);
  card.querySelector('[data-producto-precio]').textContent = formatPrice(producto.precio);

  const btn = card.querySelector('.btn--add');
  btn.textContent = t('add_cart');
  btn.dataset.productoId = String(producto.id);
  btn.dataset.productoNombre = producto.nombre;
  btn.dataset.productoPrecio = String(producto.precio);

  return card;
}

/** Pinta la grilla completa a partir de la lista de GET /catalogo. */
function renderCatalogo(productos) {
  _productos = productos;

  const grid = document.querySelector('[data-productos-grid]');
  if (!grid) return;

  grid.replaceChildren(...productos.map(crearTarjeta));

  const errorEl = document.querySelector('[data-productos-error]');
  if (errorEl) errorEl.hidden = true;
}

/** Re-aplica solo lo que depende del idioma (descripción, texto del
 *  botón) a las tarjetas ya en el DOM. No reconstruye las tarjetas para
 *  no perder el estado de disponible/agotado que ya haya pintado
 *  initStockDisponible. */
function reAplicarIdioma() {
  if (!_productos) return;
  const porId = new Map(_productos.map((p) => [String(p.id), p]));

  document.querySelectorAll('.producto-card').forEach((card) => {
    const btn = card.querySelector('[data-producto-id]');
    const producto = btn ? porId.get(btn.dataset.productoId) : null;
    if (!producto) return;

    const descEl = card.querySelector('[data-producto-descripcion]');
    if (descEl) descEl.textContent = descripcionProducto(producto);
    // Si el producto está agotado, el botón ya dice stock_agotado
    // (ver renderStockDisponible) — no lo pisamos con "Añadir al carrito".
    if (btn && !btn.disabled) btn.textContent = t('add_cart');
  });
}

window.addEventListener('lang:changed', reAplicarIdioma);

/** Trae el disponible real de cada producto (GET /inventario/disponible,
 *  público, sin token) y lo pinta sobre las tarjetas ya renderizadas. Si
 *  la petición falla, las tarjetas se quedan sin indicador de stock en
 *  vez de romper la página — el catálogo sigue siendo usable. */
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
    const stockEl = card.querySelector('[data-producto-stock]');
    if (!btn || !stockEl) return;

    const disponible = _disponiblePorId.get(String(btn.dataset.productoId));
    // Producto que ya no está activo en el catálogo del backend: se marca
    // como no disponible en vez de dejar el texto por defecto, porque el
    // backend rechaza cualquier pedido que lo incluya.
    if (disponible === undefined) {
      stockEl.textContent = `🔴 ${t('stock_agotado')}`;
      stockEl.classList.remove('producto-card__stock--disponible');
      stockEl.classList.add('producto-card__stock--agotado');
      btn.disabled = true;
      return;
    }

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

/** Maneja los filtros de categoría. Las tarjetas se buscan de nuevo en
 *  cada click (no se guardan en una variable al inicializar) porque en
 *  el momento en que se registran estos listeners la grilla todavía
 *  puede estar vacía: GET /catalogo es asíncrono. */
function initFiltros() {
  const btns = document.querySelectorAll('[data-filter]');
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
      const cards = document.querySelectorAll('[data-categoria]');
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

/** Trae el catálogo real (GET /catalogo) y arma las tarjetas. Si el
 *  backend no responde, muestra un aviso en vez de una grilla vacía sin
 *  explicación — a diferencia de antes, ya no hay tarjetas escritas a
 *  mano en el HTML que sirvan de respaldo. */
async function initCatalogo() {
  const productos = await fetchCatalogo();

  if (!productos) {
    const errorEl = document.querySelector('[data-productos-error]');
    if (errorEl) errorEl.hidden = false;
    return;
  }

  renderCatalogo(productos);
  initFiltros();
  initStockDisponible();
}

document.addEventListener('DOMContentLoaded', () => {
  initUI();
  initAddToCart();
  initCatalogo();
});

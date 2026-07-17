/**
 * PANADERÍA LUZ MARINA — Core: Cart
 * Gestión del carrito en localStorage.
 * Sin dependencias externas.
 */

const CART_KEY = 'plm_cart';

/**
 * Valida los datos de un producto antes de que entren al carrito.
 * Lanza un Error descriptivo si algo no cumple el esquema esperado.
 * @param {*} producto
 * @throws {Error}
 */
export function validateProductData(producto) {
  if (!producto || typeof producto !== 'object') {
    throw new Error('Producto inválido: se esperaba un objeto.');
  }

  const { id, nombre, precio } = producto;

  if (id === undefined || id === null || String(id).trim() === '') {
    throw new Error('Producto inválido: falta el id.');
  }

  if (typeof nombre !== 'string' || nombre.trim() === '') {
    throw new Error('Producto inválido: falta el nombre.');
  }
  if (nombre.length > 120) {
    throw new Error('Producto inválido: nombre demasiado largo.');
  }

  const precioNum = Number(precio);
  if (!Number.isFinite(precioNum) || precioNum <= 0) {
    throw new Error('Producto inválido: el precio debe ser un número mayor que 0.');
  }
  if (precioNum > 1000) {
    throw new Error('Producto inválido: precio fuera de rango permitido.');
  }

  return true;
}

/**
 * Valida un item ya almacenado en el carrito (forma persistida, incluye cantidad).
 * Usado al leer de localStorage, donde el dato pudo ser alterado externamente.
 * @param {*} item
 * @returns {boolean}
 */
function isValidStoredItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.id !== 'string' && typeof item.id !== 'number') return false;
  if (typeof item.nombre !== 'string' || item.nombre.trim() === '' || item.nombre.length > 120) return false;
  if (!Number.isFinite(Number(item.precio)) || Number(item.precio) <= 0 || Number(item.precio) > 1000) return false;
  if (!Number.isInteger(item.cantidad) || item.cantidad <= 0 || item.cantidad > 999) return false;
  if (item.imagen !== undefined && typeof item.imagen !== 'string') return false;
  return true;
}

/**
 * Escapa texto antes de insertarlo en innerHTML.
 * Usar SIEMPRE que se interpole texto proveniente del carrito,
 * de localStorage o de formularios dentro de innerHTML.
 * @param {string} str
 * @returns {string}
 */
export function escapeHTML(str) {
  return String(str ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

/**
 * @returns {Array} items del carrito, ya validados.
 * Items malformados o manipulados externamente se descartan en silencio
 * (no rompen la UI, pero tampoco se confían).
 */
export function getCart() {
  let items;
  try {
    items = JSON.parse(localStorage.getItem(CART_KEY)) ?? [];
  } catch {
    return [];
  }

  if (!Array.isArray(items)) return [];

  const validos = items.filter(isValidStoredItem);

  // Si se descartó algo, persistir la versión limpia para no arrastrar basura.
  // Un fallo de escritura (cuota llena, modo privado) no debe romper la lectura.
  if (validos.length !== items.length) {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(validos));
    } catch (err) {
      console.warn('[cart] No se pudo persistir el carrito saneado:', err.message);
    }
  }

  return validos;
}

/** Persiste el carrito */
function saveCart(items) {
  localStorage.setItem(CART_KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent('cart:updated', { detail: { items } }));
}

/**
 * Añade un producto al carrito.
 * Si ya existe, incrementa cantidad.
 * @param {{ id: string|number, nombre: string, precio: number, imagen?: string }} producto
 * @param {number} [cantidad=1]
 */
export function addToCart(producto, cantidad = 1) {
  validateProductData(producto);

  if (!Number.isInteger(cantidad) || cantidad <= 0 || cantidad > 999) {
    throw new Error('Cantidad inválida.');
  }

  const items = getCart();
  const idx = items.findIndex(i => String(i.id) === String(producto.id));

  if (idx >= 0) {
    const nuevaCantidad = items[idx].cantidad + cantidad;
    if (nuevaCantidad > 999) throw new Error('Cantidad máxima por producto excedida.');
    items[idx].cantidad = nuevaCantidad;
  } else {
    items.push({
      id:       String(producto.id),
      nombre:   producto.nombre.trim(),
      precio:   Number(producto.precio),
      imagen:   producto.imagen ?? '',
      cantidad: cantidad,
    });
  }

  saveCart(items);
}

/**
 * Actualiza la cantidad de un item.
 * Si cantidad <= 0, lo elimina.
 */
export function updateQuantity(id, cantidad) {
  if (!Number.isFinite(Number(cantidad))) return;
  cantidad = Math.trunc(Number(cantidad));

  let items = getCart();
  if (cantidad <= 0) {
    items = items.filter(i => String(i.id) !== String(id));
  } else {
    const idx = items.findIndex(i => String(i.id) === String(id));
    if (idx >= 0) items[idx].cantidad = Math.min(cantidad, 999);
  }
  saveCart(items);
}

/** Elimina un item del carrito */
export function removeFromCart(id) {
  saveCart(getCart().filter(i => String(i.id) !== String(id)));
}

/** Vacía el carrito */
export function clearCart() {
  saveCart([]);
}

/** Cuenta total de unidades */
export function getCartCount() {
  return getCart().reduce((sum, i) => sum + i.cantidad, 0);
}

/** Total en pesos */
export function getCartTotal() {
  return getCart().reduce((sum, i) => sum + i.precio * i.cantidad, 0);
}

/** Formatea número como precio en USD */
export function formatPrice(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(Number(value));
}
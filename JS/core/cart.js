/**
 * PANADERÍA LUZ MARINA — Core: Cart
 * Gestión del carrito en localStorage.
 * Sin dependencias externas.
 */

const CART_KEY = 'plm_cart';

/** @returns {Array} items del carrito */
export function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) ?? [];
  } catch {
    return [];
  }
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
  const items = getCart();
  const idx = items.findIndex(i => String(i.id) === String(producto.id));

  if (idx >= 0) {
    items[idx].cantidad += cantidad;
  } else {
    items.push({
      id:       String(producto.id),
      nombre:   producto.nombre,
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
  let items = getCart();
  if (cantidad <= 0) {
    items = items.filter(i => String(i.id) !== String(id));
  } else {
    const idx = items.findIndex(i => String(i.id) === String(id));
    if (idx >= 0) items[idx].cantidad = cantidad;
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

/** Formatea número como precio colombiano */
export function formatPrice(value) {
  return '$' + Number(value).toLocaleString('es-CO');
}

/**
 * PANADERÍA LUZ MARINA — Core: API
 * Punto único para hablar con el backend.
 *   - API_BASE compartido por todas las páginas.
 *   - apiFetch(): wrapper de fetch con timeout opcional (AbortController).
 * Sin dependencias externas.
 */

/** URL base del backend (Render). */
/** URL base del backend: detecta automáticamente localhost o producción */
export const API_BASE =
  window.location.hostname === 'localhost'
    ? 'http://localhost:3000'
    : 'https://panaderialuzmarina.onrender.com';

/**
 * fetch contra el backend con soporte de timeout.
 * Si se pasa `timeout` (ms), aborta la petición al agotarse y el error
 * resultante tendrá name === 'AbortError' para que el llamador lo distinga.
 *
 * @param {string} path  Ruta relativa al backend (p. ej. '/ordenes').
 * @param {RequestInit & { timeout?: number }} [options]
 * @returns {Promise<Response>}
 */
export function apiFetch(path, { timeout, ...options } = {}) {
  if (!timeout) {
    return fetch(`${API_BASE}${path}`, options);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  return fetch(`${API_BASE}${path}`, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Trae el catálogo activo (GET /catalogo, público, sin token). Es la fuente
 * de verdad del precio: el backend rechaza cualquier pedido cuyo precio no
 * coincida con el de la tabla productos, así que el precio escrito a mano en
 * catalogo.html solo sirve como respaldo hasta que responde esta petición.
 * Devuelve null si el backend no responde, para que quien llame decida
 * (nunca vaciar el catálogo del cliente por un problema de red).
 *
 * @returns {Promise<Array<{ id: number, nombre: string, categoria: string, precio: number }> | null>}
 */
export async function fetchCatalogo() {
  try {
    const res = await apiFetch('/catalogo', { timeout: 8000 });
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    const { productos } = await res.json();
    return Array.isArray(productos) ? productos : null;
  } catch (err) {
    console.warn('[api] No se pudo obtener el catálogo:', err.message);
    return null;
  }
}

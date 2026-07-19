/**
 * PANADERÍA LUZ MARINA — Core: API
 * Punto único para hablar con el backend.
 *   - API_BASE compartido por todas las páginas.
 *   - apiFetch(): wrapper de fetch con timeout opcional (AbortController).
 * Sin dependencias externas.
 */

/** URL base del backend (Render). */
export const API_BASE = 'https://panaderialuzmarina.onrender.com';

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

  return fetch(`${API_BASE}${path}`, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

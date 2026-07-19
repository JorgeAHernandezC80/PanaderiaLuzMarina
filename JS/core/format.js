/**
 * PANADERÍA LUZ MARINA — Core: Format
 * Utilidades de presentación compartidas por todas las páginas.
 * Sin dependencias externas.
 */

/**
 * Formatea un número como precio en USD (2 decimales).
 * Valores no numéricos se tratan como 0 para no romper la UI.
 * @param {*} value
 * @returns {string}
 */
export function formatPrice(value) {
  const num = Number(value);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(Number.isFinite(num) ? num : 0);
}

/**
 * Devuelve "<count> <palabra>" pluralizando la palabra en español.
 * El singular se usa solo cuando count === 1.
 * @param {number} count
 * @param {string} singular  Forma singular (p. ej. 'producto').
 * @param {string} [plural]  Forma plural (por defecto singular + 's').
 * @returns {string}
 */
export function pluralizeEs(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

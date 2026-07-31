/**
 * UNITS — utilidades de conversión de unidades para Insumos.
 *
 * Cubre "a cuántos gramos equivale 1 [unidad] de este insumo". Es la base
 * que va a necesitar el descuento automático de insumos en Producción
 * (todavía no implementado) para saber cuánta materia prima real se
 * descuenta cuando Producción registra gramos usados — pero este módulo
 * por sí solo NO descuenta nada, solo hace la conversión.
 */

/* Unidades de peso: factor = cuántos gramos equivalen a 1 [unidad].
   Estas son conversiones universales, no dependen del insumo. */
const FACTOR_A_GRAMOS = {
  kg: 1000,
  g: 1,
  lb: 453.592,
};

/* Unidades de volumen: factor = cuántos mililitros equivalen a 1 [unidad].
   No se convierten a gramos aquí porque la densidad varía por ingrediente
   (1 ml de agua no pesa lo mismo que 1 ml de miel) — para convertir un
   líquido a gramos haría falta la densidad específica de ese insumo, que
   todavía no se captura. Queda fuera de este alcance por ahora. */
const FACTOR_A_ML = {
  l: 1000,
  ml: 1,
  gal: 3785.41,
};

const UNIDADES_DE_PESO = Object.keys(FACTOR_A_GRAMOS);
const UNIDADES_DE_VOLUMEN = Object.keys(FACTOR_A_ML);

/* Unidades de conteo: "1 unidad/paquete/caja" no tiene un peso universal —
   un paquete de levadura y un paquete de harina pesan distinto. Para estas,
   la conversión depende de equivalencia_gramos, un dato propio de cada
   insumo (ej. "1 paquete de levadura = 500 g"). */
const UNIDADES_POR_CONTEO = ['unidad', 'paquete', 'caja'];

/**
 * Convierte la cantidad en existencia de un insumo a gramos, cuando es
 * posible con los datos disponibles.
 * @param {{ unidad: string, cantidad: number, equivalenciaGramos?: number|null }} insumo
 * @returns {number|null} gramos totales, o null si no se puede convertir
 *   (unidad de volumen sin densidad conocida, o unidad de conteo sin
 *   equivalencia_gramos cargada).
 */
function convertirAGramos(insumo) {
  if (!insumo || typeof insumo.unidad !== 'string' || typeof insumo.cantidad !== 'number') {
    return null;
  }

  if (UNIDADES_DE_PESO.includes(insumo.unidad)) {
    return insumo.cantidad * FACTOR_A_GRAMOS[insumo.unidad];
  }

  if (UNIDADES_POR_CONTEO.includes(insumo.unidad)) {
    const equivalencia = Number(insumo.equivalenciaGramos);
    if (!Number.isFinite(equivalencia) || equivalencia <= 0) {
      return null;
    }
    return insumo.cantidad * equivalencia;
  }

  // Unidades de volumen (l, ml, gal): sin densidad conocida, no se convierte.
  return null;
}

/**
 * Calcula el costo por gramo de un insumo, dado su costo unitario (el
 * costo de comprar 1 [unidad]) y esa misma unidad. Es la pieza que faltaba
 * para conectar Insumos con el costeo real de una receta más adelante
 * (cuánto cuesta, en pesos, hornear una tanda) — todavía no se usa en
 * ningún endpoint, es una utilidad lista para cuando se necesite.
 * @param {{ unidad: string, costoUnitario: number|null, equivalenciaGramos?: number|null }} insumo
 * @returns {number|null} costo por gramo, o null si no se puede calcular
 */
function costoPorGramo(insumo) {
  if (!insumo || typeof insumo.costoUnitario !== 'number' || insumo.costoUnitario < 0) {
    return null;
  }
  const gramosPorUnidad = convertirAGramos({ ...insumo, cantidad: 1 });
  if (!gramosPorUnidad || gramosPorUnidad <= 0) return null;
  return insumo.costoUnitario / gramosPorUnidad;
}

module.exports = {
  FACTOR_A_GRAMOS,
  FACTOR_A_ML,
  UNIDADES_DE_PESO,
  UNIDADES_DE_VOLUMEN,
  UNIDADES_POR_CONTEO,
  convertirAGramos,
  costoPorGramo,
};

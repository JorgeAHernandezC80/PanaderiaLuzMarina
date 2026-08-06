/**
 * PANADERÍA LUZ MARINA — Backend: Calidad de Datos (ADM)
 *
 * Gestión de Datos Aumentada (Ghandeharizadeh & Yap, 2013): automatizar
 * controles de calidad y metadatos en vez de que alguien revise fila por
 * fila a mano. Este módulo cubre las dos partes que todavía no tenía el
 * proyecto:
 *
 *   - Controles de calidad: qué le falta a cada registro puntual
 *     (evaluarProductos/evaluarInsumos → hallazgos).
 *   - Metadatos / datos maestros: qué tan completa está cada columna en
 *     general — el "diccionario de datos" declarado en CAMPOS_PRODUCTOS/
 *     CAMPOS_INSUMOS es la pieza de metadata: en vez de tener que
 *     recordar qué campos importan, queda escrito una sola vez acá.
 *
 * La tercera parte de ADM ("integración autoconfigurada y autoajustable")
 * ya existe en el proyecto sin llamarse así: el caché de
 * analyticsEngine.js decide solo cuándo recalcular sin que nadie se lo
 * pida — es la misma idea aplicada a otro problema.
 */

const db = require('./db');

function esVacio(valor) {
  return valor === null || valor === undefined || valor === '';
}

/* "Diccionario de datos": qué campo de cada tabla se espera que esté
   lleno, con qué etiqueta legible y qué tan grave es que falte. Esto es
   metadata, no lógica — cambiar qué se audita es cambiar esta lista, no
   reescribir las funciones de abajo. */
const CAMPOS_PRODUCTOS = [
  { campo: 'imagen_base', etiqueta: 'Imagen', severidad: 'media' },
  { campo: 'descripcion', etiqueta: 'Descripción', severidad: 'media' },
  { campo: 'vida_util_horas', etiqueta: 'Vida útil', severidad: 'baja' },
  { campo: 'sku', etiqueta: 'SKU', severidad: 'baja' },
];

const CAMPOS_INSUMOS = [
  { campo: 'proveedor', etiqueta: 'Proveedor', severidad: 'alta' },
  { campo: 'stock_minimo', etiqueta: 'Stock mínimo', severidad: 'alta' },
  { campo: 'costo_unitario', etiqueta: 'Costo unitario', severidad: 'alta' },
  { campo: 'fecha_vencimiento', etiqueta: 'Fecha de vencimiento', severidad: 'media' },
];

/**
 * Completitud por campo: de todas las filas, cuántas tienen ese campo
 * lleno. Es el metadato — cuánto se puede confiar en cada columna sin
 * tener que revisarla fila por fila.
 * @param {object[]} filas
 * @param {{campo: string, etiqueta: string, severidad: string}[]} campos
 */
function calcularCompletitud(filas, campos) {
  const total = filas.length;
  return campos.map(({ campo, etiqueta, severidad }) => {
    const llenos = filas.filter((f) => !esVacio(f[campo])).length;
    return {
      campo,
      etiqueta,
      severidad,
      llenos,
      total,
      porcentaje: total > 0 ? Math.round((llenos / total) * 100) : 100,
    };
  });
}

/**
 * Hallazgo de un registro puntual: qué campos le faltan. null si no le
 * falta nada (no se agrega ruido a la lista por registros completos).
 */
function calcularHallazgo(fila, campos, idCampo, nombreCampo) {
  const faltantes = campos.filter(({ campo }) => esVacio(fila[campo]));
  if (faltantes.length === 0) return null;
  return {
    id: fila[idCampo],
    nombre: fila[nombreCampo],
    faltantes: faltantes.map(({ campo, etiqueta, severidad }) => ({
      campo,
      etiqueta,
      severidad,
    })),
  };
}

/** Controles de calidad de Productos: completitud + hallazgos por campo
 *  declarado, más una regla específica de rango. No se puede usar
 *  "precio > 1000" como ejemplo de dato sospechoso: productos.precio
 *  tiene CHECK (precio > 0 AND precio <= 1000) en la propia base de
 *  datos, así que ese caso es matemáticamente imposible de encontrar —
 *  en cambio, un precio alto mal escrito (ej. "35" en vez de "3.5") sí
 *  pasa ese CHECK y sigue siendo un error real que vale la pena avisar. */
const PRECIO_SOSPECHOSO_UMBRAL = 20; // muy por encima de lo que cuesta cualquier producto de esta panadería hoy

function evaluarProductos() {
  const filas = db.prepare('SELECT * FROM productos').all();
  const completitud = calcularCompletitud(filas, CAMPOS_PRODUCTOS);
  const hallazgos = filas
    .map((f) => calcularHallazgo(f, CAMPOS_PRODUCTOS, 'id', 'nombre'))
    .filter(Boolean);

  const preciosSospechosos = filas
    .filter((f) => f.precio > PRECIO_SOSPECHOSO_UMBRAL)
    .map((f) => ({ id: f.id, nombre: f.nombre, precio: f.precio }));

  return {
    entidad: 'productos',
    totalRegistros: filas.length,
    completitud,
    hallazgos,
    alertas: { preciosSospechosos },
  };
}

/** Controles de calidad de Insumos: completitud + hallazgos, más una
 *  regla de negocio real — insumos con fecha de vencimiento ya pasada
 *  que nadie marcó ni retiró (el mismo indicador visual que ya existe
 *  en la vista de Insumos, pero acá agregado en un reporte). */
function evaluarInsumos() {
  const filas = db.prepare('SELECT * FROM insumos').all();
  const completitud = calcularCompletitud(filas, CAMPOS_INSUMOS);
  const hallazgos = filas
    .map((f) => calcularHallazgo(f, CAMPOS_INSUMOS, 'id', 'nombre'))
    .filter(Boolean);

  const hoy = new Date().toISOString().slice(0, 10);
  const vencidos = filas
    .filter((f) => f.fecha_vencimiento && f.fecha_vencimiento < hoy)
    .map((f) => ({ id: f.id, nombre: f.nombre, fechaVencimiento: f.fecha_vencimiento }));

  return {
    entidad: 'insumos',
    totalRegistros: filas.length,
    completitud,
    hallazgos,
    alertas: { vencidos },
  };
}

/** Reporte completo — lo que expone GET /calidad-datos. */
function evaluarCalidadGeneral() {
  return {
    productos: evaluarProductos(),
    insumos: evaluarInsumos(),
    generadoEn: new Date().toISOString(),
  };
}

module.exports = {
  esVacio,
  CAMPOS_PRODUCTOS,
  CAMPOS_INSUMOS,
  calcularCompletitud,
  calcularHallazgo,
  evaluarProductos,
  evaluarInsumos,
  evaluarCalidadGeneral,
};

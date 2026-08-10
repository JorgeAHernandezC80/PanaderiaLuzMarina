/**
 * PANADERÍA LUZ MARINA — Backend: Validación
 * Mismo criterio de blindaje aplicado en cart.js (frontend):
 * nunca confiar en lo que llega del cliente, validar tipo, rango y longitud.
 */

/* Antes este archivo era "puro" (sin tocar la base de datos) — el único
   caso que lo necesita es productos: antes vivían fijos en código
   (un objeto PRODUCTOS_CATALOGO fijo), ahora es una tabla real (ver db.js),
   así que validarItem puede cruzar el precio real de cada producto
   contra lo que manda el cliente, en vez de confiar ciegamente en él. */
const db = require('./db');

const MAX_ITEMS = 50;
const MAX_NOMBRE_LEN = 120;
const MAX_CLIENTE_LEN = 80;
const MAX_PRECIO = 1000;
const MAX_TOTAL = 50000;
const NUMERO_ORDEN_RE = /^LM-\d{8}-\d{4}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const ORDER_STATES = ['pendiente', 'en_preparacion', 'preparada', 'entregada'];

const MAX_INSUMO_NOMBRE_LEN = 120;
const MAX_INSUMO_PROVEEDOR_LEN = 120;
const MAX_INSUMO_MARCA_LEN = 80;
const MAX_INSUMO_UBICACION_LEN = 120;
const MAX_INSUMO_NOTAS_LEN = 500;
const MAX_INSUMO_CANTIDAD = 999999;
const MAX_INSUMO_COSTO = 999999;
const INSUMO_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const CATEGORIAS_INSUMO = [
  'harinas',
  'lacteos',
  'huevos',
  'endulzantes',
  'grasas',
  'levaduras',
  'empaque',
  'otros',
];
const UNIDADES_INSUMO = ['kg', 'g', 'l', 'ml', 'lb', 'gal', 'unidad', 'paquete', 'caja'];

/* Alérgenos comunes en panadería, para poder generar advertencias en
   etiquetas de producto más adelante. Lista blanca: un alérgeno mal escrito
   que no se detecte es un riesgo real, así que se rechaza en vez de
   ignorarse en silencio. */
const ALERGENOS_INSUMO = [
  'gluten',
  'lacteos',
  'huevo',
  'soya',
  'frutos_secos',
  'mani',
  'mariscos',
  'sesamo',
];

const MAX_INSUMO_SKU_LEN = 40;
const MAX_INSUMO_TEXTO_CORTO_LEN = 120;
const MAX_INSUMO_DIAS = 3650; // 10 años, tope defensivo
const MAX_INSUMO_IMPUESTO_PORCENTAJE = 100;
const MAX_INSUMO_EQUIVALENCIA_GRAMOS = 1_000_000; // 1 tonelada, tope generoso

const MAX_PROVEEDOR_TEXTO_LEN = 120;
const MAX_PROVEEDOR_LARGO_LEN = 500;
const MAX_PROVEEDOR_LEAD_TIME = 365;
const MAX_PROVEEDOR_PEDIDO_MINIMO = 99999999;
const PROVEEDOR_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const CONDICIONES_PAGO = ['contado', 'credito_30', 'credito_60', 'credito_90'];
const MONEDAS_PROVEEDOR = ['COP', 'MXN', 'USD', 'EUR', 'CLP', 'ARS'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const HORNEADA_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const MAX_HORNEADA_CANTIDAD = 9999;
const MAX_HORNEADA_NOTAS_LEN = 280;
const MAX_HORNEADA_REGISTRADO_POR_LEN = 80;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const HORA_RE = /^\d{1,2}:\d{2}$/;
const MAX_TEMPERATURA_HORNEADO_C = 350; // horno doméstico/industrial, tope generoso
const MAX_TIEMPO_HORNEADO_MIN = 300; // 5h, tope defensivo
const MAX_MERMA_PCT = 100;

/* Categorías de producto: whitelist cerrada, igual que las de insumo. El
   producto en sí ya no vive aquí (ver obtenerProducto), pero su categoría
   sigue siendo un conjunto fijo — los filtros de catalogo.html y el
   agrupado de Recetas dependen de que no aparezcan valores nuevos sin
   que nadie los haya previsto. La categoría es la fuente de verdad para
   Recetas — no se duplica como campo propio ahí, se lee de acá. */
const CATEGORIAS_PRODUCTO = ['panaderia', 'reposteria', 'bolleria', 'frituras'];
/* Antes era un objeto fijo con 9 productos hardcodeados, sin precio (el
   precio real solo vivía como texto en catalogo.html, nunca se validaba
   del lado del servidor). Ahora consulta la tabla productos (ver db.js)
   de verdad — mismos ids 1-9 que ya tenían, para no romper ninguna
   receta/producción/horneada/orden/ajuste existente. */
function obtenerProducto(id) {
  return db
    .prepare(
      `SELECT id, nombre, categoria, precio, estado, sku, descripcion, actualizado_por,
              imagen_base, alt_imagen, vida_util_horas, creado_en
       FROM productos WHERE id = ?`,
    )
    .get(id);
}

const MAX_PRODUCTO_NOMBRE_LEN = 80;
// Mismo tope que MAX_PRECIO (validarItem) y que el CHECK de la columna
// precio en db.js: un producto nunca debería costar más de lo que un
// solo item de pedido puede costar.
const MAX_PRODUCTO_PRECIO = MAX_PRECIO;
const ESTADOS_PRODUCTO = ['activo', 'borrador', 'agotado', 'descontinuado'];
const MAX_PRODUCTO_SKU_LEN = 40;
const MAX_PRODUCTO_DESCRIPCION_LEN = 300;
const MAX_PRODUCTO_ACTUALIZADO_POR_LEN = 80; // mismo tope que horneada/ajuste (registradoPor)
const MAX_PRODUCTO_ALT_IMAGEN_LEN = 160;
// Tope generoso pero no absurdo: 168h = una semana. Nada horneado en esta
// panadería debería durar más que eso, y evita que un typo (ej. "1680")
// se cuele como si fuera un valor real.
const MAX_VIDA_UTIL_HORAS = 168;
// imagen_base termina interpolado en el src/srcset de un <img> en
// catalogo.html (./IMG/webp/${imagenBase}-400.webp). Whitelist estricta
// (minúsculas, dígitos, guion) para que nunca pueda meter una ruta fuera
// de IMG/webp ni un atributo/etiqueta extra — mismo criterio que
// INSUMO_ID_RE/PROVEEDOR_ID_RE, pero sin mayúsculas porque los archivos
// en IMG/webp/ ya siguen esa convención (kebab-case).
const IMAGEN_BASE_RE = /^[a-z0-9-]{1,60}$/;

/** Valida los campos de un producto para crear/editar. `estado`, `sku`,
 *  `descripcion` y `actualizadoPor` son opcionales — si no vienen, se
 *  conserva lo que ya tenía el producto (ver PUT /productos/:id en
 *  server.js, que hace ese fallback). */
function validarProducto(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }

  const nombre = typeof datos.nombre === 'string' ? datos.nombre.trim() : '';
  if (!nombre || nombre.length > MAX_PRODUCTO_NOMBRE_LEN) {
    throw new ValidationError(
      `El nombre es obligatorio (máx. ${MAX_PRODUCTO_NOMBRE_LEN} caracteres).`,
    );
  }

  if (!CATEGORIAS_PRODUCTO.includes(datos.categoria)) {
    throw new ValidationError(
      `Categoría inválida. Debe ser una de: ${CATEGORIAS_PRODUCTO.join(', ')}.`,
    );
  }

  const precio = Number(datos.precio);
  if (!Number.isFinite(precio) || precio <= 0 || precio > MAX_PRODUCTO_PRECIO) {
    throw new ValidationError(`El precio debe ser mayor a 0 y menor a ${MAX_PRODUCTO_PRECIO}.`);
  }

  const resultado = { nombre, categoria: datos.categoria, precio: Math.round(precio * 100) / 100 };

  if (datos.estado !== undefined) {
    if (!ESTADOS_PRODUCTO.includes(datos.estado)) {
      throw new ValidationError(
        `Estado inválido. Debe ser uno de: ${ESTADOS_PRODUCTO.join(', ')}.`,
      );
    }
    resultado.estado = datos.estado;
  }

  if (datos.sku !== undefined) {
    const sku = typeof datos.sku === 'string' ? datos.sku.trim() : '';
    if (sku.length > MAX_PRODUCTO_SKU_LEN) {
      throw new ValidationError(`El SKU no puede superar los ${MAX_PRODUCTO_SKU_LEN} caracteres.`);
    }
    // '' -> null: un SKU vacío no debe chocar contra otro vacío por el
    // UNIQUE de la columna (NULL sí permite varios, '' no lo haría).
    resultado.sku = sku === '' ? null : sku;
  }

  if (datos.descripcion !== undefined) {
    const descripcion = typeof datos.descripcion === 'string' ? datos.descripcion.trim() : '';
    if (descripcion.length > MAX_PRODUCTO_DESCRIPCION_LEN) {
      throw new ValidationError(
        `La descripción no puede superar los ${MAX_PRODUCTO_DESCRIPCION_LEN} caracteres.`,
      );
    }
    resultado.descripcion = descripcion === '' ? null : descripcion;
  }

  if (datos.actualizadoPor !== undefined) {
    const actualizadoPor =
      typeof datos.actualizadoPor === 'string' ? datos.actualizadoPor.trim() : '';
    if (actualizadoPor.length > MAX_PRODUCTO_ACTUALIZADO_POR_LEN) {
      throw new ValidationError(
        `El nombre de quien actualiza no puede superar los ${MAX_PRODUCTO_ACTUALIZADO_POR_LEN} caracteres.`,
      );
    }
    resultado.actualizadoPor = actualizadoPor === '' ? null : actualizadoPor;
  }

  if (datos.imagenBase !== undefined) {
    const imagenBase = typeof datos.imagenBase === 'string' ? datos.imagenBase.trim() : '';
    if (imagenBase !== '' && !IMAGEN_BASE_RE.test(imagenBase)) {
      throw new ValidationError(
        'La imagen debe ser el nombre base del archivo en IMG/webp (solo minúsculas, números y guiones, sin extensión), ej. "croissant".',
      );
    }
    resultado.imagenBase = imagenBase === '' ? null : imagenBase;
  }

  if (datos.altImagen !== undefined) {
    const altImagen = typeof datos.altImagen === 'string' ? datos.altImagen.trim() : '';
    if (altImagen.length > MAX_PRODUCTO_ALT_IMAGEN_LEN) {
      throw new ValidationError(
        `El texto alternativo no puede superar los ${MAX_PRODUCTO_ALT_IMAGEN_LEN} caracteres.`,
      );
    }
    resultado.altImagen = altImagen === '' ? null : altImagen;
  }

  if (datos.vidaUtilHoras !== undefined) {
    const vidaUtilHoras =
      datos.vidaUtilHoras === '' || datos.vidaUtilHoras === null
        ? null
        : Number(datos.vidaUtilHoras);
    if (
      vidaUtilHoras !== null &&
      (!Number.isFinite(vidaUtilHoras) || vidaUtilHoras <= 0 || vidaUtilHoras > MAX_VIDA_UTIL_HORAS)
    ) {
      throw new ValidationError(
        `Vida útil inválida (debe ser un número mayor a 0 y hasta ${MAX_VIDA_UTIL_HORAS} horas).`,
      );
    }
    resultado.vidaUtilHoras = vidaUtilHoras;
  }

  return resultado;
}

const AJUSTE_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const MAX_AJUSTE_CANTIDAD = 9999;
const MAX_AJUSTE_NOTAS_LEN = 280;
const MAX_AJUSTE_REGISTRADO_POR_LEN = 80;
const MOTIVOS_AJUSTE = ['merma', 'error_conteo', 'consumo_interno', 'otro'];
const MAX_STOCK_MINIMO = 999;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

function validarItem(item, idx) {
  if (!item || typeof item !== 'object') {
    throw new ValidationError(`Item #${idx}: se esperaba un objeto.`);
  }
  if (
    typeof item.nombre !== 'string' ||
    item.nombre.trim() === '' ||
    item.nombre.length > MAX_NOMBRE_LEN
  ) {
    throw new ValidationError(`Item #${idx}: nombre inválido.`);
  }
  if (!Number.isInteger(item.cantidad) || item.cantidad <= 0 || item.cantidad > 999) {
    throw new ValidationError(`Item #${idx}: cantidad inválida.`);
  }
  const precio = Number(item.precio);
  if (!Number.isFinite(precio) || precio <= 0 || precio > MAX_PRECIO) {
    throw new ValidationError(`Item #${idx}: precio inválido.`);
  }
  // productoId es opcional a propósito: el carrito (cart.js) siempre lo
  // manda desde que existe, pero no lo exigimos aquí para no tumbar el
  // checkout si algún día el catálogo cambia de forma o queda un cliente
  // con JS cacheado viejo. Si viene, se sanea a string; si no, queda null
  // y el cruce con Inventario cae de vuelta al nombre (ver GET /inventario).
  if (item.productoId !== undefined && item.productoId !== null && item.productoId !== '') {
    const productoIdStr = String(item.productoId).trim();
    if (productoIdStr.length > 20) {
      throw new ValidationError(`Item #${idx}: productoId inválido.`);
    }
    // Cruce contra el precio real (tabla productos, ver db.js): antes el
    // único chequeo era que la suma de items coincidiera con el total
    // declarado — pero ambos números los manda el mismo cliente, así que
    // alguien podía mandar cualquier precio bajo para todo el pedido y
    // pasaba la validación igual. Con productoId siempre disponible
    // (cart.js lo manda desde que existe), ya no hace falta confiar
    // ciegamente en item.precio.
    const productoIdNum = Number(productoIdStr);
    if (Number.isInteger(productoIdNum)) {
      const producto = obtenerProducto(productoIdNum);
      if (!producto || producto.estado !== 'activo') {
        throw new ValidationError(`Item #${idx}: producto no disponible.`);
      }
      // Medio centavo de tolerancia: solo para absorber el ruido de coma
      // flotante al ir y volver por JSON, no para dejar pasar diferencias
      // reales de precio (un centavo por unidad × 999 unidades × 50 items
      // ya es dinero).
      if (Math.abs(precio - producto.precio) > 0.005) {
        throw new ValidationError(`Item #${idx}: el precio no coincide con el del catálogo.`);
      }
    }
  }
}

/**
 * Valida el objeto orden completo tal como lo arma checkout.js.
 * Lanza ValidationError (400) si algo no cumple el esquema.
 * @param {*} orden
 * @returns {object} orden saneada (strings recortados, números normalizados)
 */
function validarOrden(orden) {
  if (!orden || typeof orden !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }

  const { numero, fechaISO, fechaTexto, cliente, telefono, retiro, items, total } = orden;

  if (typeof numero !== 'string' || !NUMERO_ORDEN_RE.test(numero)) {
    throw new ValidationError('Número de orden inválido o con formato incorrecto.');
  }
  if (typeof fechaISO !== 'string' || !ISO_DATE_RE.test(fechaISO)) {
    throw new ValidationError('fechaISO inválida.');
  }
  if (typeof fechaTexto !== 'string' || fechaTexto.trim() === '' || fechaTexto.length > 200) {
    throw new ValidationError('fechaTexto inválida.');
  }
  if (typeof cliente !== 'string' || cliente.trim() === '' || cliente.length > MAX_CLIENTE_LEN) {
    throw new ValidationError('Nombre de cliente inválido.');
  }
  const telefonoDigitos = String(telefono ?? '').replace(/\D/g, '');
  if (telefonoDigitos.length < 7 || telefonoDigitos.length > 15) {
    throw new ValidationError('Teléfono inválido.');
  }
  if (typeof retiro !== 'string' || !/^\d{1,2}:\d{2}$/.test(retiro)) {
    throw new ValidationError('Horario de retiro inválido.');
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
    throw new ValidationError('Lista de items inválida.');
  }
  items.forEach(validarItem);

  const totalNum = Number(total);
  if (!Number.isFinite(totalNum) || totalNum <= 0 || totalNum > MAX_TOTAL) {
    throw new ValidationError('Total inválido.');
  }

  // Coherencia: el total declarado debe coincidir con la suma de items
  // (margen de 1 centavo por redondeo de punto flotante).
  const sumaItems = items.reduce((sum, i) => sum + Number(i.precio) * i.cantidad, 0);
  if (Math.abs(sumaItems - totalNum) > 0.01) {
    throw new ValidationError('El total no coincide con la suma de los items.');
  }

  return {
    numero,
    fechaISO,
    fechaTexto: fechaTexto.trim(),
    cliente: cliente.trim(),
    telefono: telefonoDigitos,
    retiro,
    items: items.map((i) => ({
      productoId:
        i.productoId !== undefined && i.productoId !== null && i.productoId !== ''
          ? String(i.productoId).trim()
          : null,
      nombre: i.nombre.trim(),
      cantidad: i.cantidad,
      precio: Number(i.precio),
    })),
    total: totalNum,
  };
}

/**
 * Valida y sanea los datos de un insumo tal como los envía admin.js.
 * Nunca confía en el cliente: categoría y unidad se validan contra listas
 * blancas, los números se acotan a rangos razonables y los textos libres
 * se recortan a un largo máximo antes de tocar la base de datos.
 * @param {*} datos
 * @returns {object} insumo saneado
 */
function validarInsumo(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }

  const {
    nombre,
    categoria,
    cantidad,
    unidad,
    costoUnitario,
    stockMinimo,
    stockMaximo,
    proveedor,
    proveedorSecundario,
    marca,
    sku,
    fechaVencimiento,
    ubicacion,
    presentacionCompra,
    condicionesAlmacenamiento,
    loteProveedor,
    vidaUtilAbiertoDias,
    leadTimeDias,
    impuestoPorcentaje,
    alergenos,
    equivalenciaGramos,
    notas,
  } = datos;

  if (typeof nombre !== 'string' || nombre.trim() === '' || nombre.length > MAX_INSUMO_NOMBRE_LEN) {
    throw new ValidationError('Nombre del insumo inválido.');
  }

  const categoriaFinal = CATEGORIAS_INSUMO.includes(categoria) ? categoria : 'otros';

  const cantidadNum = Number(cantidad);
  if (!Number.isFinite(cantidadNum) || cantidadNum < 0 || cantidadNum > MAX_INSUMO_CANTIDAD) {
    throw new ValidationError('Cantidad inválida.');
  }

  if (typeof unidad !== 'string' || !UNIDADES_INSUMO.includes(unidad)) {
    throw new ValidationError('Unidad inválida.');
  }

  let costoFinal = null;
  if (costoUnitario !== null && costoUnitario !== undefined && costoUnitario !== '') {
    const costoNum = Number(costoUnitario);
    if (!Number.isFinite(costoNum) || costoNum < 0 || costoNum > MAX_INSUMO_COSTO) {
      throw new ValidationError('Costo unitario inválido.');
    }
    costoFinal = costoNum;
  }

  let stockMinFinal = null;
  if (stockMinimo !== null && stockMinimo !== undefined && stockMinimo !== '') {
    const stockNum = Number(stockMinimo);
    if (!Number.isFinite(stockNum) || stockNum < 0 || stockNum > MAX_INSUMO_CANTIDAD) {
      throw new ValidationError('Stock mínimo inválido.');
    }
    stockMinFinal = stockNum;
  }

  let stockMaxFinal = null;
  if (stockMaximo !== null && stockMaximo !== undefined && stockMaximo !== '') {
    const stockMaxNum = Number(stockMaximo);
    if (!Number.isFinite(stockMaxNum) || stockMaxNum < 0 || stockMaxNum > MAX_INSUMO_CANTIDAD) {
      throw new ValidationError('Stock máximo inválido.');
    }
    if (stockMinFinal !== null && stockMaxNum < stockMinFinal) {
      throw new ValidationError('El stock máximo no puede ser menor que el stock mínimo.');
    }
    stockMaxFinal = stockMaxNum;
  }

  const proveedorFinal =
    typeof proveedor === 'string' ? proveedor.trim().slice(0, MAX_INSUMO_PROVEEDOR_LEN) : '';
  const proveedorSecundarioFinal =
    typeof proveedorSecundario === 'string'
      ? proveedorSecundario.trim().slice(0, MAX_INSUMO_PROVEEDOR_LEN)
      : '';
  const marcaFinal = typeof marca === 'string' ? marca.trim().slice(0, MAX_INSUMO_MARCA_LEN) : '';
  const ubicacionFinal =
    typeof ubicacion === 'string' ? ubicacion.trim().slice(0, MAX_INSUMO_UBICACION_LEN) : '';
  const skuFinal = typeof sku === 'string' ? sku.trim().slice(0, MAX_INSUMO_SKU_LEN) : '';
  const presentacionCompraFinal =
    typeof presentacionCompra === 'string'
      ? presentacionCompra.trim().slice(0, MAX_INSUMO_TEXTO_CORTO_LEN)
      : '';
  const condicionesAlmacenamientoFinal =
    typeof condicionesAlmacenamiento === 'string'
      ? condicionesAlmacenamiento.trim().slice(0, MAX_INSUMO_TEXTO_CORTO_LEN)
      : '';
  const loteProveedorFinal =
    typeof loteProveedor === 'string'
      ? loteProveedor.trim().slice(0, MAX_INSUMO_TEXTO_CORTO_LEN)
      : '';

  let fechaVencimientoFinal = null;
  if (fechaVencimiento !== null && fechaVencimiento !== undefined && fechaVencimiento !== '') {
    if (typeof fechaVencimiento !== 'string' || !FECHA_RE.test(fechaVencimiento)) {
      throw new ValidationError('Fecha de vencimiento inválida.');
    }
    fechaVencimientoFinal = fechaVencimiento;
  }

  let vidaUtilAbiertoDiasFinal = null;
  if (
    vidaUtilAbiertoDias !== null &&
    vidaUtilAbiertoDias !== undefined &&
    vidaUtilAbiertoDias !== ''
  ) {
    const val = Number(vidaUtilAbiertoDias);
    if (!Number.isInteger(val) || val <= 0 || val > MAX_INSUMO_DIAS) {
      throw new ValidationError('Vida útil una vez abierto inválida.');
    }
    vidaUtilAbiertoDiasFinal = val;
  }

  let leadTimeDiasFinal = null;
  if (leadTimeDias !== null && leadTimeDias !== undefined && leadTimeDias !== '') {
    const val = Number(leadTimeDias);
    if (!Number.isInteger(val) || val <= 0 || val > MAX_INSUMO_DIAS) {
      throw new ValidationError('Tiempo de entrega (lead time) inválido.');
    }
    leadTimeDiasFinal = val;
  }

  let impuestoPorcentajeFinal = null;
  if (
    impuestoPorcentaje !== null &&
    impuestoPorcentaje !== undefined &&
    impuestoPorcentaje !== ''
  ) {
    const val = Number(impuestoPorcentaje);
    if (!Number.isFinite(val) || val < 0 || val > MAX_INSUMO_IMPUESTO_PORCENTAJE) {
      throw new ValidationError('Porcentaje de impuesto inválido.');
    }
    impuestoPorcentajeFinal = val;
  }

  let equivalenciaGramosFinal = null;
  if (
    equivalenciaGramos !== null &&
    equivalenciaGramos !== undefined &&
    equivalenciaGramos !== ''
  ) {
    const val = Number(equivalenciaGramos);
    if (!Number.isFinite(val) || val <= 0 || val > MAX_INSUMO_EQUIVALENCIA_GRAMOS) {
      throw new ValidationError('Equivalencia en gramos inválida.');
    }
    equivalenciaGramosFinal = val;
  }

  let alergenosFinal = [];
  if (alergenos !== null && alergenos !== undefined) {
    if (!Array.isArray(alergenos)) {
      throw new ValidationError('Alérgenos debe ser una lista.');
    }
    for (const a of alergenos) {
      if (!ALERGENOS_INSUMO.includes(a)) {
        throw new ValidationError(`Alérgeno inválido: "${a}".`);
      }
    }
    alergenosFinal = [...new Set(alergenos)];
  }

  const notasFinal = typeof notas === 'string' ? notas.trim().slice(0, MAX_INSUMO_NOTAS_LEN) : '';

  return {
    nombre: nombre.trim(),
    categoria: categoriaFinal,
    cantidad: cantidadNum,
    unidad,
    costoUnitario: costoFinal,
    stockMinimo: stockMinFinal,
    stockMaximo: stockMaxFinal,
    proveedor: proveedorFinal,
    proveedorSecundario: proveedorSecundarioFinal,
    marca: marcaFinal,
    sku: skuFinal,
    fechaVencimiento: fechaVencimientoFinal,
    ubicacion: ubicacionFinal,
    presentacionCompra: presentacionCompraFinal,
    condicionesAlmacenamiento: condicionesAlmacenamientoFinal,
    loteProveedor: loteProveedorFinal,
    vidaUtilAbiertoDias: vidaUtilAbiertoDiasFinal,
    leadTimeDias: leadTimeDiasFinal,
    impuestoPorcentaje: impuestoPorcentajeFinal,
    alergenos: JSON.stringify(alergenosFinal),
    equivalenciaGramos: equivalenciaGramosFinal,
    notas: notasFinal,
  };
}

/**
 * Valida y sanea los datos de un proveedor tal como los envía admin.js.
 * Solo la razón social es obligatoria; el resto son campos opcionales que se
 * recortan a un largo máximo. Condiciones de pago y moneda se validan contra
 * listas blancas, los emails contra un formato básico y los números se acotan.
 * @param {*} datos
 * @returns {object} proveedor saneado
 */
function validarProveedor(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }

  const { razonSocial, condicionesPago, moneda, leadTimeDias, pedidoMinimo } = datos;

  if (
    typeof razonSocial !== 'string' ||
    razonSocial.trim() === '' ||
    razonSocial.length > MAX_PROVEEDOR_TEXTO_LEN
  ) {
    throw new ValidationError('Nombre o razón social inválido.');
  }

  if (!CONDICIONES_PAGO.includes(condicionesPago)) {
    throw new ValidationError('Condiciones de pago inválidas.');
  }
  if (!MONEDAS_PROVEEDOR.includes(moneda)) {
    throw new ValidationError('Moneda inválida.');
  }

  const texto = (valor, max = MAX_PROVEEDOR_TEXTO_LEN) =>
    typeof valor === 'string' ? valor.trim().slice(0, max) : '';

  const email = (valor, campo) => {
    const limpio = texto(valor);
    if (limpio !== '' && !EMAIL_RE.test(limpio)) {
      throw new ValidationError(`${campo} inválido.`);
    }
    return limpio;
  };

  const numeroOpcional = (valor, max, campo) => {
    if (valor === null || valor === undefined || valor === '') return null;
    const num = Number(valor);
    if (!Number.isFinite(num) || num < 0 || num > max) {
      throw new ValidationError(`${campo} inválido.`);
    }
    return num;
  };

  return {
    razonSocial: razonSocial.trim(),
    nombreComercial: texto(datos.nombreComercial),
    identificacionFiscal: texto(datos.identificacionFiscal, 40),
    giroComercial: texto(datos.giroComercial),
    direccion: texto(datos.direccion, MAX_PROVEEDOR_LARGO_LEN),
    codigoPostal: texto(datos.codigoPostal, 20),
    ciudad: texto(datos.ciudad),
    pais: texto(datos.pais),
    contactoNombre: texto(datos.contactoNombre),
    emailFacturacion: email(datos.emailFacturacion, 'Correo de facturación'),
    emailContacto: email(datos.emailContacto, 'Correo del contacto'),
    telefonoFijo: texto(datos.telefonoFijo, 30),
    celular: texto(datos.celular, 30),
    banco: texto(datos.banco),
    numeroCuenta: texto(datos.numeroCuenta, 40),
    clabeIban: texto(datos.clabeIban, 40),
    condicionesPago,
    moneda,
    metodoFacturacion: texto(datos.metodoFacturacion, MAX_PROVEEDOR_LARGO_LEN),
    leadTimeDias: numeroOpcional(leadTimeDias, MAX_PROVEEDOR_LEAD_TIME, 'Tiempo de entrega'),
    pedidoMinimo: numeroOpcional(pedidoMinimo, MAX_PROVEEDOR_PEDIDO_MINIMO, 'Pedido mínimo'),
    politicasDevolucion: texto(datos.politicasDevolucion, MAX_PROVEEDOR_LARGO_LEN),
    certificaciones: texto(datos.certificaciones, MAX_PROVEEDOR_LARGO_LEN),
    notas: texto(datos.notas, MAX_PROVEEDOR_LARGO_LEN),
  };
}

/**
 * Valida y sanea el registro de una horneada tal como lo envía admin.js.
 * El producto se valida contra el catálogo whitelist (no se confía en el
 * nombre que mande el cliente); cantidad debe ser un entero positivo
 * (número de panes horneados); fecha y hora se validan por formato, igual
 * que fechaISO/retiro en validarOrden.
 * @param {*} datos
 * @returns {object} horneada saneada
 */
function validarHorneada(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }

  const { productoId, cantidad, fecha, hora } = datos;

  const producto = obtenerProducto(Number(productoId));
  if (!producto) {
    throw new ValidationError('Producto inválido.');
  }
  const productoNombre = producto.nombre;

  const cantidadNum = Number(cantidad);
  if (!Number.isInteger(cantidadNum) || cantidadNum <= 0 || cantidadNum > MAX_HORNEADA_CANTIDAD) {
    throw new ValidationError('Cantidad horneada inválida.');
  }

  if (typeof fecha !== 'string' || !FECHA_RE.test(fecha)) {
    throw new ValidationError('Fecha de horneada inválida.');
  }
  if (typeof hora !== 'string' || !HORA_RE.test(hora)) {
    throw new ValidationError('Hora de horneada inválida.');
  }

  const notasFinal =
    typeof datos.notas === 'string' ? datos.notas.trim().slice(0, MAX_HORNEADA_NOTAS_LEN) : '';
  const registradoPorFinal =
    typeof datos.registradoPor === 'string'
      ? datos.registradoPor.trim().slice(0, MAX_HORNEADA_REGISTRADO_POR_LEN)
      : '';
  // Opcional a propósito: una horneada puede registrarse suelta (sin venir
  // de una Producción rastreada) o ligada a la tanda de masa de la que
  // salió. La existencia real del id se valida en server.js (necesita DB).
  const produccionIdFinal =
    typeof datos.produccionId === 'string' && datos.produccionId.trim() !== ''
      ? datos.produccionId.trim()
      : null;

  // Valores REALES de esa tanda horneada (lo que de verdad pasó), para
  // comparar contra el objetivo de la receta. Todos opcionales: no todas
  // las horneadas necesitan este nivel de detalle.
  let temperaturaHorneadoRealC = null;
  if (
    datos.temperaturaHorneadoRealC !== undefined &&
    datos.temperaturaHorneadoRealC !== null &&
    datos.temperaturaHorneadoRealC !== ''
  ) {
    const val = Number(datos.temperaturaHorneadoRealC);
    if (!Number.isFinite(val) || val <= 0 || val > MAX_TEMPERATURA_HORNEADO_C) {
      throw new ValidationError('Temperatura de horneado real inválida.');
    }
    temperaturaHorneadoRealC = val;
  }

  let tiempoHorneadoRealMin = null;
  if (
    datos.tiempoHorneadoRealMin !== undefined &&
    datos.tiempoHorneadoRealMin !== null &&
    datos.tiempoHorneadoRealMin !== ''
  ) {
    const val = Number(datos.tiempoHorneadoRealMin);
    if (!Number.isInteger(val) || val <= 0 || val > MAX_TIEMPO_HORNEADO_MIN) {
      throw new ValidationError('Tiempo de horneado real inválido.');
    }
    tiempoHorneadoRealMin = val;
  }

  let mermaRealPct = null;
  if (
    datos.mermaRealPct !== undefined &&
    datos.mermaRealPct !== null &&
    datos.mermaRealPct !== ''
  ) {
    const val = Number(datos.mermaRealPct);
    if (!Number.isFinite(val) || val < 0 || val > MAX_MERMA_PCT) {
      throw new ValidationError('Porcentaje de merma real inválido.');
    }
    mermaRealPct = val;
  }

  return {
    productoId: String(Number(productoId)),
    productoNombre,
    cantidad: cantidadNum,
    fecha,
    hora,
    registradoPor: registradoPorFinal,
    notas: notasFinal,
    produccionId: produccionIdFinal,
    temperaturaHorneadoRealC,
    tiempoHorneadoRealMin,
    mermaRealPct,
  };
}

/**
 * Valida y sanea un ajuste de inventario (merma, error de conteo, etc.)
 * tal como lo envía admin.js. Mismo patrón que validarHorneada: producto
 * contra la whitelist del catálogo, cantidad entera positiva, motivo
 * contra una lista blanca en vez de texto libre.
 * @param {*} datos
 * @returns {object} ajuste saneado
 */
function validarAjusteInventario(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }

  const { productoId, cantidad, motivo, fecha, hora } = datos;

  const productoAjuste = obtenerProducto(Number(productoId));
  if (!productoAjuste) {
    throw new ValidationError('Producto inválido.');
  }
  const productoNombre = productoAjuste.nombre;

  const cantidadNum = Number(cantidad);
  if (!Number.isInteger(cantidadNum) || cantidadNum <= 0 || cantidadNum > MAX_AJUSTE_CANTIDAD) {
    throw new ValidationError('Cantidad de ajuste inválida.');
  }

  if (!MOTIVOS_AJUSTE.includes(motivo)) {
    throw new ValidationError('Motivo de ajuste inválido.');
  }

  if (typeof fecha !== 'string' || !FECHA_RE.test(fecha)) {
    throw new ValidationError('Fecha de ajuste inválida.');
  }
  if (typeof hora !== 'string' || !HORA_RE.test(hora)) {
    throw new ValidationError('Hora de ajuste inválida.');
  }

  const notasFinal =
    typeof datos.notas === 'string' ? datos.notas.trim().slice(0, MAX_AJUSTE_NOTAS_LEN) : '';
  const registradoPorFinal =
    typeof datos.registradoPor === 'string'
      ? datos.registradoPor.trim().slice(0, MAX_AJUSTE_REGISTRADO_POR_LEN)
      : '';

  return {
    productoId: String(Number(productoId)),
    productoNombre,
    cantidad: cantidadNum,
    motivo,
    fecha,
    hora,
    registradoPor: registradoPorFinal,
    notas: notasFinal,
  };
}

/**
 * Valida el stock mínimo configurable de un producto (alertas de quiebre
 * de stock en Inventario).
 * @param {*} datos
 * @returns {object} { stockMinimo }
 */
function validarStockMinimo(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }
  const stockMinimoNum = Number(datos.stockMinimo);
  if (
    !Number.isInteger(stockMinimoNum) ||
    stockMinimoNum < 0 ||
    stockMinimoNum > MAX_STOCK_MINIMO
  ) {
    throw new ValidationError('Stock mínimo inválido.');
  }
  return { stockMinimo: stockMinimoNum };
}

const RECETA_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const PRODUCCION_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const ETAPA_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const MAX_PESO_G = 100000; // 100kg: tope generoso para una sola tanda de masa
const MAX_INGREDIENTES = 30;
const MAX_TIEMPO_FERMENTACION_MIN = 1440; // 24h, tope defensivo
const MAX_TIEMPO_MANO_OBRA_MIN = 1440; // 24h, tope defensivo
const MAX_RECETA_PASOS_LEN = 2000;

/* Las 8 etapas del proceso de producción (pesado → segunda fermentación).
   La 9na etapa (horneado) la cubre la tabla horneadas, ligada por
   produccion_id — no forma parte de este whitelist. */
const ETAPAS_PRODUCCION = [
  'pesado_dosificacion',
  'amasado',
  'primera_fermentacion',
  'division_pesado',
  'preformado',
  'reposo_mesa',
  'formado_definitivo',
  'segunda_fermentacion',
];

function validarIngredienteLista(ingredientes) {
  if (!Array.isArray(ingredientes) || ingredientes.length === 0) {
    throw new ValidationError('La receta debe tener al menos un ingrediente.');
  }
  if (ingredientes.length > MAX_INGREDIENTES) {
    throw new ValidationError(`No puede haber más de ${MAX_INGREDIENTES} ingredientes.`);
  }

  return ingredientes.map((ing, idx) => {
    if (!ing || typeof ing !== 'object') {
      throw new ValidationError(`Ingrediente #${idx}: se esperaba un objeto.`);
    }
    const insumoId = typeof ing.insumoId === 'string' ? ing.insumoId.trim() : '';
    if (!insumoId) {
      throw new ValidationError(`Ingrediente #${idx}: falta el insumo.`);
    }
    const gramos = Number(ing.gramos);
    if (!Number.isFinite(gramos) || gramos <= 0) {
      throw new ValidationError(`Ingrediente #${idx}: gramos inválido.`);
    }
    if (gramos > MAX_PESO_G) {
      throw new ValidationError(`Ingrediente #${idx}: gramos fuera de rango.`);
    }
    return { insumoId, gramos };
  });
}

/**
 * Valida la ficha técnica (receta) de un producto: peso de masa por unidad
 * y la lista de ingredientes con el peso en gramos de cada uno. No valida que
 * cada insumoId exista de verdad en el catálogo de Insumos — eso requiere
 * la base de datos, así que lo hace server.js al momento de guardar.
 * @param {*} datos
 * @returns {object} receta saneada
 */
function validarReceta(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }

  const producto = obtenerProducto(Number(datos.productoId));
  if (!producto) {
    throw new ValidationError('Producto inválido.');
  }
  const productoNombre = producto.nombre;

  const pesoMasaPorUnidadG = Number(datos.pesoMasaPorUnidadG);
  if (
    !Number.isFinite(pesoMasaPorUnidadG) ||
    pesoMasaPorUnidadG <= 0 ||
    pesoMasaPorUnidadG > MAX_PESO_G
  ) {
    throw new ValidationError('Peso de masa por unidad inválido.');
  }

  let tiempoFermentacionMin = null;
  if (
    datos.tiempoFermentacionMin !== undefined &&
    datos.tiempoFermentacionMin !== null &&
    datos.tiempoFermentacionMin !== ''
  ) {
    const val = Number(datos.tiempoFermentacionMin);
    if (!Number.isInteger(val) || val <= 0 || val > MAX_TIEMPO_FERMENTACION_MIN) {
      throw new ValidationError('Tiempo de fermentación inválido.');
    }
    tiempoFermentacionMin = val;
  }

  // Valores OBJETIVO de la ficha técnica (igual que tu hoja de Excel).
  // Todos opcionales: una receta puede guardarse sin ficha completa y
  // rellenarse después.
  let tiempoHorneadoMin = null;
  if (
    datos.tiempoHorneadoMin !== undefined &&
    datos.tiempoHorneadoMin !== null &&
    datos.tiempoHorneadoMin !== ''
  ) {
    const val = Number(datos.tiempoHorneadoMin);
    if (!Number.isInteger(val) || val <= 0 || val > MAX_TIEMPO_HORNEADO_MIN) {
      throw new ValidationError('Tiempo de horneado inválido.');
    }
    tiempoHorneadoMin = val;
  }

  let temperaturaHorneadoC = null;
  if (
    datos.temperaturaHorneadoC !== undefined &&
    datos.temperaturaHorneadoC !== null &&
    datos.temperaturaHorneadoC !== ''
  ) {
    const val = Number(datos.temperaturaHorneadoC);
    if (!Number.isFinite(val) || val <= 0 || val > MAX_TEMPERATURA_HORNEADO_C) {
      throw new ValidationError('Temperatura de horneado inválida.');
    }
    temperaturaHorneadoC = val;
  }

  let tiempoManoObraMin = null;
  if (
    datos.tiempoManoObraMin !== undefined &&
    datos.tiempoManoObraMin !== null &&
    datos.tiempoManoObraMin !== ''
  ) {
    const val = Number(datos.tiempoManoObraMin);
    if (!Number.isInteger(val) || val <= 0 || val > MAX_TIEMPO_MANO_OBRA_MIN) {
      throw new ValidationError('Tiempo de mano de obra inválido.');
    }
    tiempoManoObraMin = val;
  }

  let mermaCoccionPct = null;
  if (
    datos.mermaCoccionPct !== undefined &&
    datos.mermaCoccionPct !== null &&
    datos.mermaCoccionPct !== ''
  ) {
    const val = Number(datos.mermaCoccionPct);
    if (!Number.isFinite(val) || val < 0 || val > MAX_MERMA_PCT) {
      throw new ValidationError('Porcentaje de merma de cocción inválido.');
    }
    mermaCoccionPct = val;
  }

  const pasos =
    typeof datos.pasos === 'string' ? datos.pasos.trim().slice(0, MAX_RECETA_PASOS_LEN) : '';

  const ingredientes = validarIngredienteLista(datos.ingredientes);

  const notas = typeof datos.notas === 'string' ? datos.notas.trim().slice(0, 280) : '';

  return {
    productoId: String(Number(datos.productoId)),
    productoNombre,
    categoria: producto.categoria,
    pesoMasaPorUnidadG,
    tiempoFermentacionMin,
    tiempoHorneadoMin,
    temperaturaHorneadoC,
    tiempoManoObraMin,
    mermaCoccionPct,
    pasos,
    ingredientes,
    notas,
  };
}

/**
 * Valida el registro de una tanda de producción (Producción): producto,
 * fecha/hora de inicio, y los gramos reales de cada ingrediente usados en
 * esa tanda (pueden diferir de la receta base). El peso total de masa y las
 * unidades estimadas los calcula server.js con la receta guardada, no se
 * confía en lo que mande el cliente para esos dos números.
 * @param {*} datos
 * @returns {object} producción saneada
 */
function validarProduccion(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }

  const productoProduccion = obtenerProducto(Number(datos.productoId));
  if (!productoProduccion) {
    throw new ValidationError('Producto inválido.');
  }
  const productoNombre = productoProduccion.nombre;

  if (typeof datos.fecha !== 'string' || !FECHA_RE.test(datos.fecha)) {
    throw new ValidationError('Fecha de producción inválida.');
  }
  if (typeof datos.horaInicio !== 'string' || !HORA_RE.test(datos.horaInicio)) {
    throw new ValidationError('Hora de inicio inválida.');
  }

  const ingredientes = validarIngredienteLista(datos.ingredientes);

  const registradoPor =
    typeof datos.registradoPor === 'string' ? datos.registradoPor.trim().slice(0, 80) : '';
  const notas = typeof datos.notas === 'string' ? datos.notas.trim().slice(0, 280) : '';

  // Mano de obra REAL de la tanda (etapas 1-8), opcional — para comparar
  // contra el tiempoManoObraMin objetivo que vive en la receta.
  let tiempoManoObraRealMin = null;
  if (
    datos.tiempoManoObraRealMin !== undefined &&
    datos.tiempoManoObraRealMin !== null &&
    datos.tiempoManoObraRealMin !== ''
  ) {
    const val = Number(datos.tiempoManoObraRealMin);
    if (!Number.isInteger(val) || val <= 0 || val > MAX_TIEMPO_MANO_OBRA_MIN) {
      throw new ValidationError('Tiempo de mano de obra real inválido.');
    }
    tiempoManoObraRealMin = val;
  }

  return {
    productoId: String(Number(datos.productoId)),
    productoNombre,
    fecha: datos.fecha,
    horaInicio: datos.horaInicio,
    ingredientes,
    registradoPor,
    notas,
    tiempoManoObraRealMin,
  };
}

/** Valida el inicio de una etapa del proceso (POST .../etapas). */
function validarInicioEtapa(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }
  if (!ETAPAS_PRODUCCION.includes(datos.etapa)) {
    throw new ValidationError('Etapa inválida.');
  }
  if (typeof datos.horaInicio !== 'string' || !HORA_RE.test(datos.horaInicio)) {
    throw new ValidationError('Hora de inicio inválida.');
  }
  const notas = typeof datos.notas === 'string' ? datos.notas.trim().slice(0, 280) : '';
  return { etapa: datos.etapa, horaInicio: datos.horaInicio, notas };
}

/** Valida el cierre de una etapa ya iniciada (PUT .../etapas/:id). */
function validarFinEtapa(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }
  if (typeof datos.horaFin !== 'string' || !HORA_RE.test(datos.horaFin)) {
    throw new ValidationError('Hora de fin inválida.');
  }
  const notas = typeof datos.notas === 'string' ? datos.notas.trim().slice(0, 280) : '';
  return { horaFin: datos.horaFin, notas };
}

/* ═══════════════════════════════════════════
   ÓRDENES DE COMPRA
   ═══════════════════════════════════════════
   Ver docs/modelo-ordenes-compra.md. Igual que validarReceta, estas
   funciones NO tocan la base de datos para comprobar que el proveedor y
   los insumos existan: eso lo cruza server.js al guardar, que es quien
   además calcula los totales (nunca se confía en los que mande el
   cliente). */
const ORDEN_COMPRA_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const NUMERO_ORDEN_COMPRA_RE = /^OC-\d{8}-\d{4}$/;
const MAX_OC_ITEMS = 60;
const MAX_OC_CANTIDAD = 999999;
const MAX_OC_COSTO = 999999;
const MAX_OC_FLETE = 9999999;
const MAX_OC_TEXTO_LEN = 120;
const MAX_OC_LARGO_LEN = 500;
const MAX_OC_TEMPERATURA_C = 100;
const MIN_OC_TEMPERATURA_C = -50;

/* Ciclo de vida de una orden de compra. `recibida_parcial` y `recibida`
   NO son transiciones manuales: las fija el servidor al comparar lo
   recibido contra lo pedido después de cada recepción — por eso no
   aparecen como destino de ninguna transición manual acá. */
const OC_ESTADOS = [
  'borrador',
  'emitida',
  'confirmada',
  'recibida_parcial',
  'recibida',
  'cerrada',
  'cancelada',
];

const OC_TRANSICIONES = Object.freeze({
  borrador: ['emitida', 'cancelada'],
  emitida: ['confirmada', 'cancelada'],
  confirmada: ['cancelada'],
  recibida_parcial: ['cancelada'],
  recibida: ['cerrada'],
  cerrada: [],
  cancelada: [],
});

/** Estados en los que la orden todavía admite recepciones de mercancía. */
const OC_ESTADOS_RECEPCION = ['emitida', 'confirmada', 'recibida_parcial'];

function textoOC(valor, max = MAX_OC_TEXTO_LEN) {
  return typeof valor === 'string' ? valor.trim().slice(0, max) : '';
}

function numeroOC(valor, max, campo, { permitirCero = true } = {}) {
  const num = Number(valor);
  if (!Number.isFinite(num) || num < 0 || num > max || (!permitirCero && num === 0)) {
    throw new ValidationError(`${campo} inválido.`);
  }
  return num;
}

/** Valida las líneas de una orden de compra (una por insumo). */
function validarItemsOrdenCompra(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('La orden de compra debe tener al menos un insumo.');
  }
  if (items.length > MAX_OC_ITEMS) {
    throw new ValidationError(`Una orden de compra no puede tener más de ${MAX_OC_ITEMS} líneas.`);
  }

  const insumosVistos = new Set();

  return items.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new ValidationError(`Línea #${idx + 1}: se esperaba un objeto.`);
    }
    const insumoId = textoOC(item.insumoId, 64);
    if (!insumoId) {
      throw new ValidationError(`Línea #${idx + 1}: falta el insumo.`);
    }
    if (insumosVistos.has(insumoId)) {
      throw new ValidationError(
        `Línea #${idx + 1}: el insumo está repetido. Súmalo en una sola línea.`,
      );
    }
    insumosVistos.add(insumoId);

    const cantidadPedida = numeroOC(
      item.cantidadPedida,
      MAX_OC_CANTIDAD,
      `Línea #${idx + 1}: cantidad`,
      { permitirCero: false },
    );
    const costoUnitario = numeroOC(
      item.costoUnitario,
      MAX_OC_COSTO,
      `Línea #${idx + 1}: costo unitario`,
    );
    const impuestoPorcentaje = numeroOC(
      item.impuestoPorcentaje ?? 0,
      100,
      `Línea #${idx + 1}: impuesto`,
    );
    const descuentoPorcentaje = numeroOC(
      item.descuentoPorcentaje ?? 0,
      100,
      `Línea #${idx + 1}: descuento`,
    );

    if (!UNIDADES_INSUMO.includes(item.unidad)) {
      throw new ValidationError(`Línea #${idx + 1}: unidad inválida.`);
    }

    return {
      insumoId,
      cantidadPedida,
      unidad: item.unidad,
      costoUnitario,
      impuestoPorcentaje,
      descuentoPorcentaje,
      notas: textoOC(item.notas, 280),
    };
  });
}

/**
 * Valida la cabecera y el detalle de una orden de compra tal como los
 * envía admin.js. Los totales no se leen del cuerpo: se recalculan en
 * server.js a partir de las líneas ya validadas acá.
 * @param {*} datos
 * @returns {object} orden de compra saneada (sin totales)
 */
function validarOrdenCompra(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }

  const proveedorId = textoOC(datos.proveedorId, 64);
  if (!proveedorId) {
    throw new ValidationError('Proveedor inválido.');
  }

  if (typeof datos.fechaEmision !== 'string' || !FECHA_RE.test(datos.fechaEmision)) {
    throw new ValidationError('Fecha de emisión inválida.');
  }

  let fechaEntregaEstimada = null;
  if (datos.fechaEntregaEstimada) {
    if (
      typeof datos.fechaEntregaEstimada !== 'string' ||
      !FECHA_RE.test(datos.fechaEntregaEstimada)
    ) {
      throw new ValidationError('Fecha de entrega estimada inválida.');
    }
    if (datos.fechaEntregaEstimada < datos.fechaEmision) {
      throw new ValidationError('La entrega estimada no puede ser anterior a la emisión.');
    }
    fechaEntregaEstimada = datos.fechaEntregaEstimada;
  }

  if (!CONDICIONES_PAGO.includes(datos.condicionesPago)) {
    throw new ValidationError('Condiciones de pago inválidas.');
  }
  if (!MONEDAS_PROVEEDOR.includes(datos.moneda)) {
    throw new ValidationError('Moneda inválida.');
  }

  const flete = numeroOC(datos.flete ?? 0, MAX_OC_FLETE, 'Flete');
  const items = validarItemsOrdenCompra(datos.items);

  return {
    proveedorId,
    fechaEmision: datos.fechaEmision,
    fechaEntregaEstimada,
    condicionesPago: datos.condicionesPago,
    moneda: datos.moneda,
    flete,
    solicitadoPor: textoOC(datos.solicitadoPor, 80),
    lugarEntrega: textoOC(datos.lugarEntrega, MAX_OC_LARGO_LEN),
    notas: textoOC(datos.notas, MAX_OC_LARGO_LEN),
    items,
  };
}

/**
 * Valida una transición manual de estado. El motivo solo es obligatorio
 * al cancelar: una orden anulada sin explicación no sirve para auditar.
 * @param {*} datos
 * @param {string} estadoActual
 */
function validarCambioEstadoOrdenCompra(datos, estadoActual) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }
  if (!OC_ESTADOS.includes(datos.estado)) {
    throw new ValidationError('Estado de orden de compra inválido.');
  }
  const permitidos = OC_TRANSICIONES[estadoActual] ?? [];
  if (!permitidos.includes(datos.estado)) {
    throw new ValidationError(`No se puede pasar de "${estadoActual}" a "${datos.estado}".`);
  }

  const motivo = textoOC(datos.motivo, MAX_OC_LARGO_LEN);
  if (datos.estado === 'cancelada' && motivo === '') {
    throw new ValidationError('Indica el motivo de la cancelación.');
  }

  return {
    estado: datos.estado,
    usuario: textoOC(datos.usuario, 80),
    motivo,
  };
}

/**
 * Valida una recepción de mercancía: cabecera del documento (fecha, hora,
 * quién recibió, remisión) y las líneas efectivamente entregadas. No
 * comprueba que las cantidades quepan en lo pendiente de cada ítem — eso
 * necesita la orden guardada, así que lo hace server.js.
 * @param {*} datos
 * @returns {object} recepción saneada
 */
function validarRecepcionOrdenCompra(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }

  if (typeof datos.fecha !== 'string' || !FECHA_RE.test(datos.fecha)) {
    throw new ValidationError('Fecha de recepción inválida.');
  }
  if (typeof datos.hora !== 'string' || !HORA_RE.test(datos.hora)) {
    throw new ValidationError('Hora de recepción inválida.');
  }

  if (!Array.isArray(datos.items) || datos.items.length === 0) {
    throw new ValidationError('La recepción debe tener al menos una línea.');
  }
  if (datos.items.length > MAX_OC_ITEMS) {
    throw new ValidationError(`Una recepción no puede tener más de ${MAX_OC_ITEMS} líneas.`);
  }

  const items = datos.items.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new ValidationError(`Línea #${idx + 1}: se esperaba un objeto.`);
    }
    const itemId = textoOC(item.itemId, 64);
    if (!itemId) {
      throw new ValidationError(`Línea #${idx + 1}: falta la línea de la orden.`);
    }

    const cantidadRecibida = numeroOC(
      item.cantidadRecibida ?? 0,
      MAX_OC_CANTIDAD,
      `Línea #${idx + 1}: cantidad recibida`,
    );
    const cantidadRechazada = numeroOC(
      item.cantidadRechazada ?? 0,
      MAX_OC_CANTIDAD,
      `Línea #${idx + 1}: cantidad rechazada`,
    );
    if (cantidadRecibida === 0 && cantidadRechazada === 0) {
      throw new ValidationError(`Línea #${idx + 1}: no registra ni recibido ni rechazado.`);
    }

    const motivoRechazo = textoOC(item.motivoRechazo, 280);
    if (cantidadRechazada > 0 && motivoRechazo === '') {
      throw new ValidationError(`Línea #${idx + 1}: indica el motivo del rechazo.`);
    }

    let fechaVencimiento = null;
    if (item.fechaVencimiento) {
      if (typeof item.fechaVencimiento !== 'string' || !FECHA_RE.test(item.fechaVencimiento)) {
        throw new ValidationError(`Línea #${idx + 1}: fecha de vencimiento inválida.`);
      }
      fechaVencimiento = item.fechaVencimiento;
    }

    let temperaturaRecepcionC = null;
    if (
      item.temperaturaRecepcionC !== undefined &&
      item.temperaturaRecepcionC !== null &&
      item.temperaturaRecepcionC !== ''
    ) {
      const val = Number(item.temperaturaRecepcionC);
      if (!Number.isFinite(val) || val < MIN_OC_TEMPERATURA_C || val > MAX_OC_TEMPERATURA_C) {
        throw new ValidationError(`Línea #${idx + 1}: temperatura de recepción inválida.`);
      }
      temperaturaRecepcionC = val;
    }

    return {
      itemId,
      cantidadRecibida,
      cantidadRechazada,
      motivoRechazo,
      loteProveedor: textoOC(item.loteProveedor, 80),
      fechaVencimiento,
      temperaturaRecepcionC,
      notas: textoOC(item.notas, 280),
    };
  });

  return {
    fecha: datos.fecha,
    hora: datos.hora,
    recibidoPor: textoOC(datos.recibidoPor, 80),
    documentoReferencia: textoOC(datos.documentoReferencia, 80),
    notas: textoOC(datos.notas, MAX_OC_LARGO_LEN),
    items,
  };
}

module.exports = {
  validarOrden,
  ValidationError,
  NUMERO_ORDEN_RE,
  ORDER_STATES,
  validarInsumo,
  INSUMO_ID_RE,
  CATEGORIAS_INSUMO,
  ALERGENOS_INSUMO,
  UNIDADES_INSUMO,
  validarProveedor,
  PROVEEDOR_ID_RE,
  CONDICIONES_PAGO,
  MONEDAS_PROVEEDOR,
  validarHorneada,
  HORNEADA_ID_RE,
  obtenerProducto,
  validarProducto,
  CATEGORIAS_PRODUCTO,
  ESTADOS_PRODUCTO,
  validarAjusteInventario,
  AJUSTE_ID_RE,
  MOTIVOS_AJUSTE,
  validarStockMinimo,
  validarReceta,
  RECETA_ID_RE,
  validarProduccion,
  PRODUCCION_ID_RE,
  validarInicioEtapa,
  validarFinEtapa,
  ETAPAS_PRODUCCION,
  ETAPA_ID_RE,
  validarOrdenCompra,
  validarCambioEstadoOrdenCompra,
  validarRecepcionOrdenCompra,
  ORDEN_COMPRA_ID_RE,
  NUMERO_ORDEN_COMPRA_RE,
  OC_ESTADOS,
  OC_TRANSICIONES,
  OC_ESTADOS_RECEPCION,
};

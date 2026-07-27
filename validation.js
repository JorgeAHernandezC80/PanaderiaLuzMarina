/**
 * PANADERÍA LUZ MARINA — Backend: Validación
 * Mismo criterio de blindaje aplicado en cart.js (frontend):
 * nunca confiar en lo que llega del cliente, validar tipo, rango y longitud.
 */

const MAX_ITEMS = 50;
const MAX_NOMBRE_LEN = 120;
const MAX_CLIENTE_LEN = 80;
const MAX_PRECIO = 1000;
const MAX_TOTAL = 50000;
const NUMERO_ORDEN_RE = /^LM-\d{8}-\d{4}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const ORDER_STATES = ['pendiente', 'preparada'];

const MAX_INSUMO_NOMBRE_LEN = 120;
const MAX_INSUMO_PROVEEDOR_LEN = 120;
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
const UNIDADES_INSUMO = ['kg', 'g', 'l', 'ml', 'unidad', 'paquete', 'caja'];

const MAX_PROV_NOMBRE_LEN = 150;
const MAX_PROV_CORTO_LEN = 120;
const MAX_PROV_DIRECCION_LEN = 250;
const MAX_PROV_EMAIL_LEN = 150;
const MAX_PROV_TELEFONO_LEN = 30;
const MAX_PROV_CUENTA_LEN = 60;
const MAX_PROV_TEXTO_LARGO_LEN = 500;
const MAX_PROV_LEAD_TIME = 365;
const MAX_PROV_PEDIDO_MINIMO = 999999;
const PROVEEDOR_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

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

  const { nombre, categoria, cantidad, unidad, costoUnitario, stockMinimo, proveedor, notas } =
    datos;

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

  const proveedorFinal =
    typeof proveedor === 'string' ? proveedor.trim().slice(0, MAX_INSUMO_PROVEEDOR_LEN) : '';
  const notasFinal = typeof notas === 'string' ? notas.trim().slice(0, MAX_INSUMO_NOTAS_LEN) : '';

  return {
    nombre: nombre.trim(),
    categoria: categoriaFinal,
    cantidad: cantidadNum,
    unidad,
    costoUnitario: costoFinal,
    stockMinimo: stockMinFinal,
    proveedor: proveedorFinal,
    notas: notasFinal,
  };
}

/** Recorta un string opcional a un largo máximo; nunca confía en el tipo recibido. */
function texto(valor, maxLen) {
  return typeof valor === 'string' ? valor.trim().slice(0, maxLen) : '';
}

/**
 * Valida y sanea los datos de un proveedor tal como los envía admin.js.
 * Solo nombreLegal es obligatorio (es el único dato indispensable para
 * poder identificar al proveedor); el resto son campos opcionales de los
 * 4 bloques: identificación legal, contacto, financiero/facturación y
 * operativo/logística. Todo texto libre se recorta a un largo máximo
 * antes de tocar la base de datos.
 * @param {*} datos
 * @returns {object} proveedor saneado
 */
function validarProveedor(datos) {
  if (!datos || typeof datos !== 'object') {
    throw new ValidationError('Cuerpo de la petición inválido.');
  }

  const { nombreLegal, leadTimeDias, pedidoMinimo } = datos;

  if (
    typeof nombreLegal !== 'string' ||
    nombreLegal.trim() === '' ||
    nombreLegal.length > MAX_PROV_NOMBRE_LEN
  ) {
    throw new ValidationError('El nombre o razón social del proveedor es obligatorio.');
  }

  let leadTimeFinal = null;
  if (leadTimeDias !== null && leadTimeDias !== undefined && leadTimeDias !== '') {
    const leadTimeNum = Number(leadTimeDias);
    if (!Number.isFinite(leadTimeNum) || leadTimeNum < 0 || leadTimeNum > MAX_PROV_LEAD_TIME) {
      throw new ValidationError('Tiempo de entrega (lead time) inválido.');
    }
    leadTimeFinal = leadTimeNum;
  }

  let pedidoMinimoFinal = null;
  if (pedidoMinimo !== null && pedidoMinimo !== undefined && pedidoMinimo !== '') {
    const pedidoMinimoNum = Number(pedidoMinimo);
    if (
      !Number.isFinite(pedidoMinimoNum) ||
      pedidoMinimoNum < 0 ||
      pedidoMinimoNum > MAX_PROV_PEDIDO_MINIMO
    ) {
      throw new ValidationError('Pedido mínimo inválido.');
    }
    pedidoMinimoFinal = pedidoMinimoNum;
  }

  return {
    nombreLegal: nombreLegal.trim(),
    nombreComercial: texto(datos.nombreComercial, MAX_PROV_CORTO_LEN),
    identificacionFiscal: texto(datos.identificacionFiscal, MAX_PROV_CORTO_LEN),
    giroComercial: texto(datos.giroComercial, MAX_PROV_CORTO_LEN),
    direccion: texto(datos.direccion, MAX_PROV_DIRECCION_LEN),
    contactoNombre: texto(datos.contactoNombre, MAX_PROV_CORTO_LEN),
    contactoCargo: texto(datos.contactoCargo, MAX_PROV_CORTO_LEN),
    emailGeneral: texto(datos.emailGeneral, MAX_PROV_EMAIL_LEN),
    emailContacto: texto(datos.emailContacto, MAX_PROV_EMAIL_LEN),
    telefonoEmpresa: texto(datos.telefonoEmpresa, MAX_PROV_TELEFONO_LEN),
    telefonoCelular: texto(datos.telefonoCelular, MAX_PROV_TELEFONO_LEN),
    banco: texto(datos.banco, MAX_PROV_CORTO_LEN),
    numeroCuenta: texto(datos.numeroCuenta, MAX_PROV_CUENTA_LEN),
    clabeIban: texto(datos.clabeIban, MAX_PROV_CUENTA_LEN),
    condicionesPago: texto(datos.condicionesPago, MAX_PROV_CORTO_LEN),
    moneda: texto(datos.moneda, 10),
    metodoFacturacion: texto(datos.metodoFacturacion, MAX_PROV_TEXTO_LARGO_LEN),
    leadTimeDias: leadTimeFinal,
    pedidoMinimo: pedidoMinimoFinal,
    politicasDevolucion: texto(datos.politicasDevolucion, MAX_PROV_TEXTO_LARGO_LEN),
    certificaciones: texto(datos.certificaciones, MAX_PROV_TEXTO_LARGO_LEN),
    notas: texto(datos.notas, MAX_PROV_TEXTO_LARGO_LEN),
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
  UNIDADES_INSUMO,
  validarProveedor,
  PROVEEDOR_ID_RE,
};

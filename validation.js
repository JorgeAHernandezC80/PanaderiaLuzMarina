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

const MAX_PROVEEDOR_TEXTO_LEN = 120;
const MAX_PROVEEDOR_LARGO_LEN = 500;
const MAX_PROVEEDOR_LEAD_TIME = 365;
const MAX_PROVEEDOR_PEDIDO_MINIMO = 99999999;
const PROVEEDOR_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const CONDICIONES_PAGO = ['contado', 'credito_30', 'credito_60', 'credito_90'];
const MONEDAS_PROVEEDOR = ['COP', 'MXN', 'USD', 'EUR', 'CLP', 'ARS'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
  CONDICIONES_PAGO,
  MONEDAS_PROVEEDOR,
};

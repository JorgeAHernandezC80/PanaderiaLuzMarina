/**
 * Panel Admin · Panadería Luz Marina
 * Organización: Configuración → Auth → API → Render → App
 */

import { escapeHTML } from '../core/cart.js';
import { formatPrice, pluralizeEs } from '../core/format.js';
import { API_BASE, apiFetch } from '../core/api.js';
import { initTheme } from '../core/theme.js';

/* Zona horaria de referencia del negocio (Houston). Todo lo que necesite
   "la fecha de hoy" debe pasar por hoyHouston(), nunca por
   new Date().toISOString().slice(0, 10) — ese método da la fecha en UTC,
   que se adelanta un día por las noches (Houston va 5-6h detrás de UTC). */
const HOUSTON_TZ = 'America/Chicago';

function hoyHouston() {
  return new Date().toLocaleDateString('en-CA', { timeZone: HOUSTON_TZ });
}

/** "HH:MM" de ahora mismo en hora de Houston — mismo criterio que
 *  hoyHouston(), para comparar contra `retiro` (que también es hora de
 *  Houston, no UTC) al calcular pedidos retrasados. */
function ahoraHoraHouston() {
  return new Date()
    .toLocaleTimeString('en-GB', { timeZone: HOUSTON_TZ, hour12: false })
    .slice(0, 5);
}

/** Índice de día de la semana (0=domingo … 6=sábado, mismo criterio que
 *  Date#getDay()) de "mañana" en hora de Houston — para elegir qué
 *  factorEstacionalidad usar en la sugerencia de cuánto hornear (ver
 *  GET /productos/estadisticas y Render.renderSugerenciasHorneado). */
function diaSemanaMananaHouston() {
  const [y, m, d] = hoyHouston().split('-').map(Number);
  const manana = new Date(Date.UTC(y, m - 1, d));
  manana.setUTCDate(manana.getUTCDate() + 1);
  return manana.getUTCDay();
}

const DIAS_SEMANA_LABELS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
];

/** Suma minutos a una hora "HH:MM" (sin cruzar más de un día — de sobra
 *  para el margen de espera de retiro, que son 15 min). */
function sumarMinutosAHora(horaHHMM, minutos) {
  const [h, m] = horaHHMM.split(':').map(Number);
  const total = h * 60 + m + minutos;
  const hh = String(Math.floor((total % 1440) / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/* Ciclo de vida de una orden: Recibida → En Preparación → Preparada →
   Entregada. El valor interno (clave) es el que viaja al backend en
   `estado`; `label` y `siguiente` (próximo estado + texto del botón de
   avance) son solo para la UI del panel admin. `entregada` es terminal:
   no tiene `siguiente`. */
const ORDER_STATE_FLOW = {
  pendiente: { label: 'Recibida', siguiente: 'en_preparacion', accion: 'Marcar en preparación' },
  en_preparacion: { label: 'En preparación', siguiente: 'preparada', accion: 'Marcar preparada' },
  preparada: { label: 'Preparada', siguiente: 'entregada', accion: 'Marcar entregada' },
  entregada: { label: 'Entregada', siguiente: null, accion: null },
};

/* Etiquetas legibles para el motivo de un ajuste de inventario (el valor
   interno, en snake_case, es el que viaja al backend). */
const MOTIVO_AJUSTE_LABELS = {
  merma: 'Merma',
  error_conteo: 'Error de conteo',
  consumo_interno: 'Consumo interno',
  otro: 'Otro',
};

/* Las 8 etapas de Producción (pesado → segunda fermentación), en el mismo
   orden y con las mismas claves internas que ETAPAS_PRODUCCION en
   validation.js. La 9na etapa (horneado) la cubre Horneadas. */
/* Las 8 etapas de Producción (pesado → segunda fermentación), más
   autólisis (opcional, antes del amasado) y retardación en frío
   (opcional, después de la segunda fermentación) — mismo orden y mismas
   claves internas que ETAPAS_PRODUCCION en validation.js. La 9na etapa
   fija (horneado) la cubre Horneadas. */
const ETAPAS_PRODUCCION_LABELS = {
  pesado_dosificacion: 'Pesado y Dosificación',
  autolisis: 'Autólisis',
  amasado: 'Amasado',
  primera_fermentacion: 'Primera Fermentación',
  division_pesado: 'División y Pesado',
  preformado: 'Preformado',
  reposo_mesa: 'Reposo en Mesa',
  formado_definitivo: 'Formado Definitivo',
  segunda_fermentacion: 'Segunda Fermentación',
  retardacion_frio: 'Retardación en Frío',
};
const ETAPAS_PRODUCCION_ORDEN = Object.keys(ETAPAS_PRODUCCION_LABELS);

/* ═══════════════════════════════════════════
   1. CONFIGURACIÓN
   ═══════════════════════════════════════════ */
const CONFIG = Object.freeze({
  SESSION_KEY: 'plm_admin_session',
  TOKEN_KEY: 'plm_admin_token', // token recibido del backend tras autenticación
  SELECTORS: {
    loginView: '#login-view',
    dashboardView: '#dashboard-view',
    loginForm: '#login-form',
    password: '#password',
    loginError: '#login-error',
    loginErrorMsg: '#login-error [data-login-error-msg]',
    logoutBtn: '#btn-logout',
    date: '#dashboard-date',
    statOrdenes: '#stat-ordenes',
    statIngresos: '#stat-ingresos',
    statPrep: '#stat-preparadas',
    statPend: '#stat-pendientes',
    statEnPreparacion: '#stat-en-preparacion',
    statEntregadas: '#stat-entregadas',
    diagTotal: '#diag-total',
    diagCompletacion: '#diag-completacion',
    diagTiempo: '#diag-tiempo',
    diagRetrasados: '#diag-retrasados',
    diagTbody: '#diagnostico-pedidos-tbody',
    diagVacio: '#diagnostico-pedidos-vacio',
    orders: '#orders-container',
    tplGroup: '#tpl-order-group',
    tplRow: '#tpl-order-row',

    // Nav de secciones
    adminNav: '#admin-nav',
    navBtns: '.admin-nav__btn',

    // Insumos
    insumosView: '#insumos-view',
    insumosCount: '#insumos-count',
    insumosContainer: '#insumos-container',
    tplInsumoRow: '#tpl-insumo-row',

    // Productos
    productosView: '#productos-view',
    productosCount: '#productos-count',
    productosTbody: '#productos-tbody',
    productosVacio: '#productos-vacio',
    productoForm: '#producto-form',
    productoId: '#producto-id',
    productoNombre: '#producto-nombre',
    productoCategoria: '#producto-categoria',
    productoPrecio: '#producto-precio',
    productoEstado: '#producto-estado',
    productoSku: '#producto-sku',
    productoDescripcion: '#producto-descripcion',
    productoImagenBase: '#producto-imagen-base',
    productoAltImagen: '#producto-alt-imagen',
    productoVidaUtil: '#producto-vida-util',
    productoActualizadoPor: '#producto-actualizado-por',
    productoSubmitLabel: '#producto-submit-label',
    productoCancelarEdicion: '#producto-cancelar-edicion',
    productoError: '#producto-error',
    productoErrorMsg: '[data-producto-error-msg]',
    insumoForm: '#insumo-form',
    insumoId: '#insumo-id',
    insumoNombre: '#insumo-nombre',
    insumoCategoria: '#insumo-categoria',
    insumoCantidad: '#insumo-cantidad',
    insumoUnidad: '#insumo-unidad',
    insumoCosto: '#insumo-costo',
    insumoStockMinimo: '#insumo-stock-minimo',
    insumoProveedor: '#insumo-proveedor',
    insumoProveedorSecundario: '#insumo-proveedor-secundario',
    insumoMarca: '#insumo-marca',
    insumoSku: '#insumo-sku',
    insumoStockMaximo: '#insumo-stock-maximo',
    insumoEquivalenciaGramos: '#insumo-equivalencia-gramos',
    insumoPresentacionCompra: '#insumo-presentacion-compra',
    insumoImpuesto: '#insumo-impuesto',
    insumoLeadTime: '#insumo-lead-time',
    insumoCondicionesAlmacenamiento: '#insumo-condiciones-almacenamiento',
    insumoLoteProveedor: '#insumo-lote-proveedor',
    insumoVidaUtilAbierto: '#insumo-vida-util-abierto',
    insumoAlergenos: '#insumo-form [data-component="insumo-alergenos"]',
    insumoFechaVencimiento: '#insumo-fecha-vencimiento',
    insumoUbicacion: '#insumo-ubicacion',
    insumoNotas: '#insumo-notas',
    insumoError: '#insumo-error',
    insumoErrorMsg: '#insumo-error [data-insumo-error-msg]',
    insumoSubmitBtn: '#btn-insumo-submit',
    insumoCancelEditBtn: '#btn-insumo-cancel-edit',

    // Proveedores
    proveedoresView: '#proveedores-view',
    proveedoresCount: '#proveedores-count',
    proveedoresContainer: '#proveedores-container',
    tplProveedorRow: '#tpl-proveedor-row',
    proveedorForm: '#proveedor-form',
    proveedorId: '#proveedor-id',
    proveedorError: '#proveedor-error',
    proveedorErrorMsg: '#proveedor-error [data-proveedor-error-msg]',
    proveedorSubmitBtn: '#btn-proveedor-submit',
    proveedorCancelEditBtn: '#btn-proveedor-cancel-edit',

    // Órdenes de compra
    ordenesCompraView: '#ordenes-compra-view',
    ordenesCompraCount: '#ordenes-compra-count',
    ordenesCompraContainer: '#ordenes-compra-container',
    ocResumen: '#oc-resumen',
    tplOcItemRow: '#tpl-oc-item-row',
    tplOcRecepcionRow: '#tpl-oc-recepcion-row',
    ocForm: '#oc-form',
    ocId: '#oc-id',
    ocProveedor: '#oc-proveedor',
    ocFechaEmision: '#oc-fecha-emision',
    ocFechaEntrega: '#oc-fecha-entrega',
    ocCondicionesPago: '#oc-condiciones-pago',
    ocMoneda: '#oc-moneda',
    ocFlete: '#oc-flete',
    ocSolicitadoPor: '#oc-solicitado-por',
    ocLugarEntrega: '#oc-lugar-entrega',
    ocNotas: '#oc-notas',
    tplOcRow: '#tpl-oc-row',
    btnOcNueva: '#btn-oc-nueva',
    ocNuevaModal: '#oc-nueva-modal',
    ocItemsLista: '#oc-items-lista',
    ocTotales: '#oc-totales',
    btnOcAgregarItem: '#btn-oc-agregar-item',
    ocError: '#oc-error',
    ocErrorMsg: '#oc-error [data-oc-error-msg]',
    ocSubmitBtn: '#btn-oc-submit',
    ocGuardarEmitirBtn: '#btn-oc-guardar-emitir',
    ocFiltroEstado: '#oc-filtro-estado',
    ocFiltroProveedor: '#oc-filtro-proveedor',
    ocFiltroDesde: '#oc-filtro-desde',
    ocFiltroHasta: '#oc-filtro-hasta',
    btnOcFiltrar: '#btn-oc-filtrar',
    btnOcLimpiarFiltros: '#btn-oc-limpiar-filtros',
    ocRecepcionModal: '#oc-recepcion-modal',
    ocRecepcionForm: '#oc-recepcion-form',
    ocRecepcionOrdenId: '#oc-recepcion-orden-id',
    ocRecepcionFecha: '#oc-recepcion-fecha',
    ocRecepcionHora: '#oc-recepcion-hora',
    ocRecepcionRecibidoPor: '#oc-recepcion-recibido-por',
    ocRecepcionDocumento: '#oc-recepcion-documento',
    ocRecepcionLineas: '#oc-recepcion-lineas',
    ocRecepcionError: '#oc-recepcion-error',
    ocRecepcionErrorMsg: '#oc-recepcion-error [data-oc-recepcion-error-msg]',
    ocTrazabilidadModal: '#oc-trazabilidad-modal',
    ocTrazabilidadBody: '#oc-trazabilidad-body',

    // Horneadas
    horneadasView: '#horneadas-view',
    horneadasCount: '#horneadas-count',
    horneadasContainer: '#horneadas-container',
    horneadasResumen: '#horneadas-resumen',
    horneadasSugerencias: '#horneadas-sugerencias',
    productosAutoML: '#productos-automl',
    tplHorneadaRow: '#tpl-horneada-row',
    horneadaForm: '#horneada-form',
    horneadaId: '#horneada-id',
    horneadaProducto: '#horneada-producto',
    horneadaCantidad: '#horneada-cantidad',
    horneadaFecha: '#horneada-fecha',
    horneadaHora: '#horneada-hora',
    horneadaRegistradoPor: '#horneada-registrado-por',
    horneadaNotas: '#horneada-notas',
    horneadaTemperaturaPisoHorno: '#horneada-temperatura-piso-horno',
    horneadaPesoPanCocido: '#horneada-peso-pan-cocido',
    horneadaCostoEnergia: '#horneada-costo-energia',
    horneadaUnidadesSegundaCalidad: '#horneada-unidades-segunda-calidad',
    horneadaTemperaturaReal: '#horneada-temperatura-real',
    horneadaTiempoReal: '#horneada-tiempo-real',
    horneadaMermaReal: '#horneada-merma-real',
    horneadaError: '#horneada-error',
    horneadaErrorMsg: '#horneada-error [data-horneada-error-msg]',
    horneadaSubmitBtn: '#btn-horneada-submit',
    horneadaCancelEditBtn: '#btn-horneada-cancel-edit',
    horneadaFiltroFecha: '#horneada-filtro-fecha',
    btnHorneadaFiltrar: '#btn-horneada-filtrar',
    btnHorneadaHoy: '#btn-horneada-hoy',

    // Inventario
    inventarioView: '#inventario-view',
    inventarioCount: '#inventario-count',
    inventarioContainer: '#inventario-container',
    tplInventarioRow: '#tpl-inventario-row',
    inventarioFiltroFecha: '#inventario-filtro-fecha',
    btnInventarioFiltrar: '#btn-inventario-filtrar',
    btnInventarioHoy: '#btn-inventario-hoy',

    // Ajustes de inventario (mermas)
    ajustesContainer: '#ajustes-container',
    tplAjusteRow: '#tpl-ajuste-row',
    ajusteForm: '#ajuste-form',
    ajusteId: '#ajuste-id',
    ajusteProducto: '#ajuste-producto',
    ajusteCantidad: '#ajuste-cantidad',
    ajusteMotivo: '#ajuste-motivo',
    ajusteFecha: '#ajuste-fecha',
    ajusteHora: '#ajuste-hora',
    ajusteRegistradoPor: '#ajuste-registrado-por',
    ajusteNotas: '#ajuste-notas',
    ajusteError: '#ajuste-error',
    ajusteErrorMsg: '#ajuste-error [data-ajuste-error-msg]',
    ajusteSubmitBtn: '#btn-ajuste-submit',
    ajusteCancelEditBtn: '#btn-ajuste-cancel-edit',
    horneadaProduccion: '#horneada-produccion',

    // Recetas
    recetasView: '#recetas-view',
    recetasCount: '#recetas-count',
    recetasContainer: '#recetas-container',
    tplRecetaRow: '#tpl-receta-row',
    tplRecetaIngredienteRow: '#tpl-receta-ingrediente-row',
    recetaForm: '#receta-form',
    recetaId: '#receta-id',
    recetaProducto: '#receta-producto',
    recetaPesoUnidad: '#receta-peso-unidad',
    recetaFermentacion: '#receta-fermentacion',
    recetaHidratacion: '#receta-hidratacion',
    recetaTiempoHorneado: '#receta-tiempo-horneado',
    recetaTemperaturaHorneado: '#receta-temperatura-horneado',
    recetaManoObra: '#receta-mano-obra',
    recetaMermaCoccion: '#receta-merma-coccion',
    recetaPasos: '#receta-pasos',
    recetaIngredientesLista: '#receta-ingredientes-lista',
    btnRecetaAgregarIngrediente: '#btn-receta-agregar-ingrediente',
    recetaNotas: '#receta-notas',
    recetaError: '#receta-error',
    recetaErrorMsg: '#receta-error [data-receta-error-msg]',
    recetaSubmitBtn: '#btn-receta-submit',
    recetaCancelEditBtn: '#btn-receta-cancel-edit',

    // Producción
    produccionView: '#produccion-view',
    auditoriaView: '#auditoria-view',
    auditoriaIntegridad: '#auditoria-integridad',
    auditoriaResumen: '#auditoria-resumen',
    auditoriaGraficoEntidad: '#auditoria-grafico-entidad',
    auditoriaGraficoAccion: '#auditoria-grafico-accion',
    auditoriaLineaTiempo: '#auditoria-linea-tiempo',
    auditoriaTablaRegistros: '#auditoria-tabla-registros tbody',
    auditoriaTablaBloques: '#auditoria-tabla-bloques tbody',
    auditoriaPerfilado: '#auditoria-perfilado',
    auditoriaEdaIntervalo: '#auditoria-eda-intervalo',
    auditoriaEdaTamano: '#auditoria-eda-tamano',
    auditoriaMatriz: '#auditoria-matriz',
    auditoriaAtipicos: '#auditoria-atipicos',
    auditoriaDispersion: '#auditoria-dispersion',
    produccionCount: '#produccion-count',
    produccionesContainer: '#producciones-container',
    tplProduccionCard: '#tpl-produccion-card',
    tplEtapaItem: '#tpl-etapa-item',
    tplHorneadaLigadaItem: '#tpl-horneada-ligada-item',
    tplProduccionIngredienteRow: '#tpl-produccion-ingrediente-row',
    produccionForm: '#produccion-form',
    produccionProducto: '#produccion-producto',
    produccionFecha: '#produccion-fecha',
    produccionHoraInicio: '#produccion-hora-inicio',
    produccionRegistradoPor: '#produccion-registrado-por',
    produccionTemperaturaAmbiente: '#produccion-temperatura-ambiente',
    produccionTemperaturaAgua: '#produccion-temperatura-agua',
    produccionIngredientesLista: '#produccion-ingredientes-lista',
    produccionNotas: '#produccion-notas',
    produccionError: '#produccion-error',
    produccionErrorMsg: '#produccion-error [data-produccion-error-msg]',
    produccionSubmitBtn: '#btn-produccion-submit',
    produccionFiltroFecha: '#produccion-filtro-fecha',
    btnProduccionFiltrar: '#btn-produccion-filtrar',
    btnProduccionHoy: '#btn-produccion-hoy',

    // Lotes
    lotesView: '#lotes-view',
    lotesCount: '#lotes-count',
    lotesFiltroDesde: '#lotes-filtro-desde',
    lotesFiltroHasta: '#lotes-filtro-hasta',
    lotesFiltroProducto: '#lotes-filtro-producto',
    btnLotesFiltrar: '#btn-lotes-filtrar',
    btnLotesLimpiar: '#btn-lotes-limpiar',
    lotesPeriodo: '#lotes-periodo',
    lotesResumen: '#lotes-resumen',
    lotesTendencia: '#lotes-tendencia',
    lotesVariable: '#lotes-variable',
    lotesHistograma: '#lotes-histograma',
    lotesDescriptivas: '#lotes-descriptivas',
    lotesGraficoProducto: '#lotes-grafico-producto',
    lotesGraficoHora: '#lotes-grafico-hora',
    lotesCorrelaciones: '#lotes-correlaciones',
    lotesTablaAtipicos: '#lotes-tabla-atipicos tbody',
    lotesCalidad: '#lotes-calidad',
    lotesCompletitud: '#lotes-completitud',
    lotesHallazgos: '#lotes-hallazgos',
    lotesTabla: '#lotes-tabla tbody',
    loteTrazaModal: '#lote-traza-modal',
    loteTrazaBody: '#lote-traza-body',

    // Mermas
    mermasView: '#mermas-view',
    mermasCount: '#mermas-count',
    mermasFiltroDesde: '#mermas-filtro-desde',
    mermasFiltroHasta: '#mermas-filtro-hasta',
    mermasFiltroProducto: '#mermas-filtro-producto',
    btnMermasFiltrar: '#btn-mermas-filtrar',
    btnMermasLimpiar: '#btn-mermas-limpiar',
    mermasPeriodo: '#mermas-periodo',
    mermasResumen: '#mermas-resumen',
    mermasLimpieza: '#mermas-limpieza',
    mermasDescriptivas: '#mermas-descriptivas',
    mermasCausas: '#mermas-causas',
    mermasCorrelaciones: '#mermas-correlaciones',
    mermasMultivariado: '#mermas-multivariado',
    mermasHipotesisProducto: '#mermas-hipotesis-producto',
    mermasHipotesisCausa: '#mermas-hipotesis-causa',
    mermasModelo: '#mermas-modelo',
    // Ciclo de pedidos (analítica del historial de estados)
    pedidosView: '#pedidos-view',
    pedidosCount: '#pedidos-count',
    pedidosFiltroDesde: '#pedidos-filtro-desde',
    pedidosFiltroHasta: '#pedidos-filtro-hasta',
    pedidosFiltroEstado: '#pedidos-filtro-estado',
    btnPedidosFiltrar: '#btn-pedidos-filtrar',
    btnPedidosLimpiar: '#btn-pedidos-limpiar',
    pedidosPeriodo: '#pedidos-periodo',
    pedidosResumen: '#pedidos-resumen',
    pedidosLeadTime: '#pedidos-leadtime',
    pedidosTendencia: '#pedidos-tendencia',
    pedidosHistograma: '#pedidos-histograma',
    pedidosDescriptivas: '#pedidos-descriptivas',
    pedidosEmbudo: '#pedidos-embudo',
    pedidosDispositivos: '#pedidos-dispositivos',
    pedidosGraficoHoraIngreso: '#pedidos-grafico-hora-ingreso',
    pedidosGraficoHoraRetiro: '#pedidos-grafico-hora-retiro',
    pedidosTablaAtipicos: '#pedidos-tabla-atipicos tbody',
    pedidosCalidad: '#pedidos-calidad',
    pedidosCompletitud: '#pedidos-completitud',
    pedidosHallazgos: '#pedidos-hallazgos',
    pedidosTabla: '#pedidos-tabla tbody',
    pedidoHistorialModal: '#pedido-historial-modal',
    pedidoHistorialBody: '#pedido-historial-body',
    operarioActual: '#operario-actual',
  },
  /* Cada campo del proveedor se mapea a su input por id, de modo que cargar y
     leer el formulario sea una sola iteración en lugar de 24 querySelector. */
  PROVEEDOR_FIELDS: {
    razonSocial: '#proveedor-razon-social',
    nombreComercial: '#proveedor-nombre-comercial',
    identificacionFiscal: '#proveedor-identificacion-fiscal',
    giroComercial: '#proveedor-giro-comercial',
    direccion: '#proveedor-direccion',
    codigoPostal: '#proveedor-codigo-postal',
    ciudad: '#proveedor-ciudad',
    pais: '#proveedor-pais',
    contactoNombre: '#proveedor-contacto-nombre',
    emailFacturacion: '#proveedor-email-facturacion',
    emailContacto: '#proveedor-email-contacto',
    telefonoFijo: '#proveedor-telefono-fijo',
    celular: '#proveedor-celular',
    banco: '#proveedor-banco',
    numeroCuenta: '#proveedor-numero-cuenta',
    clabeIban: '#proveedor-clabe-iban',
    condicionesPago: '#proveedor-condiciones-pago',
    moneda: '#proveedor-moneda',
    metodoFacturacion: '#proveedor-metodo-facturacion',
    leadTimeDias: '#proveedor-lead-time',
    pedidoMinimo: '#proveedor-pedido-minimo',
    politicasDevolucion: '#proveedor-politicas-devolucion',
    certificaciones: '#proveedor-certificaciones',
    notas: '#proveedor-notas',
  },
  PROVEEDOR_NUMERIC_FIELDS: ['leadTimeDias', 'pedidoMinimo'],
  CONDICIONES_PAGO_LABELS: {
    contado: 'Contado',
    credito_30: 'Crédito 30 días',
    credito_60: 'Crédito 60 días',
    credito_90: 'Crédito 90 días',
  },
  CATEGORIA_LABELS: {
    harinas: 'Harinas',
    lacteos: 'Lácteos',
    huevos: 'Huevos',
    endulzantes: 'Endulzantes',
    grasas: 'Grasas / aceites',
    levaduras: 'Levaduras / leudantes',
    empaque: 'Empaque',
    otros: 'Otros',
  },
  PRODUCTO_CATEGORIA_LABELS: {
    panaderia: 'Panadería',
    reposteria: 'Repostería',
    bolleria: 'Bollería',
    frituras: 'Frituras',
  },
  // badgeClase reutiliza los mismos colores que ya usa el resto del panel
  // (sección Alertas) — nada inventado a propósito para Productos.
  PRODUCTO_ESTADO_LABELS: {
    activo: { texto: 'Activo', badgeClase: 'insumo-badge--exito' },
    borrador: { texto: 'Borrador', badgeClase: 'insumo-badge--neutral' },
    agotado: { texto: 'Agotado', badgeClase: 'insumo-badge--por-vencer' },
    descontinuado: { texto: 'Descontinuado', badgeClase: 'insumo-badge--bajo-stock' },
  },
  ALERGENO_LABELS: {
    gluten: 'Gluten',
    lacteos: 'Lácteos',
    huevo: 'Huevo',
    soya: 'Soya',
    frutos_secos: 'Frutos secos',
    mani: 'Maní',
    mariscos: 'Mariscos',
    sesamo: 'Sésamo',
  },
});

/* ═══════════════════════════════════════════
   2. MÓDULO: AUTENTICACIÓN
   ═══════════════════════════════════════════ */
const Auth = {
  /**
   * Envía la password al backend. Si es correcta, guarda el token en sessionStorage.
   * No traga los errores de red/servidor: solo una respuesta 401 significa
   * "contraseña incorrecta". Cualquier otro fallo se propaga para que la UI
   * pueda distinguir entre credenciales erróneas y el servidor caído.
   * @param {string} password
   * @returns {Promise<{ ok: boolean, reason?: 'invalid' }>}
   * @throws {Error} si hay un fallo de red o el servidor responde de forma inesperada
   */
  async login(password) {
    // CAMBIO: Usamos apiFetch con timeout de 15s para soportar el "cold start" de Render
    const res = await apiFetch('/auth', {
      method: 'POST',
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    if (res.status === 401) return { ok: false, reason: 'invalid' };
    if (!res.ok) throw new Error(`El servidor respondió ${res.status}.`);

    const { token } = await res.json();
    if (!token) throw new Error('El servidor no devolvió un token válido.');

    sessionStorage.setItem(CONFIG.SESSION_KEY, '1');
    sessionStorage.setItem(CONFIG.TOKEN_KEY, token);
    return { ok: true };
  },

  logout() {
    sessionStorage.removeItem(CONFIG.SESSION_KEY);
    sessionStorage.removeItem(CONFIG.TOKEN_KEY);
  },

  isAuthenticated() {
    return sessionStorage.getItem(CONFIG.SESSION_KEY) === '1';
  },

  getToken() {
    return sessionStorage.getItem(CONFIG.TOKEN_KEY) ?? '';
  },
};

/* ═══════════════════════════════════════════
   3. MÓDULO: API (backend)
   ═══════════════════════════════════════════ */
const Api = {
  async getTodayOrders() {
    const fecha = hoyHouston();

    try {
      const res = await apiFetch(`/ordenes?fecha=${fecha}`, {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      // El token de sesión caducó o es inválido: forzar reinicio de sesión.
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error('[Api] Timeout obteniendo órdenes (el servidor puede estar iniciando).');
      } else {
        console.error('[Api] Error obteniendo órdenes:', err.message);
      }
      return null;
    }
  },

  /** Avanza una orden a cualquiera de los estados de ORDER_STATE_FLOW
   *  (antes solo existía markAsPrepared, fijo a 'preparada'). */
  async updateOrderStatus(numero, estado) {
    try {
      const res = await apiFetch(`/ordenes/${encodeURIComponent(numero)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        /* El operario viaja con el cambio: el panel entra con una sola
           contraseña, así que el backend no puede saber quién movió el
           botón. Va vacío si nadie lo declaró — el pedido avanza igual. */
        body: JSON.stringify({ estado, usuario: Operario.leer() }),
      });
      return res.ok;
    } catch (err) {
      console.error('[Api] Error actualizando orden:', err.message);
      return false;
    }
  },

  /** Conexión WebSocket para refresco en vivo. Reintenta sola si se cae,
   *  con backoff exponencial (máx. 30s) para no martillar un servidor caído. */
  connectLive(onMessage) {
    let intento = 0;

    const connect = () => {
      // El WebSocket del navegador no permite headers custom en el
      // handshake (no se puede mandar Authorization: Bearer como en
      // fetch) — el token va como query param, que es lo único que el
      // servidor puede leer antes de aceptar la conexión (ver
      // verifyClient en server.js). Se lee de nuevo en cada intento —no
      // una sola vez afuera de connect()— porque si el token expira
      // mientras la pestaña sigue abierta, los reintentos automáticos de
      // más abajo seguirían mandando uno viejo para siempre.
      const wsUrl = `${API_BASE.replace(/^http/, 'ws')}?token=${encodeURIComponent(Auth.getToken())}`;
      const socket = new WebSocket(wsUrl);

      socket.addEventListener('open', () => {
        intento = 0;
      });

      socket.addEventListener('message', (e) => {
        try {
          onMessage(JSON.parse(e.data));
        } catch (err) {
          console.warn('[Api] Mensaje WebSocket ignorado (no es JSON válido):', err.message);
        }
      });

      socket.addEventListener('error', () => {
        console.warn('[Api] Error en la conexión WebSocket; se intentará reconectar.');
        socket.close();
      });

      socket.addEventListener('close', () => {
        const espera = Math.min(30_000, 1_000 * 2 ** intento);
        intento++;
        setTimeout(connect, espera);
      });
    };

    connect();
  },
};

/* ═══════════════════════════════════════════
   4. MÓDULO: FORMATO
   ═══════════════════════════════════════════ */
const Format = {
  currency: formatPrice,

  /** Muestra cantidades sin decimales innecesarios (2 -> "2", 2.5 -> "2.5"). */
  cantidad(valor) {
    const num = Number(valor) || 0;
    return num % 1 === 0 ? String(num) : num.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  },

  todayDate() {
    return new Date().toLocaleDateString('es-US', {
      timeZone: HOUSTON_TZ,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  },
};

/* ═══════════════════════════════════════════
   5. MÓDULO: INSUMOS (backend real)
   ═══════════════════════════════════════════
   CRUD contra /insumos, protegido por el mismo token de sesión que
   /ordenes. Mismo patrón que el módulo Api: apiFetch con timeout,
   401 => sesión expirada, errores de red devuelven null/ok:false
   en lugar de lanzar, para que la UI decida qué mostrar. */
const Insumos = {
  async listar() {
    try {
      const res = await apiFetch('/insumos', {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error('[Insumos] Timeout obteniendo insumos (el servidor puede estar iniciando).');
      } else {
        console.error('[Insumos] Error obteniendo insumos:', err.message);
      }
      return null;
    }
  },

  async crear(datos) {
    return this._enviar('/insumos', 'POST', datos);
  },

  async actualizar(id, datos) {
    return this._enviar(`/insumos/${encodeURIComponent(id)}`, 'PUT', datos);
  },

  async _enviar(path, method, datos) {
    try {
      const res = await apiFetch(path, {
        method,
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        body: JSON.stringify(datos),
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: body.error };
      }
      return { ok: true, insumo: await res.json() };
    } catch (err) {
      console.error(`[Insumos] Error en ${method} ${path}:`, err.message);
      return { ok: false, reason: 'network' };
    }
  },

  async eliminar(id) {
    try {
      const res = await apiFetch(`/insumos/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok && res.status !== 204) {
        const cuerpo = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: cuerpo.error };
      }
      return { ok: true };
    } catch (err) {
      console.error('[Insumos] Error eliminando insumo:', err.message);
      return { ok: false, reason: 'network' };
    }
  },
};

/* ═══════════════════════════════════════════
   MÓDULO: PRODUCTOS (backend real)
   ═══════════════════════════════════════════
   Mismo contrato que Insumos, pero sin eliminar() — un producto sale de
   circulación cambiando su estado (PUT con estado 'agotado' o
   'descontinuado'), nunca se borra: ya tiene historial en recetas,
   producciones, horneadas, ajustes y pedidos. */
const Productos = {
  async listar() {
    try {
      const res = await apiFetch('/productos', {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error(
          '[Productos] Timeout obteniendo productos (el servidor puede estar iniciando).',
        );
      } else {
        console.error('[Productos] Error obteniendo productos:', err.message);
      }
      return null;
    }
  },

  async crear(datos) {
    return this._enviar('/productos', 'POST', datos);
  },

  async actualizar(id, datos) {
    return this._enviar(`/productos/${encodeURIComponent(id)}`, 'PUT', datos);
  },

  /** GET /productos/estadisticas — tasaRotacionDiaria, desviacionEstandarDemanda
   *  y factorEstacionalidad de todos los productos activos, calculados desde
   *  el historial real de órdenes entregadas (ver estadisticas.js). Se usa
   *  para la sugerencia de cuánto hornear mañana en la vista de Horneadas. */
  async estadisticas() {
    try {
      const res = await apiFetch('/productos/estadisticas', {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      const { productos } = await res.json();
      return productos;
    } catch (err) {
      console.error('[Productos] Error obteniendo estadísticas:', err.message);
      return null;
    }
  },

  /** GET /productos/prediccion-automl — para cada producto activo, el
   *  modelo de pronóstico que AutoML eligió por backtesting, su
   *  predicción y su margen de error (ver autoML.js). Se usa en la
   *  tarjeta de predicción de la vista Productos. */
  async prediccionAutoML() {
    try {
      const res = await apiFetch('/productos/prediccion-automl', {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      const { productos } = await res.json();
      return productos;
    } catch (err) {
      console.error('[Productos] Error obteniendo la predicción AutoML:', err.message);
      return null;
    }
  },

  async _enviar(path, method, datos) {
    try {
      const res = await apiFetch(path, {
        method,
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        body: JSON.stringify(datos),
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: body.error };
      }
      return { ok: true, producto: await res.json() };
    } catch (err) {
      console.error(`[Productos] Error en ${method} ${path}:`, err.message);
      return { ok: false, reason: 'network' };
    }
  },
};

/* ═══════════════════════════════════════════
   MÓDULO: AUDITORÍA (backend real)
   ═══════════════════════════════════════════
   Cadena de hashes de solo lectura desde el panel — la API nunca expone
   forma de escribir en auditoria_cadena directamente (ver auditoria.js
   y server.js); acá solo se consulta lo que ya se generó automáticamente
   al crear/editar/borrar en Productos, Horneadas y Ajustes. */
const Auditoria = {
  /** GET /auditoria/analisis — integridad de la cadena + agrupaciones
   *  (por entidad, por acción, actividad por día, registros con más
   *  cambios). Es lo que arma toda la vista Auditoría del panel. */
  async analisis() {
    try {
      const res = await apiFetch('/auditoria/analisis', {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('[Auditoria] Error obteniendo el análisis:', err.message);
      return null;
    }
  },

  /** GET /auditoria — últimos bloques (sin filtro, los 200 más
   *  recientes) para la tabla "Últimos bloques". */
  async ultimosBloques() {
    try {
      const res = await apiFetch('/auditoria', {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      const { bloques } = await res.json();
      return bloques;
    } catch (err) {
      console.error('[Auditoria] Error obteniendo los bloques:', err.message);
      return null;
    }
  },
};

/* ═══════════════════════════════════════════
   MÓDULO: LOTES (backend real)
   ═══════════════════════════════════════════
   Solo lectura, igual que Auditoría: un lote se crea registrando una
   horneada (vista Horneadas), no desde acá. El backend (lotes.js) ya hace
   todo el trabajo de datos — cruces, indicadores derivados, estadística,
   tendencias y validación — así que el panel solo pide y pinta. */
const LotesApi = {
  /** GET /lotes/analisis — el reporte completo del período: resumen,
   *  descriptivas con histograma, atípicos, cortes, correlaciones,
   *  tendencias, validación y los lotes ya derivados. */
  async analisis({ desde, hasta, productoId } = {}) {
    const params = new URLSearchParams();
    if (desde) params.set('desde', desde);
    if (hasta) params.set('hasta', hasta);
    if (productoId) params.set('productoId', productoId);
    const query = params.toString();

    try {
      const res = await apiFetch(`/lotes/analisis${query ? `?${query}` : ''}`, {
        timeout: 15_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('[Lotes] Error obteniendo el análisis:', err.message);
      return null;
    }
  },

  /** GET /lotes/:id — un lote con su trazabilidad hacia atrás. */
  async detalle(id) {
    try {
      const res = await apiFetch(`/lotes/${encodeURIComponent(id)}`, {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('[Lotes] Error obteniendo el lote:', err.message);
      return null;
    }
  },
};

/* ═══════════════════════════════════════════
   MÓDULO: MERMAS (backend real)
   ═══════════════════════════════════════════
   Mismo criterio que Lotes: solo lectura, una sola llamada trae todo el
   pipeline ya resuelto (recopilación → almacenamiento → procesamiento →
   limpieza → análisis) — ver mermas.js / mermasAnalitica.js /
   mermasModelos.js. El panel solo pide y pinta. */
const MermasApi = {
  /** GET /mermas/analisis — dataset limpio + EDA + hipótesis + modelo
   *  predictivo del período. */
  async analisis({ desde, hasta, productoId } = {}) {
    const params = new URLSearchParams();
    if (desde) params.set('desde', desde);
    if (hasta) params.set('hasta', hasta);
    if (productoId) params.set('productoId', productoId);
    const query = params.toString();

    try {
      const res = await apiFetch(`/mermas/analisis${query ? `?${query}` : ''}`, {
        timeout: 15_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('[Mermas] Error obteniendo el análisis:', err.message);
      return null;
    }
  },
};

/* ═══════════════════════════════════════════
   MÓDULO: CICLO DE PEDIDOS (backend real)
   ═══════════════════════════════════════════
   La fila de la orden solo guarda el estado actual; el tiempo de cada etapa
   se reconstruye en el backend desde el historial de transiciones. Acá solo
   se consulta — ver pedidos.js y pedidosAnalitica.js. */
const PedidosApi = {
  /** GET /ordenes/analisis — reporte del período: resumen, descriptivas,
   *  lead time por etapa, embudo, dispositivos, tendencias y validación. */
  async analisis({ desde, hasta, estado } = {}) {
    const params = new URLSearchParams();
    if (desde) params.set('desde', desde);
    if (hasta) params.set('hasta', hasta);
    if (estado) params.set('estado', estado);
    const query = params.toString();

    try {
      const res = await apiFetch(`/ordenes/analisis${query ? `?${query}` : ''}`, {
        timeout: 15_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('[Pedidos] Error obteniendo el análisis:', err.message);
      return null;
    }
  },

  /** GET /ordenes/:numero/historial — un pedido con su línea de tiempo. */
  async historial(numero) {
    try {
      const res = await apiFetch(`/ordenes/${encodeURIComponent(numero)}/historial`, {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('[Pedidos] Error obteniendo el historial:', err.message);
      return null;
    }
  },
};

/* Quién está moviendo los pedidos. El panel se abre con una sola contraseña
   compartida: sin este dato el historial puede decir cuándo avanzó cada
   pedido, pero no quién lo avanzó. Se guarda en este navegador para no
   volver a escribirlo en cada turno; nunca sale de acá salvo dentro del
   PATCH del pedido. */
const Operario = {
  STORAGE_KEY: 'plm_operario',

  leer() {
    const el = document.querySelector(CONFIG.SELECTORS.operarioActual);
    return el ? el.value.trim() : '';
  },

  guardar(nombre) {
    try {
      localStorage.setItem(this.STORAGE_KEY, nombre);
    } catch {
      /* localStorage no disponible (modo privado) — el nombre igual viaja
         en el PATCH de esta sesión, solo no se recuerda. */
    }
  },

  restaurar() {
    const el = document.querySelector(CONFIG.SELECTORS.operarioActual);
    if (!el) return;
    try {
      el.value = localStorage.getItem(this.STORAGE_KEY) ?? '';
    } catch {
      /* Sin localStorage el campo arranca vacío. */
    }
  },
};

/* ═══════════════════════════════════════════
   6. MÓDULO: PROVEEDORES (backend real)
   ═══════════════════════════════════════════
   Mismo contrato que el módulo Insumos: CRUD contra /proveedores con el token
   de sesión, 401 => sesión expirada, fallos de red devuelven null / ok:false. */
const Proveedores = {
  async listar() {
    try {
      const res = await apiFetch('/proveedores', {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error('[Proveedores] Timeout obteniendo proveedores.');
      } else {
        console.error('[Proveedores] Error obteniendo proveedores:', err.message);
      }
      return null;
    }
  },

  async crear(datos) {
    return this._enviar('/proveedores', 'POST', datos);
  },

  async actualizar(id, datos) {
    return this._enviar(`/proveedores/${encodeURIComponent(id)}`, 'PUT', datos);
  },

  async _enviar(path, method, datos) {
    try {
      const res = await apiFetch(path, {
        method,
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        body: JSON.stringify(datos),
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: body.error };
      }
      return { ok: true, proveedor: await res.json() };
    } catch (err) {
      console.error(`[Proveedores] Error en ${method} ${path}:`, err.message);
      return { ok: false, reason: 'network' };
    }
  },

  async eliminar(id) {
    try {
      const res = await apiFetch(`/proveedores/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok && res.status !== 204) {
        return { ok: false, reason: 'error' };
      }
      return { ok: true };
    } catch (err) {
      console.error('[Proveedores] Error eliminando proveedor:', err.message);
      return { ok: false, reason: 'network' };
    }
  },
};

/* ═══════════════════════════════════════════
   6b. MÓDULO: HORNEADAS (backend real)
   ═══════════════════════════════════════════
   Mismo contrato que Insumos/Proveedores: CRUD contra /horneadas con el
   token de sesión, 401 => sesión expirada, fallos de red devuelven
   null / ok:false. listar() siempre pide la fecha de hoy — es la vista
   operativa del día por defecto, pero acepta una fecha explícita para poder
   revisar la trazabilidad de cualquier día pasado. */
const Horneadas = {
  async listar(fecha) {
    const fechaConsulta = fecha || hoyHouston();
    try {
      const res = await apiFetch(`/horneadas?fecha=${fechaConsulta}`, {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error('[Horneadas] Timeout obteniendo horneadas.');
      } else {
        console.error('[Horneadas] Error obteniendo horneadas:', err.message);
      }
      return null;
    }
  },

  async crear(datos) {
    return this._enviar('/horneadas', 'POST', datos);
  },

  async actualizar(id, datos) {
    return this._enviar(`/horneadas/${encodeURIComponent(id)}`, 'PUT', datos);
  },

  async _enviar(path, method, datos) {
    try {
      const res = await apiFetch(path, {
        method,
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        body: JSON.stringify(datos),
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: body.error };
      }
      return { ok: true, horneada: await res.json() };
    } catch (err) {
      console.error(`[Horneadas] Error en ${method} ${path}:`, err.message);
      return { ok: false, reason: 'network' };
    }
  },

  async eliminar(id) {
    try {
      const res = await apiFetch(`/horneadas/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok && res.status !== 204) {
        return { ok: false, reason: 'error' };
      }
      return { ok: true };
    } catch (err) {
      console.error('[Horneadas] Error eliminando horneada:', err.message);
      return { ok: false, reason: 'network' };
    }
  },
};

/* ═══════════════════════════════════════════
   6c. MÓDULO: INVENTARIO (vista agregada, solo lectura)
   ═══════════════════════════════════════════ */
const Inventario = {
  async ver(fecha) {
    const fechaConsulta = fecha || hoyHouston();
    try {
      const res = await apiFetch(`/inventario?fecha=${fechaConsulta}`, {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error('[Inventario] Timeout obteniendo inventario.');
      } else {
        console.error('[Inventario] Error obteniendo inventario:', err.message);
      }
      return null;
    }
  },
};

/* ═══════════════════════════════════════════
   6d. MÓDULO: AJUSTES DE INVENTARIO (mermas, errores de conteo...)
   Mismo contrato que Horneadas.
   ═══════════════════════════════════════════ */
const Ajustes = {
  async listar(fecha) {
    const fechaConsulta = fecha || hoyHouston();
    try {
      const res = await apiFetch(`/ajustes-inventario?fecha=${fechaConsulta}`, {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error('[Ajustes] Timeout obteniendo ajustes.');
      } else {
        console.error('[Ajustes] Error obteniendo ajustes:', err.message);
      }
      return null;
    }
  },

  async crear(datos) {
    return this._enviar('/ajustes-inventario', 'POST', datos);
  },

  async actualizar(id, datos) {
    return this._enviar(`/ajustes-inventario/${encodeURIComponent(id)}`, 'PUT', datos);
  },

  async _enviar(path, method, datos) {
    try {
      const res = await apiFetch(path, {
        method,
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        body: JSON.stringify(datos),
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: body.error };
      }
      return { ok: true, ajuste: await res.json() };
    } catch (err) {
      console.error(`[Ajustes] Error en ${method} ${path}:`, err.message);
      return { ok: false, reason: 'network' };
    }
  },

  async eliminar(id) {
    try {
      const res = await apiFetch(`/ajustes-inventario/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok && res.status !== 204) {
        return { ok: false, reason: 'error' };
      }
      return { ok: true };
    } catch (err) {
      console.error('[Ajustes] Error eliminando ajuste:', err.message);
      return { ok: false, reason: 'network' };
    }
  },
};

/* ═══════════════════════════════════════════
   6e. MÓDULO: STOCK MÍNIMO por producto
   ═══════════════════════════════════════════ */
const StockMinimo = {
  async actualizar(productoId, stockMinimo) {
    try {
      const res = await apiFetch(`/productos/${encodeURIComponent(productoId)}/stock-minimo`, {
        method: 'PUT',
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        body: JSON.stringify({ stockMinimo }),
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: body.error };
      }
      return { ok: true };
    } catch (err) {
      console.error('[StockMinimo] Error actualizando stock mínimo:', err.message);
      return { ok: false, reason: 'network' };
    }
  },
};

/* ═══════════════════════════════════════════
   6f. MÓDULO: RECETAS
   ═══════════════════════════════════════════ */
const Recetas = {
  async listar() {
    try {
      const res = await apiFetch('/recetas', {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('[Recetas] Error obteniendo recetas:', err.message);
      return null;
    }
  },

  async crear(datos) {
    return this._enviar('/recetas', 'POST', datos);
  },

  async actualizar(id, datos) {
    return this._enviar(`/recetas/${encodeURIComponent(id)}`, 'PUT', datos);
  },

  async _enviar(path, method, datos) {
    try {
      const res = await apiFetch(path, {
        method,
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        body: JSON.stringify(datos),
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: body.error };
      }
      return { ok: true, receta: await res.json() };
    } catch (err) {
      console.error(`[Recetas] Error en ${method} ${path}:`, err.message);
      return { ok: false, reason: 'network' };
    }
  },

  async eliminar(id) {
    try {
      const res = await apiFetch(`/recetas/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok && res.status !== 204) {
        const cuerpo = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: cuerpo.error };
      }
      return { ok: true };
    } catch (err) {
      console.error('[Recetas] Error eliminando receta:', err.message);
      return { ok: false, reason: 'network' };
    }
  },
};

/* ═══════════════════════════════════════════
   6f-bis. MÓDULO: ÓRDENES DE COMPRA
   ═══════════════════════════════════════════
   Mismo contrato que los demás módulos (401 => sesión expirada, red caída
   => null / ok:false). Lo específico de compras son las dos operaciones
   que no son un CRUD: cambiar de estado y registrar una recepción; ambas
   devuelven la orden completa ya recalculada por el servidor, así que la
   UI nunca tiene que deducir totales ni avance por su cuenta. */
const OrdenesCompra = {
  async listar(filtros = {}) {
    const params = new URLSearchParams();
    if (filtros.estado) params.set('estado', filtros.estado);
    if (filtros.proveedorId) params.set('proveedorId', filtros.proveedorId);
    if (filtros.desde) params.set('desde', filtros.desde);
    if (filtros.hasta) params.set('hasta', filtros.hasta);
    const query = params.toString();

    try {
      const res = await apiFetch(`/ordenes-compra${query ? `?${query}` : ''}`, {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('[OrdenesCompra] Error obteniendo órdenes de compra:', err.message);
      return null;
    }
  },

  async trazabilidad(id) {
    try {
      const res = await apiFetch(`/ordenes-compra/${encodeURIComponent(id)}/trazabilidad`, {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('[OrdenesCompra] Error obteniendo trazabilidad:', err.message);
      return null;
    }
  },

  async crear(datos) {
    return this._enviar('/ordenes-compra', 'POST', datos);
  },

  async actualizar(id, datos) {
    return this._enviar(`/ordenes-compra/${encodeURIComponent(id)}`, 'PUT', datos);
  },

  async cambiarEstado(id, datos) {
    return this._enviar(`/ordenes-compra/${encodeURIComponent(id)}/estado`, 'PATCH', datos);
  },

  async registrarRecepcion(id, datos) {
    return this._enviar(`/ordenes-compra/${encodeURIComponent(id)}/recepciones`, 'POST', datos);
  },

  async _enviar(path, method, datos) {
    try {
      const res = await apiFetch(path, {
        method,
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        body: JSON.stringify(datos),
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: body.error };
      }
      return { ok: true, ordenCompra: await res.json() };
    } catch (err) {
      console.error(`[OrdenesCompra] Error en ${method} ${path}:`, err.message);
      return { ok: false, reason: 'network' };
    }
  },

  async eliminar(id) {
    try {
      const res = await apiFetch(`/ordenes-compra/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok && res.status !== 204) {
        const cuerpo = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: cuerpo.error };
      }
      return { ok: true };
    } catch (err) {
      console.error('[OrdenesCompra] Error eliminando orden de compra:', err.message);
      return { ok: false, reason: 'network' };
    }
  },
};

/* Etiqueta y color de cada estado del ciclo de vida (ver
   docs/modelo-ordenes-compra.md). Las transiciones que se ofrecen como
   botón son solo las manuales: recibida_parcial y recibida las decide el
   servidor al registrar recepciones, nunca el usuario. */
const OC_ESTADO_LABEL = {
  borrador: 'Borrador',
  emitida: 'Emitida',
  confirmada: 'Confirmada',
  recibida_parcial: 'Recibida parcial',
  recibida: 'Recibida',
  cerrada: 'Cerrada',
  cancelada: 'Cancelada',
};

const OC_TRANSICIONES_UI = {
  borrador: [{ estado: 'emitida', label: 'Emitir', icono: 'fa-paper-plane' }],
  emitida: [{ estado: 'confirmada', label: 'Confirmar', icono: 'fa-handshake' }],
  confirmada: [],
  recibida_parcial: [],
  recibida: [{ estado: 'cerrada', label: 'Cerrar', icono: 'fa-lock' }],
  cerrada: [],
  cancelada: [],
};

const OC_ESTADOS_RECEPCION_UI = ['emitida', 'confirmada', 'recibida_parcial'];

/* ═══════════════════════════════════════════
   6g. MÓDULO: PRODUCCIÓN (tandas de masa + etapas)
   ═══════════════════════════════════════════ */
const Producciones = {
  async listar(fecha) {
    const fechaConsulta = fecha || hoyHouston();
    try {
      const res = await apiFetch(`/producciones?fecha=${fechaConsulta}`, {
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return 'UNAUTHORIZED';
      }
      if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('[Producciones] Error obteniendo producciones:', err.message);
      return null;
    }
  },

  async crear(datos) {
    try {
      const res = await apiFetch('/producciones', {
        method: 'POST',
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        body: JSON.stringify(datos),
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: body.error };
      }
      return { ok: true, produccion: await res.json() };
    } catch (err) {
      console.error('[Producciones] Error creando producción:', err.message);
      return { ok: false, reason: 'network' };
    }
  },

  async eliminar(id) {
    try {
      const res = await apiFetch(`/producciones/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        timeout: 10_000,
        headers: { Authorization: `Bearer ${Auth.getToken()}` },
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok && res.status !== 204) {
        return { ok: false, reason: 'error' };
      }
      return { ok: true };
    } catch (err) {
      console.error('[Producciones] Error eliminando producción:', err.message);
      return { ok: false, reason: 'network' };
    }
  },

  async iniciarEtapa(produccionId, etapa, horaInicio) {
    try {
      const res = await apiFetch(`/producciones/${encodeURIComponent(produccionId)}/etapas`, {
        method: 'POST',
        timeout: 10_000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        body: JSON.stringify({ etapa, horaInicio }),
      });
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: body.error };
      }
      return { ok: true, produccion: await res.json() };
    } catch (err) {
      console.error('[Producciones] Error iniciando etapa:', err.message);
      return { ok: false, reason: 'network' };
    }
  },

  async finalizarEtapa(produccionId, etapaId, horaFin) {
    try {
      const res = await apiFetch(
        `/producciones/${encodeURIComponent(produccionId)}/etapas/${encodeURIComponent(etapaId)}`,
        {
          method: 'PUT',
          timeout: 10_000,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${Auth.getToken()}`,
          },
          body: JSON.stringify({ horaFin }),
        },
      );
      if (res.status === 401) {
        Auth.logout();
        return { ok: false, reason: 'unauthorized' };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, reason: 'error', message: body.error };
      }
      return { ok: true, produccion: await res.json() };
    } catch (err) {
      console.error('[Producciones] Error finalizando etapa:', err.message);
      return { ok: false, reason: 'network' };
    }
  },
};

/* ═══════════════════════════════════════════
   7. MÓDULO: RENDERIZADO
   ═══════════════════════════════════════════ */
const Render = {
  updateStats(orders) {
    const lista = orders || [];
    const total = lista.length;
    const ingresos = lista.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const contarPor = (estado) => lista.filter((o) => o.estado === estado).length;

    this._setStat(CONFIG.SELECTORS.statOrdenes, total);
    this._setStat(CONFIG.SELECTORS.statIngresos, Format.currency(ingresos), ingresos);
    this._setStat(CONFIG.SELECTORS.statPend, contarPor('pendiente'));
    this._setStat(CONFIG.SELECTORS.statEnPreparacion, contarPor('en_preparacion'));
    this._setStat(CONFIG.SELECTORS.statPrep, contarPor('preparada'));
    this._setStat(CONFIG.SELECTORS.statEntregadas, contarPor('entregada'));
  },

  /** Diagnóstico de pedidos: completación, tiempo promedio de entrega
   *  (creadoEn -> actualizadoEn de los ya entregados) y retrasados —
   *  "retrasado" usa la regla de negocio real del proyecto (retiro + 15
   *  min de espera máxima), no un número inventado. Se calcula del mismo
   *  array de `orders` que ya trae refresh(), sin pedir nada aparte. */
  renderDiagnosticoPedidos(orders) {
    const lista = orders || [];
    const hoy = hoyHouston();
    const horaLimite = ahoraHoraHouston();

    const total = lista.length;
    const entregadas = lista.filter((o) => o.estado === 'entregada');
    const completacion = total > 0 ? Math.round((entregadas.length / total) * 100) : 0;

    const duracionesMin = entregadas
      .map((o) => {
        if (!o.creadoEn || !o.actualizadoEn) return null;
        const ms = new Date(o.actualizadoEn) - new Date(o.creadoEn);
        return Number.isFinite(ms) && ms >= 0 ? ms / 60000 : null;
      })
      .filter((min) => min !== null);
    const tiempoPromedio =
      duracionesMin.length > 0
        ? Math.round(duracionesMin.reduce((s, m) => s + m, 0) / duracionesMin.length)
        : null;

    const diagnostico = (orden) => {
      if (orden.estado === 'entregada') {
        return { texto: 'Saludable', clase: 'insumo-badge--exito' };
      }
      // Un pedido de un día ANTERIOR que nunca se entregó ya está
      // retrasado sin importar la hora — no hace falta comparar horas.
      const esDeOtroDia = orden.fechaISO < hoy;
      const pasoLaHoraLimite =
        orden.fechaISO === hoy && horaLimite > sumarMinutosAHora(orden.retiro, 15);
      if (esDeOtroDia || pasoLaHoraLimite) {
        return { texto: 'Retrasado', clase: 'insumo-badge--bajo-stock' };
      }
      return { texto: 'En proceso', clase: 'insumo-badge--neutral' };
    };

    const retrasados = lista.filter((o) => diagnostico(o).clase === 'insumo-badge--bajo-stock');

    this._setStat(CONFIG.SELECTORS.diagTotal, total);
    this._setStat(CONFIG.SELECTORS.diagCompletacion, `${completacion}%`, completacion);
    this._setStat(
      CONFIG.SELECTORS.diagTiempo,
      tiempoPromedio === null ? '—' : `${tiempoPromedio} min`,
      tiempoPromedio ?? 0,
    );
    this._setStat(CONFIG.SELECTORS.diagRetrasados, retrasados.length);

    const tbody = document.querySelector(CONFIG.SELECTORS.diagTbody);
    const vacio = document.querySelector(CONFIG.SELECTORS.diagVacio);
    if (!tbody) return;

    if (total === 0) {
      tbody.innerHTML = '';
      if (vacio) vacio.hidden = false;
      return;
    }
    if (vacio) vacio.hidden = true;

    tbody.innerHTML = lista
      .map((orden) => {
        const diag = diagnostico(orden);
        const estadoLabel = ORDER_STATE_FLOW[orden.estado]?.label || orden.estado;
        return `
          <tr>
            <td data-label="Pedido">${escapeHTML(orden.numero)}</td>
            <td data-label="Cliente">${escapeHTML(orden.cliente)}</td>
            <td data-label="Estado">${escapeHTML(estadoLabel)}</td>
            <td data-label="Retiro">${escapeHTML(orden.retiro)}</td>
            <td data-label="Diagnóstico">
              <span class="insumo-badge ${diag.clase}">${diag.texto}</span>
            </td>
          </tr>
        `;
      })
      .join('');
  },

  _setStat(selector, displayValue, rawValue) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.textContent = displayValue;
    if (rawValue !== undefined) el.value = rawValue;
  },

  renderOrders(orders) {
    const container = document.querySelector(CONFIG.SELECTORS.orders);
    container.innerHTML = '';

    if (orders === null) {
      container.appendChild(
        this._emptyState(
          'No se pudo conectar con el servidor de pedidos. Verifica que el backend esté corriendo.',
        ),
      );
      return;
    }

    if (orders.length === 0) {
      container.appendChild(this._emptyState());
      return;
    }

    const groups = this._groupByPickup(orders);
    const sortedTimes = Object.keys(groups).sort();

    sortedTimes.forEach((time) => {
      container.appendChild(this._renderGroup(time, groups[time]));
    });
  },

  _groupByPickup(orders) {
    return orders.reduce((acc, order) => {
      const time = order.retiro || 'Sin horario definido';
      if (!acc[time]) acc[time] = [];
      acc[time].push(order);
      return acc;
    }, {});
  },

  _emptyState(mensaje) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `
      <span class="empty-state__icon" aria-hidden="true">${mensaje ? '⚠️' : '🧺'}</span>
      <h2 class="empty-state__title">${mensaje ? 'No se pudo cargar' : 'Sin pedidos hoy'}</h2>
      <p class="empty-state__text">
        ${mensaje || 'Los pedidos aparecerán aquí cuando los clientes completen el checkout.'}
      </p>
    `;
    return div;
  },

  _renderGroup(time, orders) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplGroup);
    const node = tpl.content.cloneNode(true);
    const article = node.querySelector('.order-group');

    const subtotal = orders.reduce((s, o) => s + (Number(o.total) || 0), 0);

    node.querySelector('.order-group__time-value').textContent = time;
    node.querySelector('.order-group__count').textContent = pluralizeEs(orders.length, 'pedido');
    node.querySelector('.order-group__subtotal').textContent = Format.currency(subtotal);

    const tbody = node.querySelector('.order-table tbody');
    orders.forEach((order) => tbody.appendChild(this._renderRow(order)));

    return article;
  },

  _renderRow(order) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplRow);
    const row = tpl.content.cloneNode(true);
    const tr = row.querySelector('tr');

    const flow = ORDER_STATE_FLOW[order.estado] || ORDER_STATE_FLOW.pendiente;
    const esTerminal = !flow.siguiente; // 'entregada': ya no hay más pasos
    if (esTerminal) tr.classList.add('order-row--done');
    if (order.estado === 'en_preparacion') tr.classList.add('order-row--in-progress');

    row.querySelector('.order-table__id').textContent = order.numero || '—';
    row.querySelector('.order-table__cliente').textContent = order.cliente || '—';

    const tel = order.telefono || '';
    row.querySelector('.order-table__telefono').innerHTML = tel
      ? `<a href="tel:${escapeHTML(tel)}">${escapeHTML(tel)}</a>`
      : '—';

    const productos = (order.items || [])
      .map((p) => `${Number(p.cantidad) || 0}× ${escapeHTML(p.nombre)}`)
      .join('<br>');
    row.querySelector('.order-table__productos').innerHTML = productos || '—';

    row.querySelector('.order-table__total').textContent = Format.currency(order.total);

    const estadoCell = row.querySelector('.order-table__estado');
    if (esTerminal) {
      estadoCell.innerHTML = `
        <span class="order-status order-status--done">✓ ${escapeHTML(flow.label)}</span>
      `;
    } else {
      const siguienteEstado = flow.siguiente;
      const textoBoton = flow.accion;

      const badge = document.createElement('span');
      badge.className = `order-status order-status--${order.estado.replace(/_/g, '-')}`;
      badge.textContent = flow.label;
      estadoCell.appendChild(badge);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--action';
      btn.textContent = textoBoton;
      btn.disabled = false;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Guardando…';
        const ok = await Api.updateOrderStatus(order.numero, siguienteEstado);
        if (ok) {
          App.refresh();
        } else {
          btn.disabled = false;
          btn.textContent = '✗ Reintentar';
          btn.classList.add('btn--error');
          btn.title = 'No se pudo actualizar. Haz clic para intentar de nuevo.';
          setTimeout(() => {
            btn.textContent = textoBoton;
            btn.classList.remove('btn--error');
            btn.title = '';
          }, 3000);
        }
      });
      estadoCell.appendChild(btn);
    }

    return tr;
  },

  updateInsumosCount(lista) {
    const el = document.querySelector(CONFIG.SELECTORS.insumosCount);
    if (el) el.textContent = lista.length;
  },

  updateProductosCount(lista) {
    const el = document.querySelector(CONFIG.SELECTORS.productosCount);
    if (el) el.textContent = lista.length;
  },

  /** Llena los selects de producto de Recetas, Producción, Horneadas y
   *  Ajustes desde la tabla productos, en vez de las opciones fijas que
   *  antes estaban escritas en admin.html: un producto creado en esta
   *  pestaña tiene que aparecer solo en el resto del panel.
   *
   *  Los productos que ya no están activos se listan deshabilitados en
   *  vez de omitirse — si se omitieran, abrir para editar una horneada
   *  vieja de un producto descontinuado dejaría el select en blanco y al
   *  guardar cambiaría el producto del registro histórico. */
  fillProductoSelects(lista) {
    const selectores = [
      CONFIG.SELECTORS.recetaProducto,
      CONFIG.SELECTORS.produccionProducto,
      CONFIG.SELECTORS.horneadaProducto,
      CONFIG.SELECTORS.ajusteProducto,
    ];

    this.fillLotesProductoSelect(lista);
    this.fillMermasProductoSelect(lista);

    for (const selector of selectores) {
      const select = document.querySelector(selector);
      if (!select) continue;

      const valorActual = select.value;
      const placeholder = select.querySelector('option[value=""]');
      select.innerHTML = '';
      if (placeholder) select.appendChild(placeholder);

      for (const p of lista) {
        const opt = document.createElement('option');
        opt.value = String(p.id);
        const estaActivo = p.estado === 'activo';
        const estadoTexto = CONFIG.PRODUCTO_ESTADO_LABELS[p.estado]?.texto ?? p.estado;
        opt.textContent = estaActivo ? p.nombre : `${p.nombre} (${estadoTexto})`;
        opt.disabled = !estaActivo;
        select.appendChild(opt);
      }

      if (valorActual) select.value = valorActual;
    }
  },

  /** El select de producto del filtro de Lotes va aparte: acá los productos
   *  inactivos NO se deshabilitan, porque sus lotes históricos existen y son
   *  justamente los que se quiere poder revisar. */
  fillLotesProductoSelect(lista) {
    const select = document.querySelector(CONFIG.SELECTORS.lotesFiltroProducto);
    if (!select) return;

    const valorActual = select.value;
    select.innerHTML = '<option value="">Todos</option>';
    for (const p of lista) {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.nombre;
      select.appendChild(opt);
    }
    if (valorActual) select.value = valorActual;
  },

  /** Mismo criterio que fillLotesProductoSelect: el filtro de Mermas
   *  también necesita ver productos descontinuados, porque sus eventos de
   *  merma históricos siguen ahí. */
  fillMermasProductoSelect(lista) {
    const select = document.querySelector(CONFIG.SELECTORS.mermasFiltroProducto);
    if (!select) return;

    const valorActual = select.value;
    select.innerHTML = '<option value="">Todos</option>';
    for (const p of lista) {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.nombre;
      select.appendChild(opt);
    }
    if (valorActual) select.value = valorActual;
  },

  /** Tabla de Productos: mismo patrón que renderDiagnosticoPedidos (tabla
   *  estática en el HTML, esta función solo llena el <tbody>) — más simple
   *  que el patrón <template> de Insumos porque acá no hay tantas columnas
   *  ni casos especiales. Los botones usan delegación de eventos (un solo
   *  listener en el tbody, ver _bindEvents) en vez de uno por fila. */
  renderProductos(lista) {
    const tbody = document.querySelector(CONFIG.SELECTORS.productosTbody);
    const vacio = document.querySelector(CONFIG.SELECTORS.productosVacio);
    if (!tbody) return;

    if (lista.length === 0) {
      tbody.innerHTML = '';
      if (vacio) vacio.hidden = false;
      return;
    }
    if (vacio) vacio.hidden = true;

    tbody.innerHTML = lista
      .map((p) => {
        const categoriaLabel = CONFIG.PRODUCTO_CATEGORIA_LABELS[p.categoria] || p.categoria;
        const estadoInfo = CONFIG.PRODUCTO_ESTADO_LABELS[p.estado] || {
          texto: p.estado,
          badgeClase: 'insumo-badge--neutral',
        };
        const estadoBadge = `<span class="insumo-badge ${estadoInfo.badgeClase}">${escapeHTML(estadoInfo.texto)}</span>`;
        return `
          <tr>
            <td data-label="Nombre">${escapeHTML(p.nombre)}</td>
            <td data-label="Categoría">${escapeHTML(categoriaLabel)}</td>
            <td data-label="SKU">${p.sku ? escapeHTML(p.sku) : '—'}</td>
            <td data-label="Precio">${formatPrice(p.precio)}</td>
            <td data-label="Estado">${estadoBadge}</td>
            <td data-label="Acciones">
              <div class="insumo-table__acciones">
                <button type="button" class="btn btn--small btn--ghost" data-accion="editar-producto" data-id="${p.id}">
                  <i class="fa-solid fa-pen" aria-hidden="true"></i> Editar
                </button>
              </div>
            </td>
          </tr>
        `;
      })
      .join('');
  },

  renderInsumos(lista, huboErrorConexion) {
    const container = document.querySelector(CONFIG.SELECTORS.insumosContainer);
    container.innerHTML = '';

    if (huboErrorConexion) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">⚠️</span>
        <h2 class="empty-state__title">No se pudo conectar con el servidor</h2>
        <p class="empty-state__text">Verifica que el backend esté corriendo e intenta de nuevo.</p>
      `;
      container.appendChild(div);
      return;
    }

    if (lista.length === 0) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">📦</span>
        <h2 class="empty-state__title">Sin insumos registrados</h2>
        <p class="empty-state__text">Usa el formulario de arriba para agregar el primer insumo.</p>
      `;
      container.appendChild(div);
      return;
    }

    const table = document.createElement('table');
    table.className = 'insumo-table';
    table.innerHTML = `
      <caption class="visually-hidden">Detalle de insumos registrados</caption>
      <thead>
        <tr>
          <th scope="col">Insumo</th>
          <th scope="col">Categoría</th>
          <th scope="col">Cantidad</th>
          <th scope="col">Costo unit.</th>
          <th scope="col">Proveedor</th>
          <th scope="col">Marca</th>
          <th scope="col">SKU</th>
          <th scope="col">Vencimiento</th>
          <th scope="col">Ubicación</th>
          <th scope="col">Alérgenos</th>
          <th scope="col">Acciones</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    lista.forEach((insumo) => tbody.appendChild(this._renderInsumoRow(insumo)));

    container.appendChild(table);
  },

  _renderInsumoRow(insumo) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplInsumoRow);
    const row = tpl.content.cloneNode(true);
    const tr = row.querySelector('tr');

    const bajoMinimo =
      insumo.stockMinimo != null &&
      insumo.stockMinimo !== '' &&
      Number(insumo.cantidad) <= Number(insumo.stockMinimo);
    if (bajoMinimo) tr.classList.add('insumo-row--bajo-stock');

    row.querySelector('.insumo-table__nombre').textContent = insumo.nombre;
    row.querySelector('.insumo-table__categoria').textContent =
      CONFIG.CATEGORIA_LABELS[insumo.categoria] || insumo.categoria || '—';

    const cantidadCell = row.querySelector('.insumo-table__cantidad');
    cantidadCell.textContent = `${Format.cantidad(insumo.cantidad)} ${escapeHTML(insumo.unidad || '')}`;
    if (bajoMinimo) {
      const badge = document.createElement('span');
      badge.className = 'insumo-badge insumo-badge--bajo-stock';
      badge.textContent = 'Stock bajo';
      cantidadCell.appendChild(document.createElement('br'));
      cantidadCell.appendChild(badge);
    }

    row.querySelector('.insumo-table__costo').textContent =
      insumo.costoUnitario != null && insumo.costoUnitario !== ''
        ? Format.currency(insumo.costoUnitario)
        : '—';
    row.querySelector('.insumo-table__proveedor').textContent = insumo.proveedor || '—';
    row.querySelector('.insumo-table__marca').textContent = insumo.marca || '—';
    row.querySelector('.insumo-table__sku').textContent = insumo.sku || '—';
    row.querySelector('.insumo-table__ubicacion').textContent = insumo.ubicacion || '—';

    const vencimientoCell = row.querySelector('.insumo-table__vencimiento');
    if (!insumo.fechaVencimiento) {
      vencimientoCell.textContent = '—';
    } else {
      vencimientoCell.textContent = insumo.fechaVencimiento;
      const hoy = hoyHouston();
      const diasRestantes = Math.floor(
        (new Date(insumo.fechaVencimiento) - new Date(hoy)) / (1000 * 60 * 60 * 24),
      );
      if (diasRestantes < 0) {
        const badge = document.createElement('span');
        badge.className = 'insumo-badge insumo-badge--bajo-stock';
        badge.textContent = 'Vencido';
        vencimientoCell.appendChild(document.createElement('br'));
        vencimientoCell.appendChild(badge);
      } else if (diasRestantes <= 7) {
        const badge = document.createElement('span');
        badge.className = 'insumo-badge insumo-badge--por-vencer';
        badge.textContent = 'Por vencer';
        vencimientoCell.appendChild(document.createElement('br'));
        vencimientoCell.appendChild(badge);
      }
    }

    const alergenosCell = row.querySelector('.insumo-table__alergenos');
    alergenosCell.textContent =
      Array.isArray(insumo.alergenos) && insumo.alergenos.length > 0
        ? insumo.alergenos.map((a) => CONFIG.ALERGENO_LABELS[a] || a).join(', ')
        : '—';

    const acciones = row.querySelector('.insumo-table__acciones');

    const btnEditar = document.createElement('button');
    btnEditar.type = 'button';
    btnEditar.className = 'btn btn--action';
    btnEditar.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i> Editar';
    btnEditar.addEventListener('click', () => App.startEditInsumo(insumo.id));

    const btnEliminar = document.createElement('button');
    btnEliminar.type = 'button';
    btnEliminar.className = 'btn btn--ghost btn--danger';
    btnEliminar.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i> Eliminar';
    btnEliminar.addEventListener('click', () => App.deleteInsumo(insumo.id, insumo.nombre));

    acciones.appendChild(btnEditar);
    acciones.appendChild(btnEliminar);

    return tr;
  },

  updateProveedoresCount(lista) {
    const el = document.querySelector(CONFIG.SELECTORS.proveedoresCount);
    if (el) el.textContent = lista.length;
  },

  renderProveedores(lista, huboErrorConexion) {
    const container = document.querySelector(CONFIG.SELECTORS.proveedoresContainer);
    if (!container) return;
    container.innerHTML = '';

    if (huboErrorConexion) {
      container.appendChild(
        this._proveedorEmptyState(
          '⚠️',
          'No se pudo conectar con el servidor',
          'Verifica que el backend esté corriendo e intenta de nuevo.',
        ),
      );
      return;
    }

    if (lista.length === 0) {
      container.appendChild(
        this._proveedorEmptyState(
          '🚛',
          'Sin proveedores registrados',
          'Usa el formulario de arriba para agregar el primer proveedor.',
        ),
      );
      return;
    }

    const table = document.createElement('table');
    table.className = 'insumo-table proveedor-table';
    table.innerHTML = `
      <caption class="visually-hidden">Detalle de proveedores registrados</caption>
      <thead>
        <tr>
          <th scope="col">Proveedor</th>
          <th scope="col">Ident. fiscal</th>
          <th scope="col">Contacto</th>
          <th scope="col">Pago</th>
          <th scope="col">Logística</th>
          <th scope="col">Acciones</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    lista.forEach((proveedor) => tbody.appendChild(this._renderProveedorRow(proveedor)));

    container.appendChild(table);
  },

  _proveedorEmptyState(icono, titulo, texto) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `
      <span class="empty-state__icon" aria-hidden="true">${icono}</span>
      <h2 class="empty-state__title">${titulo}</h2>
      <p class="empty-state__text">${texto}</p>
    `;
    return div;
  },

  _renderProveedorRow(proveedor) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplProveedorRow);
    const row = tpl.content.cloneNode(true);
    const tr = row.querySelector('tr');

    const nombreCell = row.querySelector('.insumo-table__nombre');
    nombreCell.textContent = proveedor.razonSocial || '—';
    if (proveedor.nombreComercial) {
      const alias = document.createElement('small');
      alias.className = 'proveedor-table__alias';
      alias.textContent = proveedor.nombreComercial;
      nombreCell.appendChild(document.createElement('br'));
      nombreCell.appendChild(alias);
    }

    row.querySelector('.proveedor-table__fiscal').textContent =
      proveedor.identificacionFiscal || '—';

    const contacto = [proveedor.contactoNombre, proveedor.celular || proveedor.telefonoFijo]
      .filter(Boolean)
      .join(' · ');
    row.querySelector('.proveedor-table__contacto').textContent = contacto || '—';

    const pago = [
      CONFIG.CONDICIONES_PAGO_LABELS[proveedor.condicionesPago] || proveedor.condicionesPago,
      proveedor.moneda,
    ]
      .filter(Boolean)
      .join(' · ');
    row.querySelector('.proveedor-table__pago').textContent = pago || '—';

    const logistica = [
      proveedor.leadTimeDias != null ? `${Format.cantidad(proveedor.leadTimeDias)} días` : null,
      proveedor.pedidoMinimo != null ? `mín. ${Format.currency(proveedor.pedidoMinimo)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    row.querySelector('.proveedor-table__logistica').textContent = logistica || '—';

    const acciones = row.querySelector('.insumo-table__acciones');

    const btnEditar = document.createElement('button');
    btnEditar.type = 'button';
    btnEditar.className = 'btn btn--action';
    btnEditar.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i> Editar';
    btnEditar.addEventListener('click', () => App.startEditProveedor(proveedor.id));

    const btnEliminar = document.createElement('button');
    btnEliminar.type = 'button';
    btnEliminar.className = 'btn btn--ghost btn--danger';
    btnEliminar.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i> Eliminar';
    btnEliminar.addEventListener('click', () =>
      App.deleteProveedor(proveedor.id, proveedor.razonSocial),
    );

    acciones.appendChild(btnEditar);
    acciones.appendChild(btnEliminar);

    return tr;
  },

  updateHorneadasCount(lista) {
    const el = document.querySelector(CONFIG.SELECTORS.horneadasCount);
    if (el) el.textContent = lista.length;
  },

  /** Sugerencia de cuánto hornear mañana por producto: produccionSugeridaManana
   *  ya viene calculada del backend (ver AnalyticsEngine.enriquecerProductoConEstadisticas
   *  y calcularProduccionSugerida en estadisticas.js) — promedio histórico
   *  ajustado por estacionalidad del día, más el colchón de stock de
   *  seguridad (desviación estándar × 1.65, ~95% de no quedarse corto).
   *  Acá solo se pinta; el cálculo vive en un único lugar (el backend),
   *  no duplicado en el navegador. */
  renderSugerenciasHorneado(estadisticas) {
    const container = document.querySelector(CONFIG.SELECTORS.horneadasSugerencias);
    if (!container) return;
    container.innerHTML = '';

    if (!Array.isArray(estadisticas) || estadisticas.length === 0) return;

    const diaManana = diaSemanaMananaHouston();
    const labelDia = DIAS_SEMANA_LABELS[diaManana];

    const titulo = document.createElement('h2');
    titulo.className = 'sr-only';
    titulo.textContent = `Sugerencia de horneado para mañana (${labelDia})`;
    container.appendChild(titulo);

    const conDatos = estadisticas.filter((e) => e.produccionSugeridaManana !== null);
    const sinDatos = estadisticas.filter((e) => e.produccionSugeridaManana === null);

    conDatos
      .slice()
      .sort((a, b) => b.produccionSugeridaManana - a.produccionSugeridaManana)
      .forEach(({ productoNombre, produccionSugeridaManana, desviacionEstandarDemanda }) => {
        const card = document.createElement('article');
        card.className = 'stat-card';
        card.innerHTML = `
          <span class="stat-card__label">${escapeHTML(productoNombre)}</span>
          <data class="stat-card__value" value="${produccionSugeridaManana}">${produccionSugeridaManana}</data>
          <span class="stat-card__hint">±${desviacionEstandarDemanda} de variabilidad diaria</span>
        `;
        container.appendChild(card);
      });

    if (sinDatos.length > 0) {
      const nota = document.createElement('p');
      nota.className = 'insumo-form__hint';
      nota.textContent = `Todavía sin sugerencia por falta de historial de ventas: ${sinDatos
        .map((e) => e.productoNombre)
        .join(', ')}.`;
      container.appendChild(nota);
    }
  },

  /** Tarjeta de predicción por producto: qué modelo eligió AutoML por
   *  backtesting (ver autoML.js), su predicción para el próximo día y su
   *  margen de error (MAE del backtest — entre más bajo, más confiable
   *  fue esa técnica prediciendo los últimos días reales de ESE
   *  producto). Transparente a propósito: el nombre del modelo dice qué
   *  se eligió y por qué (no es una caja negra con solo un número). */
  renderProductosAutoML(predicciones) {
    const container = document.querySelector(CONFIG.SELECTORS.productosAutoML);
    if (!container) return;
    container.innerHTML = '';

    if (!Array.isArray(predicciones) || predicciones.length === 0) return;

    const titulo = document.createElement('h2');
    titulo.className = 'sr-only';
    titulo.textContent = 'Predicción de demanda elegida automáticamente por producto';
    container.appendChild(titulo);

    const conDatos = predicciones.filter((p) => !p.datosInsuficientes);
    const sinDatos = predicciones.filter((p) => p.datosInsuficientes);

    conDatos
      .slice()
      .sort((a, b) => b.prediccion - a.prediccion)
      .forEach(({ productoNombre, modeloElegido, prediccion, errorPromedio }) => {
        const card = document.createElement('article');
        card.className = 'stat-card';
        card.innerHTML = `
          <span class="stat-card__label">${escapeHTML(productoNombre)}</span>
          <data class="stat-card__value" value="${prediccion}">${prediccion}</data>
          <span class="stat-card__hint">${escapeHTML(modeloElegido)} · margen de error ±${errorPromedio}</span>
        `;
        container.appendChild(card);
      });

    if (sinDatos.length > 0) {
      const nota = document.createElement('p');
      nota.className = 'insumo-form__hint';
      nota.textContent = `Todavía sin suficiente historial para que AutoML elija un modelo: ${sinDatos
        .map((p) => p.productoNombre)
        .join(', ')}.`;
      container.appendChild(nota);
    }
  },

  /** Etiquetas legibles para lo que guarda auditoria_cadena — la tabla
   *  guarda nombres técnicos (entidad = nombre de tabla SQL, accion en
   *  minúscula) porque eso es lo que usan los otros endpoints; acá se
   *  traduce para la vista. */
  AUDITORIA_ENTIDAD_LABELS: {
    productos: 'Productos',
    horneadas: 'Horneadas',
    ajustes_inventario: 'Ajustes de inventario',
  },
  AUDITORIA_ACCION_LABELS: {
    crear: 'Crear',
    actualizar: 'Actualizar',
    eliminar: 'Eliminar',
  },

  /** Pinta toda la vista Auditoría: estado de integridad, tarjetas de
   *  resumen, dos "gráficos" de barras (con CSS, sin librería — mismo
   *  criterio de "vanilla" del resto del proyecto) para entidad/acción,
   *  línea de tiempo de actividad por día, y las dos tablas (registros
   *  con más cambios, últimos bloques). */
  renderAuditoria(analisis, bloques) {
    if (!analisis) return;

    // Integridad
    const integridadEl = document.querySelector(CONFIG.SELECTORS.auditoriaIntegridad);
    if (integridadEl) {
      const { integra, totalBloques, rotoEnId, motivo } = analisis.integridad;
      integridadEl.className = `auditoria-integridad ${
        integra ? 'auditoria-integridad--ok' : 'auditoria-integridad--rota'
      }`;
      integridadEl.innerHTML = integra
        ? `<i class="fa-solid fa-shield-halved" aria-hidden="true"></i>
           <div>
             <strong>Cadena íntegra</strong>
             <span>${totalBloques} bloque(s) verificado(s), ninguno alterado.</span>
           </div>`
        : `<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
           <div>
             <strong>Cadena rota en el bloque #${rotoEnId}</strong>
             <span>${escapeHTML(motivo)}</span>
           </div>`;
    }

    // Tarjetas de resumen
    const resumenEl = document.querySelector(CONFIG.SELECTORS.auditoriaResumen);
    if (resumenEl) {
      const totalCambios = analisis.porEntidad.reduce((suma, e) => suma + e.total, 0);
      const totalAtipicos =
        (analisis.atipicos?.atipicosIntervalo?.length ?? 0) +
        (analisis.atipicos?.atipicosTamano?.length ?? 0);
      resumenEl.innerHTML = `
        <article class="stat-card stat-card--accent">
          <span class="stat-card__label">Total de cambios registrados</span>
          <data class="stat-card__value" value="${totalCambios}">${totalCambios}</data>
        </article>
        <article class="stat-card">
          <span class="stat-card__label">Módulos con auditoría activa</span>
          <data class="stat-card__value" value="${analisis.porEntidad.length}">${analisis.porEntidad.length}</data>
        </article>
        <article class="stat-card">
          <span class="stat-card__label">Bloques atípicos</span>
          <data class="stat-card__value" value="${totalAtipicos}">${totalAtipicos}</data>
          <span class="stat-card__hint">${totalAtipicos ? 'Por ritmo de escritura o tamaño del cambio — ver abajo' : 'Ninguno fuera de lo esperado'}</span>
        </article>
      `;
    }

    this._renderAuditoriaPerfilado(analisis.perfilado);
    this._renderAuditoriaEDAVariable(
      CONFIG.SELECTORS.auditoriaEdaIntervalo,
      analisis.eda?.intervaloEntreBloquesSeg,
      { sufijo: 'seg' },
    );
    this._renderAuditoriaEDAVariable(
      CONFIG.SELECTORS.auditoriaEdaTamano,
      analisis.eda?.tamanoPayloadBytes,
      { sufijo: 'bytes' },
    );
    this._renderAuditoriaMatriz(analisis.matrizEntidadAccion);
    this._renderAuditoriaAtipicos(analisis.atipicos);
    this._renderAuditoriaDispersion(analisis.dispersion);

    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.auditoriaGraficoEntidad,
      analisis.porEntidad.map((e) => ({
        etiqueta: this.AUDITORIA_ENTIDAD_LABELS[e.entidad] || e.entidad,
        total: e.total,
      })),
    );
    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.auditoriaGraficoAccion,
      analisis.porAccion.map((a) => ({
        etiqueta: this.AUDITORIA_ACCION_LABELS[a.accion] || a.accion,
        total: a.total,
      })),
    );

    // Línea de tiempo (barras horizontales por día, mismo componente que
    // los otros dos "gráficos")
    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.auditoriaLineaTiempo,
      analisis.actividadPorDia.map((d) => ({ etiqueta: d.fecha, total: d.total })),
    );

    // Registros con más cambios
    const tbodyRegistros = document.querySelector(CONFIG.SELECTORS.auditoriaTablaRegistros);
    if (tbodyRegistros) {
      tbodyRegistros.innerHTML = analisis.entidadesMasModificadas.length
        ? analisis.entidadesMasModificadas
            .map(
              (r) => `
          <tr>
            <td>${escapeHTML(this.AUDITORIA_ENTIDAD_LABELS[r.entidad] || r.entidad)}</td>
            <td>${escapeHTML(String(r.entidadId))}</td>
            <td>${r.total}</td>
          </tr>`,
            )
            .join('')
        : '<tr><td colspan="3">Todavía no hay cambios registrados.</td></tr>';
    }

    // Últimos bloques
    const tbodyBloques = document.querySelector(CONFIG.SELECTORS.auditoriaTablaBloques);
    if (tbodyBloques) {
      const filas = Array.isArray(bloques) ? bloques.slice(0, 50) : [];
      tbodyBloques.innerHTML = filas.length
        ? filas
            .map((b) => {
              const fecha = new Date(b.creadoEn).toLocaleString('es-US', {
                timeZone: HOUSTON_TZ,
                dateStyle: 'medium',
                timeStyle: 'short',
              });
              return `
          <tr>
            <td>${escapeHTML(fecha)}</td>
            <td>${escapeHTML(this.AUDITORIA_ENTIDAD_LABELS[b.entidad] || b.entidad)}</td>
            <td>${escapeHTML(this.AUDITORIA_ACCION_LABELS[b.accion] || b.accion)}</td>
            <td>${escapeHTML(b.actualizadoPor || '—')}</td>
            <td><code class="auditoria-hash" title="${escapeHTML(b.hash)}">${escapeHTML(b.hash.slice(0, 12))}…</code></td>
          </tr>`;
            })
            .join('')
        : '<tr><td colspan="5">Todavía no hay bloques.</td></tr>';
    }
  },

  /** "Gráfico" de barras horizontales hecho con CSS puro (ancho en % del
   *  máximo del propio conjunto de datos) — sin librería de charts, para
   *  no meter una dependencia nueva solo para esto. */
  _renderAuditoriaBarras(selector, datos) {
    const container = document.querySelector(selector);
    if (!container) return;

    if (!datos.length) {
      container.innerHTML = '<p class="insumo-form__hint">Sin datos todavía.</p>';
      return;
    }

    const maximo = Math.max(...datos.map((d) => d.total), 1);
    container.innerHTML = datos
      .map(
        (d) => `
      <div class="auditoria-barra">
        <span class="auditoria-barra__etiqueta">${escapeHTML(d.etiqueta)}</span>
        <div class="auditoria-barra__pista">
          <div class="auditoria-barra__relleno" style="width: ${(d.total / maximo) * 100}%"></div>
        </div>
        <span class="auditoria-barra__valor">${d.total}</span>
      </div>`,
      )
      .join('');
  },

  /** Completitud por campo de la cadena (ver auditoriaAnalitica.js →
   *  perfilarCadena). Reutiliza .auditoria-barra: acá el ancho de la
   *  barra ya es un porcentaje directo (no hace falta dividir por un
   *  máximo del propio conjunto, como en los otros "gráficos"). */
  _renderAuditoriaPerfilado(perfilado) {
    const container = document.querySelector(CONFIG.SELECTORS.auditoriaPerfilado);
    if (!container) return;

    if (!perfilado || !perfilado.totalBloques) {
      container.innerHTML = '<p class="insumo-form__hint">Sin bloques todavía.</p>';
      return;
    }

    const rango = perfilado.rangoFechas
      ? `Del ${new Date(perfilado.rangoFechas.desde).toLocaleDateString('es-US', {
          timeZone: HOUSTON_TZ,
        })} al ${new Date(perfilado.rangoFechas.hasta).toLocaleDateString('es-US', {
          timeZone: HOUSTON_TZ,
        })}.`
      : '';

    container.innerHTML = `
      <p class="lotes-periodo">${perfilado.totalBloques} bloque(s) en la cadena. ${escapeHTML(rango)}</p>
      ${perfilado.campos
        .map(
          (c) => `
        <div class="auditoria-barra">
          <span class="auditoria-barra__etiqueta">${escapeHTML(c.etiqueta)}</span>
          <div class="auditoria-barra__pista">
            <div class="auditoria-barra__relleno" style="width: ${c.porcentajeCompletitud}%"></div>
          </div>
          <span class="auditoria-barra__valor">${c.porcentajeCompletitud}%</span>
        </div>`,
        )
        .join('')}
    `;
  },

  /** Una variable derivada (intervalo entre bloques o tamaño del
   *  payload): ficha con resumen de cinco números (mismo componente
   *  .lotes-ficha/.lotes-caja que ya usa Lotes) + histograma debajo. */
  _renderAuditoriaEDAVariable(selector, variable, { sufijo }) {
    const container = document.querySelector(selector);
    if (!container) return;

    if (!variable || variable.descriptivas.n === 0) {
      container.innerHTML = '<p class="insumo-form__hint">Sin datos suficientes todavía.</p>';
      return;
    }

    const d = variable.descriptivas;
    const rango = d.maximo - d.minimo;
    // Con todos los valores iguales la caja no tiene ancho: se dibuja
    // centrada en vez de dividir por cero (mismo criterio que Lotes).
    const pos = (valor) => (rango === 0 ? 50 : ((valor - d.minimo) / rango) * 100);
    const izquierda = pos(d.p25);
    const ancho = Math.max(pos(d.p75) - izquierda, 1);
    const maximoHist = Math.max(...variable.histograma.map((t) => t.total), 1);

    container.innerHTML = `
      <article class="lotes-ficha">
        <header class="lotes-ficha__header">
          <h4 class="lotes-ficha__titulo">Promedio</h4>
          <span class="lotes-ficha__n">n = ${d.n}</span>
        </header>
        <p class="lotes-ficha__valor">
          <data value="${d.media}">${d.media}</data>
          <span class="lotes-ficha__unidad">${sufijo}</span>
        </p>
        <p class="lotes-ficha__mediana">Mediana ${d.mediana} ${sufijo}</p>

        <div
          class="lotes-caja"
          role="img"
          aria-label="Mínimo ${d.minimo}, primer cuartil ${d.p25}, mediana ${d.mediana}, tercer cuartil ${d.p75}, máximo ${d.maximo} ${sufijo}"
        >
          <span class="lotes-caja__rango"></span>
          <span class="lotes-caja__iqr" style="left: ${izquierda}%; width: ${ancho}%"></span>
          <span class="lotes-caja__mediana" style="left: ${pos(d.mediana)}%"></span>
        </div>
        <div class="lotes-caja__escala">
          <span>${d.minimo}</span>
          <span>${d.p25} – ${d.p75} <small>(50% central)</small></span>
          <span>${d.maximo}</span>
        </div>

        <dl class="lotes-ficha__metricas">
          <div>
            <dt>Desviación</dt>
            <dd>${d.desviacion}</dd>
          </div>
          <div>
            <dt>Coef. variación</dt>
            <dd>${d.coeficienteVariacion === null ? '—' : `${d.coeficienteVariacion}%`}</dd>
          </div>
        </dl>
      </article>

      ${variable.histograma
        .map(
          (t) => `
        <div class="auditoria-barra">
          <span class="auditoria-barra__etiqueta">${t.desde}–${t.hasta}</span>
          <div class="auditoria-barra__pista">
            <div class="auditoria-barra__relleno" style="width: ${(t.total / maximoHist) * 100}%"></div>
          </div>
          <span class="auditoria-barra__valor">${t.total}</span>
        </div>`,
        )
        .join('')}
    `;
  },

  /** Tabla de contingencia entidad×acción como mapa de calor (celdas más
   *  oscuras = más bloques), más el veredicto de la prueba χ² de
   *  independencia. Ver auditoriaAnalitica.js → matrizEntidadAccion. */
  _renderAuditoriaMatriz(matriz) {
    const container = document.querySelector(CONFIG.SELECTORS.auditoriaMatriz);
    if (!container) return;

    if (!matriz || !matriz.entidades.length || !matriz.acciones.length) {
      container.innerHTML = '<p class="insumo-form__hint">Sin datos suficientes todavía.</p>';
      return;
    }

    const maximo = Math.max(...matriz.tabla.flat(), 1);

    const encabezado =
      `<div class="auditoria-matriz__celda auditoria-matriz__celda--header"></div>` +
      matriz.acciones
        .map(
          (a) =>
            `<div class="auditoria-matriz__celda auditoria-matriz__celda--header">${escapeHTML(
              this.AUDITORIA_ACCION_LABELS[a] || a,
            )}</div>`,
        )
        .join('');

    const filas = matriz.entidades
      .map((entidad, i) => {
        const etiqueta = `<div class="auditoria-matriz__celda auditoria-matriz__celda--header">${escapeHTML(
          this.AUDITORIA_ENTIDAD_LABELS[entidad] || entidad,
        )}</div>`;
        const celdas = matriz.tabla[i]
          .map((valor) => {
            const intensidad = Math.round((valor / maximo) * 85);
            return `<div class="auditoria-matriz__celda" style="background-color: color-mix(in srgb, var(--color-accent) ${intensidad}%, var(--color-surface))">
              <span class="auditoria-matriz__valor">${valor}</span>
            </div>`;
          })
          .join('');
        return etiqueta + celdas;
      })
      .join('');

    const indep = matriz.independencia;
    const veredicto =
      indep && indep.valido
        ? `<p class="lotes-cv ${indep.hipotesisNulaRechazada ? 'lotes-cv--info' : 'lotes-cv--baja'}">
             ${indep.hipotesisNulaRechazada ? 'El tipo de acción varía según el módulo' : 'El tipo de acción no depende del módulo'}
           </p>
           <p class="insumo-form__hint">${escapeHTML(indep.interpretacion)}</p>`
        : indep
          ? `<p class="insumo-form__hint">${escapeHTML(indep.motivo)}</p>`
          : '';

    container.innerHTML = `
      <div
        class="auditoria-matriz"
        style="grid-template-columns: minmax(9rem, auto) repeat(${matriz.acciones.length}, minmax(4rem, 1fr));"
      >
        ${encabezado}${filas}
      </div>
      ${veredicto}
    `;
  },

  /** Bloques que se salen de lo típico por intervalo o por tamaño (regla
   *  de Tukey). No es una lista de errores — un bloque atípico puede ser
   *  una operación masiva legítima — por eso el texto invita a revisar,
   *  no acusa. */
  _renderAuditoriaAtipicos(atipicos) {
    const container = document.querySelector(CONFIG.SELECTORS.auditoriaAtipicos);
    if (!container) return;

    const items = [
      ...(atipicos?.atipicosIntervalo ?? []).map((a) => ({
        icono: a.lado === 'alto' ? 'fa-hourglass-half' : 'fa-bolt',
        texto:
          a.lado === 'alto'
            ? 'Hueco inusualmente largo antes de este bloque'
            : 'Ráfaga: bloque casi inmediato al anterior',
        detalle: `Bloque #${a.id} · ${a.intervaloSeg}s desde el bloque anterior`,
      })),
      ...(atipicos?.atipicosTamano ?? []).map((a) => ({
        icono: 'fa-weight-hanging',
        texto: a.lado === 'alto' ? 'Payload inusualmente grande' : 'Payload inusualmente pequeño',
        detalle: `Bloque #${a.id} · ${a.tamanoBytes} bytes`,
      })),
    ];

    if (!items.length) {
      container.innerHTML =
        '<p class="insumo-form__hint">Sin bloques atípicos — el ritmo de escritura y el tamaño de los cambios se mantienen dentro de lo esperado.</p>';
      return;
    }

    container.innerHTML = `<ul class="lotes-veredictos">
      ${items
        .map(
          (it) => `
        <li>
          <i class="fa-solid ${it.icono}" aria-hidden="true"></i>
          <strong>${escapeHTML(it.texto)}</strong>
          <span>${escapeHTML(it.detalle)}</span>
        </li>`,
        )
        .join('')}
    </ul>`;
  },

  /** Dispersión real intervalo×tamaño por bloque, con los puntos de mayor
   *  puntaje de anomalía combinado resaltados en rojo. Existe porque
   *  porEntidad/porAccion (agregados) pueden verse idénticos en dos
   *  períodos con un ritmo de escritura muy distinto — ver la nota
   *  "cuarteto de Anscombe" en auditoriaAnalitica.js. */
  _renderAuditoriaDispersion(puntos) {
    const container = document.querySelector(CONFIG.SELECTORS.auditoriaDispersion);
    if (!container) return;

    const validos = (puntos ?? []).filter((p) => p.intervaloSeg !== null);
    if (validos.length < 2) {
      container.innerHTML =
        '<p class="insumo-form__hint">Hacen falta más bloques para dibujar el mapa.</p>';
      return;
    }

    const ANCHO = 640;
    const ALTO = 220;
    const PAD = 28;
    const maxX = Math.max(...validos.map((p) => p.intervaloSeg), 1);
    const maxY = Math.max(...validos.map((p) => p.tamanoBytes), 1);
    const x = (v) => PAD + (v / maxX) * (ANCHO - PAD * 2);
    const y = (v) => ALTO - PAD - (v / maxY) * (ALTO - PAD * 2);

    const circulos = validos
      .map((p) => {
        const atipico = (p.puntajeAnomalia ?? 0) >= 2;
        return `<circle
          class="auditoria-dispersion__punto${atipico ? ' auditoria-dispersion__punto--atipico' : ''}"
          cx="${x(p.intervaloSeg).toFixed(1)}" cy="${y(p.tamanoBytes).toFixed(1)}" r="${atipico ? 5 : 3.5}"
        ><title>Bloque #${p.id} · ${p.intervaloSeg}s · ${p.tamanoBytes} bytes</title></circle>`;
      })
      .join('');

    container.innerHTML = `
      <svg
        class="auditoria-dispersion"
        viewBox="0 0 ${ANCHO} ${ALTO}"
        role="img"
        aria-label="Intervalo entre bloques contra tamaño del payload; en rojo, los bloques con un puntaje de anomalía combinado alto"
      >
        <line x1="${PAD}" y1="${ALTO - PAD}" x2="${ANCHO - PAD}" y2="${ALTO - PAD}" class="auditoria-dispersion__eje" />
        <line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${ALTO - PAD}" class="auditoria-dispersion__eje" />
        ${circulos}
      </svg>
      <div class="lotes-serie__pie">
        <span>Intervalo entre bloques (seg) →</span>
        <span>↑ Tamaño del payload (bytes)</span>
      </div>
      <p class="insumo-form__hint">Cada punto es un bloque. Los puntos en rojo combinan un intervalo y un tamaño fuera de lo típico a la vez — vale la pena revisarlos aunque los conteos por módulo o acción se vean normales.</p>
    `;
  },

  /* ───────────────────────── LOTES ─────────────────────────
     Todo lo que se pinta acá viene calculado del backend (lotes.js):
     el panel no recalcula ni redondea nada, solo formatea. Los gráficos
     son CSS/SVG a mano, mismo criterio que Auditoría — sin librería. */

  LOTES_ESTADO_LABELS: {
    fresco: { texto: 'Fresco', badgeClase: 'insumo-badge--exito' },
    por_vencer: { texto: 'Por vencer', badgeClase: 'insumo-badge--por-vencer' },
    vencido: { texto: 'Vencido', badgeClase: 'insumo-badge--bajo-stock' },
    agotado: { texto: 'Agotado', badgeClase: 'insumo-badge--neutral' },
    sin_dato: { texto: 'Sin vida útil', badgeClase: 'insumo-badge--neutral' },
  },
  LOTES_SEVERIDAD_LABELS: {
    alta: { texto: 'Alta', badgeClase: 'insumo-badge--bajo-stock' },
    media: { texto: 'Media', badgeClase: 'insumo-badge--por-vencer' },
    baja: { texto: 'Baja', badgeClase: 'insumo-badge--neutral' },
  },
  LOTES_TENDENCIA_LABELS: {
    sube: { texto: 'Va en subida', icono: 'fa-arrow-trend-up' },
    baja: { texto: 'Va en bajada', icono: 'fa-arrow-trend-down' },
    estable: { texto: 'Estable', icono: 'fa-equals' },
    sin_datos: { texto: 'Sin datos suficientes', icono: 'fa-circle-question' },
  },

  /** Un número que puede ser null: "—" en vez de "null" o un 0 falso. Los
   *  valores capturados a mano pueden traer cola binaria (13.200000000003):
   *  se recortan a dos decimales para mostrarlos, sin tocar el dato. */
  _lotesNum(valor, sufijo = '') {
    if (valor === null || valor === undefined) return '—';
    const texto = typeof valor === 'number' ? String(Math.round(valor * 100) / 100) : valor;
    return `${texto}${sufijo}`;
  },

  /** Pinta la vista Lotes completa a partir de GET /lotes/analisis. */
  renderLotes(analisis, variableHistograma) {
    if (!analisis) return;

    const periodoEl = document.querySelector(CONFIG.SELECTORS.lotesPeriodo);
    if (periodoEl) {
      const { desde, hasta, dias } = analisis.periodo;
      periodoEl.textContent = `Período analizado: ${desde} a ${hasta} (${dias} día(s)) · ${analisis.resumen.totalLotes} lote(s).`;
    }

    this._renderLotesResumen(analisis.resumen);
    this._renderLotesTendencia(analisis.tendencias);
    this._renderLotesHistograma(analisis.descriptivas, variableHistograma);
    this._renderLotesDescriptivas(analisis.descriptivas);

    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.lotesGraficoProducto,
      analisis.porProducto.map((p) => ({ etiqueta: p.clave, total: p.unidades })),
    );
    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.lotesGraficoHora,
      analisis.porHora.map((h) => ({
        etiqueta: `${String(h.clave).padStart(2, '0')}:00`,
        total: h.lotes,
      })),
    );

    this._renderCorrelaciones(CONFIG.SELECTORS.lotesCorrelaciones, analisis.correlaciones);
    this._renderLotesAtipicos(analisis.atipicos);
    this._renderLotesCalidad(analisis.calidad);
    this._renderLotesTabla(analisis.lotes);
  },

  _renderLotesResumen(resumen) {
    const container = document.querySelector(CONFIG.SELECTORS.lotesResumen);
    if (!container) return;

    const porEstado = new Map(resumen.lotesPorEstado.map((e) => [e.estado, e.total]));
    const enRiesgo = (porEstado.get('por_vencer') ?? 0) + (porEstado.get('vencido') ?? 0);

    container.innerHTML = `
      <article class="stat-card stat-card--accent">
        <span class="stat-card__label">Lotes en el período</span>
        <data class="stat-card__value" value="${resumen.totalLotes}">${resumen.totalLotes}</data>
        <span class="stat-card__hint">${resumen.totalUnidades} unidad(es) horneada(s)</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">Vendido el mismo día</span>
        <data class="stat-card__value" value="${resumen.tasaVentaPct ?? 0}">${this._lotesNum(resumen.tasaVentaPct, '%')}</data>
        <span class="stat-card__hint">${resumen.unidadesVendidas} vendida(s), ${resumen.unidadesNoVendidas} sin vender</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">Merma real promedio</span>
        <data class="stat-card__value" value="${resumen.mermaPromedioPct ?? 0}">${this._lotesNum(resumen.mermaPromedioPct, '%')}</data>
        <span class="stat-card__hint">Desvío vs. receta: ${this._lotesNum(resumen.desvioMermaPromedioPp, ' pp')}</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">Segunda calidad</span>
        <data class="stat-card__value" value="${resumen.segundaCalidadPromedioPct ?? 0}">${this._lotesNum(resumen.segundaCalidadPromedioPct, '%')}</data>
        <span class="stat-card__hint">Promedio por lote</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">Lotes por vencer o vencidos</span>
        <data class="stat-card__value" value="${enRiesgo}">${enRiesgo}</data>
        <span class="stat-card__hint">${porEstado.get('agotado') ?? 0} agotado(s), ${porEstado.get('fresco') ?? 0} fresco(s)</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">Lotes trazables al proveedor</span>
        <data class="stat-card__value" value="${resumen.lotesTrazables}">${resumen.lotesTrazables}</data>
        <span class="stat-card__hint">Tiempo promedio en venderse: ${this._lotesNum(resumen.horasPromedioHastaAgotarse, ' h')}</span>
      </article>
    `;
  },

  /** Serie diaria como gráfico de líneas en SVG inline (unidades + media
   *  móvil de 7 días), más el veredicto de tendencia y la comparación
   *  entre la última semana y la anterior. */
  _renderLotesTendencia(tendencias) {
    const container = document.querySelector(CONFIG.SELECTORS.lotesTendencia);
    if (!container) return;

    const { serie, mediaMovilUnidades, unidades, merma, comparacionUnidades } = tendencias;
    if (!serie.length) {
      container.innerHTML = '<p class="insumo-form__hint">Sin lotes en el período.</p>';
      return;
    }

    const ANCHO = 640;
    const ALTO = 180;
    const maximo = Math.max(...serie.map((d) => d.unidades), 1);
    const x = (i) => (serie.length === 1 ? 0 : (i / (serie.length - 1)) * ANCHO);
    const y = (valor) => ALTO - (valor / maximo) * ALTO;
    const puntos = (valores) =>
      valores
        .map((valor, i) => (Number.isFinite(valor) ? `${x(i)},${y(valor)}` : null))
        .filter(Boolean)
        .join(' ');

    const veredicto = this.LOTES_TENDENCIA_LABELS[unidades.direccion];
    const veredictoMerma = this.LOTES_TENDENCIA_LABELS[merma.direccion];

    container.innerHTML = `
      <svg
        class="lotes-serie"
        viewBox="0 0 ${ANCHO} ${ALTO}"
        preserveAspectRatio="none"
        role="img"
        aria-label="Unidades horneadas por día y su media móvil de 7 días"
      >
        <polyline class="lotes-serie__linea" points="${puntos(serie.map((d) => d.unidades))}" />
        <polyline class="lotes-serie__media" points="${puntos(mediaMovilUnidades)}" />
      </svg>
      <div class="lotes-serie__pie">
        <span>${escapeHTML(serie[0].fecha)}</span>
        <span>máximo ${maximo} u/día</span>
        <span>${escapeHTML(serie[serie.length - 1].fecha)}</span>
      </div>
      <ul class="lotes-veredictos">
        <li>
          <i class="fa-solid ${veredicto.icono}" aria-hidden="true"></i>
          <strong>Unidades horneadas: ${escapeHTML(veredicto.texto)}</strong>
          ${
            unidades.datosInsuficientes
              ? `<span>Hacen falta al menos 7 días con datos (hay ${unidades.dias}).</span>`
              : `<span>${unidades.pendientePorDia > 0 ? '+' : ''}${this._lotesNum(unidades.pendientePorDia, ' u/día')} · la recta explica el ${Math.round(unidades.r2 * 100)}% de la variación.</span>`
          }
        </li>
        <li>
          <i class="fa-solid ${veredictoMerma.icono}" aria-hidden="true"></i>
          <strong>Merma real: ${escapeHTML(veredictoMerma.texto)}</strong>
          ${
            merma.datosInsuficientes
              ? `<span>Hacen falta al menos 7 días con merma registrada (hay ${merma.dias}).</span>`
              : `<span>${merma.pendientePorDia > 0 ? '+' : ''}${this._lotesNum(merma.pendientePorDia, ' pp/día')}.</span>`
          }
        </li>
        <li>
          <i class="fa-solid fa-scale-balanced" aria-hidden="true"></i>
          <strong>Últimos 7 días vs. los 7 anteriores</strong>
          ${
            comparacionUnidades.datosInsuficientes
              ? '<span>El período es más corto que dos semanas.</span>'
              : `<span>${comparacionUnidades.actual} u/día vs. ${comparacionUnidades.previa} u/día (${this._lotesNum(comparacionUnidades.variacionPct, '%')}).</span>`
          }
        </li>
      </ul>
    `;
  },

  _renderLotesHistograma(descriptivas, variable) {
    const elegida = descriptivas.find((d) => d.campo === variable) ?? descriptivas[0];
    const container = document.querySelector(CONFIG.SELECTORS.lotesHistograma);
    if (!container || !elegida) return;

    if (!elegida.histograma.length) {
      container.innerHTML = `<p class="insumo-form__hint">Ningún lote del período tiene ${escapeHTML(
        elegida.etiqueta.toLowerCase(),
      )} registrada.</p>`;
      return;
    }

    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.lotesHistograma,
      elegida.histograma.map((tramo) => ({
        etiqueta: `${tramo.desde}–${tramo.hasta} ${elegida.unidad}`,
        total: tramo.total,
      })),
    );
  },

  /** Qué tan disperso está el dato, en palabras: el coeficiente de
   *  variación es la desviación como porcentaje de la media, así que se
   *  puede leer igual para gramos, horas o porcentajes. */
  _lotesDispersion(cv) {
    if (cv === null || cv === undefined) return null;
    if (cv < 15) return { texto: 'Muy consistente', clase: 'lotes-cv--baja' };
    if (cv < 35) return { texto: 'Variación normal', clase: 'lotes-cv--media' };
    return { texto: 'Muy dispersa', clase: 'lotes-cv--alta' };
  },

  /** Una ficha por variable, con un resumen de cinco números dibujado como
   *  caja (mín — P25 — mediana — P75 — máx). Reemplaza a la tabla de diez
   *  columnas: se lee sin desplazarse en horizontal y la caja muestra de
   *  una la asimetría, que en la tabla había que deducir comparando
   *  números. */
  _renderLotesDescriptivas(descriptivas) {
    const container = document.querySelector(CONFIG.SELECTORS.lotesDescriptivas);
    if (!container) return;

    container.innerHTML = `<div class="lotes-descriptivas">${descriptivas
      .map((d) => this._renderLotesFichaDescriptiva(d))
      .join('')}</div>`;
  },

  _renderLotesFichaDescriptiva(d) {
    const cabecera = `
      <header class="lotes-ficha__header">
        <h4 class="lotes-ficha__titulo">${escapeHTML(d.etiqueta)}</h4>
        <span class="lotes-ficha__n">n = ${d.n}</span>
      </header>`;

    if (d.n === 0) {
      return `
      <article class="lotes-ficha lotes-ficha--sin-datos">
        ${cabecera}
        <p class="lotes-ficha__vacio">Ningún lote del período tiene este dato registrado.</p>
      </article>`;
    }

    const dispersion = this._lotesDispersion(d.coeficienteVariacion);
    const rango = d.maximo - d.minimo;
    // Con todos los valores iguales la caja no tiene ancho: se dibuja
    // centrada en vez de dividir por cero.
    const pos = (valor) => (rango === 0 ? 50 : ((valor - d.minimo) / rango) * 100);
    const izquierda = pos(d.p25);
    const ancho = Math.max(pos(d.p75) - izquierda, 1);

    return `
      <article class="lotes-ficha">
        ${cabecera}
        <p class="lotes-ficha__valor">
          <data value="${d.media}">${d.media}</data>
          <span class="lotes-ficha__unidad">${escapeHTML(d.unidad)}</span>
          <span class="lotes-ficha__valor-etiqueta">promedio</span>
        </p>
        <p class="lotes-ficha__mediana">Mediana ${d.mediana} ${escapeHTML(d.unidad)}</p>

        <div
          class="lotes-caja"
          role="img"
          aria-label="Mínimo ${d.minimo}, primer cuartil ${d.p25}, mediana ${d.mediana}, tercer cuartil ${d.p75}, máximo ${d.maximo} ${escapeHTML(d.unidad)}"
        >
          <span class="lotes-caja__rango"></span>
          <span class="lotes-caja__iqr" style="left: ${izquierda}%; width: ${ancho}%"></span>
          <span class="lotes-caja__mediana" style="left: ${pos(d.mediana)}%"></span>
        </div>
        <div class="lotes-caja__escala">
          <span>${d.minimo}</span>
          <span>${d.p25} – ${d.p75} <small>(50% central)</small></span>
          <span>${d.maximo}</span>
        </div>

        <dl class="lotes-ficha__metricas">
          <div>
            <dt>Desviación</dt>
            <dd>${this._lotesNum(d.desviacion)}</dd>
          </div>
          <div>
            <dt>Coef. variación</dt>
            <dd>${this._lotesNum(d.coeficienteVariacion, '%')}</dd>
          </div>
        </dl>
        ${dispersion ? `<p class="lotes-cv ${dispersion.clase}">${dispersion.texto}</p>` : ''}
      </article>`;
  },

  /** Fuerza de la asociación en palabras. El texto dice "se mueven juntas",
   *  no "una causa la otra": con estos datos no se puede afirmar causa. */
  _lotesFuerzaCorrelacion(r) {
    const abs = Math.abs(r);
    if (abs >= 0.7) return 'fuerte';
    if (abs >= 0.4) return 'moderada';
    if (abs >= 0.2) return 'débil';
    return 'casi nula';
  },

  /** Reutilizada por Lotes y Mermas — mismo componente visual, cada quien
   *  con su propio contenedor (por eso recibe el selector, no lo asume). */
  _renderCorrelaciones(selector, correlaciones) {
    const container = document.querySelector(selector);
    if (!container) return;

    container.innerHTML = `<div class="lotes-correlaciones">${correlaciones
      .map((c) => {
        if (c.datosInsuficientes) {
          return `
          <article class="lotes-correlacion lotes-correlacion--sin-datos">
            <h4>${escapeHTML(c.etiqueta)}</h4>
            <p>Sin datos suficientes (${c.n} lote(s) con ambas variables registradas).</p>
          </article>`;
        }
        const sentido = c.r > 0 ? 'en el mismo sentido' : 'en sentido contrario';
        return `
        <article class="lotes-correlacion">
          <h4>${escapeHTML(c.etiqueta)}</h4>
          <data class="lotes-correlacion__valor" value="${c.r}">r = ${c.r}</data>
          <p>Asociación ${this._lotesFuerzaCorrelacion(c.r)}, ${sentido}, sobre ${c.n} lote(s). Es asociación, no causa.</p>
        </article>`;
      })
      .join('')}</div>`;
  },

  _renderLotesAtipicos(atipicos) {
    const tbody = document.querySelector(CONFIG.SELECTORS.lotesTablaAtipicos);
    if (!tbody) return;

    tbody.innerHTML = atipicos.length
      ? atipicos
          .map(
            (a) => `
        <tr>
          <td data-label="Lote"><code class="lotes-table__codigo">${escapeHTML(a.codigo)}</code></td>
          <td data-label="Producto">${escapeHTML(a.productoNombre)}</td>
          <td data-label="Fecha">${escapeHTML(a.fecha)}</td>
          <td data-label="Variable">${escapeHTML(a.etiqueta)}</td>
          <td data-label="Valor">
            ${a.valor} ${escapeHTML(a.unidad)}
            <span class="insumo-badge ${a.lado === 'alto' ? 'insumo-badge--bajo-stock' : 'insumo-badge--por-vencer'}">
              ${a.lado === 'alto' ? 'Muy alto' : 'Muy bajo'}
            </span>
          </td>
        </tr>`,
          )
          .join('')
      : '<tr><td colspan="5">Ningún lote se sale del rango habitual del período.</td></tr>';
  },

  _renderLotesCalidad(calidad) {
    const container = document.querySelector(CONFIG.SELECTORS.lotesCalidad);
    if (container) {
      container.innerHTML = `
        <div class="stats">
          <article class="stat-card stat-card--accent">
            <span class="stat-card__label">Lotes sin observaciones</span>
            <data class="stat-card__value" value="${calidad.porcentajeSano}">${calidad.porcentajeSano}%</data>
            <span class="stat-card__hint">${calidad.lotesConHallazgos} de ${calidad.totalLotes} lote(s) con algo que revisar</span>
          </article>
          <article class="stat-card">
            <span class="stat-card__label">Hallazgos de severidad alta</span>
            <data class="stat-card__value" value="${calidad.porSeveridad.alta}">${calidad.porSeveridad.alta}</data>
            <span class="stat-card__hint">${calidad.porSeveridad.media} media(s), ${calidad.porSeveridad.baja} baja(s)</span>
          </article>
        </div>
      `;
    }

    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.lotesCompletitud,
      Array.isArray(calidad.completitud)
        ? calidad.completitud.map((c) => ({ etiqueta: c.etiqueta, total: c.porcentaje }))
        : [],
    );

    const hallazgosEl = document.querySelector(CONFIG.SELECTORS.lotesHallazgos);
    if (!hallazgosEl) return;
    hallazgosEl.innerHTML = calidad.porRegla.length
      ? `<ul class="lotes-hallazgos">${calidad.porRegla
          .map((r) => {
            const sev = this.LOTES_SEVERIDAD_LABELS[r.severidad];
            return `
          <li>
            <span class="insumo-badge ${sev.badgeClase}">${sev.texto}</span>
            <strong>${r.total} lote(s)</strong>
            <span>${escapeHTML(r.mensaje)}</span>
          </li>`;
          })
          .join('')}</ul>`
      : '<p class="insumo-form__hint">Ninguna regla de validación se disparó en el período.</p>';
  },

  _renderLotesTabla(lotes) {
    const tbody = document.querySelector(CONFIG.SELECTORS.lotesTabla);
    if (!tbody) return;

    if (!lotes.length) {
      tbody.innerHTML =
        '<tr><td colspan="7">No hay lotes en el período. Registra horneadas para verlos acá.</td></tr>';
      return;
    }

    tbody.innerHTML = lotes
      .map((lote) => {
        const estado = this.LOTES_ESTADO_LABELS[lote.estadoFrescura];
        const severidadPeor = ['alta', 'media', 'baja'].find((sev) =>
          lote.hallazgos.some((h) => h.severidad === sev),
        );
        const validacion = severidadPeor
          ? `<span class="insumo-badge ${this.LOTES_SEVERIDAD_LABELS[severidadPeor].badgeClase}" title="${escapeHTML(
              lote.hallazgos.map((h) => h.mensaje).join(' '),
            )}">${lote.hallazgos.length} observación(es)</span>`
          : '<span class="insumo-badge insumo-badge--exito">Sin observaciones</span>';

        return `
      <tr>
        <td data-label="Lote">
          <code class="lotes-table__codigo">${escapeHTML(lote.codigo)}</code>
          <span class="lotes-table__producto">${escapeHTML(lote.productoNombre)}</span>
        </td>
        <td data-label="Fecha y hora">
          ${escapeHTML(lote.fecha)}<span class="lotes-table__hora">${escapeHTML(lote.hora)}</span>
        </td>
        <td data-label="Unidades">
          ${lote.cantidad}
          <span class="lotes-table__vendidas">${this._lotesNum(lote.unidadesVendidas)} vendida(s)</span>
        </td>
        <td data-label="Merma real">${this._lotesNum(lote.mermaRealPct, '%')}</td>
        <td data-label="Estado">
          <span class="insumo-badge ${estado.badgeClase}">${estado.texto}</span>
        </td>
        <td data-label="Validación">${validacion}</td>
        <td data-label="Trazabilidad">
          <button
            type="button"
            class="btn btn--ghost btn--small"
            data-lote-accion="trazabilidad"
            data-id="${escapeHTML(lote.id)}"
          >
            <i class="fa-solid fa-diagram-project" aria-hidden="true"></i>
            Ver
          </button>
        </td>
      </tr>`;
      })
      .join('');
  },

  /** Modal de trazabilidad: el lote, su tanda de masa y, por cada insumo,
   *  el lote del proveedor con el que se hizo (y de qué orden de compra
   *  vino). Lo que no se puede rastrear se dice, no se rellena. */
  renderTrazabilidadLote(lote) {
    const body = document.querySelector(CONFIG.SELECTORS.loteTrazaBody);
    if (!body) return;

    const filas = lote.trazabilidad.length
      ? lote.trazabilidad
          .map(
            (t) => `
        <tr>
          <td data-label="Insumo">${escapeHTML(t.insumoNombre)}</td>
          <td data-label="Usado">${t.gramos} g</td>
          <td data-label="Lote del proveedor">${t.loteProveedor ? `<code class="lotes-table__codigo">${escapeHTML(t.loteProveedor)}</code>` : '<span class="insumo-badge insumo-badge--por-vencer">Sin lote</span>'}</td>
          <td data-label="Proveedor">${escapeHTML(t.proveedor ?? '—')}</td>
          <td data-label="Orden de compra">${escapeHTML(t.ordenNumero ?? '—')}</td>
          <td data-label="Vence (insumo)">${escapeHTML(t.fechaVencimiento ?? '—')}</td>
        </tr>`,
          )
          .join('')
      : '<tr><td colspan="6">La tanda de masa no tiene ingredientes registrados.</td></tr>';

    body.innerHTML = `
      <p class="oc-trazabilidad__cabecera">
        Lote <strong>${escapeHTML(lote.codigo)}</strong> · ${escapeHTML(lote.productoNombre)} ·
        ${escapeHTML(lote.fecha)} ${escapeHTML(lote.hora)} · ${lote.cantidad} unidad(es)
      </p>
      <div class="stats">
        <article class="stat-card">
          <span class="stat-card__label">Merma real / receta</span>
          <data class="stat-card__value" value="${lote.mermaRealPct ?? 0}">${this._lotesNum(lote.mermaRealPct, '%')}</data>
          <span class="stat-card__hint">Receta: ${this._lotesNum(lote.mermaEsperadaPct, '%')} · desvío ${this._lotesNum(lote.desvioMermaPp, ' pp')}</span>
        </article>
        <article class="stat-card">
          <span class="stat-card__label">Horneado real / receta</span>
          <data class="stat-card__value" value="${lote.temperaturaHorneadoRealC ?? 0}">${this._lotesNum(lote.temperaturaHorneadoRealC, ' °C')}</data>
          <span class="stat-card__hint">Receta: ${this._lotesNum(lote.temperaturaRecetaC, ' °C')} · ${this._lotesNum(lote.tiempoHorneadoRealMin, ' min')} vs. ${this._lotesNum(lote.tiempoRecetaMin, ' min')}</span>
        </article>
        <article class="stat-card">
          <span class="stat-card__label">Vence</span>
          <data class="stat-card__value" value="0">${escapeHTML(lote.vencimientoIso?.slice(0, 10) ?? '—')}</data>
          <span class="stat-card__hint">
            ${lote.vencimientoIso ? `A las ${escapeHTML(lote.vencimientoIso.slice(11, 16))} · ` : ''}vida
            útil: ${this._lotesNum(lote.vidaUtilHoras, ' h')}
          </span>
        </article>
      </div>
      <h3 class="section-subtitle">Tanda de masa de origen</h3>
      ${
        lote.produccionId
          ? `<p class="insumo-form__hint">Tanda del ${escapeHTML(lote.produccionFecha ?? '—')} ·
             masa ${this._lotesNum(lote.pesoTotalMasaG, ' g')} ·
             estimadas ${this._lotesNum(lote.unidadesEstimadas, ' u')} ·
             rendimiento vs. estimado ${this._lotesNum(lote.desvioRendimientoPct, '%')}</p>`
          : '<p class="insumo-form__hint">Este lote no tiene tanda de masa vinculada: la trazabilidad hacia los insumos se corta acá.</p>'
      }
      <div class="tabla-shell">
        <table class="insumo-table lotes-table">
          <thead>
            <tr>
              <th scope="col">Insumo</th>
              <th scope="col">Usado</th>
              <th scope="col">Lote del proveedor</th>
              <th scope="col">Proveedor</th>
              <th scope="col">Orden de compra</th>
              <th scope="col">Vence (insumo)</th>
            </tr>
          </thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
    `;
  },

  updateLotesCount(total) {
    const el = document.querySelector(CONFIG.SELECTORS.lotesCount);
    if (el) el.textContent = String(total);
  },

  /* ───────────────────────── MERMAS ─────────────────────────
     Todo lo que se pinta acá viene ya calculado del backend (mermas.js /
     mermasAnalitica.js / mermasModelos.js): el panel no recalcula nada,
     solo formatea. Reutiliza los mismos componentes visuales que Lotes
     (fichas descriptivas, barras, correlaciones) porque son el mismo
     tipo de contenido — no hace falta inventar un lenguaje visual nuevo
     para un módulo de análisis más. */

  updateMermasCount(total) {
    const el = document.querySelector(CONFIG.SELECTORS.mermasCount);
    if (el) el.textContent = String(total);
  },

  MERMAS_TIPO_LABELS: {
    coccion: { texto: 'Merma de cocción', unidad: '%' },
    ajuste_manual: { texto: 'Ajuste manual', unidad: 'unidades' },
    segunda_calidad: { texto: 'Segunda calidad', unidad: 'unidades' },
  },

  /** Pinta la vista Mermas completa a partir de GET /mermas/analisis. */
  renderMermas(datos) {
    if (!datos) return;

    const periodoEl = document.querySelector(CONFIG.SELECTORS.mermasPeriodo);
    if (periodoEl) {
      const { desde, hasta } = datos.rango;
      periodoEl.textContent = `Período analizado: ${desde} a ${hasta} · ${datos.eventos.length} evento(s) de merma.`;
    }

    this._renderMermasResumen(datos);
    this._renderMermasLimpieza(datos.limpieza);
    this._renderMermasDescriptivas(datos.analisis.univariado.porTipo);
    this._renderMermasCausas(datos.analisis.univariado.frecuenciaCausas);
    this._renderMermasCorrelaciones(datos.analisis.bivariado);
    this._renderMermasMultivariado(datos.analisis.multivariado);
    this._renderMermasHipotesisProducto(datos.analisis.hipotesis.productoConMasMermaVsSegundo);
    this._renderMermasHipotesisCausa(datos.analisis.hipotesis.causaEsIndependienteDelProducto);
    this._renderMermasModelo(datos.analisis.modeloPredictivo);
  },

  _renderMermasResumen(datos) {
    const container = document.querySelector(CONFIG.SELECTORS.mermasResumen);
    if (!container) return;

    const porTipo = new Map();
    for (const ev of datos.eventos) porTipo.set(ev.tipo, (porTipo.get(ev.tipo) ?? 0) + 1);
    const altoRiesgo = datos.eventos.filter(
      (ev) => ev.esAtipico && ev.ladoAtipico === 'alto',
    ).length;

    container.innerHTML = `
      <article class="stat-card">
        <span class="stat-card__label">Eventos de merma</span>
        <data class="stat-card__value" value="${datos.eventos.length}">${datos.eventos.length}</data>
        <span class="stat-card__hint">
          Cocción ${porTipo.get('coccion') ?? 0} · Ajustes ${porTipo.get('ajuste_manual') ?? 0} ·
          Segunda calidad ${porTipo.get('segunda_calidad') ?? 0}
        </span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">Datos imputados</span>
        <data class="stat-card__value" value="${datos.limpieza.nulosImputados}">${datos.limpieza.nulosImputados}</data>
        <span class="stat-card__hint">de ${datos.limpieza.nulosDetectados} valor(es) ausente(s) detectado(s)</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">Eventos atípicos</span>
        <data class="stat-card__value" value="${datos.limpieza.atipicosDetectados}">${datos.limpieza.atipicosDetectados}</data>
        <span class="stat-card__hint">por la regla de Tukey (IQR), calculada por tipo</span>
      </article>
      <article class="stat-card${altoRiesgo > 0 ? ' stat-card--accent' : ''}">
        <span class="stat-card__label">Lotes de alto riesgo</span>
        <data class="stat-card__value" value="${altoRiesgo}">${altoRiesgo}</data>
        <span class="stat-card__hint">merma de cocción marcada atípica hacia arriba</span>
      </article>
    `;
  },

  _renderMermasLimpieza(reporte) {
    const container = document.querySelector(CONFIG.SELECTORS.mermasLimpieza);
    if (!container) return;

    if (reporte.nulosDetectados === 0) {
      container.innerHTML =
        '<p class="insumo-form__hint">Ningún valor ausente en el período: no hizo falta imputar nada.</p>';
      return;
    }

    const porFuente = new Map();
    for (const imp of reporte.imputaciones) {
      porFuente.set(imp.fuente, (porFuente.get(imp.fuente) ?? 0) + 1);
    }
    const FUENTE_LABELS = {
      mediana_producto: 'con la mediana del mismo producto',
      mediana_global_tipo: 'con la mediana global de su tipo (poco historial propio)',
    };

    container.innerHTML = `
      <p>
        ${reporte.nulosImputados} de ${reporte.nulosDetectados} valor(es) ausente(s) se
        imputaron${reporte.imputacionesSinResolver ? `, ${reporte.imputacionesSinResolver} quedaron sin resolver por falta total de datos del tipo` : ''}:
      </p>
      <ul class="lotes-hallazgos">
        ${[...porFuente.entries()]
          .map(
            ([fuente, n]) =>
              `<li><span>${n}</span><span>${escapeHTML(FUENTE_LABELS[fuente] ?? fuente)}</span></li>`,
          )
          .join('')}
      </ul>
    `;
  },

  _renderMermasDescriptivas(porTipo) {
    const container = document.querySelector(CONFIG.SELECTORS.mermasDescriptivas);
    if (!container) return;

    const fichas = Object.entries(porTipo)
      .map(([tipo, datos]) => {
        const label = this.MERMAS_TIPO_LABELS[tipo];
        return this._renderLotesFichaDescriptiva({
          ...datos.descriptivas,
          etiqueta: label.texto,
          unidad: label.unidad,
        });
      })
      .join('');
    container.innerHTML = `<div class="lotes-descriptivas">${fichas}</div>`;
  },

  _renderMermasCausas(frecuencias) {
    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.mermasCausas,
      frecuencias.map((f) => ({ etiqueta: f.valor, total: f.conteo })),
    );
  },

  _renderMermasCorrelaciones(bivariado) {
    const ETIQUETAS = {
      mermaVsTemperatura: 'Merma vs. temperatura de horneado',
      mermaVsTiempoHorneado: 'Merma vs. tiempo de horneado',
      mermaVsVidaUtil: 'Merma vs. vida útil del producto',
    };
    const correlaciones = Object.entries(bivariado).map(([clave, valor]) => ({
      etiqueta: ETIQUETAS[clave] ?? clave,
      ...valor,
    }));
    this._renderCorrelaciones(CONFIG.SELECTORS.mermasCorrelaciones, correlaciones);
  },

  _renderMermasMultivariado(modelo) {
    const container = document.querySelector(CONFIG.SELECTORS.mermasMultivariado);
    if (!container) return;

    if (!modelo) {
      container.innerHTML =
        '<p class="insumo-form__hint">Todavía no hay suficientes lotes con temperatura, tiempo y vida útil registrados a la vez para ajustar el modelo.</p>';
      return;
    }

    const NOMBRES = {
      temperaturaC: 'Temperatura',
      tiempoMin: 'Tiempo de horno',
      vidaUtilHoras: 'Vida útil',
    };
    container.innerHTML = `
      <p>
        Merma de cocción (%) ≈ ${modelo.intercepto}
        ${modelo.coeficientes.map((c, i) => ` ${c >= 0 ? '+' : '−'} ${Math.abs(c)} × ${escapeHTML(NOMBRES[modelo.variables[i]])}`).join('')}
      </p>
      <p class="insumo-form__hint">
        R² = ${modelo.r2} (proporción de la variación de la merma que explican estas tres
        variables juntas) sobre ${modelo.n} lote(s).
      </p>
    `;
  },

  _renderMermasHipotesis(container, resultado, nombreA, nombreB) {
    if (!resultado.valido) {
      container.innerHTML = `<p class="insumo-form__hint">${escapeHTML(resultado.motivo)}</p>`;
      return;
    }
    const prueba = resultado.prueba;
    if (!prueba.valido) {
      container.innerHTML = `<p class="insumo-form__hint">${escapeHTML(prueba.motivo)}</p>`;
      return;
    }
    const badgeClase = prueba.hipotesisNulaRechazada
      ? 'insumo-badge--bajo-stock'
      : 'insumo-badge--neutral';
    container.innerHTML = `
      <p>
        <strong>${escapeHTML(nombreA)}</strong> (n=${prueba.nA ?? resultado.productoA?.n}) vs.
        <strong>${escapeHTML(nombreB)}</strong> (n=${prueba.nB ?? resultado.productoB?.n})
      </p>
      <p>
        t = ${prueba.estadisticoT ?? prueba.estadistico}, gl = ${prueba.gradosLibertad},
        p ${prueba.pValor !== undefined ? `= ${prueba.pValor}` : `${prueba.hipotesisNulaRechazada ? '<' : '≥'} ${prueba.alpha ?? 0.05} (vs. crítico ${prueba.valorCritico})`}
        <span class="insumo-badge ${badgeClase}">${prueba.hipotesisNulaRechazada ? 'Significativo' : 'No significativo'}</span>
      </p>
      <p class="insumo-form__hint">${escapeHTML(prueba.interpretacion)}${prueba.advertenciaMuestraPequena ? ` ${escapeHTML(prueba.advertenciaMuestraPequena)}` : ''}</p>
    `;
  },

  _renderMermasHipotesisProducto(resultado) {
    const container = document.querySelector(CONFIG.SELECTORS.mermasHipotesisProducto);
    if (!container) return;
    if (!resultado.valido) {
      container.innerHTML = `<p class="insumo-form__hint">${escapeHTML(resultado.motivo)}</p>`;
      return;
    }
    this._renderMermasHipotesis(
      container,
      resultado,
      resultado.productoA.nombre,
      resultado.productoB.nombre,
    );
  },

  _renderMermasHipotesisCausa(resultado) {
    const container = document.querySelector(CONFIG.SELECTORS.mermasHipotesisCausa);
    if (!container) return;
    if (!resultado.valido) {
      container.innerHTML = `<p class="insumo-form__hint">${escapeHTML(resultado.motivo)}</p>`;
      return;
    }
    const prueba = resultado.prueba;
    if (!prueba.valido) {
      container.innerHTML = `<p class="insumo-form__hint">${escapeHTML(prueba.motivo)}</p>`;
      return;
    }
    const badgeClase = prueba.hipotesisNulaRechazada
      ? 'insumo-badge--bajo-stock'
      : 'insumo-badge--neutral';
    container.innerHTML = `
      <p>Causas: ${resultado.causas.map(escapeHTML).join(', ')} · Productos: ${resultado.productos.length} más frecuentes</p>
      <p>
        χ² = ${prueba.estadistico}, gl = ${prueba.gradosLibertad}
        ${prueba.valorCritico !== null ? ` (crítico α=${prueba.alpha}: ${prueba.valorCritico})` : ''}
        <span class="insumo-badge ${badgeClase}">${prueba.hipotesisNulaRechazada ? 'Dependientes' : 'Independientes'}</span>
      </p>
      <p class="insumo-form__hint">${escapeHTML(prueba.interpretacion)}${prueba.advertenciaMuestraPequena ? ` ${escapeHTML(prueba.advertenciaMuestraPequena)}` : ''}</p>
    `;
  },

  _renderMermasModelo(modelo) {
    const container = document.querySelector(CONFIG.SELECTORS.mermasModelo);
    if (!container) return;

    if (!modelo) {
      container.innerHTML =
        '<p class="insumo-form__hint">Todavía no hay suficientes lotes de alto riesgo (o suficiente historial en general) para entrenar el clasificador con confianza.</p>';
      return;
    }

    const e = modelo.evaluacion;
    container.innerHTML = `
      <p>
        Entrenado con ${modelo.n} lote(s) (${modelo.casosAltoRiesgo} de alto riesgo) usando
        temperatura, tiempo de horno y vida útil.
      </p>
      <div class="stats">
        <article class="stat-card">
          <span class="stat-card__label">Exactitud</span>
          <data class="stat-card__value" value="${e.exactitud}">${Math.round(e.exactitud * 100)}%</data>
        </article>
        <article class="stat-card">
          <span class="stat-card__label">Precisión</span>
          <data class="stat-card__value" value="${e.precision ?? 0}">${e.precision === null ? '—' : `${Math.round(e.precision * 100)}%`}</data>
        </article>
        <article class="stat-card">
          <span class="stat-card__label">Exhaustividad</span>
          <data class="stat-card__value" value="${e.exhaustividad ?? 0}">${e.exhaustividad === null ? '—' : `${Math.round(e.exhaustividad * 100)}%`}</data>
        </article>
      </div>
      <p class="insumo-form__hint">
        Evaluado sobre los mismos datos de entrenamiento (in-sample): mide qué tan bien el
        modelo describe lo ya ocurrido, no cómo va a predecir un lote nunca visto.
      </p>
    `;
  },

  /* ───────────────────── CICLO DE PEDIDOS ─────────────────────
     Todo llega calculado del backend (pedidos.js): acá solo se pinta.
     Regla que se repite en cada bloque: un null es "no se midió" y se
     muestra como "—", nunca como 0 — un lead time de 0 min se leería como
     "instantáneo" cuando en realidad significa "sin historial". */

  updatePedidosCount(total) {
    const el = document.querySelector(CONFIG.SELECTORS.pedidosCount);
    if (el) el.textContent = String(total);
  },

  /** Minutos en la unidad que se lee mejor: 45 min, 2.5 h, 1.2 d. */
  _pedidosDuracion(minutos) {
    if (minutos === null || minutos === undefined) return '—';
    if (minutos < 60) return `${this._lotesNum(minutos)} min`;
    if (minutos < 60 * 24) return `${this._lotesNum(minutos / 60)} h`;
    return `${this._lotesNum(minutos / 1440)} d`;
  },

  PEDIDOS_DISPOSITIVO_ICONOS: {
    movil: 'fa-mobile-screen',
    tablet: 'fa-tablet-screen-button',
    escritorio: 'fa-desktop',
    bot: 'fa-robot',
    desconocido: 'fa-circle-question',
  },

  /** Pinta la vista Ciclo de pedidos a partir de GET /ordenes/analisis. */
  renderPedidos(analisis) {
    if (!analisis) return;

    const periodoEl = document.querySelector(CONFIG.SELECTORS.pedidosPeriodo);
    if (periodoEl) {
      const { desde, hasta } = analisis.periodo;
      periodoEl.textContent = `Período analizado: ${desde} a ${hasta} · ${analisis.resumen.pedidos} pedido(s).`;
    }

    this._renderPedidosResumen(analisis.resumen);
    this._renderPedidosLeadTime(analisis.leadTime);
    this._renderPedidosTendencia(analisis.tendencias);
    this._renderPedidosHistograma(analisis.histogramaLeadTime);
    this._renderPedidosDescriptivas(analisis.descriptivas);
    this._renderPedidosEmbudo(analisis.embudo);
    this._renderPedidosDispositivos(analisis.porDispositivo, analisis.resumen);

    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.pedidosGraficoHoraIngreso,
      analisis.porHoraIngreso.map((h) => ({ etiqueta: `${h.clave}:00`, total: h.pedidos })),
    );
    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.pedidosGraficoHoraRetiro,
      analisis.porHoraRetiro.map((h) => ({ etiqueta: `${h.clave}:00`, total: h.pedidos })),
    );

    this._renderPedidosAtipicos(analisis.atipicos);
    this._renderPedidosCalidad(analisis.calidad, analisis.completitud);
    this._renderPedidosTabla(analisis.pedidos);
  },

  _renderPedidosResumen(resumen) {
    const container = document.querySelector(CONFIG.SELECTORS.pedidosResumen);
    if (!container) return;

    container.innerHTML = `
      <article class="stat-card stat-card--accent">
        <span class="stat-card__label">Pedidos del período</span>
        <data class="stat-card__value" value="${resumen.pedidos}">${resumen.pedidos}</data>
        <span class="stat-card__hint">${resumen.unidades} unidad(es) vendida(s)</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">Entregados</span>
        <data class="stat-card__value" value="${resumen.porcentajeEntregado ?? 0}">${this._lotesNum(resumen.porcentajeEntregado, '%')}</data>
        <span class="stat-card__hint">${resumen.entregados} de ${resumen.pedidos} pedido(s)</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">Ingresos</span>
        <data class="stat-card__value" value="${resumen.ingresos}">${Format.currency(resumen.ingresos)}</data>
        <span class="stat-card__hint">Ticket promedio: ${resumen.ticketPromedio === null ? '—' : Format.currency(resumen.ticketPromedio)}</span>
      </article>
      <article class="stat-card">
        <span class="stat-card__label">Checkout desde el teléfono</span>
        <data class="stat-card__value" value="${resumen.porcentajeMovil ?? 0}">${this._lotesNum(resumen.porcentajeMovil, '%')}</data>
        <span class="stat-card__hint">Sobre ${resumen.pedidosConMetadatos} pedido(s) con dato de dispositivo</span>
      </article>
    `;
  },

  /** Tiempo por etapa: la etapa más lenta por MEDIANA es el cuello de
   *  botella (un solo pedido olvidado toda la noche movería el promedio lo
   *  suficiente para señalar la etapa equivocada). */
  _renderPedidosLeadTime(leadTime) {
    const container = document.querySelector(CONFIG.SELECTORS.pedidosLeadTime);
    if (!container) return;

    if (leadTime.datosInsuficientes) {
      container.innerHTML = `
        <p class="insumo-form__hint">
          Todavía no hay transiciones de estado registradas en el período, así que no se puede medir
          cuánto tarda cada etapa. Los tiempos aparecen a medida que los pedidos se avanzan desde el
          panel (Recibida → En preparación → Preparada → Entregada).
        </p>`;
      return;
    }

    const maximo = Math.max(...leadTime.etapas.map((e) => e.mediana ?? 0), 1);
    const barras = leadTime.etapas
      .map((etapa) => {
        const esCuello = leadTime.cuelloDeBotella?.estado === etapa.estado;
        return `
        <div class="auditoria-barra">
          <span class="auditoria-barra__etiqueta">${escapeHTML(etapa.etiqueta)}${esCuello ? ' ⏱' : ''}</span>
          <div class="auditoria-barra__pista">
            <div class="auditoria-barra__relleno" style="width: ${((etapa.mediana ?? 0) / maximo) * 100}%"></div>
          </div>
          <span class="auditoria-barra__valor">${this._pedidosDuracion(etapa.mediana)}</span>
        </div>`;
      })
      .join('');

    const cuello = leadTime.cuelloDeBotella;
    container.innerHTML = `
      <div class="stats">
        <article class="stat-card stat-card--accent">
          <span class="stat-card__label">Lead time total (mediana)</span>
          <data class="stat-card__value" value="${leadTime.total.mediana ?? 0}">${this._pedidosDuracion(leadTime.total.mediana)}</data>
          <span class="stat-card__hint">Promedio ${this._pedidosDuracion(leadTime.total.media)} sobre ${leadTime.total.pedidosMedidos} pedido(s) entregado(s)</span>
        </article>
        <article class="stat-card">
          <span class="stat-card__label">Cuello de botella</span>
          <data class="stat-card__value" value="${cuello ? cuello.medianaMin : 0}">${cuello ? escapeHTML(cuello.etiqueta) : '—'}</data>
          <span class="stat-card__hint">${cuello ? `${this._pedidosDuracion(cuello.medianaMin)} de mediana en ${cuello.pedidosMedidos} pedido(s)` : 'Sin etapas medibles'}</span>
        </article>
        <article class="stat-card">
          <span class="stat-card__label">Pedido más lento</span>
          <data class="stat-card__value" value="${leadTime.total.maximo ?? 0}">${this._pedidosDuracion(leadTime.total.maximo)}</data>
          <span class="stat-card__hint">El más rápido: ${this._pedidosDuracion(leadTime.total.minimo)}</span>
        </article>
      </div>
      <p class="insumo-form__hint">
        Mediana de minutos que el pedido pasa en cada etapa. Se usa la mediana y no el promedio: un
        solo pedido olvidado de un día para otro bastaría para señalar la etapa equivocada.
      </p>
      ${barras}
    `;
  },

  _renderPedidosTendencia(tendencias) {
    const container = document.querySelector(CONFIG.SELECTORS.pedidosTendencia);
    if (!container) return;

    const { pedidos, leadTime, comparacionPedidos } = tendencias;
    const direccion = (t) => this.LOTES_TENDENCIA_LABELS[t.direccion] ?? { texto: '—', icono: '' };
    const dirPedidos = direccion(pedidos);
    const dirLeadTime = direccion(leadTime);

    container.innerHTML = `
      <ul class="lotes-veredictos">
        <li>
          <i class="fa-solid ${dirPedidos.icono}" aria-hidden="true"></i>
          <strong>Pedidos por día: ${escapeHTML(dirPedidos.texto)}</strong>
          ${
            pedidos.datosInsuficientes
              ? `<span>Hacen falta al menos 7 días con datos (hay ${pedidos.dias}).</span>`
              : `<span>${pedidos.pendientePorDia > 0 ? '+' : ''}${this._lotesNum(pedidos.pendientePorDia, ' pedidos/día')} · la recta explica el ${Math.round(pedidos.r2 * 100)}% de la variación.</span>`
          }
        </li>
        <li>
          <i class="fa-solid ${dirLeadTime.icono}" aria-hidden="true"></i>
          <strong>Lead time medio diario: ${escapeHTML(dirLeadTime.texto)}</strong>
          ${
            leadTime.datosInsuficientes
              ? `<span>Hacen falta al menos 7 días con pedidos entregados (hay ${leadTime.dias}).</span>`
              : `<span>${leadTime.pendientePorDia > 0 ? '+' : ''}${this._lotesNum(leadTime.pendientePorDia, ' min/día')}. Si sube, la cocina se está atrasando.</span>`
          }
        </li>
        <li>
          <i class="fa-solid fa-scale-balanced" aria-hidden="true"></i>
          <strong>Últimos 7 días vs. los 7 anteriores</strong>
          ${
            comparacionPedidos.datosInsuficientes
              ? '<span>El período es más corto que dos semanas.</span>'
              : `<span>${comparacionPedidos.actual} pedidos/día vs. ${comparacionPedidos.previa} pedidos/día (${this._lotesNum(comparacionPedidos.variacionPct, '%')}).</span>`
          }
        </li>
      </ul>
    `;
  },

  _renderPedidosHistograma(histograma) {
    const container = document.querySelector(CONFIG.SELECTORS.pedidosHistograma);
    if (!container) return;

    if (!histograma.length) {
      container.innerHTML =
        '<p class="insumo-form__hint">Ningún pedido del período tiene lead time medible: hace falta que el pedido llegue a "Entregada" con su historial registrado.</p>';
      return;
    }

    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.pedidosHistograma,
      histograma.map((tramo) => ({
        etiqueta: `${tramo.desde}–${tramo.hasta} min`,
        total: tramo.total,
      })),
    );
  },

  /** Mismas fichas que en Lotes (mín — P25 — mediana — P75 — máx): la
   *  descriptiva se lee sin desplazarse en horizontal. */
  _renderPedidosDescriptivas(descriptivas) {
    const container = document.querySelector(CONFIG.SELECTORS.pedidosDescriptivas);
    if (!container) return;

    container.innerHTML = `<div class="lotes-descriptivas">${descriptivas
      .map((d) =>
        this._renderLotesFichaDescriptiva({
          ...d,
          etiqueta: d.variable,
          campo: d.variable,
        }),
      )
      .join('')}</div>`;
  },

  /** Embudo: cuántos pedidos alcanzaron cada etapa. Donde cae el porcentaje
   *  es donde se pierden los pedidos (o donde se dejó de registrar). */
  _renderPedidosEmbudo(embudo) {
    const container = document.querySelector(CONFIG.SELECTORS.pedidosEmbudo);
    if (!container) return;

    const maximo = Math.max(...embudo.map((e) => e.pedidos), 1);
    container.innerHTML = `
      <div>
        ${embudo
          .map(
            (paso) => `
          <div class="auditoria-barra">
            <span class="auditoria-barra__etiqueta">${escapeHTML(paso.etiqueta)}</span>
            <div class="auditoria-barra__pista">
              <div class="auditoria-barra__relleno" style="width: ${(paso.pedidos / maximo) * 100}%"></div>
            </div>
            <span class="auditoria-barra__valor">
              ${paso.pedidos}
              ${paso.conversionDesdeAnterior === null ? '' : `<small>(${this._lotesNum(paso.conversionDesdeAnterior, '%')})</small>`}
            </span>
          </div>`,
          )
          .join('')}
      </div>
      <p class="insumo-form__hint">
        El porcentaje es la conversión desde la etapa anterior. Un pedido cuenta como que alcanzó la
        etapa si su historial la registra o si su estado actual ya está más adelante.
      </p>
    `;
  },

  _renderPedidosDispositivos(porDispositivo, resumen) {
    const container = document.querySelector(CONFIG.SELECTORS.pedidosDispositivos);
    if (!container) return;

    if (!porDispositivo.length) {
      container.innerHTML =
        '<p class="insumo-form__hint">Todavía no hay pedidos en el período.</p>';
      return;
    }

    const fichas = porDispositivo
      .map(
        (d) => `
      <article class="stat-card">
        <span class="stat-card__label">
          <i class="fa-solid ${this.PEDIDOS_DISPOSITIVO_ICONOS[d.clave] ?? 'fa-circle-question'}" aria-hidden="true"></i>
          ${escapeHTML(d.etiqueta)}
        </span>
        <data class="stat-card__value" value="${d.pedidos}">${this._lotesNum(d.porcentajePedidos, '%')}</data>
        <span class="stat-card__hint">
          ${d.pedidos} pedido(s) · ${Format.currency(d.ingresos)} (${this._lotesNum(d.porcentajeIngresos, '%')} de los ingresos) ·
          ticket ${Format.currency(d.ticketPromedio)}
        </span>
      </article>`,
      )
      .join('');

    container.innerHTML = `
      <div class="stats">${fichas}</div>
      <p class="insumo-form__hint">
        El dispositivo se deduce del User-Agent que envía el navegador al crear el pedido. Los
        pedidos anteriores a esta captura aparecen como "Sin dato" y no cuentan para el
        ${this._lotesNum(resumen.porcentajeMovil, '%')} de checkout móvil.
      </p>
    `;
  },

  _renderPedidosAtipicos(atipicos) {
    const tbody = document.querySelector(CONFIG.SELECTORS.pedidosTablaAtipicos);
    if (!tbody) return;

    tbody.innerHTML = atipicos.length
      ? atipicos
          .map(
            (a) => `
        <tr>
          <td data-label="Pedido"><code class="lotes-table__codigo">${escapeHTML(a.numero)}</code></td>
          <td data-label="Cliente">${escapeHTML(a.cliente)}</td>
          <td data-label="Fecha">${escapeHTML(a.fecha)}</td>
          <td data-label="Lead time">
            ${this._pedidosDuracion(a.valor)}
            <span class="insumo-badge ${a.lado === 'alto' ? 'insumo-badge--bajo-stock' : 'insumo-badge--por-vencer'}">
              ${a.lado === 'alto' ? 'Muy lento' : 'Muy rápido'}
            </span>
          </td>
        </tr>`,
          )
          .join('')
      : '<tr><td colspan="4">Ningún pedido se sale del rango habitual del período.</td></tr>';
  },

  _renderPedidosCalidad(calidad, completitud) {
    const container = document.querySelector(CONFIG.SELECTORS.pedidosCalidad);
    if (container) {
      container.innerHTML = `
        <div class="stats">
          <article class="stat-card stat-card--accent">
            <span class="stat-card__label">Pedidos sin observaciones</span>
            <data class="stat-card__value" value="${calidad.porcentajeSano}">${calidad.porcentajeSano}%</data>
            <span class="stat-card__hint">${calidad.pedidosConHallazgos} de ${calidad.totalPedidos} pedido(s) con algo que revisar</span>
          </article>
          <article class="stat-card">
            <span class="stat-card__label">Hallazgos de severidad alta</span>
            <data class="stat-card__value" value="${calidad.porSeveridad.alta}">${calidad.porSeveridad.alta}</data>
            <span class="stat-card__hint">${calidad.porSeveridad.media} media(s), ${calidad.porSeveridad.baja} baja(s)</span>
          </article>
        </div>
      `;
    }

    this._renderAuditoriaBarras(
      CONFIG.SELECTORS.pedidosCompletitud,
      Array.isArray(completitud)
        ? completitud.map((c) => ({ etiqueta: c.etiqueta, total: c.porcentaje }))
        : [],
    );

    const hallazgosEl = document.querySelector(CONFIG.SELECTORS.pedidosHallazgos);
    if (!hallazgosEl) return;
    hallazgosEl.innerHTML = calidad.porRegla.length
      ? `<ul class="lotes-hallazgos">${calidad.porRegla
          .map((r) => {
            const sev = this.LOTES_SEVERIDAD_LABELS[r.severidad];
            return `
          <li>
            <span class="insumo-badge ${sev.badgeClase}">${sev.texto}</span>
            <strong>${r.total} pedido(s)</strong>
            <span>${escapeHTML(r.mensaje)}</span>
          </li>`;
          })
          .join('')}</ul>`
      : '<p class="insumo-form__hint">Ninguna regla de validación se disparó en el período.</p>';
  },

  _renderPedidosTabla(pedidos) {
    const tbody = document.querySelector(CONFIG.SELECTORS.pedidosTabla);
    if (!tbody) return;

    if (!pedidos.length) {
      tbody.innerHTML = '<tr><td colspan="6">No hay pedidos en el período seleccionado.</td></tr>';
      return;
    }

    tbody.innerHTML = pedidos
      .map(
        (pedido) => `
      <tr>
        <td data-label="Pedido">
          <code class="lotes-table__codigo">${escapeHTML(pedido.numero)}</code>
          <span class="lotes-table__vendidas">${escapeHTML(pedido.fecha)} ${escapeHTML(pedido.hora)}</span>
        </td>
        <td data-label="Cliente">
          ${escapeHTML(pedido.cliente)}
          <span class="lotes-table__vendidas">${pedido.unidades} u · ${Format.currency(pedido.total)}</span>
        </td>
        <td data-label="Estado">
          ${escapeHTML(pedido.etiquetaEstado)}
          <span class="lotes-table__vendidas">
            <i class="fa-solid ${this.PEDIDOS_DISPOSITIVO_ICONOS[pedido.dispositivo] ?? 'fa-circle-question'}" aria-hidden="true"></i>
            ${escapeHTML(pedido.dispositivo ?? 'sin dato')}
          </span>
        </td>
        <td data-label="Etapas (min)">
          <span class="lotes-table__vendidas">Prep.: ${this._pedidosDuracion(pedido.minutosEnPreparacion)}</span>
          <span class="lotes-table__vendidas">Espera: ${this._pedidosDuracion(pedido.minutosEsperandoRetiro)}</span>
        </td>
        <td data-label="Lead time">${this._pedidosDuracion(pedido.leadTimeTotalMin)}</td>
        <td data-label="Historial">
          <button
            type="button"
            class="btn btn--ghost btn--small"
            data-pedido-accion="historial"
            aria-label="Ver historial del pedido ${escapeHTML(pedido.numero)}"
            data-numero="${escapeHTML(pedido.numero)}"
          >
            Ver
          </button>
        </td>
      </tr>`,
      )
      .join('');
  },

  /** Cómo se lee una etapa de la línea de tiempo. La última etapa nunca
   *  tiene duración (no hay transición siguiente que la cierre): en un
   *  pedido entregado eso es el final del ciclo, no una espera abierta. */
  _pedidosEstadoEtapa(etapa) {
    if (!etapa.abierta) return `Duró ${this._pedidosDuracion(etapa.minutos)}`;
    return etapa.estado === 'entregada' ? 'Fin del ciclo' : 'Etapa en curso';
  },

  /** Línea de tiempo de un pedido: cada transición con su hora, cuánto duró
   *  la etapa y quién la movió. */
  renderHistorialPedido(pedido) {
    const body = document.querySelector(CONFIG.SELECTORS.pedidoHistorialBody);
    if (!body) return;

    const etapas = pedido.lineaTiempo.etapas;
    const timeline = etapas.length
      ? `<ul class="lotes-veredictos">${etapas
          .map(
            (etapa) => `
        <li>
          <i class="fa-solid fa-clock" aria-hidden="true"></i>
          <strong>${escapeHTML(etapa.etiqueta)} · ${new Date(etapa.desde).toLocaleString('es-CO')}</strong>
          <span>
            ${this._pedidosEstadoEtapa(etapa)} ·
            ${etapa.usuarioAdmin ? `movido por ${escapeHTML(etapa.usuarioAdmin)}` : 'sin operario declarado'}
          </span>
        </li>`,
          )
          .join('')}</ul>`
      : `<p class="insumo-form__hint">
           Este pedido no tiene transiciones registradas: se creó antes de que existiera el historial
           de estados, así que su lead time no se puede reconstruir.
         </p>`;

    const problemas = pedido.problemas.length
      ? `<ul class="lotes-hallazgos">${pedido.problemas
          .map((p) => {
            const sev = this.LOTES_SEVERIDAD_LABELS[p.severidad];
            return `<li><span class="insumo-badge ${sev.badgeClase}">${sev.texto}</span><strong></strong><span>${escapeHTML(p.mensaje)}</span></li>`;
          })
          .join('')}</ul>`
      : '';

    body.innerHTML = `
      <div class="stats">
        <article class="stat-card stat-card--accent">
          <span class="stat-card__label">${escapeHTML(pedido.numero)}</span>
          <data class="stat-card__value" value="${pedido.total}">${Format.currency(pedido.total)}</data>
          <span class="stat-card__hint">${escapeHTML(pedido.cliente)} · retiro ${escapeHTML(pedido.retiro)} · ${pedido.unidades} u</span>
        </article>
        <article class="stat-card">
          <span class="stat-card__label">Lead time total</span>
          <data class="stat-card__value" value="${pedido.leadTimeTotalMin ?? 0}">${this._pedidosDuracion(pedido.leadTimeTotalMin)}</data>
          <span class="stat-card__hint">${pedido.entregada ? 'Pedido entregado' : 'Todavía en curso'}</span>
        </article>
        <article class="stat-card">
          <span class="stat-card__label">Checkout</span>
          <data class="stat-card__value" value="0">${escapeHTML(pedido.dispositivo ?? 'sin dato')}</data>
          <span class="stat-card__hint">${escapeHTML(pedido.zonaHoraria ?? 'zona horaria sin dato')} · ${escapeHTML(pedido.idioma ?? 'idioma sin dato')}</span>
        </article>
      </div>
      ${timeline}
      ${problemas}
    `;
  },

  /** Tarjetas de resumen: total de panes horneados en la fecha consultada y
   *  desglose por producto, para leer de un vistazo la producción del día
   *  sin tener que sumar filas de la tabla a mano. */
  renderHorneadaResumen(lista, fecha) {
    const container = document.querySelector(CONFIG.SELECTORS.horneadasResumen);
    if (!container) return;
    container.innerHTML = '';

    if (!Array.isArray(lista) || lista.length === 0) return;

    const totalPanes = lista.reduce((sum, h) => sum + Number(h.cantidad || 0), 0);
    const porProducto = new Map();
    lista.forEach((h) => {
      porProducto.set(h.productoNombre, (porProducto.get(h.productoNombre) || 0) + h.cantidad);
    });

    const fechaLabel = document.createElement('h2');
    fechaLabel.className = 'sr-only';
    fechaLabel.textContent = `Resumen de producción — ${fecha}`;
    container.appendChild(fechaLabel);

    const cardTotal = document.createElement('article');
    cardTotal.className = 'stat-card stat-card--accent';
    cardTotal.innerHTML = `
      <span class="stat-card__label">Total horneado (${fecha})</span>
      <data class="stat-card__value" value="${totalPanes}">${totalPanes}</data>
    `;
    container.appendChild(cardTotal);

    [...porProducto.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([producto, cantidad]) => {
        const card = document.createElement('article');
        card.className = 'stat-card';
        card.innerHTML = `
          <span class="stat-card__label">${escapeHTML(producto)}</span>
          <data class="stat-card__value" value="${cantidad}">${cantidad}</data>
        `;
        container.appendChild(card);
      });
  },

  renderHorneadas(lista, huboErrorConexion, fecha) {
    const container = document.querySelector(CONFIG.SELECTORS.horneadasContainer);
    if (!container) return;
    container.innerHTML = '';

    if (huboErrorConexion) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">⚠️</span>
        <h2 class="empty-state__title">No se pudo conectar con el servidor</h2>
        <p class="empty-state__text">Verifica que el backend esté corriendo e intenta de nuevo.</p>
      `;
      container.appendChild(div);
      return;
    }

    if (lista.length === 0) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">🍞</span>
        <h2 class="empty-state__title">Sin horneadas registradas para ${escapeHTML(fecha || 'esta fecha')}</h2>
        <p class="empty-state__text">Usa el formulario de arriba para registrar una horneada de ese día.</p>
      `;
      container.appendChild(div);
      return;
    }

    const table = document.createElement('table');
    table.className = 'insumo-table';
    table.innerHTML = `
      <caption class="visually-hidden">Detalle de horneadas registradas el ${fecha || ''}</caption>
      <thead>
        <tr>
          <th scope="col">Producto</th>
          <th scope="col">Cantidad</th>
          <th scope="col">Hora</th>
          <th scope="col">Registrado por</th>
          <th scope="col">Notas</th>
          <th scope="col">Acciones</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    lista.forEach((horneada) => tbody.appendChild(this._renderHorneadaRow(horneada)));

    container.appendChild(table);
  },

  _renderHorneadaRow(horneada) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplHorneadaRow);
    const row = tpl.content.cloneNode(true);
    const tr = row.querySelector('tr');

    row.querySelector('.insumo-table__nombre').textContent = horneada.productoNombre;
    row.querySelector('.horneada-table__cantidad').textContent =
      `${Format.cantidad(horneada.cantidad)} pan(es)`;

    const horaCell = row.querySelector('.horneada-table__hora');
    horaCell.textContent = horneada.hora;
    // Trazabilidad: si actualizadoEn difiere de creadoEn, el registro se
    // corrigió después de creado — se marca para que quede claro que no es
    // el dato original de cuando se horneó.
    if (horneada.actualizadoEn && horneada.actualizadoEn !== horneada.creadoEn) {
      const badge = document.createElement('span');
      badge.className = 'insumo-badge insumo-badge--info';
      badge.title = `Editado por última vez: ${horneada.actualizadoEn}`;
      badge.textContent = 'Editado';
      horaCell.appendChild(document.createElement('br'));
      horaCell.appendChild(badge);
    }

    row.querySelector('.horneada-table__registrado-por').textContent =
      horneada.registradoPor || '—';
    row.querySelector('.horneada-table__notas').textContent = horneada.notas || '—';

    const acciones = row.querySelector('.insumo-table__acciones');

    const btnEditar = document.createElement('button');
    btnEditar.type = 'button';
    btnEditar.className = 'btn btn--action';
    btnEditar.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i> Editar';
    btnEditar.addEventListener('click', () => App.startEditHorneada(horneada.id));

    const btnEliminar = document.createElement('button');
    btnEliminar.type = 'button';
    btnEliminar.className = 'btn btn--ghost btn--danger';
    btnEliminar.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i> Eliminar';
    btnEliminar.addEventListener('click', () =>
      App.deleteHorneada(horneada.id, horneada.productoNombre),
    );

    acciones.appendChild(btnEditar);
    acciones.appendChild(btnEliminar);

    return tr;
  },

  updateInventarioCount(productos) {
    const el = document.querySelector(CONFIG.SELECTORS.inventarioCount);
    if (!el) return;
    const bajoStock = productos.filter((p) => p.bajoStock).length;
    el.textContent = bajoStock;
    if (bajoStock === 0) el.setAttribute('data-zero', '');
    else el.removeAttribute('data-zero');
  },

  renderInventario(productos, huboErrorConexion) {
    const container = document.querySelector(CONFIG.SELECTORS.inventarioContainer);
    if (!container) return;
    container.innerHTML = '';

    if (huboErrorConexion) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">⚠️</span>
        <h2 class="empty-state__title">No se pudo conectar con el servidor</h2>
        <p class="empty-state__text">Verifica que el backend esté corriendo e intenta de nuevo.</p>
      `;
      container.appendChild(div);
      return;
    }

    const table = document.createElement('table');
    table.className = 'insumo-table';
    table.innerHTML = `
      <caption class="visually-hidden">Disponible por producto para la fecha consultada</caption>
      <thead>
        <tr>
          <th scope="col">Producto</th>
          <th scope="col">Horneado</th>
          <th scope="col">Preparado</th>
          <th scope="col">Vendido</th>
          <th scope="col">Ajustes</th>
          <th scope="col">Disponible</th>
          <th scope="col">Stock mínimo</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    (productos || []).forEach((producto) => tbody.appendChild(this._renderInventarioRow(producto)));

    container.appendChild(table);
  },

  _renderInventarioRow(producto) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplInventarioRow);
    const row = tpl.content.cloneNode(true);
    const tr = row.querySelector('tr');

    if (producto.bajoStock) tr.classList.add('insumo-row--bajo-stock');

    row.querySelector('.insumo-table__nombre').textContent = producto.productoNombre;

    const nums = row.querySelectorAll('.inventario-table__num');
    nums[0].textContent = producto.horneado;
    nums[1].textContent = producto.preparado;
    nums[2].textContent = producto.vendido;
    nums[3].textContent = producto.ajustes;

    const disponibleCell = row.querySelector('.inventario-table__disponible');
    disponibleCell.textContent = producto.disponible;
    if (producto.bajoStock) {
      const badge = document.createElement('span');
      badge.className = 'insumo-badge insumo-badge--bajo-stock';
      badge.textContent = 'Stock bajo';
      disponibleCell.appendChild(document.createElement('br'));
      disponibleCell.appendChild(badge);
    }

    const stockMinimoCell = row.querySelector('.inventario-table__stock-minimo');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.value = producto.stockMinimo;
    input.setAttribute('aria-label', `Stock mínimo de ${producto.productoNombre}`);

    const feedback = document.createElement('span');
    feedback.className = 'inventario-table__stock-minimo__guardado';
    feedback.textContent = '✓ Guardado';

    input.addEventListener('change', () => {
      App.guardarStockMinimo(producto.productoId, input.value, input, feedback);
    });

    stockMinimoCell.appendChild(input);
    stockMinimoCell.appendChild(feedback);

    return tr;
  },

  renderAjustes(lista, huboErrorConexion, fecha) {
    const container = document.querySelector(CONFIG.SELECTORS.ajustesContainer);
    if (!container) return;
    container.innerHTML = '';

    if (huboErrorConexion) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">⚠️</span>
        <h2 class="empty-state__title">No se pudo conectar con el servidor</h2>
        <p class="empty-state__text">Verifica que el backend esté corriendo e intenta de nuevo.</p>
      `;
      container.appendChild(div);
      return;
    }

    if (!lista || lista.length === 0) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">📋</span>
        <h2 class="empty-state__title">Sin ajustes registrados para ${escapeHTML(fecha || 'esta fecha')}</h2>
        <p class="empty-state__text">Usa el formulario de arriba si hay una merma o error de conteo que registrar.</p>
      `;
      container.appendChild(div);
      return;
    }

    const table = document.createElement('table');
    table.className = 'insumo-table';
    table.innerHTML = `
      <caption class="visually-hidden">Ajustes de inventario registrados el ${fecha || ''}</caption>
      <thead>
        <tr>
          <th scope="col">Producto</th>
          <th scope="col">Cantidad</th>
          <th scope="col">Motivo</th>
          <th scope="col">Hora</th>
          <th scope="col">Registrado por</th>
          <th scope="col">Notas</th>
          <th scope="col">Acciones</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    lista.forEach((ajuste) => tbody.appendChild(this._renderAjusteRow(ajuste)));

    container.appendChild(table);
  },

  _renderAjusteRow(ajuste) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplAjusteRow);
    const row = tpl.content.cloneNode(true);
    const tr = row.querySelector('tr');

    row.querySelector('.insumo-table__nombre').textContent = ajuste.productoNombre;
    row.querySelector('.horneada-table__cantidad').textContent = ajuste.cantidad;
    row.querySelector('.ajuste-table__motivo').textContent =
      MOTIVO_AJUSTE_LABELS[ajuste.motivo] || ajuste.motivo;
    row.querySelector('.horneada-table__hora').textContent = ajuste.hora;
    row.querySelector('.horneada-table__registrado-por').textContent = ajuste.registradoPor || '—';
    row.querySelector('.horneada-table__notas').textContent = ajuste.notas || '—';

    const acciones = row.querySelector('.insumo-table__acciones');

    const btnEditar = document.createElement('button');
    btnEditar.type = 'button';
    btnEditar.className = 'btn btn--action';
    btnEditar.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i> Editar';
    btnEditar.addEventListener('click', () => App.startEditAjuste(ajuste.id));

    const btnEliminar = document.createElement('button');
    btnEliminar.type = 'button';
    btnEliminar.className = 'btn btn--ghost btn--danger';
    btnEliminar.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i> Eliminar';
    btnEliminar.addEventListener('click', () => App.deleteAjuste(ajuste.id, ajuste.productoNombre));

    acciones.appendChild(btnEditar);
    acciones.appendChild(btnEliminar);

    return tr;
  },

  updateRecetasCount(recetas) {
    const el = document.querySelector(CONFIG.SELECTORS.recetasCount);
    if (el) el.textContent = recetas.length;
  },

  renderRecetas(recetas, huboErrorConexion) {
    const container = document.querySelector(CONFIG.SELECTORS.recetasContainer);
    if (!container) return;
    container.innerHTML = '';

    if (huboErrorConexion) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">⚠️</span>
        <h2 class="empty-state__title">No se pudo conectar con el servidor</h2>
        <p class="empty-state__text">Verifica que el backend esté corriendo e intenta de nuevo.</p>
      `;
      container.appendChild(div);
      return;
    }

    if (!recetas || recetas.length === 0) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">📋</span>
        <h2 class="empty-state__title">Sin recetas todavía</h2>
        <p class="empty-state__text">Usa el formulario de arriba para crear la ficha técnica de un producto.</p>
      `;
      container.appendChild(div);
      return;
    }

    const table = document.createElement('table');
    table.className = 'insumo-table';
    table.innerHTML = `
      <caption class="visually-hidden">Recetas configuradas</caption>
      <thead>
        <tr>
          <th scope="col">Producto</th>
          <th scope="col">Peso/unidad (g)</th>
          <th scope="col">Ingredientes</th>
          <th scope="col">Acciones</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    recetas.forEach((receta) => tbody.appendChild(this._renderRecetaRow(receta)));
    container.appendChild(table);
  },

  _renderRecetaRow(receta) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplRecetaRow);
    const row = tpl.content.cloneNode(true);
    const nums = row.querySelectorAll('.inventario-table__num');

    row.querySelector('.insumo-table__nombre').textContent = receta.productoNombre;
    nums[0].textContent = receta.pesoMasaPorUnidadG;
    nums[1].textContent = receta.ingredientes.length;

    const acciones = row.querySelector('.insumo-table__acciones');

    const btnEditar = document.createElement('button');
    btnEditar.type = 'button';
    btnEditar.className = 'btn btn--action';
    btnEditar.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i> Editar';
    btnEditar.addEventListener('click', () => App.startEditReceta(receta.id));

    const btnEliminar = document.createElement('button');
    btnEliminar.type = 'button';
    btnEliminar.className = 'btn btn--ghost btn--danger';
    btnEliminar.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i> Eliminar';
    btnEliminar.addEventListener('click', () => App.deleteReceta(receta.id, receta.productoNombre));

    acciones.appendChild(btnEditar);
    acciones.appendChild(btnEliminar);

    return row.querySelector('tr');
  },

  updateOrdenesCompraCount(ordenes) {
    const el = document.querySelector(CONFIG.SELECTORS.ordenesCompraCount);
    // El badge del nav cuenta lo que sigue vivo (ni cerrada ni cancelada):
    // el número que importa es "cuántas compras están en curso".
    if (el)
      el.textContent = ordenes.filter((o) => !['cerrada', 'cancelada'].includes(o.estado)).length;
  },

  renderResumenOrdenesCompra(ordenes) {
    const container = document.querySelector(CONFIG.SELECTORS.ocResumen);
    if (!container) return;

    const abiertas = ordenes.filter((o) => !['cerrada', 'cancelada'].includes(o.estado));
    const porRecibir = ordenes.filter((o) =>
      ['emitida', 'confirmada', 'recibida_parcial'].includes(o.estado),
    );
    const mes = hoyHouston().slice(0, 7);
    const delMes = ordenes.filter(
      (o) => o.fechaEmision?.startsWith(mes) && o.estado !== 'cancelada',
    );
    const valorMes = delMes.reduce((acc, o) => acc + o.total, 0);

    const tarjetas = [
      { icono: '📄', valor: abiertas.length, label: 'Órdenes abiertas' },
      { icono: '🚚', valor: porRecibir.length, label: 'Esperando mercancía' },
      { icono: '🧾', valor: delMes.length, label: 'Emitidas este mes' },
      { icono: '💵', valor: Format.currency(valorMes), label: 'Comprado este mes' },
    ];

    container.innerHTML = tarjetas
      .map(
        (t) => `
        <article class="stat-card">
          <span class="stat-card__icon" aria-hidden="true">${t.icono}</span>
          <div class="stat-card__body">
            <span class="stat-card__value">${escapeHTML(String(t.valor))}</span>
            <span class="stat-card__label">${t.label}</span>
          </div>
        </article>`,
      )
      .join('');
  },

  renderOrdenesCompra(ordenes, huboErrorConexion) {
    const container = document.querySelector(CONFIG.SELECTORS.ordenesCompraContainer);
    if (!container) return;
    container.innerHTML = '';

    if (huboErrorConexion) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">⚠️</span>
        <h2 class="empty-state__title">No se pudo conectar con el servidor</h2>
        <p class="empty-state__text">Verifica que el backend esté corriendo e intenta de nuevo.</p>
      `;
      container.appendChild(div);
      return;
    }

    if (!ordenes || ordenes.length === 0) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">🧾</span>
        <h2 class="empty-state__title">Sin órdenes de compra</h2>
        <p class="empty-state__text">Crea la primera con el formulario de arriba, o ajusta los filtros.</p>
      `;
      container.appendChild(div);
      return;
    }

    const table = document.createElement('table');
    table.className = 'insumo-table';
    table.innerHTML = `
      <caption class="visually-hidden">Historial de órdenes de compra</caption>
      <thead>
        <tr>
          <th scope="col">Número</th>
          <th scope="col">Proveedor</th>
          <th scope="col">Emitida</th>
          <th scope="col">Entrega estimada</th>
          <th scope="col">Total</th>
          <th scope="col">Recepción</th>
          <th scope="col">Estado</th>
          <th scope="col">Acciones</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    ordenes.forEach((orden) => tbody.appendChild(this._renderOrdenCompraRow(orden)));

    container.appendChild(table);
  },

  _renderOrdenCompraRow(orden) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplOcRow);
    const row = tpl.content.cloneNode(true);
    const tr = row.querySelector('tr');
    tr.className = `oc-row oc-row--${orden.estado}`;

    row.querySelector('.oc-table__numero').textContent = orden.numero;
    row.querySelector('.oc-table__proveedor').textContent = orden.proveedorRazonSocial;
    row.querySelector('.oc-table__emision').textContent = orden.fechaEmision;
    row.querySelector('.oc-table__entrega').textContent = orden.fechaEntregaEstimada || '—';
    row.querySelector('.oc-table__total').textContent =
      `${Format.currency(orden.total)} ${orden.moneda}`;

    const barra = row.querySelector('.oc-progress__barra');
    barra.style.width = `${Math.min(orden.avanceRecepcionPct, 100)}%`;
    row
      .querySelector('.oc-progress')
      .setAttribute('aria-label', `Recepción al ${orden.avanceRecepcionPct}%`);
    row.querySelector('.oc-table__avance-pct').textContent = `${orden.avanceRecepcionPct}%`;

    const estadoCell = row.querySelector('.oc-table__estado');
    const badge = document.createElement('span');
    badge.className = `oc-badge oc-badge--${orden.estado}`;
    badge.textContent = OC_ESTADO_LABEL[orden.estado] ?? orden.estado;
    estadoCell.appendChild(badge);
    if (orden.motivoCancelacion) {
      const motivo = document.createElement('p');
      motivo.className = 'oc-table__cancelacion';
      motivo.textContent = `Cancelada: ${orden.motivoCancelacion}`;
      estadoCell.appendChild(motivo);
    }

    const acciones = row.querySelector('.oc-table__acciones');

    const agregarBoton = (label, icono, clase, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = clase;
      btn.innerHTML = `<i class="fa-solid ${icono}" aria-hidden="true"></i> ${label}`;
      btn.addEventListener('click', onClick);
      acciones.appendChild(btn);
    };

    if (orden.estado === 'borrador') {
      agregarBoton('Editar', 'fa-pen', 'btn btn--action', () => App.startEditOrdenCompra(orden.id));
    }

    (OC_TRANSICIONES_UI[orden.estado] ?? []).forEach((t) => {
      agregarBoton(t.label, t.icono, 'btn btn--action', () =>
        App.cambiarEstadoOrdenCompra(orden.id, t.estado),
      );
    });

    if (OC_ESTADOS_RECEPCION_UI.includes(orden.estado)) {
      agregarBoton('Registrar recepción', 'fa-truck-ramp-box', 'btn btn--primary btn--small', () =>
        App.abrirRecepcionOrdenCompra(orden.id),
      );
    }

    agregarBoton('Trazabilidad', 'fa-timeline', 'btn btn--ghost', () =>
      App.verTrazabilidadOrdenCompra(orden.id),
    );

    if (!['cerrada', 'cancelada'].includes(orden.estado)) {
      agregarBoton('Cancelar', 'fa-ban', 'btn btn--ghost btn--danger', () =>
        App.cambiarEstadoOrdenCompra(orden.id, 'cancelada'),
      );
    }

    if (orden.estado === 'borrador') {
      agregarBoton('Eliminar', 'fa-trash', 'btn btn--ghost btn--danger', () =>
        App.deleteOrdenCompra(orden.id, orden.numero),
      );
    }

    return tr;
  },

  /** Línea de tiempo de la orden: cada evento de la bitácora con su
   *  usuario y su hora, más el veredicto de integridad de la cadena. */
  renderTrazabilidadOrdenCompra(traza, items = []) {
    const body = document.querySelector(CONFIG.SELECTORS.ocTrazabilidadBody);
    if (!body) return;

    const lineasPactadas = items
      .map(
        (item) => `
        <tr>
          <td data-label="Insumo">${escapeHTML(item.insumoNombre)}</td>
          <td data-label="Pedido">${Format.cantidad(item.cantidadPedida)} ${escapeHTML(item.unidad)}</td>
          <td data-label="Recibido">${Format.cantidad(item.cantidadRecibida)} ${escapeHTML(item.unidad)}</td>
          <td data-label="Pendiente">${Format.cantidad(item.cantidadPendiente)} ${escapeHTML(item.unidad)}</td>
          <td data-label="Costo unit.">${Format.currency(item.costoUnitario)}</td>
          <td data-label="Total línea">${Format.currency(item.totalLinea)}</td>
        </tr>`,
      )
      .join('');

    const eventos = traza.eventos
      .map(
        (evento) => `
        <li class="oc-timeline__item oc-timeline__item--${evento.tipo}">
          <div class="oc-timeline__marca"></div>
          <div class="oc-timeline__contenido">
            <p class="oc-timeline__titulo">${escapeHTML(evento.descripcion)}</p>
            <p class="oc-timeline__meta">
              ${escapeHTML(evento.usuario || 'Sin usuario')} ·
              ${escapeHTML(
                String(evento.creadoEn || '')
                  .replace('T', ' ')
                  .slice(0, 16),
              )}
              ${evento.estadoNuevo ? `· ${OC_ESTADO_LABEL[evento.estadoNuevo] ?? evento.estadoNuevo}` : ''}
            </p>
          </div>
        </li>`,
      )
      .join('');

    const lotes = traza.recepciones
      .flatMap((r) =>
        r.items.map(
          (linea) => `
          <tr>
            <td data-label="Fecha">${escapeHTML(r.fecha)} ${escapeHTML(r.hora)}</td>
            <td data-label="Insumo">${escapeHTML(linea.insumoNombre)}</td>
            <td data-label="Recibido">${Format.cantidad(linea.cantidadRecibida)}</td>
            <td data-label="Rechazado">${Format.cantidad(linea.cantidadRechazada)}</td>
            <td data-label="Lote">${escapeHTML(linea.loteProveedor || '—')}</td>
            <td data-label="Vence">${escapeHTML(linea.fechaVencimiento || '—')}</td>
            <td data-label="Recibió">${escapeHTML(r.recibidoPor || '—')}</td>
          </tr>`,
        ),
      )
      .join('');

    body.innerHTML = `
      <p class="oc-trazabilidad__cabecera">
        <strong>${escapeHTML(traza.numero)}</strong> ·
        ${OC_ESTADO_LABEL[traza.estado] ?? traza.estado} ·
        cadena de auditoría
        ${traza.integridadCadena?.integra ? '<span class="oc-chip oc-chip--ok">íntegra</span>' : '<span class="oc-chip oc-chip--alerta">alterada</span>'}
        (${traza.bloques.length} ${pluralizeEs(traza.bloques.length, 'bloque', 'bloques')})
      </p>

      <ol class="oc-timeline">${eventos}</ol>

      ${
        lineasPactadas
          ? `<h3 class="section-subtitle">Líneas pactadas</h3>
             <table class="insumo-table">
               <thead>
                 <tr>
                   <th scope="col">Insumo</th>
                   <th scope="col">Pedido</th>
                   <th scope="col">Recibido</th>
                   <th scope="col">Pendiente</th>
                   <th scope="col">Costo unit.</th>
                   <th scope="col">Total línea</th>
                 </tr>
               </thead>
               <tbody>${lineasPactadas}</tbody>
             </table>`
          : ''
      }

      ${
        lotes
          ? `<h3 class="section-subtitle">Mercancía recibida</h3>
             <table class="insumo-table">
               <thead>
                 <tr>
                   <th scope="col">Fecha</th>
                   <th scope="col">Insumo</th>
                   <th scope="col">Recibido</th>
                   <th scope="col">Rechazado</th>
                   <th scope="col">Lote</th>
                   <th scope="col">Vence</th>
                   <th scope="col">Recibió</th>
                 </tr>
               </thead>
               <tbody>${lotes}</tbody>
             </table>`
          : '<p class="oc-trazabilidad__vacio">Todavía no se ha recibido mercancía de esta orden.</p>'
      }
    `;
  },

  updateProduccionCount(producciones) {
    const el = document.querySelector(CONFIG.SELECTORS.produccionCount);
    if (el) el.textContent = producciones.length;
  },

  renderProducciones(producciones, huboErrorConexion, fecha) {
    const container = document.querySelector(CONFIG.SELECTORS.produccionesContainer);
    if (!container) return;
    container.innerHTML = '';

    if (huboErrorConexion) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">⚠️</span>
        <h2 class="empty-state__title">No se pudo conectar con el servidor</h2>
        <p class="empty-state__text">Verifica que el backend esté corriendo e intenta de nuevo.</p>
      `;
      container.appendChild(div);
      return;
    }

    if (!producciones || producciones.length === 0) {
      const div = document.createElement('div');
      div.className = 'empty-state';
      div.innerHTML = `
        <span class="empty-state__icon" aria-hidden="true">🥖</span>
        <h2 class="empty-state__title">Sin tandas de masa para ${escapeHTML(fecha || 'esta fecha')}</h2>
        <p class="empty-state__text">Usa el formulario de arriba para registrar una nueva.</p>
      `;
      container.appendChild(div);
      return;
    }

    producciones.forEach((produccion) =>
      container.appendChild(this._renderProduccionCard(produccion)),
    );
  },

  _renderProduccionCard(produccion) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplProduccionCard);
    const card = tpl.content.cloneNode(true);

    card.querySelector('.produccion-card__titulo').textContent =
      `${produccion.productoNombre} — ${produccion.pesoTotalMasaG} g (${produccion.unidadesEstimadas} u. est.)`;
    card.querySelector('.produccion-card__meta').textContent =
      `Inicio ${produccion.horaInicio} · ${produccion.fecha} · Registrado por: ${produccion.registradoPor || '—'}`;

    card
      .querySelector('.produccion-card__eliminar')
      .addEventListener('click', () =>
        App.deleteProduccion(produccion.id, produccion.productoNombre),
      );

    const etapasList = card.querySelector('.produccion-card__etapas');
    ETAPAS_PRODUCCION_ORDEN.forEach((claveEtapa) => {
      const etapaGuardada = produccion.etapas.find((e) => e.etapa === claveEtapa);
      etapasList.appendChild(this._renderEtapaItem(produccion.id, claveEtapa, etapaGuardada));
    });

    const horneadasLista = card.querySelector('.produccion-card__horneadas-lista');
    if (produccion.horneadas.length === 0) {
      const li = document.createElement('li');
      li.className = 'horneada-ligada-item';
      li.textContent = 'Ninguna todavía';
      horneadasLista.appendChild(li);
    } else {
      produccion.horneadas.forEach((h) => {
        const tplHorneada = document.querySelector(CONFIG.SELECTORS.tplHorneadaLigadaItem);
        const item = tplHorneada.content.cloneNode(true);
        item.querySelector('.horneada-ligada-item__texto').textContent =
          `${h.cantidad} unidades — ${h.hora}`;
        horneadasLista.appendChild(item);
      });
    }

    return card;
  },

  _renderEtapaItem(produccionId, claveEtapa, etapaGuardada) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplEtapaItem);
    const item = tpl.content.cloneNode(true);
    const li = item.querySelector('li');

    item.querySelector('.etapa-item__nombre').textContent = ETAPAS_PRODUCCION_LABELS[claveEtapa];
    const horasEl = item.querySelector('.etapa-item__horas');
    const btn = item.querySelector('.etapa-item__accion');

    if (!etapaGuardada) {
      horasEl.textContent = '';
      btn.textContent = 'Iniciar';
      btn.addEventListener('click', () => App.iniciarEtapaProduccion(produccionId, claveEtapa));
    } else if (!etapaGuardada.horaFin) {
      li.classList.add('etapa-item--en-curso');
      horasEl.textContent = `Inicio ${etapaGuardada.horaInicio}`;
      btn.textContent = 'Finalizar';
      btn.addEventListener('click', () =>
        App.finalizarEtapaProduccion(produccionId, etapaGuardada.id),
      );
    } else {
      li.classList.add('etapa-item--completada');
      horasEl.textContent = `${etapaGuardada.horaInicio} – ${etapaGuardada.horaFin}`;
      btn.remove();
    }

    return item;
  },
};

/* ═══════════════════════════════════════════
   8. APP: ORQUESTADOR PRINCIPAL
   ═══════════════════════════════════════════ */
const App = {
  _liveConnected: false,
  _insumosCache: [],
  _productosCache: [],
  _proveedoresCache: [],
  _horneadasCache: [],
  // Fecha que se está consultando en la pestaña Horneadas — por defecto hoy,
  // pero el toolbar de la vista permite cambiarla para revisar trazabilidad
  // de días anteriores.
  _horneadaFechaConsulta: hoyHouston(),
  _inventarioCache: [],
  _ajustesCache: [],
  // Misma idea que _horneadaFechaConsulta, para la pestaña Inventario.
  _inventarioFechaConsulta: hoyHouston(),
  _recetasCache: [],
  _insumosCacheGeneral: [], // insumos reales, para poblar los selects de ingredientes
  _produccionesCache: [],
  _produccionFechaConsulta: hoyHouston(),
  _ordenesCompraCache: [],
  _ocFiltros: {},
  // Lotes: sin filtros el backend analiza los últimos 30 días. El análisis
  // se guarda para poder cambiar la variable del histograma sin volver a
  // pedirlo (ya viene el de todas las variables).
  _lotesFiltros: {},
  _lotesVariable: 'mermaRealPct',
  _pedidosFiltros: {},
  _lotesAnalisisCache: null,
  // Mermas: mismo criterio de rango por defecto que Lotes (últimos 30 días).
  _mermasFiltros: {},

  init() {
    this._bindEvents();
    this._showCorrectView();
  },

  async refresh() {
    const orders = await Api.getTodayOrders();

    // Sesión caducada: volver a la vista de login en lugar de mostrar datos vacíos.
    if (orders === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    Render.updateStats(orders);
    Render.renderDiagnosticoPedidos(orders);
    Render.renderOrders(orders);

    if (orders !== null && !this._liveConnected) {
      this._liveConnected = true;
      // Los avisos de producto no tienen nada que ver con los pedidos del
      // día: refrescar el catálogo (y con él los selects de producto de
      // las demás vistas) en vez de recargar la tabla de pedidos.
      Api.connectLive((msg) => {
        if (msg?.tipo === 'producto:nuevo' || msg?.tipo === 'producto:actualizado') {
          this.refreshProductos();
          return;
        }
        // Cualquier cambio de Órdenes de compra (nueva, actualizada, recepción
        // registrada, eliminada) refresca la tabla en todas las pantallas
        // abiertas, sin importar quién lo haya hecho.
        if (typeof msg?.tipo === 'string' && msg.tipo.startsWith('orden-compra:')) {
          this.refreshOrdenesCompra();
          return;
        }
        this.refresh();
      });
    }
  },

  async refreshInsumos() {
    const lista = await Insumos.listar();

    if (lista === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    this._insumosCache = Array.isArray(lista) ? lista : [];
    Render.updateInsumosCount(this._insumosCache);
    Render.renderInsumos(this._insumosCache, lista === null);
  },

  async refreshProductos() {
    const lista = await Productos.listar();

    if (lista === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    this._productosCache = Array.isArray(lista) ? lista : [];
    Render.updateProductosCount(this._productosCache);
    Render.renderProductos(this._productosCache);
    Render.fillProductoSelects(this._productosCache);
  },

  /** Carga el catálogo solo para los selects de producto de otras vistas
   *  (Recetas, Producción, Horneadas, Ajustes). Se vuelve a pedir en cada
   *  entrada a esas vistas porque el catálogo lo puede haber cambiado
   *  otra sesión del panel mientras esta seguía abierta; si la petición
   *  falla se usa lo último que se había cargado. */
  async cargarProductosParaSelects() {
    const lista = await Productos.listar();
    if (lista === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (Array.isArray(lista)) {
      this._productosCache = lista;
      Render.updateProductosCount(lista);
    }
    Render.fillProductoSelects(this._productosCache);
  },

  async refreshProveedores() {
    const lista = await Proveedores.listar();

    if (lista === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    this._proveedoresCache = Array.isArray(lista) ? lista : [];
    Render.updateProveedoresCount(this._proveedoresCache);
    Render.renderProveedores(this._proveedoresCache, lista === null);
  },

  /** Trae el análisis agrupado (integridad + agrupaciones) y los últimos
   *  bloques, y pinta toda la vista Auditoría. Dos llamadas separadas
   *  porque son dos consultas de propósito distinto en el backend (una
   *  agrega/agrupa, la otra solo lista) — ver Auditoria en este archivo. */
  async refreshAuditoria() {
    const [analisis, bloques] = await Promise.all([
      Auditoria.analisis(),
      Auditoria.ultimosBloques(),
    ]);

    if (analisis === 'UNAUTHORIZED' || bloques === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    Render.renderAuditoria(analisis, bloques);
  },

  /* ───────────────────────── LOTES ─────────────────────────
     Una sola llamada trae todo (los lotes derivados y sus agregados van
     juntos en GET /lotes/analisis) — así la tabla y los indicadores
     siempre hablan del mismo conjunto de datos. */

  async refreshLotes() {
    const analisis = await LotesApi.analisis(this._lotesFiltros);

    if (analisis === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!analisis) {
      const periodoEl = document.querySelector(CONFIG.SELECTORS.lotesPeriodo);
      if (periodoEl) {
        periodoEl.textContent = 'No se pudo cargar el análisis de lotes. Intenta de nuevo.';
      }
      return;
    }

    this._lotesAnalisisCache = analisis;
    Render.updateLotesCount(analisis.resumen.totalLotes);
    Render.renderLotes(analisis, this._lotesVariable);
  },

  /** Cambiar la variable del histograma no vuelve a pedir nada: el
   *  análisis ya trae el histograma de todas las variables. */
  cambiarVariableLotes(campo) {
    this._lotesVariable = campo;
    if (this._lotesAnalisisCache) {
      Render._renderLotesHistograma(this._lotesAnalisisCache.descriptivas, campo);
    }
  },

  /* ───────────────────────── MERMAS ─────────────────────────
     Una sola llamada trae todo el pipeline resuelto (dataset limpio +
     EDA + hipótesis + modelo predictivo) — ver GET /mermas/analisis. */
  async refreshMermas() {
    const datos = await MermasApi.analisis(this._mermasFiltros);

    if (datos === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!datos) {
      const periodoEl = document.querySelector(CONFIG.SELECTORS.mermasPeriodo);
      if (periodoEl) {
        periodoEl.textContent = 'No se pudo cargar el análisis de mermas. Intenta de nuevo.';
      }
      return;
    }

    Render.updateMermasCount(datos.eventos.length);
    Render.renderMermas(datos);
  },

  /* ──────────────────── CICLO DE PEDIDOS ────────────────────
     Una sola llamada trae el análisis y los pedidos ya cruzados con su
     historial, así la tabla y los indicadores hablan siempre del mismo
     conjunto de datos. */

  async refreshPedidos() {
    const analisis = await PedidosApi.analisis(this._pedidosFiltros);

    if (analisis === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!analisis) {
      const periodoEl = document.querySelector(CONFIG.SELECTORS.pedidosPeriodo);
      if (periodoEl) {
        periodoEl.textContent = 'No se pudo cargar el análisis de pedidos. Intenta de nuevo.';
      }
      return;
    }

    Render.updatePedidosCount(analisis.resumen.pedidos);
    Render.renderPedidos(analisis);
  },

  async verHistorialPedido(numero) {
    const pedido = await PedidosApi.historial(numero);
    if (pedido === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!pedido) {
      window.alert('No se pudo cargar el historial del pedido. Intenta de nuevo.');
      return;
    }
    Render.renderHistorialPedido(pedido);
    this._abrirModal(CONFIG.SELECTORS.pedidoHistorialModal);
  },

  async verTrazabilidadLote(id) {
    const lote = await LotesApi.detalle(id);
    if (lote === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!lote) {
      window.alert('No se pudo cargar la trazabilidad del lote. Intenta de nuevo.');
      return;
    }
    Render.renderTrazabilidadLote(lote);
    this._abrirModal(CONFIG.SELECTORS.loteTrazaModal);
  },

  async refreshHorneadas() {
    const fecha = this._horneadaFechaConsulta;
    const lista = await Horneadas.listar(fecha);

    if (lista === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    this._horneadasCache = Array.isArray(lista) ? lista : [];
    Render.updateHorneadasCount(this._horneadasCache);
    Render.renderHorneadaResumen(this._horneadasCache, fecha);
    Render.renderHorneadas(this._horneadasCache, lista === null, fecha);
  },

  /** Sugerencia de cuánto hornear mañana (ver Render.renderSugerenciasHorneado).
   *  Independiente de refreshHorneadas: esta consulta no depende de la fecha
   *  que se esté consultando en el historial, siempre mira hacia adelante. */
  async refreshSugerenciasHorneado() {
    const estadisticas = await Productos.estadisticas();

    if (estadisticas === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    Render.renderSugerenciasHorneado(estadisticas);
  },

  /** Trae la predicción AutoML de todos los productos activos y pinta la
   *  tarjeta en la vista Productos (ver Render.renderProductosAutoML). */
  async refreshProductosAutoML() {
    const predicciones = await Productos.prediccionAutoML();

    if (predicciones === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    Render.renderProductosAutoML(predicciones);
  },

  /** Cambia la fecha consultada en la pestaña Horneadas y vuelve a cargar.
   *  Es la puerta de entrada a la trazabilidad histórica: sin esto, el panel
   *  solo podía ver el día actual. */
  verFechaHorneadas(fecha) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return;
    this._horneadaFechaConsulta = fecha;
    const btnHoy = document.querySelector(CONFIG.SELECTORS.btnHorneadaHoy);
    const hoy = hoyHouston();
    if (btnHoy) btnHoy.hidden = fecha === hoy;
    this.refreshHorneadas();
  },

  volverAHoyHorneadas() {
    const hoy = hoyHouston();
    const filtroEl = document.querySelector(CONFIG.SELECTORS.horneadaFiltroFecha);
    if (filtroEl) filtroEl.value = hoy;
    this.verFechaHorneadas(hoy);
  },

  /** Carga /inventario y /ajustes-inventario juntos para la misma fecha: el
   *  disponible que se ve en la tabla depende de los ajustes que aparecen
   *  debajo, así que tiene que refrescarse todo junto. */
  async refreshInventario() {
    const fecha = this._inventarioFechaConsulta;
    const [inventario, ajustes] = await Promise.all([Inventario.ver(fecha), Ajustes.listar(fecha)]);

    if (inventario === 'UNAUTHORIZED' || ajustes === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    this._inventarioCache =
      inventario && Array.isArray(inventario.productos) ? inventario.productos : [];
    Render.updateInventarioCount(this._inventarioCache);
    Render.renderInventario(this._inventarioCache, inventario === null);

    this._ajustesCache = Array.isArray(ajustes) ? ajustes : [];
    Render.renderAjustes(this._ajustesCache, ajustes === null, fecha);
  },

  verFechaInventario(fecha) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return;
    this._inventarioFechaConsulta = fecha;
    const btnHoy = document.querySelector(CONFIG.SELECTORS.btnInventarioHoy);
    const hoy = hoyHouston();
    if (btnHoy) btnHoy.hidden = fecha === hoy;
    this.refreshInventario();
  },

  volverAHoyInventario() {
    const hoy = hoyHouston();
    const filtroEl = document.querySelector(CONFIG.SELECTORS.inventarioFiltroFecha);
    if (filtroEl) filtroEl.value = hoy;
    this.verFechaInventario(hoy);
  },

  /** Guarda el stock mínimo de un producto al vuelo (blur/change del input
   *  en la tabla de Inventario) — no hay botón de guardar aparte. */
  async guardarStockMinimo(productoId, valor, inputEl, feedbackEl) {
    const stockMinimo = Number(valor);
    if (!Number.isInteger(stockMinimo) || stockMinimo < 0) {
      inputEl.value = inputEl.defaultValue;
      return;
    }

    const resultado = await StockMinimo.actualizar(productoId, stockMinimo);

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert('No se pudo guardar el stock mínimo. Intenta de nuevo.');
      return;
    }

    inputEl.defaultValue = String(stockMinimo);
    feedbackEl.classList.add('inventario-table__stock-minimo__guardado--visible');
    setTimeout(
      () => feedbackEl.classList.remove('inventario-table__stock-minimo__guardado--visible'),
      2000,
    );

    // El cambio de stock mínimo puede mover a un producto dentro o fuera de
    // "bajo stock", así que refrescamos la tabla completa (y el badge del nav).
    this.refreshInventario();
  },

  /* ───────────────────────── RECETAS ───────────────────────── */

  async refreshRecetas() {
    const [insumos, recetas] = await Promise.all([Insumos.listar(), Recetas.listar()]);

    if (recetas === 'UNAUTHORIZED' || insumos === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    this._insumosCacheGeneral = Array.isArray(insumos) ? insumos : [];
    this._recetasCache = Array.isArray(recetas) ? recetas : [];
    Render.updateRecetasCount(this._recetasCache);
    Render.renderRecetas(this._recetasCache, recetas === null);
  },

  /** Agrega una fila de ingrediente al formulario de Receta (select de
   *  insumo + peso en gramos + botón quitar). Si se pasan valores, precarga
   *  esa fila (modo edición); si no, queda vacía para que el usuario elija. */
  agregarFilaIngredienteReceta(valores) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplRecetaIngredienteRow);
    const row = tpl.content.cloneNode(true);
    const select = row.querySelector('.receta-ingrediente-row__insumo');
    const inputGramos = row.querySelector('.receta-ingrediente-row__gramos');
    const btnQuitar = row.querySelector('.receta-ingrediente-row__quitar');

    this._insumosCacheGeneral.forEach((insumo) => {
      const opt = document.createElement('option');
      opt.value = insumo.id;
      opt.textContent = insumo.nombre;
      select.appendChild(opt);
    });

    if (valores) {
      select.value = valores.insumoId;
      inputGramos.value = valores.gramos;
    }

    btnQuitar.addEventListener('click', () => {
      select.closest('.receta-ingrediente-row').remove();
    });

    document.querySelector(CONFIG.SELECTORS.recetaIngredientesLista).appendChild(row);
  },

  _leerIngredientesReceta() {
    const filas = document.querySelectorAll(
      `${CONFIG.SELECTORS.recetaIngredientesLista} .receta-ingrediente-row`,
    );
    return [...filas].map((fila) => ({
      insumoId: fila.querySelector('.receta-ingrediente-row__insumo').value,
      gramos: Number(fila.querySelector('.receta-ingrediente-row__gramos').value),
    }));
  },

  startEditReceta(id) {
    const receta = this._recetasCache.find((r) => r.id === id);
    if (!receta) return;

    document.querySelector(CONFIG.SELECTORS.recetaId).value = receta.id;
    document.querySelector(CONFIG.SELECTORS.recetaProducto).value = receta.productoId;
    document.querySelector(CONFIG.SELECTORS.recetaPesoUnidad).value = receta.pesoMasaPorUnidadG;
    document.querySelector(CONFIG.SELECTORS.recetaFermentacion).value =
      receta.tiempoFermentacionMin ?? '';
    document.querySelector(CONFIG.SELECTORS.recetaHidratacion).value =
      receta.hidratacionObjetivoPorcentaje ?? '';
    document.querySelector(CONFIG.SELECTORS.recetaTiempoHorneado).value =
      receta.tiempoHorneadoMin ?? '';
    document.querySelector(CONFIG.SELECTORS.recetaTemperaturaHorneado).value =
      receta.temperaturaHorneadoC ?? '';
    document.querySelector(CONFIG.SELECTORS.recetaManoObra).value = receta.tiempoManoObraMin ?? '';
    document.querySelector(CONFIG.SELECTORS.recetaMermaCoccion).value =
      receta.mermaCoccionPct ?? '';
    document.querySelector(CONFIG.SELECTORS.recetaPasos).value = receta.pasos || '';
    document.querySelector(CONFIG.SELECTORS.recetaNotas).value = receta.notas || '';

    document.querySelector(CONFIG.SELECTORS.recetaIngredientesLista).innerHTML = '';
    receta.ingredientes.forEach((ing) => this.agregarFilaIngredienteReceta(ing));

    const submitBtn = document.querySelector(CONFIG.SELECTORS.recetaSubmitBtn);
    submitBtn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> Guardar cambios';
    document.querySelector(CONFIG.SELECTORS.recetaCancelEditBtn).hidden = false;

    document
      .querySelector(CONFIG.SELECTORS.recetaForm)
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  cancelEditReceta() {
    this._resetRecetaForm();
  },

  async deleteReceta(id, productoNombre) {
    const confirmado = window.confirm(
      `¿Eliminar la receta de "${productoNombre}"? Si ya se usó en alguna producción registrada, no se podrá eliminar (para no perder ese historial).`,
    );
    if (!confirmado) return;

    const resultado = await Recetas.eliminar(id);
    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert(
        resultado.message || 'No se pudo eliminar la receta. Intenta de nuevo en unos segundos.',
      );
      return;
    }
    this.refreshRecetas();
  },

  _resetRecetaForm() {
    const form = document.querySelector(CONFIG.SELECTORS.recetaForm);
    form.reset();
    document.querySelector(CONFIG.SELECTORS.recetaId).value = '';
    document.querySelector(CONFIG.SELECTORS.recetaIngredientesLista).innerHTML = '';
    document.querySelector(CONFIG.SELECTORS.recetaSubmitBtn).innerHTML =
      '<i class="fa-solid fa-plus" aria-hidden="true"></i> Guardar receta';
    document.querySelector(CONFIG.SELECTORS.recetaCancelEditBtn).hidden = true;
    document.querySelector(CONFIG.SELECTORS.recetaError).hidden = true;
  },

  async _handleRecetaSubmit() {
    const errorEl = document.querySelector(CONFIG.SELECTORS.recetaError);
    const errorMsgEl = document.querySelector(CONFIG.SELECTORS.recetaErrorMsg);

    const productoId = document.querySelector(CONFIG.SELECTORS.recetaProducto).value;
    const pesoMasaPorUnidadG = document.querySelector(CONFIG.SELECTORS.recetaPesoUnidad).value;
    const ingredientes = this._leerIngredientesReceta();

    if (!productoId) {
      errorMsgEl.textContent = 'Selecciona un producto.';
      errorEl.hidden = false;
      return;
    }
    if (!pesoMasaPorUnidadG || Number(pesoMasaPorUnidadG) <= 0) {
      errorMsgEl.textContent = 'Escribe el peso de masa por unidad, en gramos (ej: 50).';
      errorEl.hidden = false;
      return;
    }
    if (ingredientes.length === 0) {
      errorMsgEl.textContent = 'Agrega al menos un ingrediente con "+ Agregar ingrediente".';
      errorEl.hidden = false;
      return;
    }
    if (ingredientes.some((i) => !i.insumoId || !i.gramos || i.gramos <= 0)) {
      errorMsgEl.textContent =
        'Cada ingrediente necesita un insumo seleccionado y un peso en gramos mayor a 0.';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const idExistente = document.querySelector(CONFIG.SELECTORS.recetaId).value || null;
    const datos = {
      productoId,
      pesoMasaPorUnidadG: Number(pesoMasaPorUnidadG),
      tiempoFermentacionMin:
        document.querySelector(CONFIG.SELECTORS.recetaFermentacion).value || null,
      hidratacionObjetivoPorcentaje:
        document.querySelector(CONFIG.SELECTORS.recetaHidratacion).value || null,
      tiempoHorneadoMin:
        document.querySelector(CONFIG.SELECTORS.recetaTiempoHorneado).value || null,
      temperaturaHorneadoC:
        document.querySelector(CONFIG.SELECTORS.recetaTemperaturaHorneado).value || null,
      tiempoManoObraMin: document.querySelector(CONFIG.SELECTORS.recetaManoObra).value || null,
      mermaCoccionPct: document.querySelector(CONFIG.SELECTORS.recetaMermaCoccion).value || null,
      pasos: document.querySelector(CONFIG.SELECTORS.recetaPasos).value.trim(),
      notas: document.querySelector(CONFIG.SELECTORS.recetaNotas).value.trim(),
      ingredientes,
    };

    const submitBtn = document.querySelector(CONFIG.SELECTORS.recetaSubmitBtn);
    submitBtn.disabled = true;

    const resultado = idExistente
      ? await Recetas.actualizar(idExistente, datos)
      : await Recetas.crear(datos);

    submitBtn.disabled = false;

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      errorMsgEl.textContent =
        resultado.message || 'No se pudo guardar la receta. Intenta de nuevo.';
      errorEl.hidden = false;
      return;
    }

    this._resetRecetaForm();
    this.refreshRecetas();
  },

  /* ───────────────────────── ÓRDENES DE COMPRA ───────────────────────── */

  async refreshOrdenesCompra() {
    const [insumos, proveedores, ordenes] = await Promise.all([
      Insumos.listar(),
      Proveedores.listar(),
      OrdenesCompra.listar(this._ocFiltros),
    ]);

    if ([insumos, proveedores, ordenes].includes('UNAUTHORIZED')) {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    this._insumosCacheGeneral = Array.isArray(insumos) ? insumos : this._insumosCacheGeneral;
    this._proveedoresCache = Array.isArray(proveedores) ? proveedores : this._proveedoresCache;
    this._ordenesCompraCache = Array.isArray(ordenes) ? ordenes : [];

    this._llenarSelectsProveedorOC();
    Render.updateOrdenesCompraCount(this._ordenesCompraCache);
    Render.renderResumenOrdenesCompra(this._ordenesCompraCache);
    Render.renderOrdenesCompra(this._ordenesCompraCache, ordenes === null);
  },

  _llenarSelectsProveedorOC() {
    const opciones = this._proveedoresCache
      .map((p) => `<option value="${escapeHTML(p.id)}">${escapeHTML(p.razonSocial)}</option>`)
      .join('');

    const select = document.querySelector(CONFIG.SELECTORS.ocProveedor);
    if (select) {
      const seleccionado = select.value;
      select.innerHTML = `<option value="" disabled>Selecciona un proveedor</option>${opciones}`;
      select.value = seleccionado;
    }

    const filtro = document.querySelector(CONFIG.SELECTORS.ocFiltroProveedor);
    if (filtro) {
      const seleccionado = filtro.value;
      filtro.innerHTML = `<option value="">Todos</option>${opciones}`;
      filtro.value = seleccionado;
    }
  },

  /** Agrega una línea al formulario de orden. Al elegir el insumo se
   *  prellenan unidad, costo e impuesto con los del catálogo: casi siempre
   *  se compra en la misma unidad y al último precio conocido. */
  agregarFilaItemOC(valores) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplOcItemRow);
    if (!tpl) return;
    const row = tpl.content.cloneNode(true);
    const select = row.querySelector('.oc-item-row__insumo');
    const inputCantidad = row.querySelector('.oc-item-row__cantidad');
    const selectUnidad = row.querySelector('.oc-item-row__unidad');
    const inputCosto = row.querySelector('.oc-item-row__costo');
    const inputImpuesto = row.querySelector('.oc-item-row__impuesto');
    const inputDescuento = row.querySelector('.oc-item-row__descuento');
    const btnQuitar = row.querySelector('.oc-item-row__quitar');

    this._insumosCacheGeneral.forEach((insumo) => {
      const opt = document.createElement('option');
      opt.value = insumo.id;
      opt.textContent = insumo.nombre;
      select.appendChild(opt);
    });

    select.addEventListener('change', () => {
      const insumo = this._insumosCacheGeneral.find((i) => i.id === select.value);
      if (!insumo) return;
      selectUnidad.value = insumo.unidad;
      if (!inputCosto.value && insumo.costoUnitario != null)
        inputCosto.value = insumo.costoUnitario;
      if (!inputImpuesto.value && insumo.impuestoPorcentaje != null) {
        inputImpuesto.value = insumo.impuestoPorcentaje;
      }
      this._recalcularTotalesOC();
    });

    [inputCantidad, inputCosto, inputImpuesto, inputDescuento].forEach((input) => {
      input.addEventListener('input', () => this._recalcularTotalesOC());
    });

    btnQuitar.addEventListener('click', () => {
      select.closest('.oc-item-row').remove();
      this._recalcularTotalesOC();
    });

    if (valores) {
      select.value = valores.insumoId;
      inputCantidad.value = valores.cantidadPedida;
      selectUnidad.value = valores.unidad;
      inputCosto.value = valores.costoUnitario;
      inputImpuesto.value = valores.impuestoPorcentaje ?? '';
      inputDescuento.value = valores.descuentoPorcentaje ?? '';
    }

    document.querySelector(CONFIG.SELECTORS.ocItemsLista).appendChild(row);
    this._recalcularTotalesOC();
  },

  _leerItemsOC() {
    const filas = document.querySelectorAll(`${CONFIG.SELECTORS.ocItemsLista} .oc-item-row`);
    return [...filas].map((fila) => ({
      insumoId: fila.querySelector('.oc-item-row__insumo').value,
      cantidadPedida: Number(fila.querySelector('.oc-item-row__cantidad').value),
      unidad: fila.querySelector('.oc-item-row__unidad').value,
      costoUnitario: Number(fila.querySelector('.oc-item-row__costo').value),
      impuestoPorcentaje: Number(fila.querySelector('.oc-item-row__impuesto').value) || 0,
      descuentoPorcentaje: Number(fila.querySelector('.oc-item-row__descuento').value) || 0,
    }));
  },

  /** Vista previa de los totales mientras se escribe. El cálculo válido
   *  es el del servidor (mismas fórmulas, ver calcularTotalesOrdenCompra);
   *  esto solo evita que el usuario tenga que guardar para ver cuánto va. */
  _recalcularTotalesOC() {
    const salida = document.querySelector(CONFIG.SELECTORS.ocTotales);
    if (!salida) return;

    const items = this._leerItemsOC();
    const flete = Number(document.querySelector(CONFIG.SELECTORS.ocFlete)?.value) || 0;

    let subtotal = 0;
    let descuento = 0;
    let impuestos = 0;

    items.forEach((item, idx) => {
      const bruto = (item.cantidadPedida || 0) * (item.costoUnitario || 0);
      const descuentoLinea = bruto * (item.descuentoPorcentaje / 100);
      const neto = bruto - descuentoLinea;
      const impuestoLinea = neto * (item.impuestoPorcentaje / 100);

      subtotal += bruto;
      descuento += descuentoLinea;
      impuestos += impuestoLinea;

      const celda = document.querySelectorAll(
        `${CONFIG.SELECTORS.ocItemsLista} .oc-item-row__total`,
      )[idx];
      if (celda) celda.textContent = Format.currency(neto + impuestoLinea);
    });

    const total = subtotal - descuento + impuestos + flete;
    salida.innerHTML = `
      <span>Subtotal: <strong>${Format.currency(subtotal)}</strong></span>
      <span>Descuento: <strong>${Format.currency(descuento)}</strong></span>
      <span>Impuestos: <strong>${Format.currency(impuestos)}</strong></span>
      <span>Flete: <strong>${Format.currency(flete)}</strong></span>
      <span class="oc-totales__total">Total: <strong>${Format.currency(total)}</strong></span>
    `;
  },

  startEditOrdenCompra(id) {
    const orden = this._ordenesCompraCache.find((o) => o.id === id);
    if (!orden) return;

    document.querySelector(CONFIG.SELECTORS.ocId).value = orden.id;
    document.querySelector(CONFIG.SELECTORS.ocProveedor).value = orden.proveedorId;
    document.querySelector(CONFIG.SELECTORS.ocFechaEmision).value = orden.fechaEmision;
    document.querySelector(CONFIG.SELECTORS.ocFechaEntrega).value =
      orden.fechaEntregaEstimada ?? '';
    document.querySelector(CONFIG.SELECTORS.ocCondicionesPago).value = orden.condicionesPago;
    document.querySelector(CONFIG.SELECTORS.ocMoneda).value = orden.moneda;
    document.querySelector(CONFIG.SELECTORS.ocFlete).value = orden.flete || '';
    document.querySelector(CONFIG.SELECTORS.ocSolicitadoPor).value = orden.solicitadoPor ?? '';
    document.querySelector(CONFIG.SELECTORS.ocLugarEntrega).value = orden.lugarEntrega ?? '';
    document.querySelector(CONFIG.SELECTORS.ocNotas).value = orden.notas ?? '';

    document.querySelector(CONFIG.SELECTORS.ocItemsLista).innerHTML = '';
    orden.items.forEach((item) => this.agregarFilaItemOC(item));

    document.querySelector(CONFIG.SELECTORS.ocSubmitBtn).innerHTML =
      '<i class="fa-solid fa-check" aria-hidden="true"></i> Guardar cambios';

    this._abrirModal(CONFIG.SELECTORS.ocNuevaModal);
  },

  /** Abre el modal en blanco para capturar una orden nueva. */
  abrirNuevaOrdenCompra() {
    this._resetOCForm();
    this._abrirModal(CONFIG.SELECTORS.ocNuevaModal);
  },

  /** El botón "Cancelar" del modal hace las dos cosas a la vez: si había
   *  una edición en curso la descarta, y en cualquier caso cierra el
   *  modal (crear o editar usan el mismo formulario). */
  cancelEditOrdenCompra() {
    this._resetOCForm();
    this._cerrarModal(CONFIG.SELECTORS.ocNuevaModal);
  },

  _resetOCForm() {
    const form = document.querySelector(CONFIG.SELECTORS.ocForm);
    if (!form) return;
    form.reset();
    document.querySelector(CONFIG.SELECTORS.ocId).value = '';
    document.querySelector(CONFIG.SELECTORS.ocItemsLista).innerHTML = '';
    document.querySelector(CONFIG.SELECTORS.ocFechaEmision).value = hoyHouston();
    document.querySelector(CONFIG.SELECTORS.ocSubmitBtn).innerHTML =
      '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Guardar borrador';
    document.querySelector(CONFIG.SELECTORS.ocError).hidden = true;
    this._recalcularTotalesOC();
  },

  async _handleOrdenCompraSubmit({ emitir = false } = {}) {
    const errorEl = document.querySelector(CONFIG.SELECTORS.ocError);
    const errorMsgEl = document.querySelector(CONFIG.SELECTORS.ocErrorMsg);

    const proveedorId = document.querySelector(CONFIG.SELECTORS.ocProveedor).value;
    const fechaEmision = document.querySelector(CONFIG.SELECTORS.ocFechaEmision).value;
    const items = this._leerItemsOC();

    const mostrarError = (mensaje) => {
      errorMsgEl.textContent = mensaje;
      errorEl.hidden = false;
    };

    if (!proveedorId) return mostrarError('Selecciona un proveedor.');
    if (!fechaEmision) return mostrarError('Indica la fecha de emisión.');
    if (items.length === 0)
      return mostrarError('Agrega al menos un insumo con "+ Agregar insumo".');
    if (items.some((i) => !i.insumoId || !i.cantidadPedida || i.cantidadPedida <= 0)) {
      return mostrarError('Cada línea necesita un insumo y una cantidad mayor a 0.');
    }
    errorEl.hidden = true;

    const idExistente = document.querySelector(CONFIG.SELECTORS.ocId).value || null;
    const datos = {
      proveedorId,
      fechaEmision,
      fechaEntregaEstimada: document.querySelector(CONFIG.SELECTORS.ocFechaEntrega).value || null,
      condicionesPago: document.querySelector(CONFIG.SELECTORS.ocCondicionesPago).value,
      moneda: document.querySelector(CONFIG.SELECTORS.ocMoneda).value,
      flete: Number(document.querySelector(CONFIG.SELECTORS.ocFlete).value) || 0,
      solicitadoPor: document.querySelector(CONFIG.SELECTORS.ocSolicitadoPor).value.trim(),
      lugarEntrega: document.querySelector(CONFIG.SELECTORS.ocLugarEntrega).value.trim(),
      notas: document.querySelector(CONFIG.SELECTORS.ocNotas).value.trim(),
      items,
      emitir,
    };

    const submitBtn = document.querySelector(CONFIG.SELECTORS.ocSubmitBtn);
    submitBtn.disabled = true;

    const resultado = idExistente
      ? await OrdenesCompra.actualizar(idExistente, datos)
      : await OrdenesCompra.crear(datos);

    submitBtn.disabled = false;

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      return mostrarError(
        resultado.message || 'No se pudo guardar la orden de compra. Intenta de nuevo.',
      );
    }

    // Editar un borrador y pedir "guardar y emitir" son dos pasos distintos
    // en el backend a propósito (PUT no cambia de estado), así que el
    // segundo se dispara aquí sobre la orden ya guardada.
    if (emitir && idExistente) {
      await OrdenesCompra.cambiarEstado(idExistente, {
        estado: 'emitida',
        usuario: datos.solicitadoPor,
      });
    }

    this._resetOCForm();
    this._cerrarModal(CONFIG.SELECTORS.ocNuevaModal);
    this.refreshOrdenesCompra();
  },

  async cambiarEstadoOrdenCompra(id, estado) {
    const orden = this._ordenesCompraCache.find((o) => o.id === id);
    let motivo = '';

    if (estado === 'cancelada') {
      motivo =
        window.prompt('¿Por qué se cancela esta orden? (queda registrado en la trazabilidad)') ??
        '';
      if (motivo.trim() === '') return;
    }

    const resultado = await OrdenesCompra.cambiarEstado(id, {
      estado,
      usuario: orden?.solicitadoPor || '',
      motivo,
    });

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert(resultado.message || 'No se pudo cambiar el estado de la orden.');
      return;
    }
    this.refreshOrdenesCompra();
  },

  async deleteOrdenCompra(id, numero) {
    const confirmado = window.confirm(
      `¿Eliminar el borrador ${numero}? Solo se pueden eliminar borradores; una orden ya emitida se cancela para conservar su rastro.`,
    );
    if (!confirmado) return;

    const resultado = await OrdenesCompra.eliminar(id);
    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert(resultado.message || 'No se pudo eliminar la orden de compra.');
      return;
    }
    this.refreshOrdenesCompra();
  },

  abrirRecepcionOrdenCompra(id) {
    const orden = this._ordenesCompraCache.find((o) => o.id === id);
    if (!orden) return;

    document.querySelector(CONFIG.SELECTORS.ocRecepcionOrdenId).value = id;
    document.querySelector(CONFIG.SELECTORS.ocRecepcionFecha).value = hoyHouston();
    document.querySelector(CONFIG.SELECTORS.ocRecepcionHora).value = ahoraHoraHouston();
    document.querySelector(CONFIG.SELECTORS.ocRecepcionRecibidoPor).value = '';
    document.querySelector(CONFIG.SELECTORS.ocRecepcionDocumento).value = '';
    document.querySelector(CONFIG.SELECTORS.ocRecepcionError).hidden = true;

    const lista = document.querySelector(CONFIG.SELECTORS.ocRecepcionLineas);
    const tpl = document.querySelector(CONFIG.SELECTORS.tplOcRecepcionRow);
    lista.innerHTML = '';

    // Solo se ofrecen las líneas que todavía tienen algo pendiente: lo ya
    // recibido no se puede volver a recibir (el backend también lo rechaza).
    orden.items
      .filter((item) => item.cantidadPendiente > 0)
      .forEach((item) => {
        const fila = tpl.content.cloneNode(true);
        const contenedor = fila.querySelector('.oc-recepcion-row');
        contenedor.dataset.itemId = item.id;
        fila.querySelector('.oc-recepcion-row__insumo').textContent = item.insumoNombre;
        fila.querySelector('.oc-recepcion-row__pendiente').textContent =
          `Faltan ${Format.cantidad(item.cantidadPendiente)} ${item.unidad}`;
        const inputRecibido = fila.querySelector('.oc-recepcion-row__recibido');
        inputRecibido.max = item.cantidadPendiente;
        inputRecibido.value = item.cantidadPendiente;
        lista.appendChild(fila);
      });

    this._abrirModal(CONFIG.SELECTORS.ocRecepcionModal);
  },

  async _handleRecepcionOrdenCompraSubmit() {
    const errorEl = document.querySelector(CONFIG.SELECTORS.ocRecepcionError);
    const errorMsgEl = document.querySelector(CONFIG.SELECTORS.ocRecepcionErrorMsg);
    const id = document.querySelector(CONFIG.SELECTORS.ocRecepcionOrdenId).value;

    const items = [...document.querySelectorAll('.oc-recepcion-row')]
      .map((fila) => ({
        itemId: fila.dataset.itemId,
        cantidadRecibida: Number(fila.querySelector('.oc-recepcion-row__recibido').value) || 0,
        cantidadRechazada: Number(fila.querySelector('.oc-recepcion-row__rechazado').value) || 0,
        motivoRechazo: fila.querySelector('.oc-recepcion-row__motivo').value.trim(),
        loteProveedor: fila.querySelector('.oc-recepcion-row__lote').value.trim(),
        fechaVencimiento: fila.querySelector('.oc-recepcion-row__vencimiento').value || null,
      }))
      .filter((item) => item.cantidadRecibida > 0 || item.cantidadRechazada > 0);

    if (items.length === 0) {
      errorMsgEl.textContent = 'Indica al menos una cantidad recibida o rechazada.';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const resultado = await OrdenesCompra.registrarRecepcion(id, {
      fecha: document.querySelector(CONFIG.SELECTORS.ocRecepcionFecha).value,
      hora: document.querySelector(CONFIG.SELECTORS.ocRecepcionHora).value,
      recibidoPor: document.querySelector(CONFIG.SELECTORS.ocRecepcionRecibidoPor).value.trim(),
      documentoReferencia: document
        .querySelector(CONFIG.SELECTORS.ocRecepcionDocumento)
        .value.trim(),
      items,
    });

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      errorMsgEl.textContent = resultado.message || 'No se pudo registrar la recepción.';
      errorEl.hidden = false;
      return;
    }

    this._cerrarModal(CONFIG.SELECTORS.ocRecepcionModal);
    // La recepción movió inventario, así que Insumos también quedó viejo.
    this.refreshOrdenesCompra();
    this.refreshInsumos();
  },

  async verTrazabilidadOrdenCompra(id) {
    const traza = await OrdenesCompra.trazabilidad(id);
    if (traza === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!traza) {
      window.alert('No se pudo cargar la trazabilidad. Intenta de nuevo en unos segundos.');
      return;
    }
    const ordenCache = this._ordenesCompraCache.find((o) => o.id === id);
    Render.renderTrazabilidadOrdenCompra(traza, ordenCache?.items ?? []);
    this._abrirModal(CONFIG.SELECTORS.ocTrazabilidadModal);
  },

  _abrirModal(selector) {
    const modal = document.querySelector(selector);
    if (!modal) return;
    modal.hidden = false;
    // El reflow fuerza a que el navegador registre el estado inicial antes
    // de la clase que dispara la transición; si no, aparece de golpe.
    void modal.offsetWidth;
    modal.classList.add('is-open');
  },

  _cerrarModal(selector) {
    const modal = document.querySelector(selector);
    if (!modal) return;
    modal.classList.remove('is-open');
    modal.hidden = true;
  },

  /* ───────────────────────── PRODUCCIÓN ───────────────────────── */

  async refreshProducciones() {
    const fecha = this._produccionFechaConsulta;
    // Las recetas también hacen falta aquí: el select de producto necesita
    // saber para cuáles productos ya existe receta, para prellenar ingredientes.
    const [insumos, recetas, producciones] = await Promise.all([
      this._insumosCacheGeneral.length ? this._insumosCacheGeneral : Insumos.listar(),
      Recetas.listar(),
      Producciones.listar(fecha),
    ]);

    if (producciones === 'UNAUTHORIZED' || recetas === 'UNAUTHORIZED') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }

    if (Array.isArray(insumos)) this._insumosCacheGeneral = insumos;
    this._recetasCache = Array.isArray(recetas) ? recetas : [];
    this._produccionesCache = Array.isArray(producciones) ? producciones : [];

    Render.updateProduccionCount(this._produccionesCache);
    Render.renderProducciones(this._produccionesCache, producciones === null, fecha);
  },

  verFechaProduccion(fecha) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return;
    this._produccionFechaConsulta = fecha;
    const btnHoy = document.querySelector(CONFIG.SELECTORS.btnProduccionHoy);
    const hoy = hoyHouston();
    if (btnHoy) btnHoy.hidden = fecha === hoy;
    this.refreshProducciones();
  },

  volverAHoyProduccion() {
    const hoy = hoyHouston();
    const filtroEl = document.querySelector(CONFIG.SELECTORS.produccionFiltroFecha);
    if (filtroEl) filtroEl.value = hoy;
    this.verFechaProduccion(hoy);
  },

  /** Cuando cambia el producto del formulario de Producción, prellena los
   *  ingredientes con los de la receta de ese producto (si existe). El
   *  panadero solo tiene que escribir los gramos reales de cada uno. */
  _onProduccionProductoChange() {
    const productoId = document.querySelector(CONFIG.SELECTORS.produccionProducto).value;
    const lista = document.querySelector(CONFIG.SELECTORS.produccionIngredientesLista);
    lista.innerHTML = '';

    const receta = this._recetasCache.find((r) => r.productoId === productoId);
    if (!receta) {
      const hint = document.createElement('p');
      hint.className = 'produccion-form__hint';
      hint.textContent =
        'Este producto todavía no tiene receta, créala primero en la pestaña Recetas.';
      lista.appendChild(hint);
      return;
    }

    receta.ingredientes.forEach((ing) => {
      const tpl = document.querySelector(CONFIG.SELECTORS.tplProduccionIngredienteRow);
      const row = tpl.content.cloneNode(true);
      const wrapper = row.querySelector('.receta-ingrediente-row');
      wrapper.dataset.insumoId = ing.insumoId;
      row.querySelector('.produccion-ingrediente-row__nombre').textContent = ing.insumoNombre;
      // Se prellena con el gramaje de referencia de la receta; el panadero
      // lo ajusta si esta tanda usó una cantidad distinta.
      row.querySelector('.produccion-ingrediente-row__gramos').value = ing.gramos;
      lista.appendChild(row);
    });
  },

  _leerIngredientesProduccion() {
    const filas = document.querySelectorAll(
      `${CONFIG.SELECTORS.produccionIngredientesLista} .receta-ingrediente-row`,
    );
    return [...filas].map((fila) => ({
      insumoId: fila.dataset.insumoId,
      gramos: Number(fila.querySelector('.produccion-ingrediente-row__gramos').value),
    }));
  },

  async deleteProduccion(id, productoNombre) {
    const confirmado = window.confirm(
      `¿Eliminar esta producción de "${productoNombre}"? También se pierden sus etapas registradas.`,
    );
    if (!confirmado) return;

    const resultado = await Producciones.eliminar(id);
    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert('No se pudo eliminar la producción. Intenta de nuevo en unos segundos.');
      return;
    }
    this.refreshProducciones();
  },

  async iniciarEtapaProduccion(produccionId, etapa) {
    const ahora = new Date();
    const horaInicio = `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`;

    const resultado = await Producciones.iniciarEtapa(produccionId, etapa, horaInicio);
    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert(resultado.message || 'No se pudo iniciar la etapa. Intenta de nuevo.');
      return;
    }
    this.refreshProducciones();
  },

  async finalizarEtapaProduccion(produccionId, etapaId) {
    const ahora = new Date();
    const horaFin = `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`;

    const resultado = await Producciones.finalizarEtapa(produccionId, etapaId, horaFin);
    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert(resultado.message || 'No se pudo cerrar la etapa. Intenta de nuevo.');
      return;
    }
    this.refreshProducciones();
  },

  async _handleProduccionSubmit() {
    const errorEl = document.querySelector(CONFIG.SELECTORS.produccionError);
    const errorMsgEl = document.querySelector(CONFIG.SELECTORS.produccionErrorMsg);

    const productoId = document.querySelector(CONFIG.SELECTORS.produccionProducto).value;
    const fecha = document.querySelector(CONFIG.SELECTORS.produccionFecha).value;
    const horaInicio = document.querySelector(CONFIG.SELECTORS.produccionHoraInicio).value;
    const ingredientes = this._leerIngredientesProduccion();

    if (!productoId) {
      errorMsgEl.textContent = 'Selecciona un producto.';
      errorEl.hidden = false;
      return;
    }
    if (ingredientes.length === 0) {
      errorMsgEl.textContent =
        'Este producto no tiene ingredientes cargados — probablemente no tiene receta todavía. Créala en la pestaña Recetas.';
      errorEl.hidden = false;
      return;
    }
    if (!fecha || !horaInicio) {
      errorMsgEl.textContent = 'Completa la fecha y la hora de inicio.';
      errorEl.hidden = false;
      return;
    }
    if (ingredientes.some((i) => !i.gramos || i.gramos <= 0)) {
      errorMsgEl.textContent = 'Cada ingrediente necesita una cantidad en gramos mayor a 0.';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const datos = {
      productoId,
      fecha,
      horaInicio,
      registradoPor: document.querySelector(CONFIG.SELECTORS.produccionRegistradoPor).value.trim(),
      notas: document.querySelector(CONFIG.SELECTORS.produccionNotas).value.trim(),
      temperaturaAmbienteC:
        document.querySelector(CONFIG.SELECTORS.produccionTemperaturaAmbiente).value || null,
      temperaturaAguaC:
        document.querySelector(CONFIG.SELECTORS.produccionTemperaturaAgua).value || null,
      ingredientes,
    };

    const submitBtn = document.querySelector(CONFIG.SELECTORS.produccionSubmitBtn);
    submitBtn.disabled = true;

    const resultado = await Producciones.crear(datos);

    submitBtn.disabled = false;

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      errorMsgEl.textContent =
        resultado.message || 'No se pudo guardar la producción. Intenta de nuevo.';
      errorEl.hidden = false;
      return;
    }

    document.querySelector(CONFIG.SELECTORS.produccionForm).reset();
    document.querySelector(CONFIG.SELECTORS.produccionIngredientesLista).innerHTML =
      '<p class="produccion-form__hint">Selecciona un producto con receta para ver sus ingredientes.</p>';
    this.refreshProducciones();
  },

  /** Cuando cambia el producto en el formulario de Horneadas, refresca el
   *  select "Producción de origen" con las tandas de ese producto en la
   *  fecha elegida (o hoy, si no hay fecha todavía). */
  async _actualizarSelectProduccionParaHorneada() {
    const selectProducto = document.querySelector(CONFIG.SELECTORS.horneadaProducto);
    const selectProduccion = document.querySelector(CONFIG.SELECTORS.horneadaProduccion);
    if (!selectProducto || !selectProduccion) return;

    const productoId = selectProducto.value;
    selectProduccion.innerHTML = '<option value="">— Ninguna (registro suelto) —</option>';
    if (!productoId) return;

    const fechaEl = document.querySelector(CONFIG.SELECTORS.horneadaFecha);
    const fecha = fechaEl?.value || hoyHouston();

    // Una producción solo se hornea una vez (el backend ya lo bloquea) — acá
    // se filtra en la UI para no dejar elegir algo que el servidor rechazaría
    // de todas formas. La horneada que se está editando (si hay una) es la
    // excepción: su propia producción vinculada debe seguir apareciendo.
    const idHorneadaEnEdicion = document.querySelector(CONFIG.SELECTORS.horneadaId)?.value || null;

    const [producciones, horneadasDelDia] = await Promise.all([
      Producciones.listar(fecha),
      Horneadas.listar(fecha),
    ]);
    if (!Array.isArray(producciones)) return;

    const produccionesYaUsadas = new Set(
      Array.isArray(horneadasDelDia)
        ? horneadasDelDia
            .filter((h) => h.produccionId && h.id !== idHorneadaEnEdicion)
            .map((h) => h.produccionId)
        : [],
    );

    producciones
      .filter((p) => p.productoId === productoId && !produccionesYaUsadas.has(p.id))
      .forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.horaInicio} — ${p.pesoTotalMasaG}g (${p.unidadesEstimadas} u. est.)`;
        opt.dataset.pesoTotalMasaG = p.pesoTotalMasaG ?? '';
        selectProduccion.appendChild(opt);
      });

    this._recalcularMermaReal();
  },

  /** Recalcula % Merma = ((Masa Cruda − Pan Cocido) / Masa Cruda) × 100 cada
   *  vez que cambia el peso del pan cocido o la producción de origen
   *  elegida. Sin producción vinculada no hay masa cruda con qué comparar,
   *  así que el campo se deja vacío en vez de mostrar un cero engañoso. */
  _recalcularMermaReal() {
    const selectProduccion = document.querySelector(CONFIG.SELECTORS.horneadaProduccion);
    const inputPesoPanCocido = document.querySelector(CONFIG.SELECTORS.horneadaPesoPanCocido);
    const inputMerma = document.querySelector(CONFIG.SELECTORS.horneadaMermaReal);
    if (!selectProduccion || !inputPesoPanCocido || !inputMerma) return;

    const opcionElegida = selectProduccion.selectedOptions[0];
    const pesoMasaCruda = Number(opcionElegida?.dataset.pesoTotalMasaG);
    const pesoPanCocido = Number(inputPesoPanCocido.value);

    if (
      !opcionElegida?.value ||
      !Number.isFinite(pesoMasaCruda) ||
      pesoMasaCruda <= 0 ||
      !Number.isFinite(pesoPanCocido) ||
      pesoPanCocido <= 0
    ) {
      inputMerma.value = '';
      return;
    }

    const merma = ((pesoMasaCruda - pesoPanCocido) / pesoMasaCruda) * 100;
    inputMerma.value = Math.round(merma * 10) / 10;
  },

  startEditProveedor(id) {
    const proveedor = this._proveedoresCache.find((p) => p.id === id);
    if (!proveedor) return;

    document.querySelector(CONFIG.SELECTORS.proveedorId).value = proveedor.id;
    Object.entries(CONFIG.PROVEEDOR_FIELDS).forEach(([campo, selector]) => {
      const input = document.querySelector(selector);
      if (input) input.value = proveedor[campo] ?? '';
    });

    document.querySelector(CONFIG.SELECTORS.proveedorSubmitBtn).innerHTML =
      '<i class="fa-solid fa-check" aria-hidden="true"></i> Guardar cambios';
    document.querySelector(CONFIG.SELECTORS.proveedorCancelEditBtn).hidden = false;

    document
      .querySelector(CONFIG.SELECTORS.proveedorForm)
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelector(CONFIG.PROVEEDOR_FIELDS.razonSocial).focus();
  },

  cancelEditProveedor() {
    this._resetProveedorForm();
  },

  async deleteProveedor(id, nombre) {
    const confirmado = window.confirm(`¿Eliminar "${nombre}" del listado de proveedores?`);
    if (!confirmado) return;

    const resultado = await Proveedores.eliminar(id);

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert('No se pudo eliminar el proveedor. Intenta de nuevo en unos segundos.');
      return;
    }

    this.refreshProveedores();
  },

  _resetProveedorForm() {
    document.querySelector(CONFIG.SELECTORS.proveedorForm).reset();
    document.querySelector(CONFIG.SELECTORS.proveedorId).value = '';
    document.querySelector(CONFIG.SELECTORS.proveedorSubmitBtn).innerHTML =
      '<i class="fa-solid fa-plus" aria-hidden="true"></i> Agregar proveedor';
    document.querySelector(CONFIG.SELECTORS.proveedorCancelEditBtn).hidden = true;
    document.querySelector(CONFIG.SELECTORS.proveedorError).hidden = true;
  },

  async _handleProveedorSubmit() {
    const errorEl = document.querySelector(CONFIG.SELECTORS.proveedorError);
    const errorMsgEl = document.querySelector(CONFIG.SELECTORS.proveedorErrorMsg);

    const datos = {};
    Object.entries(CONFIG.PROVEEDOR_FIELDS).forEach(([campo, selector]) => {
      const valor = document.querySelector(selector)?.value ?? '';
      datos[campo] = CONFIG.PROVEEDOR_NUMERIC_FIELDS.includes(campo)
        ? valor === ''
          ? null
          : Number(valor)
        : valor.trim();
    });

    if (!datos.razonSocial) {
      errorMsgEl.textContent = 'El nombre o razón social es obligatorio.';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const idExistente = document.querySelector(CONFIG.SELECTORS.proveedorId).value || null;
    const submitBtn = document.querySelector(CONFIG.SELECTORS.proveedorSubmitBtn);
    const textoOriginal = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Guardando…';

    const resultado = idExistente
      ? await Proveedores.actualizar(idExistente, datos)
      : await Proveedores.crear(datos);

    submitBtn.disabled = false;
    submitBtn.innerHTML = textoOriginal;

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      errorMsgEl.textContent =
        resultado.message || 'No se pudo guardar el proveedor. Intenta de nuevo.';
      errorEl.hidden = false;
      return;
    }

    this._resetProveedorForm();
    this.refreshProveedores();
  },

  startEditHorneada(id) {
    const horneada = this._horneadasCache.find((h) => h.id === id);
    if (!horneada) return;

    document.querySelector(CONFIG.SELECTORS.horneadaId).value = horneada.id;
    document.querySelector(CONFIG.SELECTORS.horneadaProducto).value = horneada.productoId;
    document.querySelector(CONFIG.SELECTORS.horneadaCantidad).value = horneada.cantidad ?? '';
    document.querySelector(CONFIG.SELECTORS.horneadaFecha).value = horneada.fecha || '';
    document.querySelector(CONFIG.SELECTORS.horneadaHora).value = horneada.hora || '';
    document.querySelector(CONFIG.SELECTORS.horneadaRegistradoPor).value =
      horneada.registradoPor || '';
    document.querySelector(CONFIG.SELECTORS.horneadaNotas).value = horneada.notas || '';
    document.querySelector(CONFIG.SELECTORS.horneadaTemperaturaPisoHorno).value =
      horneada.temperaturaPisoHornoC ?? '';
    document.querySelector(CONFIG.SELECTORS.horneadaPesoPanCocido).value =
      horneada.pesoPanCocidoTotalG ?? '';
    document.querySelector(CONFIG.SELECTORS.horneadaCostoEnergia).value =
      horneada.costoEstimadoEnergiaLote ?? '';
    document.querySelector(CONFIG.SELECTORS.horneadaUnidadesSegundaCalidad).value =
      horneada.unidadesSegundaCalidad ?? '';
    document.querySelector(CONFIG.SELECTORS.horneadaTemperaturaReal).value =
      horneada.temperaturaHorneadoRealC ?? '';
    document.querySelector(CONFIG.SELECTORS.horneadaTiempoReal).value =
      horneada.tiempoHorneadoRealMin ?? '';
    document.querySelector(CONFIG.SELECTORS.horneadaMermaReal).value = horneada.mermaRealPct ?? '';

    this._actualizarSelectProduccionParaHorneada().then(() => {
      const selectProduccion = document.querySelector(CONFIG.SELECTORS.horneadaProduccion);
      if (selectProduccion && horneada.produccionId) {
        selectProduccion.value = horneada.produccionId;
      }
      // Asignar .value por JS no dispara 'change', así que el recálculo
      // automático de merma no se activaría solo — se llama a mano acá.
      this._recalcularMermaReal();
    });

    const submitBtn = document.querySelector(CONFIG.SELECTORS.horneadaSubmitBtn);
    submitBtn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> Guardar cambios';
    document.querySelector(CONFIG.SELECTORS.horneadaCancelEditBtn).hidden = false;

    document
      .querySelector(CONFIG.SELECTORS.horneadaForm)
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelector(CONFIG.SELECTORS.horneadaProducto).focus();
  },

  cancelEditHorneada() {
    this._resetHorneadaForm();
  },

  async deleteHorneada(id, productoNombre) {
    const confirmado = window.confirm(`¿Eliminar el registro de horneada de "${productoNombre}"?`);
    if (!confirmado) return;

    const resultado = await Horneadas.eliminar(id);

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert('No se pudo eliminar la horneada. Intenta de nuevo en unos segundos.');
      return;
    }

    this.refreshHorneadas();
  },

  _resetHorneadaForm() {
    const form = document.querySelector(CONFIG.SELECTORS.horneadaForm);
    form.reset();
    document.querySelector(CONFIG.SELECTORS.horneadaId).value = '';
    document.querySelector(CONFIG.SELECTORS.horneadaSubmitBtn).innerHTML =
      '<i class="fa-solid fa-plus" aria-hidden="true"></i> Registrar horneada';
    document.querySelector(CONFIG.SELECTORS.horneadaCancelEditBtn).hidden = true;
    document.querySelector(CONFIG.SELECTORS.horneadaError).hidden = true;
    this._prefillHorneadaFechaHora();
  },

  /** Prellena fecha (hoy) y hora (ahora) del formulario, como punto de partida
   *  cómodo — el usuario puede ajustarlas si registra la horneada tarde. */
  _prefillHorneadaFechaHora() {
    const ahora = new Date();
    const fechaEl = document.querySelector(CONFIG.SELECTORS.horneadaFecha);
    const horaEl = document.querySelector(CONFIG.SELECTORS.horneadaHora);
    if (fechaEl && !fechaEl.value) fechaEl.value = ahora.toISOString().slice(0, 10);
    if (horaEl && !horaEl.value) {
      horaEl.value = `${String(ahora.getHours()).padStart(2, '0')}:${String(
        ahora.getMinutes(),
      ).padStart(2, '0')}`;
    }
  },

  async _handleHorneadaSubmit() {
    const errorEl = document.querySelector(CONFIG.SELECTORS.horneadaError);
    const errorMsgEl = document.querySelector(CONFIG.SELECTORS.horneadaErrorMsg);

    const productoId = document.querySelector(CONFIG.SELECTORS.horneadaProducto).value;
    const cantidadRaw = document.querySelector(CONFIG.SELECTORS.horneadaCantidad).value;
    const fecha = document.querySelector(CONFIG.SELECTORS.horneadaFecha).value;
    const hora = document.querySelector(CONFIG.SELECTORS.horneadaHora).value;

    if (!productoId || cantidadRaw === '' || Number(cantidadRaw) <= 0 || !fecha || !hora) {
      errorMsgEl.textContent =
        'Completa producto, cantidad (mayor a 0), fecha y hora de la horneada.';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const idExistente = document.querySelector(CONFIG.SELECTORS.horneadaId).value || null;

    const datos = {
      productoId,
      cantidad: Number(cantidadRaw),
      fecha,
      hora,
      registradoPor: document.querySelector(CONFIG.SELECTORS.horneadaRegistradoPor).value.trim(),
      notas: document.querySelector(CONFIG.SELECTORS.horneadaNotas).value.trim(),
      produccionId: document.querySelector(CONFIG.SELECTORS.horneadaProduccion)?.value || null,
      temperaturaPisoHornoC:
        document.querySelector(CONFIG.SELECTORS.horneadaTemperaturaPisoHorno).value || null,
      pesoPanCocidoTotalG:
        document.querySelector(CONFIG.SELECTORS.horneadaPesoPanCocido).value || null,
      costoEstimadoEnergiaLote:
        document.querySelector(CONFIG.SELECTORS.horneadaCostoEnergia).value || null,
      unidadesSegundaCalidad:
        document.querySelector(CONFIG.SELECTORS.horneadaUnidadesSegundaCalidad).value || null,
      temperaturaHorneadoRealC:
        document.querySelector(CONFIG.SELECTORS.horneadaTemperaturaReal).value || null,
      tiempoHorneadoRealMin:
        document.querySelector(CONFIG.SELECTORS.horneadaTiempoReal).value || null,
      mermaRealPct: document.querySelector(CONFIG.SELECTORS.horneadaMermaReal).value || null,
    };

    const submitBtn = document.querySelector(CONFIG.SELECTORS.horneadaSubmitBtn);
    const textoOriginal = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Guardando…';

    const resultado = idExistente
      ? await Horneadas.actualizar(idExistente, datos)
      : await Horneadas.crear(datos);

    submitBtn.disabled = false;
    submitBtn.innerHTML = textoOriginal;

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      errorMsgEl.textContent =
        resultado.message || 'No se pudo guardar la horneada. Intenta de nuevo.';
      errorEl.hidden = false;
      return;
    }

    this._resetHorneadaForm();
    this.refreshHorneadas();
  },

  startEditAjuste(id) {
    const ajuste = this._ajustesCache.find((a) => a.id === id);
    if (!ajuste) return;

    document.querySelector(CONFIG.SELECTORS.ajusteId).value = ajuste.id;
    document.querySelector(CONFIG.SELECTORS.ajusteProducto).value = ajuste.productoId;
    document.querySelector(CONFIG.SELECTORS.ajusteCantidad).value = ajuste.cantidad ?? '';
    document.querySelector(CONFIG.SELECTORS.ajusteMotivo).value = ajuste.motivo || 'merma';
    document.querySelector(CONFIG.SELECTORS.ajusteFecha).value = ajuste.fecha || '';
    document.querySelector(CONFIG.SELECTORS.ajusteHora).value = ajuste.hora || '';
    document.querySelector(CONFIG.SELECTORS.ajusteRegistradoPor).value = ajuste.registradoPor || '';
    document.querySelector(CONFIG.SELECTORS.ajusteNotas).value = ajuste.notas || '';

    const submitBtn = document.querySelector(CONFIG.SELECTORS.ajusteSubmitBtn);
    submitBtn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> Guardar cambios';
    document.querySelector(CONFIG.SELECTORS.ajusteCancelEditBtn).hidden = false;

    document
      .querySelector(CONFIG.SELECTORS.ajusteForm)
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelector(CONFIG.SELECTORS.ajusteProducto).focus();
  },

  cancelEditAjuste() {
    this._resetAjusteForm();
  },

  async deleteAjuste(id, productoNombre) {
    const confirmado = window.confirm(`¿Eliminar el ajuste de inventario de "${productoNombre}"?`);
    if (!confirmado) return;

    const resultado = await Ajustes.eliminar(id);

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert('No se pudo eliminar el ajuste. Intenta de nuevo en unos segundos.');
      return;
    }

    this.refreshInventario();
  },

  _resetAjusteForm() {
    const form = document.querySelector(CONFIG.SELECTORS.ajusteForm);
    form.reset();
    document.querySelector(CONFIG.SELECTORS.ajusteId).value = '';
    document.querySelector(CONFIG.SELECTORS.ajusteSubmitBtn).innerHTML =
      '<i class="fa-solid fa-plus" aria-hidden="true"></i> Registrar ajuste';
    document.querySelector(CONFIG.SELECTORS.ajusteCancelEditBtn).hidden = true;
    document.querySelector(CONFIG.SELECTORS.ajusteError).hidden = true;
    this._prefillAjusteFechaHora();
  },

  _prefillAjusteFechaHora() {
    const ahora = new Date();
    const fechaEl = document.querySelector(CONFIG.SELECTORS.ajusteFecha);
    const horaEl = document.querySelector(CONFIG.SELECTORS.ajusteHora);
    if (fechaEl && !fechaEl.value) fechaEl.value = ahora.toISOString().slice(0, 10);
    if (horaEl && !horaEl.value) {
      horaEl.value = `${String(ahora.getHours()).padStart(2, '0')}:${String(
        ahora.getMinutes(),
      ).padStart(2, '0')}`;
    }
  },

  async _handleAjusteSubmit() {
    const errorEl = document.querySelector(CONFIG.SELECTORS.ajusteError);
    const errorMsgEl = document.querySelector(CONFIG.SELECTORS.ajusteErrorMsg);

    const productoId = document.querySelector(CONFIG.SELECTORS.ajusteProducto).value;
    const cantidadRaw = document.querySelector(CONFIG.SELECTORS.ajusteCantidad).value;
    const motivo = document.querySelector(CONFIG.SELECTORS.ajusteMotivo).value;
    const fecha = document.querySelector(CONFIG.SELECTORS.ajusteFecha).value;
    const hora = document.querySelector(CONFIG.SELECTORS.ajusteHora).value;

    if (
      !productoId ||
      cantidadRaw === '' ||
      Number(cantidadRaw) <= 0 ||
      !motivo ||
      !fecha ||
      !hora
    ) {
      errorMsgEl.textContent = 'Completa producto, cantidad (mayor a 0), motivo, fecha y hora.';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const idExistente = document.querySelector(CONFIG.SELECTORS.ajusteId).value || null;

    const datos = {
      productoId,
      cantidad: Number(cantidadRaw),
      motivo,
      fecha,
      hora,
      registradoPor: document.querySelector(CONFIG.SELECTORS.ajusteRegistradoPor).value.trim(),
      notas: document.querySelector(CONFIG.SELECTORS.ajusteNotas).value.trim(),
    };

    const submitBtn = document.querySelector(CONFIG.SELECTORS.ajusteSubmitBtn);
    const textoOriginal = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Guardando…';

    const resultado = idExistente
      ? await Ajustes.actualizar(idExistente, datos)
      : await Ajustes.crear(datos);

    submitBtn.disabled = false;
    submitBtn.innerHTML = textoOriginal;

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      errorMsgEl.textContent =
        resultado.message || 'No se pudo guardar el ajuste. Intenta de nuevo.';
      errorEl.hidden = false;
      return;
    }

    this._resetAjusteForm();
    this.refreshInventario();
  },

  startEditInsumo(id) {
    const insumo = this._insumosCache.find((i) => i.id === id);
    if (!insumo) return;

    document.querySelector(CONFIG.SELECTORS.insumoId).value = insumo.id;
    document.querySelector(CONFIG.SELECTORS.insumoNombre).value = insumo.nombre || '';
    document.querySelector(CONFIG.SELECTORS.insumoCategoria).value = insumo.categoria || 'otros';
    document.querySelector(CONFIG.SELECTORS.insumoCantidad).value = insumo.cantidad ?? '';
    document.querySelector(CONFIG.SELECTORS.insumoUnidad).value = insumo.unidad || 'kg';
    document.querySelector(CONFIG.SELECTORS.insumoCosto).value = insumo.costoUnitario ?? '';
    document.querySelector(CONFIG.SELECTORS.insumoStockMinimo).value = insumo.stockMinimo ?? '';
    document.querySelector(CONFIG.SELECTORS.insumoProveedor).value = insumo.proveedor || '';
    document.querySelector(CONFIG.SELECTORS.insumoProveedorSecundario).value =
      insumo.proveedorSecundario || '';
    document.querySelector(CONFIG.SELECTORS.insumoMarca).value = insumo.marca || '';
    document.querySelector(CONFIG.SELECTORS.insumoSku).value = insumo.sku || '';
    document.querySelector(CONFIG.SELECTORS.insumoStockMaximo).value = insumo.stockMaximo ?? '';
    document.querySelector(CONFIG.SELECTORS.insumoEquivalenciaGramos).value =
      insumo.equivalenciaGramos ?? '';
    document.querySelector(CONFIG.SELECTORS.insumoPresentacionCompra).value =
      insumo.presentacionCompra || '';
    document.querySelector(CONFIG.SELECTORS.insumoImpuesto).value = insumo.impuestoPorcentaje ?? '';
    document.querySelector(CONFIG.SELECTORS.insumoLeadTime).value = insumo.leadTimeDias ?? '';
    document.querySelector(CONFIG.SELECTORS.insumoCondicionesAlmacenamiento).value =
      insumo.condicionesAlmacenamiento || '';
    document.querySelector(CONFIG.SELECTORS.insumoLoteProveedor).value = insumo.loteProveedor || '';
    document.querySelector(CONFIG.SELECTORS.insumoVidaUtilAbierto).value =
      insumo.vidaUtilAbiertoDias ?? '';
    document
      .querySelector(CONFIG.SELECTORS.insumoAlergenos)
      .querySelectorAll('input[type="checkbox"]')
      .forEach((cb) => {
        cb.checked = Array.isArray(insumo.alergenos) && insumo.alergenos.includes(cb.value);
      });
    document.querySelector(CONFIG.SELECTORS.insumoFechaVencimiento).value =
      insumo.fechaVencimiento || '';
    document.querySelector(CONFIG.SELECTORS.insumoUbicacion).value = insumo.ubicacion || '';
    document.querySelector(CONFIG.SELECTORS.insumoNotas).value = insumo.notas || '';

    const submitBtn = document.querySelector(CONFIG.SELECTORS.insumoSubmitBtn);
    submitBtn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> Guardar cambios';
    document.querySelector(CONFIG.SELECTORS.insumoCancelEditBtn).hidden = false;

    document
      .querySelector(CONFIG.SELECTORS.insumoForm)
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelector(CONFIG.SELECTORS.insumoNombre).focus();
  },

  cancelEditInsumo() {
    this._resetInsumoForm();
  },

  startEditProducto(id) {
    const producto = this._productosCache.find((p) => p.id === id);
    if (!producto) return;

    document.querySelector(CONFIG.SELECTORS.productoId).value = producto.id;
    document.querySelector(CONFIG.SELECTORS.productoNombre).value = producto.nombre || '';
    document.querySelector(CONFIG.SELECTORS.productoCategoria).value = producto.categoria || '';
    document.querySelector(CONFIG.SELECTORS.productoPrecio).value = producto.precio ?? '';
    document.querySelector(CONFIG.SELECTORS.productoEstado).value = producto.estado || 'activo';
    document.querySelector(CONFIG.SELECTORS.productoSku).value = producto.sku || '';
    document.querySelector(CONFIG.SELECTORS.productoDescripcion).value = producto.descripcion || '';
    document.querySelector(CONFIG.SELECTORS.productoImagenBase).value = producto.imagenBase || '';
    document.querySelector(CONFIG.SELECTORS.productoAltImagen).value = producto.altImagen || '';
    document.querySelector(CONFIG.SELECTORS.productoVidaUtil).value = producto.vidaUtilHoras ?? '';
    document.querySelector(CONFIG.SELECTORS.productoActualizadoPor).value =
      producto.actualizadoPor || '';

    document.querySelector(CONFIG.SELECTORS.productoSubmitLabel).textContent = 'Guardar cambios';
    document.querySelector(CONFIG.SELECTORS.productoCancelarEdicion).hidden = false;

    document
      .querySelector(CONFIG.SELECTORS.productoForm)
      .scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelector(CONFIG.SELECTORS.productoNombre).focus();
  },

  cancelEditProducto() {
    this._resetProductoForm();
  },

  async deleteInsumo(id, nombre) {
    const confirmado = window.confirm(`¿Eliminar "${nombre}" del listado de insumos?`);
    if (!confirmado) return;

    const resultado = await Insumos.eliminar(id);

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert(
        resultado.message || 'No se pudo eliminar el insumo. Intenta de nuevo en unos segundos.',
      );
      return;
    }

    this.refreshInsumos();
  },

  _resetInsumoForm() {
    const form = document.querySelector(CONFIG.SELECTORS.insumoForm);
    form.reset();
    document.querySelector(CONFIG.SELECTORS.insumoId).value = '';
    document.querySelector(CONFIG.SELECTORS.insumoSubmitBtn).innerHTML =
      '<i class="fa-solid fa-plus" aria-hidden="true"></i> Agregar insumo';
    document.querySelector(CONFIG.SELECTORS.insumoCancelEditBtn).hidden = true;
    document.querySelector(CONFIG.SELECTORS.insumoError).hidden = true;
  },

  async _handleProductoSubmit() {
    const errorEl = document.querySelector(CONFIG.SELECTORS.productoError);
    const errorMsgEl = document.querySelector(CONFIG.SELECTORS.productoErrorMsg);

    const nombre = document.querySelector(CONFIG.SELECTORS.productoNombre).value.trim();
    const categoria = document.querySelector(CONFIG.SELECTORS.productoCategoria).value;
    const precioRaw = document.querySelector(CONFIG.SELECTORS.productoPrecio).value;

    if (!nombre || !categoria || precioRaw === '' || Number(precioRaw) <= 0) {
      errorMsgEl.textContent = 'Completa nombre, categoría y un precio mayor a 0.';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const idExistente = document.querySelector(CONFIG.SELECTORS.productoId).value || null;
    const datos = {
      nombre,
      categoria,
      precio: Number(precioRaw),
      estado: document.querySelector(CONFIG.SELECTORS.productoEstado).value,
      sku: document.querySelector(CONFIG.SELECTORS.productoSku).value.trim(),
      descripcion: document.querySelector(CONFIG.SELECTORS.productoDescripcion).value.trim(),
      imagenBase: document.querySelector(CONFIG.SELECTORS.productoImagenBase).value.trim(),
      altImagen: document.querySelector(CONFIG.SELECTORS.productoAltImagen).value.trim(),
      vidaUtilHoras: document.querySelector(CONFIG.SELECTORS.productoVidaUtil).value.trim(),
      actualizadoPor: document.querySelector(CONFIG.SELECTORS.productoActualizadoPor).value.trim(),
    };

    const submitLabel = document.querySelector(CONFIG.SELECTORS.productoSubmitLabel);
    const textoOriginal = submitLabel.textContent;
    submitLabel.textContent = 'Guardando…';

    const resultado = idExistente
      ? await Productos.actualizar(idExistente, datos)
      : await Productos.crear(datos);

    submitLabel.textContent = textoOriginal;

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      errorMsgEl.textContent =
        resultado.message || 'No se pudo guardar el producto. Intenta de nuevo.';
      errorEl.hidden = false;
      return;
    }

    this._resetProductoForm();
    this.refreshProductos();
  },

  _resetProductoForm() {
    const form = document.querySelector(CONFIG.SELECTORS.productoForm);
    form.reset();
    document.querySelector(CONFIG.SELECTORS.productoId).value = '';
    document.querySelector(CONFIG.SELECTORS.productoEstado).value = 'activo';
    document.querySelector(CONFIG.SELECTORS.productoSubmitLabel).textContent = 'Guardar producto';
    document.querySelector(CONFIG.SELECTORS.productoCancelarEdicion).hidden = true;
    document.querySelector(CONFIG.SELECTORS.productoError).hidden = true;
  },

  _bindEvents() {
    // Login
    document.querySelector(CONFIG.SELECTORS.loginForm)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pwd = document.querySelector(CONFIG.SELECTORS.password).value;
      const errorEl = document.querySelector(CONFIG.SELECTORS.loginError);
      const submitBtn = e.target.querySelector('button[type="submit"]');

      submitBtn.disabled = true;
      submitBtn.textContent = 'Verificando…';

      try {
        const result = await Auth.login(pwd);
        if (result.ok) {
          errorEl.hidden = true;
          this._showCorrectView();
          return;
        }
        this._showLoginError('Contraseña incorrecta. Intenta de nuevo.');
      } catch (err) {
        console.error('[Auth] No se pudo iniciar sesión:', err.message);
        this._showLoginError(
          'No se pudo conectar con el servidor. Intenta de nuevo en unos segundos.',
        );
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML =
          '<i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i> Entrar';
      }
    });

    // Logout
    document.querySelector(CONFIG.SELECTORS.logoutBtn)?.addEventListener('click', () => {
      Auth.logout();
      this._showCorrectView();
    });

    // Nav entre secciones (Dashboard / Insumos)
    document.querySelectorAll(CONFIG.SELECTORS.navBtns).forEach((btn) => {
      btn.addEventListener('click', () => this._switchView(btn.dataset.viewTarget));
    });

    // Formulario de insumos: alta y edición
    document.querySelector(CONFIG.SELECTORS.insumoForm)?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleInsumoSubmit();
    });

    document
      .querySelector(CONFIG.SELECTORS.insumoCancelEditBtn)
      ?.addEventListener('click', () => this.cancelEditInsumo());

    // Formulario de productos: alta y edición
    document.querySelector(CONFIG.SELECTORS.productoForm)?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleProductoSubmit();
    });

    document
      .querySelector(CONFIG.SELECTORS.productoCancelarEdicion)
      ?.addEventListener('click', () => this.cancelEditProducto());

    // Tabla de productos: un solo listener delegado en el tbody, en vez
    // de uno por fila (la tabla se reconstruye entera en cada
    // refreshProductos(), así que los listeners individuales se
    // perderían de todas formas en cada render).
    document.querySelector(CONFIG.SELECTORS.productosTbody)?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-accion]');
      if (!btn) return;
      const id = Number(btn.dataset.id);
      if (btn.dataset.accion === 'editar-producto') this.startEditProducto(id);
    });

    // Formulario de proveedores: alta y edición
    document.querySelector(CONFIG.SELECTORS.proveedorForm)?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleProveedorSubmit();
    });

    document
      .querySelector(CONFIG.SELECTORS.proveedorCancelEditBtn)
      ?.addEventListener('click', () => this.cancelEditProveedor());

    // Órdenes de compra: formulario, líneas, filtros y modales
    document.querySelector(CONFIG.SELECTORS.ocForm)?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleOrdenCompraSubmit();
    });

    document
      .querySelector(CONFIG.SELECTORS.ocGuardarEmitirBtn)
      ?.addEventListener('click', () => this._handleOrdenCompraSubmit({ emitir: true }));

    document
      .querySelector(CONFIG.SELECTORS.btnOcNueva)
      ?.addEventListener('click', () => this.abrirNuevaOrdenCompra());

    document.querySelectorAll('[data-oc-cerrar-nueva]').forEach((btn) => {
      btn.addEventListener('click', () => this.cancelEditOrdenCompra());
    });

    document
      .querySelector(CONFIG.SELECTORS.btnOcAgregarItem)
      ?.addEventListener('click', () => this.agregarFilaItemOC());

    document
      .querySelector(CONFIG.SELECTORS.ocFlete)
      ?.addEventListener('input', () => this._recalcularTotalesOC());

    document.querySelector(CONFIG.SELECTORS.btnOcFiltrar)?.addEventListener('click', () => {
      this._ocFiltros = {
        estado: document.querySelector(CONFIG.SELECTORS.ocFiltroEstado).value,
        proveedorId: document.querySelector(CONFIG.SELECTORS.ocFiltroProveedor).value,
        desde: document.querySelector(CONFIG.SELECTORS.ocFiltroDesde).value,
        hasta: document.querySelector(CONFIG.SELECTORS.ocFiltroHasta).value,
      };
      this.refreshOrdenesCompra();
    });

    document.querySelector(CONFIG.SELECTORS.btnOcLimpiarFiltros)?.addEventListener('click', () => {
      document.querySelector(CONFIG.SELECTORS.ocFiltroEstado).value = '';
      document.querySelector(CONFIG.SELECTORS.ocFiltroProveedor).value = '';
      document.querySelector(CONFIG.SELECTORS.ocFiltroDesde).value = '';
      document.querySelector(CONFIG.SELECTORS.ocFiltroHasta).value = '';
      this._ocFiltros = {};
      this.refreshOrdenesCompra();
    });

    document.querySelector(CONFIG.SELECTORS.ocRecepcionForm)?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleRecepcionOrdenCompraSubmit();
    });

    document.querySelectorAll('[data-oc-cerrar-recepcion]').forEach((btn) => {
      btn.addEventListener('click', () => this._cerrarModal(CONFIG.SELECTORS.ocRecepcionModal));
    });

    document.querySelectorAll('[data-oc-cerrar-trazabilidad]').forEach((btn) => {
      btn.addEventListener('click', () => this._cerrarModal(CONFIG.SELECTORS.ocTrazabilidadModal));
    });

    // Lotes: filtros, variable del histograma y trazabilidad de un lote.
    document.querySelector(CONFIG.SELECTORS.btnLotesFiltrar)?.addEventListener('click', () => {
      this._lotesFiltros = {
        desde: document.querySelector(CONFIG.SELECTORS.lotesFiltroDesde).value,
        hasta: document.querySelector(CONFIG.SELECTORS.lotesFiltroHasta).value,
        productoId: document.querySelector(CONFIG.SELECTORS.lotesFiltroProducto).value,
      };
      this.refreshLotes();
    });

    document.querySelector(CONFIG.SELECTORS.btnLotesLimpiar)?.addEventListener('click', () => {
      document.querySelector(CONFIG.SELECTORS.lotesFiltroDesde).value = '';
      document.querySelector(CONFIG.SELECTORS.lotesFiltroHasta).value = '';
      document.querySelector(CONFIG.SELECTORS.lotesFiltroProducto).value = '';
      this._lotesFiltros = {};
      this.refreshLotes();
    });

    document.querySelector(CONFIG.SELECTORS.lotesVariable)?.addEventListener('change', (e) => {
      this.cambiarVariableLotes(e.target.value);
    });

    document.querySelector(CONFIG.SELECTORS.lotesTabla)?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-lote-accion="trazabilidad"]');
      if (!btn) return;
      this.verTrazabilidadLote(btn.dataset.id);
    });

    document.querySelectorAll('[data-lote-traza-cerrar]').forEach((btn) => {
      btn.addEventListener('click', () => this._cerrarModal(CONFIG.SELECTORS.loteTrazaModal));
    });

    // Mermas: filtros (mismo patrón que Lotes).
    document.querySelector(CONFIG.SELECTORS.btnMermasFiltrar)?.addEventListener('click', () => {
      this._mermasFiltros = {
        desde: document.querySelector(CONFIG.SELECTORS.mermasFiltroDesde).value,
        hasta: document.querySelector(CONFIG.SELECTORS.mermasFiltroHasta).value,
        productoId: document.querySelector(CONFIG.SELECTORS.mermasFiltroProducto).value,
      };
      this.refreshMermas();
    });

    document.querySelector(CONFIG.SELECTORS.btnMermasLimpiar)?.addEventListener('click', () => {
      document.querySelector(CONFIG.SELECTORS.mermasFiltroDesde).value = '';
      document.querySelector(CONFIG.SELECTORS.mermasFiltroHasta).value = '';
      document.querySelector(CONFIG.SELECTORS.mermasFiltroProducto).value = '';
      this._mermasFiltros = {};
      this.refreshMermas();
    });

    // Ciclo de pedidos: filtros e historial de un pedido.
    document.querySelector(CONFIG.SELECTORS.btnPedidosFiltrar)?.addEventListener('click', () => {
      this._pedidosFiltros = {
        desde: document.querySelector(CONFIG.SELECTORS.pedidosFiltroDesde).value,
        hasta: document.querySelector(CONFIG.SELECTORS.pedidosFiltroHasta).value,
        estado: document.querySelector(CONFIG.SELECTORS.pedidosFiltroEstado).value,
      };
      this.refreshPedidos();
    });

    document.querySelector(CONFIG.SELECTORS.btnPedidosLimpiar)?.addEventListener('click', () => {
      document.querySelector(CONFIG.SELECTORS.pedidosFiltroDesde).value = '';
      document.querySelector(CONFIG.SELECTORS.pedidosFiltroHasta).value = '';
      document.querySelector(CONFIG.SELECTORS.pedidosFiltroEstado).value = '';
      this._pedidosFiltros = {};
      this.refreshPedidos();
    });

    document.querySelector(CONFIG.SELECTORS.pedidosTabla)?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pedido-accion="historial"]');
      if (!btn) return;
      this.verHistorialPedido(btn.dataset.numero);
    });

    document.querySelectorAll('[data-pedido-historial-cerrar]').forEach((btn) => {
      btn.addEventListener('click', () => this._cerrarModal(CONFIG.SELECTORS.pedidoHistorialModal));
    });

    // El operario en turno se recuerda en este navegador para no reescribirlo
    // en cada cambio de estado.
    Operario.restaurar();
    document.querySelector(CONFIG.SELECTORS.operarioActual)?.addEventListener('change', (e) => {
      Operario.guardar(e.target.value.trim());
    });

    // Formulario de horneadas: alta y edición
    document.querySelector(CONFIG.SELECTORS.horneadaForm)?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleHorneadaSubmit();
    });

    document
      .querySelector(CONFIG.SELECTORS.horneadaCancelEditBtn)
      ?.addEventListener('click', () => this.cancelEditHorneada());

    // Toolbar de trazabilidad: consultar horneadas de otra fecha
    document.querySelector(CONFIG.SELECTORS.btnHorneadaFiltrar)?.addEventListener('click', () => {
      const valor = document.querySelector(CONFIG.SELECTORS.horneadaFiltroFecha)?.value;
      this.verFechaHorneadas(valor);
    });

    document
      .querySelector(CONFIG.SELECTORS.btnHorneadaHoy)
      ?.addEventListener('click', () => this.volverAHoyHorneadas());

    // Formulario de ajustes de inventario: alta y edición
    document.querySelector(CONFIG.SELECTORS.ajusteForm)?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleAjusteSubmit();
    });

    document
      .querySelector(CONFIG.SELECTORS.ajusteCancelEditBtn)
      ?.addEventListener('click', () => this.cancelEditAjuste());

    // Toolbar de Inventario: consultar otra fecha
    document.querySelector(CONFIG.SELECTORS.btnInventarioFiltrar)?.addEventListener('click', () => {
      const valor = document.querySelector(CONFIG.SELECTORS.inventarioFiltroFecha)?.value;
      this.verFechaInventario(valor);
    });

    document
      .querySelector(CONFIG.SELECTORS.btnInventarioHoy)
      ?.addEventListener('click', () => this.volverAHoyInventario());

    // Formulario de recetas: alta y edición
    document.querySelector(CONFIG.SELECTORS.recetaForm)?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleRecetaSubmit();
    });
    document
      .querySelector(CONFIG.SELECTORS.recetaCancelEditBtn)
      ?.addEventListener('click', () => this.cancelEditReceta());
    document
      .querySelector(CONFIG.SELECTORS.btnRecetaAgregarIngrediente)
      ?.addEventListener('click', () => this.agregarFilaIngredienteReceta());

    // Formulario de producción: alta + prellenado de ingredientes por receta
    document.querySelector(CONFIG.SELECTORS.produccionForm)?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleProduccionSubmit();
    });
    document
      .querySelector(CONFIG.SELECTORS.produccionProducto)
      ?.addEventListener('change', () => this._onProduccionProductoChange());

    document.querySelector(CONFIG.SELECTORS.btnProduccionFiltrar)?.addEventListener('click', () => {
      const valor = document.querySelector(CONFIG.SELECTORS.produccionFiltroFecha)?.value;
      this.verFechaProduccion(valor);
    });
    document
      .querySelector(CONFIG.SELECTORS.btnProduccionHoy)
      ?.addEventListener('click', () => this.volverAHoyProduccion());

    // Horneadas: al cambiar de producto (o de fecha), refresca qué
    // producciones puede elegir como origen.
    document
      .querySelector(CONFIG.SELECTORS.horneadaProducto)
      ?.addEventListener('change', () => this._actualizarSelectProduccionParaHorneada());
    document
      .querySelector(CONFIG.SELECTORS.horneadaFecha)
      ?.addEventListener('change', () => this._actualizarSelectProduccionParaHorneada());

    // Recalcular % merma real cada vez que cambia el peso del pan cocido o
    // la producción de origen elegida (ver _recalcularMermaReal).
    document
      .querySelector(CONFIG.SELECTORS.horneadaProduccion)
      ?.addEventListener('change', () => this._recalcularMermaReal());
    document
      .querySelector(CONFIG.SELECTORS.horneadaPesoPanCocido)
      ?.addEventListener('input', () => this._recalcularMermaReal());
  },

  async _handleInsumoSubmit() {
    const errorEl = document.querySelector(CONFIG.SELECTORS.insumoError);
    const errorMsgEl = document.querySelector(CONFIG.SELECTORS.insumoErrorMsg);

    const nombre = document.querySelector(CONFIG.SELECTORS.insumoNombre).value.trim();
    const cantidadRaw = document.querySelector(CONFIG.SELECTORS.insumoCantidad).value;
    const unidad = document.querySelector(CONFIG.SELECTORS.insumoUnidad).value;

    if (!nombre || cantidadRaw === '' || Number(cantidadRaw) < 0) {
      errorMsgEl.textContent =
        'Completa nombre, cantidad y unidad (la cantidad no puede ser negativa).';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const costoRaw = document.querySelector(CONFIG.SELECTORS.insumoCosto).value;
    const stockMinRaw = document.querySelector(CONFIG.SELECTORS.insumoStockMinimo).value;
    const stockMaxRaw = document.querySelector(CONFIG.SELECTORS.insumoStockMaximo).value;
    const equivalenciaRaw = document.querySelector(CONFIG.SELECTORS.insumoEquivalenciaGramos).value;
    const impuestoRaw = document.querySelector(CONFIG.SELECTORS.insumoImpuesto).value;
    const leadTimeRaw = document.querySelector(CONFIG.SELECTORS.insumoLeadTime).value;
    const vidaUtilRaw = document.querySelector(CONFIG.SELECTORS.insumoVidaUtilAbierto).value;
    const alergenos = [
      ...document.querySelectorAll(
        `${CONFIG.SELECTORS.insumoAlergenos} input[type="checkbox"]:checked`,
      ),
    ].map((cb) => cb.value);
    const idExistente = document.querySelector(CONFIG.SELECTORS.insumoId).value || null;

    const datos = {
      nombre,
      categoria: document.querySelector(CONFIG.SELECTORS.insumoCategoria).value,
      cantidad: Number(cantidadRaw),
      unidad,
      costoUnitario: costoRaw === '' ? null : Number(costoRaw),
      stockMinimo: stockMinRaw === '' ? null : Number(stockMinRaw),
      stockMaximo: stockMaxRaw === '' ? null : Number(stockMaxRaw),
      proveedor: document.querySelector(CONFIG.SELECTORS.insumoProveedor).value.trim(),
      proveedorSecundario: document
        .querySelector(CONFIG.SELECTORS.insumoProveedorSecundario)
        .value.trim(),
      marca: document.querySelector(CONFIG.SELECTORS.insumoMarca).value.trim(),
      sku: document.querySelector(CONFIG.SELECTORS.insumoSku).value.trim(),
      equivalenciaGramos: equivalenciaRaw === '' ? null : Number(equivalenciaRaw),
      presentacionCompra: document
        .querySelector(CONFIG.SELECTORS.insumoPresentacionCompra)
        .value.trim(),
      impuestoPorcentaje: impuestoRaw === '' ? null : Number(impuestoRaw),
      leadTimeDias: leadTimeRaw === '' ? null : Number(leadTimeRaw),
      condicionesAlmacenamiento: document
        .querySelector(CONFIG.SELECTORS.insumoCondicionesAlmacenamiento)
        .value.trim(),
      loteProveedor: document.querySelector(CONFIG.SELECTORS.insumoLoteProveedor).value.trim(),
      vidaUtilAbiertoDias: vidaUtilRaw === '' ? null : Number(vidaUtilRaw),
      alergenos,
      fechaVencimiento:
        document.querySelector(CONFIG.SELECTORS.insumoFechaVencimiento).value || null,
      ubicacion: document.querySelector(CONFIG.SELECTORS.insumoUbicacion).value.trim(),
      notas: document.querySelector(CONFIG.SELECTORS.insumoNotas).value.trim(),
    };

    const submitBtn = document.querySelector(CONFIG.SELECTORS.insumoSubmitBtn);
    const textoOriginal = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Guardando…';

    const resultado = idExistente
      ? await Insumos.actualizar(idExistente, datos)
      : await Insumos.crear(datos);

    submitBtn.disabled = false;
    submitBtn.innerHTML = textoOriginal;

    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      errorMsgEl.textContent =
        resultado.message || 'No se pudo guardar el insumo. Intenta de nuevo.';
      errorEl.hidden = false;
      return;
    }

    this._resetInsumoForm();
    this.refreshInsumos();
  },

  _switchView(targetId) {
    const views = [
      CONFIG.SELECTORS.dashboardView,
      CONFIG.SELECTORS.insumosView,
      CONFIG.SELECTORS.productosView,
      CONFIG.SELECTORS.proveedoresView,
      CONFIG.SELECTORS.ordenesCompraView,
      CONFIG.SELECTORS.horneadasView,
      CONFIG.SELECTORS.inventarioView,
      CONFIG.SELECTORS.recetasView,
      CONFIG.SELECTORS.produccionView,
      CONFIG.SELECTORS.lotesView,
      CONFIG.SELECTORS.pedidosView,
      CONFIG.SELECTORS.auditoriaView,
      CONFIG.SELECTORS.mermasView,
    ];
    views.forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) el.hidden = el.id !== targetId;
    });

    document.querySelectorAll(CONFIG.SELECTORS.navBtns).forEach((btn) => {
      const active = btn.dataset.viewTarget === targetId;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    if (targetId === CONFIG.SELECTORS.insumosView.slice(1)) {
      this.refreshInsumos();
    }
    if (targetId === CONFIG.SELECTORS.productosView.slice(1)) {
      this.refreshProductos();
      this.refreshProductosAutoML();
    }
    if (targetId === CONFIG.SELECTORS.proveedoresView.slice(1)) {
      this.refreshProveedores();
    }
    if (targetId === CONFIG.SELECTORS.auditoriaView.slice(1)) {
      this.refreshAuditoria();
    }
    if (targetId === CONFIG.SELECTORS.ordenesCompraView.slice(1)) {
      const emisionEl = document.querySelector(CONFIG.SELECTORS.ocFechaEmision);
      if (emisionEl && !emisionEl.value) emisionEl.value = hoyHouston();
      this.refreshOrdenesCompra();
    }
    // Vistas que trabajan sobre un producto del catálogo: sus selects se
    // llenan desde la tabla productos, así que hay que tener el catálogo
    // cargado antes de renderizarlas.
    if (
      [
        CONFIG.SELECTORS.horneadasView,
        CONFIG.SELECTORS.inventarioView,
        CONFIG.SELECTORS.recetasView,
        CONFIG.SELECTORS.produccionView,
        CONFIG.SELECTORS.lotesView,
        CONFIG.SELECTORS.mermasView,
      ].some((sel) => targetId === sel.slice(1))
    ) {
      this.cargarProductosParaSelects();
    }

    if (targetId === CONFIG.SELECTORS.horneadasView.slice(1)) {
      this._prefillHorneadaFechaHora();
      const filtroEl = document.querySelector(CONFIG.SELECTORS.horneadaFiltroFecha);
      if (filtroEl && !filtroEl.value) filtroEl.value = this._horneadaFechaConsulta;
      this.refreshHorneadas();
      this.refreshSugerenciasHorneado();
    }
    if (targetId === CONFIG.SELECTORS.inventarioView.slice(1)) {
      this._prefillAjusteFechaHora();
      const filtroEl = document.querySelector(CONFIG.SELECTORS.inventarioFiltroFecha);
      if (filtroEl && !filtroEl.value) filtroEl.value = this._inventarioFechaConsulta;
      this.refreshInventario();
    }
    if (targetId === CONFIG.SELECTORS.recetasView.slice(1)) {
      this.refreshRecetas();
    }
    if (targetId === CONFIG.SELECTORS.produccionView.slice(1)) {
      const filtroEl = document.querySelector(CONFIG.SELECTORS.produccionFiltroFecha);
      if (filtroEl && !filtroEl.value) filtroEl.value = this._produccionFechaConsulta;
      const fechaEl = document.querySelector(CONFIG.SELECTORS.produccionFecha);
      if (fechaEl && !fechaEl.value) fechaEl.value = hoyHouston();
      this.refreshProducciones();
    }
    if (targetId === CONFIG.SELECTORS.lotesView.slice(1)) {
      this.refreshLotes();
    }
    if (targetId === CONFIG.SELECTORS.mermasView.slice(1)) {
      this.refreshMermas();
    }
    if (targetId === CONFIG.SELECTORS.pedidosView.slice(1)) {
      this.refreshPedidos();
    }
  },

  _showLoginError(mensaje) {
    const errorEl = document.querySelector(CONFIG.SELECTORS.loginError);
    const msgEl = document.querySelector(CONFIG.SELECTORS.loginErrorMsg);
    if (msgEl) msgEl.textContent = mensaje;
    if (errorEl) errorEl.hidden = false;
    document.querySelector(CONFIG.SELECTORS.password)?.focus();
  },

  _showCorrectView() {
    const loginView = document.querySelector(CONFIG.SELECTORS.loginView);
    const dashView = document.querySelector(CONFIG.SELECTORS.dashboardView);
    const insumosView = document.querySelector(CONFIG.SELECTORS.insumosView);
    const productosView = document.querySelector(CONFIG.SELECTORS.productosView);
    const proveedoresView = document.querySelector(CONFIG.SELECTORS.proveedoresView);
    const ordenesCompraView = document.querySelector(CONFIG.SELECTORS.ordenesCompraView);
    const horneadasView = document.querySelector(CONFIG.SELECTORS.horneadasView);
    const inventarioView = document.querySelector(CONFIG.SELECTORS.inventarioView);
    const recetasView = document.querySelector(CONFIG.SELECTORS.recetasView);
    const produccionView = document.querySelector(CONFIG.SELECTORS.produccionView);
    const lotesView = document.querySelector(CONFIG.SELECTORS.lotesView);
    const mermasView = document.querySelector(CONFIG.SELECTORS.mermasView);
    const pedidosView = document.querySelector(CONFIG.SELECTORS.pedidosView);
    const navEl = document.querySelector(CONFIG.SELECTORS.adminNav);

    if (Auth.isAuthenticated()) {
      if (loginView) loginView.hidden = true;
      if (navEl) navEl.hidden = false;
      if (dashView) dashView.hidden = false;
      if (insumosView) insumosView.hidden = true;
      if (productosView) productosView.hidden = true;
      if (proveedoresView) proveedoresView.hidden = true;
      if (ordenesCompraView) ordenesCompraView.hidden = true;
      if (horneadasView) horneadasView.hidden = true;
      if (inventarioView) inventarioView.hidden = true;
      if (recetasView) recetasView.hidden = true;
      if (produccionView) produccionView.hidden = true;
      if (lotesView) lotesView.hidden = true;
      if (mermasView) mermasView.hidden = true;
      if (pedidosView) pedidosView.hidden = true;

      // Actualizar fecha
      const dateEl = document.querySelector(CONFIG.SELECTORS.date);
      if (dateEl) {
        dateEl.textContent = Format.todayDate();
        dateEl.dateTime = hoyHouston();
      }

      this.refresh();
    } else {
      if (loginView) loginView.hidden = false;
      if (navEl) navEl.hidden = true;
      if (dashView) dashView.hidden = true;
      if (insumosView) insumosView.hidden = true;
      if (productosView) productosView.hidden = true;
      if (proveedoresView) proveedoresView.hidden = true;
      if (ordenesCompraView) ordenesCompraView.hidden = true;
      if (horneadasView) horneadasView.hidden = true;
      if (inventarioView) inventarioView.hidden = true;
      if (recetasView) recetasView.hidden = true;
      if (produccionView) produccionView.hidden = true;
      if (lotesView) lotesView.hidden = true;
      if (mermasView) mermasView.hidden = true;
      if (pedidosView) pedidosView.hidden = true;
      const pwd = document.querySelector(CONFIG.SELECTORS.password);
      if (pwd) pwd.value = '';
    }
  },
};

/* ═══════════════════════════════════════════
   9. SIDEBAR MÓVIL (drawer)
   ═══════════════════════════════════════════
   No toca _switchView: sigue usando .admin-nav__btn + data-view-target.
   Los botones deshabilitados (.admin-nav__btn--soon) no tienen
   data-view-target, así que nunca disparan un cambio de vista. */
// `overflow: hidden` en body NO alcanza para bloquear el scroll en Safari
// iOS: la página igual puede "saltar" o hacer zoom al abrir/cerrar el
// drawer porque el viewport visual sigue moviéndose por debajo. La técnica
// robusta es fijar el body en su posición actual (position: fixed + top
// negativo con el scrollY guardado) y restaurar el scroll exacto al cerrar.
// Además se compensa el ancho de la scrollbar (relevante en tablets/
// desktop angosto) para que el contenido no "salte" horizontalmente al
// desaparecer la barra.
let lockedScrollY = 0;

function lockBodyScroll() {
  lockedScrollY = window.scrollY || window.pageYOffset || 0;
  const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${lockedScrollY}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  document.body.style.width = '100%';
  if (scrollbarWidth > 0) {
    document.body.style.paddingRight = `${scrollbarWidth}px`;
  }
}

function unlockBodyScroll() {
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  document.body.style.width = '';
  document.body.style.paddingRight = '';
  window.scrollTo(0, lockedScrollY);
}

function initAdminSidebarDrawer() {
  const nav = document.getElementById('admin-nav');
  const toggle = document.getElementById('admin-menu-toggle');
  const overlay = document.getElementById('admin-nav-overlay');
  const topbar = document.getElementById('admin-topbar');
  const logoutMobile = document.getElementById('btn-logout-mobile');
  const logoutDesktop = document.getElementById('btn-logout');

  if (!nav || !toggle) return;

  const open = () => {
    nav.classList.add('is-open');
    if (overlay) {
      overlay.hidden = false;
      requestAnimationFrame(() => overlay.classList.add('is-visible'));
    }
    toggle.setAttribute('aria-expanded', 'true');
    lockBodyScroll();
  };

  const close = () => {
    nav.classList.remove('is-open');
    if (overlay) {
      overlay.classList.remove('is-visible');
      window.setTimeout(() => {
        if (!overlay.classList.contains('is-visible')) overlay.hidden = true;
      }, 200);
    }
    toggle.setAttribute('aria-expanded', 'false');
    unlockBodyScroll();
  };

  const isMobile = () => window.matchMedia('(max-width: 899px)').matches;

  toggle.addEventListener('click', () => {
    if (nav.classList.contains('is-open')) close();
    else open();
  });

  overlay?.addEventListener('click', close);

  // Cerrar drawer al elegir una sección (solo móvil)
  nav.querySelectorAll('.admin-nav__btn[data-view-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (isMobile()) close();
    });
  });

  // Logout móvil → mismo comportamiento que desktop
  logoutMobile?.addEventListener('click', () => {
    logoutDesktop?.click();
  });

  // Mostrar topbar cuando la nav deja de estar hidden (post-login)
  const syncTopbar = () => {
    if (!topbar) return;
    const navVisible = !nav.hasAttribute('hidden');
    if (navVisible) topbar.removeAttribute('hidden');
    else topbar.setAttribute('hidden', '');
  };

  // Observar atributo hidden de #admin-nav (Auth lo quita al entrar)
  const observer = new MutationObserver(syncTopbar);
  observer.observe(nav, { attributes: true, attributeFilter: ['hidden'] });
  syncTopbar();

  // Escape cierra el drawer
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) close();
  });
}

/* ═══════════════════════════════════════════
   9b. BUSCADOR DE SECCIONES (nav)
   ═══════════════════════════════════════════
   El HTML y el CSS ya traían todo listo (.admin-nav__btn[hidden],
   .admin-nav__group[hidden], #admin-nav-empty) pero no había JS que
   conectara el input con el filtrado — por eso no hacía nada. */
function normalizeSearchText(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function initAdminNavSearch() {
  const input = document.getElementById('admin-nav-search');
  const groups = document.querySelectorAll('.admin-nav__group');
  const emptyState = document.getElementById('admin-nav-empty');

  if (!input || !groups.length) return;

  const filter = () => {
    const query = normalizeSearchText(input.value);
    let visibleCount = 0;

    groups.forEach((group) => {
      const buttons = group.querySelectorAll('.admin-nav__btn');
      let groupHasMatch = false;

      buttons.forEach((btn) => {
        const label = btn.querySelector('.admin-nav__btn-label')?.textContent ?? '';
        const matches = !query || normalizeSearchText(label).includes(query);
        btn.hidden = !matches;
        if (matches) {
          groupHasMatch = true;
          visibleCount += 1;
        }
      });

      group.hidden = !groupHasMatch;
    });

    if (emptyState) emptyState.hidden = visibleCount > 0;
  };

  input.addEventListener('input', filter);

  // Limpiar la búsqueda con Escape (sin cerrar el drawer si hay texto)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && input.value) {
      e.stopPropagation();
      input.value = '';
      filter();
    }
  });
}

/* ═══════════════════════════════════════════
   9c. COLAPSAR SIDEBAR A RAIL (solo desktop)
   ═══════════════════════════════════════════
   El CSS del modo rail (.is-collapsed) ya estaba completo, pero nada
   togglaba la clase — por eso el botón no hacía nada. */
function initAdminNavCollapse() {
  const nav = document.getElementById('admin-nav');
  const toggle = document.getElementById('admin-nav-collapse');
  if (!nav || !toggle) return;

  const STORAGE_KEY = 'admin-nav-collapsed';

  const setCollapsed = (collapsed) => {
    nav.classList.toggle('is-collapsed', collapsed);
    toggle.setAttribute('aria-pressed', String(collapsed));
    const label = collapsed ? 'Expandir menú lateral' : 'Colapsar menú lateral';
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    try {
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      /* localStorage no disponible (modo privado, etc.) — no es crítico */
    }
  };

  // Restaurar preferencia guardada. En móvil no afecta nada: la media
  // query del drawer ignora .is-collapsed por fuera de escritorio.
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* ignorar */
  }
  if (stored === '1') setCollapsed(true);

  toggle.addEventListener('click', () => {
    setCollapsed(!nav.classList.contains('is-collapsed'));
  });

  // El tooltip del modo rail usa var(--nav-tooltip-y, 50%) — sin esto
  // siempre aparecía al centro de la pantalla en vez de junto al botón.
  const placeTooltip = (btn) => {
    const rect = btn.getBoundingClientRect();
    nav.style.setProperty('--nav-tooltip-y', `${rect.top + rect.height / 2}px`);
  };

  nav.querySelectorAll('.admin-nav__btn').forEach((btn) => {
    btn.addEventListener('mouseenter', () => placeTooltip(btn));
    btn.addEventListener('focus', () => placeTooltip(btn));
  });
}

/* ═══════════════════════════════════════════
   9c. SOMBRA DEL TOPBAR AL HACER SCROLL
   ═══════════════════════════════════════════
   El CSS ya trae la regla .admin-topbar.is-scrolled (sombra + borde
   transparente) — sin este listener, esa clase nunca se agrega y el
   topbar se queda siempre con el borde sutil de reposo. */
function initAdminTopbarScroll() {
  const topbar = document.getElementById('admin-topbar');
  if (!topbar) return;

  const sync = () => {
    topbar.classList.toggle('is-scrolled', window.scrollY > 0);
  };

  window.addEventListener('scroll', sync, { passive: true });
  sync(); // estado inicial (por si la página carga ya con scroll restaurado)
}

/* ═══════════════════════════════════════════
   10. ARRANQUE
   ═══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  App.init();
  initTheme();
  initAdminSidebarDrawer();
  initAdminNavSearch();
  initAdminNavCollapse();
  initAdminTopbarScroll();
});

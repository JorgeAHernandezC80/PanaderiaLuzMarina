/**
 * Panel Admin · Panadería Luz Marina
 * Organización: Configuración → Auth → API → Render → App
 */

import { escapeHTML } from '../core/cart.js';
import { formatPrice, pluralizeEs } from '../core/format.js';
import { API_BASE, apiFetch } from '../core/api.js';

/* Zona horaria de referencia del negocio (Houston). Todo lo que necesite
   "la fecha de hoy" debe pasar por hoyHouston(), nunca por
   new Date().toISOString().slice(0, 10) — ese método da la fecha en UTC,
   que se adelanta un día por las noches (Houston va 5-6h detrás de UTC). */
const HOUSTON_TZ = 'America/Chicago';

function hoyHouston() {
  return new Date().toLocaleDateString('en-CA', { timeZone: HOUSTON_TZ });
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
const ETAPAS_PRODUCCION_LABELS = {
  pesado_dosificacion: 'Pesado y Dosificación',
  amasado: 'Amasado',
  primera_fermentacion: 'Primera Fermentación',
  division_pesado: 'División y Pesado',
  preformado: 'Preformado',
  reposo_mesa: 'Reposo en Mesa',
  formado_definitivo: 'Formado Definitivo',
  segunda_fermentacion: 'Segunda Fermentación',
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

    // Horneadas
    horneadasView: '#horneadas-view',
    horneadasCount: '#horneadas-count',
    horneadasContainer: '#horneadas-container',
    horneadasResumen: '#horneadas-resumen',
    tplHorneadaRow: '#tpl-horneada-row',
    horneadaForm: '#horneada-form',
    horneadaId: '#horneada-id',
    horneadaProducto: '#horneada-producto',
    horneadaCantidad: '#horneada-cantidad',
    horneadaFecha: '#horneada-fecha',
    horneadaHora: '#horneada-hora',
    horneadaRegistradoPor: '#horneada-registrado-por',
    horneadaNotas: '#horneada-notas',
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
    recetaIngredientesLista: '#receta-ingredientes-lista',
    btnRecetaAgregarIngrediente: '#btn-receta-agregar-ingrediente',
    recetaNotas: '#receta-notas',
    recetaError: '#receta-error',
    recetaErrorMsg: '#receta-error [data-receta-error-msg]',
    recetaSubmitBtn: '#btn-receta-submit',
    recetaCancelEditBtn: '#btn-receta-cancel-edit',

    // Producción
    produccionView: '#produccion-view',
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
    produccionIngredientesLista: '#produccion-ingredientes-lista',
    produccionNotas: '#produccion-notas',
    produccionError: '#produccion-error',
    produccionErrorMsg: '#produccion-error [data-produccion-error-msg]',
    produccionSubmitBtn: '#btn-produccion-submit',
    produccionFiltroFecha: '#produccion-filtro-fecha',
    btnProduccionFiltrar: '#btn-produccion-filtrar',
    btnProduccionHoy: '#btn-produccion-hoy',
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
        body: JSON.stringify({ estado }),
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
    const wsUrl = API_BASE.replace(/^http/, 'ws');
    let intento = 0;

    const connect = () => {
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
        return { ok: false, reason: 'error' };
      }
      return { ok: true };
    } catch (err) {
      console.error('[Insumos] Error eliminando insumo:', err.message);
      return { ok: false, reason: 'network' };
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
        return { ok: false, reason: 'error' };
      }
      return { ok: true };
    } catch (err) {
      console.error('[Recetas] Error eliminando receta:', err.message);
      return { ok: false, reason: 'network' };
    }
  },
};

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
    Render.renderOrders(orders);

    if (orders !== null && !this._liveConnected) {
      this._liveConnected = true;
      Api.connectLive(() => this.refresh());
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
      `¿Eliminar la receta de "${productoNombre}"? Esto no afecta las producciones ya registradas.`,
    );
    if (!confirmado) return;

    const resultado = await Recetas.eliminar(id);
    if (resultado.reason === 'unauthorized') {
      this._showCorrectView();
      this._showLoginError('Tu sesión expiró. Inicia sesión de nuevo.');
      return;
    }
    if (!resultado.ok) {
      window.alert('No se pudo eliminar la receta. Intenta de nuevo en unos segundos.');
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
        'Este producto todavía no tiene receta — créala primero en la pestaña Recetas.';
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

    const producciones = await Producciones.listar(fecha);
    if (!Array.isArray(producciones)) return;

    producciones
      .filter((p) => p.productoId === productoId)
      .forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.horaInicio} — ${p.pesoTotalMasaG}g (${p.unidadesEstimadas} u. est.)`;
        selectProduccion.appendChild(opt);
      });
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

    this._actualizarSelectProduccionParaHorneada().then(() => {
      const selectProduccion = document.querySelector(CONFIG.SELECTORS.horneadaProduccion);
      if (selectProduccion && horneada.produccionId) {
        selectProduccion.value = horneada.produccionId;
      }
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
      window.alert('No se pudo eliminar el insumo. Intenta de nuevo en unos segundos.');
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

    // Formulario de proveedores: alta y edición
    document.querySelector(CONFIG.SELECTORS.proveedorForm)?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleProveedorSubmit();
    });

    document
      .querySelector(CONFIG.SELECTORS.proveedorCancelEditBtn)
      ?.addEventListener('click', () => this.cancelEditProveedor());

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
      CONFIG.SELECTORS.proveedoresView,
      CONFIG.SELECTORS.horneadasView,
      CONFIG.SELECTORS.inventarioView,
      CONFIG.SELECTORS.recetasView,
      CONFIG.SELECTORS.produccionView,
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
    if (targetId === CONFIG.SELECTORS.proveedoresView.slice(1)) {
      this.refreshProveedores();
    }
    if (targetId === CONFIG.SELECTORS.horneadasView.slice(1)) {
      this._prefillHorneadaFechaHora();
      const filtroEl = document.querySelector(CONFIG.SELECTORS.horneadaFiltroFecha);
      if (filtroEl && !filtroEl.value) filtroEl.value = this._horneadaFechaConsulta;
      this.refreshHorneadas();
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
    const proveedoresView = document.querySelector(CONFIG.SELECTORS.proveedoresView);
    const horneadasView = document.querySelector(CONFIG.SELECTORS.horneadasView);
    const inventarioView = document.querySelector(CONFIG.SELECTORS.inventarioView);
    const recetasView = document.querySelector(CONFIG.SELECTORS.recetasView);
    const produccionView = document.querySelector(CONFIG.SELECTORS.produccionView);
    const navEl = document.querySelector(CONFIG.SELECTORS.adminNav);

    if (Auth.isAuthenticated()) {
      if (loginView) loginView.hidden = true;
      if (navEl) navEl.hidden = false;
      if (dashView) dashView.hidden = false;
      if (insumosView) insumosView.hidden = true;
      if (proveedoresView) proveedoresView.hidden = true;
      if (horneadasView) horneadasView.hidden = true;
      if (inventarioView) inventarioView.hidden = true;
      if (recetasView) recetasView.hidden = true;
      if (produccionView) produccionView.hidden = true;

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
      if (proveedoresView) proveedoresView.hidden = true;
      if (horneadasView) horneadasView.hidden = true;
      if (inventarioView) inventarioView.hidden = true;
      if (recetasView) recetasView.hidden = true;
      if (produccionView) produccionView.hidden = true;
      const pwd = document.querySelector(CONFIG.SELECTORS.password);
      if (pwd) pwd.value = '';
    }
  },
};

/* ═══════════════════════════════════════════
   9. SIDEBAR (drawer móvil + rail colapsable en desktop)
   ═══════════════════════════════════════════
   No toca _switchView: sigue usando .admin-nav__btn + data-view-target.
   Los botones deshabilitados (.admin-nav__btn--soon) no tienen
   data-view-target, así que nunca disparan un cambio de vista. */
const NAV_COLLAPSED_KEY = 'plm_admin_nav_collapsed';

function initAdminSidebarDrawer() {
  const nav = document.getElementById('admin-nav');
  const toggle = document.getElementById('admin-menu-toggle');
  const overlay = document.getElementById('admin-nav-overlay');
  const topbar = document.getElementById('admin-topbar');
  const logoutMobile = document.getElementById('btn-logout-mobile');
  const logoutDesktop = document.getElementById('btn-logout');
  const collapseBtn = document.getElementById('admin-nav-collapse');
  const search = document.getElementById('admin-nav-search');
  const emptyMsg = document.getElementById('admin-nav-empty');

  if (!nav || !toggle) return;

  let lastFocused = null;

  const isMobile = () => window.matchMedia('(max-width: 899px)').matches;

  const focusables = () =>
    Array.from(nav.querySelectorAll('button:not([disabled]), input, a[href]')).filter(
      (el) => el.offsetParent !== null,
    );

  const open = () => {
    lastFocused = document.activeElement;
    nav.classList.add('is-open');
    if (overlay) {
      overlay.hidden = false;
      requestAnimationFrame(() => overlay.classList.add('is-visible'));
    }
    toggle.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    focusables()[0]?.focus();
  };

  const close = ({ restoreFocus = false } = {}) => {
    nav.classList.remove('is-open');
    if (overlay) {
      overlay.classList.remove('is-visible');
      window.setTimeout(() => {
        if (!overlay.classList.contains('is-visible')) overlay.hidden = true;
      }, 200);
    }
    toggle.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    if (restoreFocus) (lastFocused instanceof HTMLElement ? lastFocused : toggle).focus();
  };

  toggle.addEventListener('click', () => {
    if (nav.classList.contains('is-open')) close({ restoreFocus: true });
    else open();
  });

  overlay?.addEventListener('click', () => close());

  // Cerrar drawer al elegir una sección (solo móvil)
  nav.querySelectorAll('.admin-nav__btn[data-view-target]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (isMobile()) close();
    });
  });

  /* ── Rail colapsable (desktop): se recuerda entre sesiones ── */
  const applyCollapsed = (collapsed) => {
    nav.classList.toggle('is-collapsed', collapsed);
    if (!collapseBtn) return;
    const label = collapsed ? 'Expandir menú lateral' : 'Colapsar menú lateral';
    collapseBtn.setAttribute('aria-pressed', String(collapsed));
    collapseBtn.setAttribute('aria-label', label);
    collapseBtn.title = label;
    if (collapsed && search) {
      search.value = '';
      search.dispatchEvent(new Event('input'));
    }
  };

  let storedCollapsed = false;
  try {
    storedCollapsed = localStorage.getItem(NAV_COLLAPSED_KEY) === '1';
  } catch {
    storedCollapsed = false;
  }
  applyCollapsed(storedCollapsed);

  collapseBtn?.addEventListener('click', () => {
    const collapsed = !nav.classList.contains('is-collapsed');
    applyCollapsed(collapsed);
    try {
      localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      /* modo privado: el estado solo dura esta sesión */
    }
  });

  /* ── Buscador de secciones ── */
  const normalize = (str) =>
    str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

  search?.addEventListener('input', () => {
    const query = normalize(search.value.trim());
    let visibles = 0;

    nav.querySelectorAll('.admin-nav__group').forEach((group) => {
      let groupVisibles = 0;
      group.querySelectorAll('.admin-nav__btn').forEach((btn) => {
        const label = normalize(btn.querySelector('.admin-nav__btn-label')?.textContent ?? '');
        const match = !query || label.includes(query);
        btn.hidden = !match;
        if (match) groupVisibles += 1;
      });
      group.hidden = groupVisibles === 0;
      visibles += groupVisibles;
    });

    if (emptyMsg) emptyMsg.hidden = visibles > 0;
  });

  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      search.value = '';
      search.dispatchEvent(new Event('input'));
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      nav.querySelector('.admin-nav__btn[data-view-target]:not([hidden])')?.click();
    }
  });

  /* ── Tooltips del rail ──
     El tooltip se dibuja con position: fixed para que no lo recorte el
     scroll de .admin-nav__groups, así que necesita su coordenada vertical. */
  const placeTooltips = () => {
    if (!nav.classList.contains('is-collapsed')) return;
    nav.querySelectorAll('.admin-nav__btn').forEach((btn) => {
      const rect = btn.getBoundingClientRect();
      btn.style.setProperty('--nav-tooltip-y', `${rect.top + rect.height / 2}px`);
    });
  };

  // Los ítems deshabilitados no reciben eventos de puntero, así que se
  // recalculan todos a la vez en lugar de solo el que tiene el cursor.
  nav.addEventListener('pointerover', placeTooltips);
  nav.addEventListener('focusin', placeTooltips);
  nav.querySelector('.admin-nav__groups')?.addEventListener('scroll', placeTooltips);
  window.addEventListener('resize', placeTooltips);
  collapseBtn?.addEventListener('click', () => requestAnimationFrame(placeTooltips));
  placeTooltips();

  /* ── Navegación con flechas entre secciones ── */
  nav.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const btn = e.target.closest?.('.admin-nav__btn');
    if (!btn) return;
    const items = Array.from(nav.querySelectorAll('.admin-nav__btn:not([disabled]):not([hidden])'));
    if (items.length === 0) return;
    e.preventDefault();
    const i = items.indexOf(btn);
    const next =
      e.key === 'Home'
        ? items[0]
        : e.key === 'End'
          ? items[items.length - 1]
          : items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    next.focus();
  });

  /* ── Focus trap mientras el drawer está abierto ── */
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !nav.classList.contains('is-open')) return;
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
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
    if (e.key === 'Escape' && nav.classList.contains('is-open')) close({ restoreFocus: true });
  });
}

/* ═══════════════════════════════════════════
   10. ARRANQUE
   ═══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  App.init();
  initAdminSidebarDrawer();
});

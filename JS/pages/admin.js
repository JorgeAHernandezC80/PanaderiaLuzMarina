/**
 * Panel Admin · Panadería Luz Marina
 * Organización: Configuración → Auth → API → Render → App
 */

import { escapeHTML } from '../core/cart.js';
import { formatPrice, pluralizeEs } from '../core/format.js';
import { API_BASE, apiFetch } from '../core/api.js';

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
    proveedorNombreLegal: '#proveedor-nombre-legal',
    proveedorNombreComercial: '#proveedor-nombre-comercial',
    proveedorIdFiscal: '#proveedor-id-fiscal',
    proveedorGiro: '#proveedor-giro',
    proveedorDireccion: '#proveedor-direccion',
    proveedorContactoNombre: '#proveedor-contacto-nombre',
    proveedorContactoCargo: '#proveedor-contacto-cargo',
    proveedorEmailGeneral: '#proveedor-email-general',
    proveedorEmailContacto: '#proveedor-email-contacto',
    proveedorTelEmpresa: '#proveedor-tel-empresa',
    proveedorTelCelular: '#proveedor-tel-celular',
    proveedorBanco: '#proveedor-banco',
    proveedorNumeroCuenta: '#proveedor-numero-cuenta',
    proveedorClabeIban: '#proveedor-clabe-iban',
    proveedorCondicionesPago: '#proveedor-condiciones-pago',
    proveedorMoneda: '#proveedor-moneda',
    proveedorMetodoFacturacion: '#proveedor-metodo-facturacion',
    proveedorLeadTime: '#proveedor-lead-time',
    proveedorPedidoMinimo: '#proveedor-pedido-minimo',
    proveedorPoliticasDevolucion: '#proveedor-politicas-devolucion',
    proveedorCertificaciones: '#proveedor-certificaciones',
    proveedorNotas: '#proveedor-notas',
    proveedorError: '#proveedor-error',
    proveedorErrorMsg: '#proveedor-error [data-proveedor-error-msg]',
    proveedorSubmitBtn: '#btn-proveedor-submit',
    proveedorCancelEditBtn: '#btn-proveedor-cancel-edit',
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
    const fecha = new Date().toISOString().slice(0, 10);

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

  async markAsPrepared(numero) {
    try {
      const res = await apiFetch(`/ordenes/${encodeURIComponent(numero)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${Auth.getToken()}`,
        },
        body: JSON.stringify({ estado: 'preparada' }),
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
   5b. MÓDULO: PROVEEDORES (backend real)
   ═══════════════════════════════════════════
   CRUD contra /proveedores, mismo patrón que Insumos: apiFetch con
   timeout, 401 => sesión expirada, errores de red devuelven null/ok:false
   en lugar de lanzar, para que la UI decida qué mostrar. */
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
        console.error(
          '[Proveedores] Timeout obteniendo proveedores (el servidor puede estar iniciando).',
        );
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
   6. MÓDULO: RENDERIZADO
   ═══════════════════════════════════════════ */
const Render = {
  updateStats(orders) {
    const lista = orders || [];
    const total = lista.length;
    const ingresos = lista.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const preparadas = lista.filter((o) => o.estado === 'preparada').length;
    const pendientes = total - preparadas;

    this._setStat(CONFIG.SELECTORS.statOrdenes, total);
    this._setStat(CONFIG.SELECTORS.statIngresos, Format.currency(ingresos), ingresos);
    this._setStat(CONFIG.SELECTORS.statPrep, preparadas);
    this._setStat(CONFIG.SELECTORS.statPend, pendientes);
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

    const estaPreparada = order.estado === 'preparada';
    if (estaPreparada) tr.classList.add('order-row--done');

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
    if (estaPreparada) {
      estadoCell.innerHTML = `
        <span class="order-status order-status--done">✓ Lista</span>
      `;
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--action';
      btn.textContent = 'Marcar lista';
      btn.disabled = false;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Guardando…';
        const ok = await Api.markAsPrepared(order.numero);
        if (ok) {
          App.refresh();
        } else {
          btn.disabled = false;
          btn.textContent = '✗ Reintentar';
          btn.classList.add('btn--error');
          btn.title = 'No se pudo actualizar. Haz clic para intentar de nuevo.';
          setTimeout(() => {
            btn.textContent = 'Marcar lista';
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
        <span class="empty-state__icon" aria-hidden="true">🚚</span>
        <h2 class="empty-state__title">Sin proveedores registrados</h2>
        <p class="empty-state__text">Usa el formulario de arriba para agregar el primer proveedor.</p>
      `;
      container.appendChild(div);
      return;
    }

    const table = document.createElement('table');
    table.className = 'proveedor-table';
    table.innerHTML = `
      <caption class="visually-hidden">Detalle de proveedores registrados</caption>
      <thead>
        <tr>
          <th scope="col">Proveedor</th>
          <th scope="col">Giro</th>
          <th scope="col">Contacto</th>
          <th scope="col">Teléfono</th>
          <th scope="col">Condiciones de pago</th>
          <th scope="col">Acciones</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');
    lista.forEach((proveedor) => tbody.appendChild(this._renderProveedorRow(proveedor)));

    container.appendChild(table);
  },

  _renderProveedorRow(proveedor) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplProveedorRow);
    const row = tpl.content.cloneNode(true);
    const tr = row.querySelector('tr');

    row.querySelector('.proveedor-table__nombre').textContent =
      proveedor.nombreComercial || proveedor.nombreLegal;
    row.querySelector('.proveedor-table__giro').textContent = proveedor.giroComercial || '—';

    const contactoCell = row.querySelector('.proveedor-table__contacto');
    if (proveedor.contactoNombre) {
      contactoCell.textContent = proveedor.contactoCargo
        ? `${proveedor.contactoNombre} (${proveedor.contactoCargo})`
        : proveedor.contactoNombre;
    } else {
      contactoCell.textContent = '—';
    }

    const tel = proveedor.telefonoCelular || proveedor.telefonoEmpresa || '';
    row.querySelector('.proveedor-table__telefono').innerHTML = tel
      ? `<a href="tel:${escapeHTML(tel)}">${escapeHTML(tel)}</a>`
      : '—';

    row.querySelector('.proveedor-table__condiciones').textContent =
      proveedor.condicionesPago || '—';

    const acciones = row.querySelector('.proveedor-table__acciones');

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
      App.deleteProveedor(proveedor.id, proveedor.nombreComercial || proveedor.nombreLegal),
    );

    acciones.appendChild(btnEditar);
    acciones.appendChild(btnEliminar);

    return tr;
  },
};

/* ═══════════════════════════════════════════
   7. APP: ORQUESTADOR PRINCIPAL
   ═══════════════════════════════════════════ */
const App = {
  _liveConnected: false,
  _insumosCache: [],
  _proveedoresCache: [],

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

  startEditProveedor(id) {
    const proveedor = this._proveedoresCache.find((p) => p.id === id);
    if (!proveedor) return;

    const S = CONFIG.SELECTORS;
    document.querySelector(S.proveedorId).value = proveedor.id;
    document.querySelector(S.proveedorNombreLegal).value = proveedor.nombreLegal || '';
    document.querySelector(S.proveedorNombreComercial).value = proveedor.nombreComercial || '';
    document.querySelector(S.proveedorIdFiscal).value = proveedor.identificacionFiscal || '';
    document.querySelector(S.proveedorGiro).value = proveedor.giroComercial || '';
    document.querySelector(S.proveedorDireccion).value = proveedor.direccion || '';
    document.querySelector(S.proveedorContactoNombre).value = proveedor.contactoNombre || '';
    document.querySelector(S.proveedorContactoCargo).value = proveedor.contactoCargo || '';
    document.querySelector(S.proveedorEmailGeneral).value = proveedor.emailGeneral || '';
    document.querySelector(S.proveedorEmailContacto).value = proveedor.emailContacto || '';
    document.querySelector(S.proveedorTelEmpresa).value = proveedor.telefonoEmpresa || '';
    document.querySelector(S.proveedorTelCelular).value = proveedor.telefonoCelular || '';
    document.querySelector(S.proveedorBanco).value = proveedor.banco || '';
    document.querySelector(S.proveedorNumeroCuenta).value = proveedor.numeroCuenta || '';
    document.querySelector(S.proveedorClabeIban).value = proveedor.clabeIban || '';
    document.querySelector(S.proveedorCondicionesPago).value = proveedor.condicionesPago || '';
    document.querySelector(S.proveedorMoneda).value = proveedor.moneda || '';
    document.querySelector(S.proveedorMetodoFacturacion).value = proveedor.metodoFacturacion || '';
    document.querySelector(S.proveedorLeadTime).value = proveedor.leadTimeDias ?? '';
    document.querySelector(S.proveedorPedidoMinimo).value = proveedor.pedidoMinimo ?? '';
    document.querySelector(S.proveedorPoliticasDevolucion).value =
      proveedor.politicasDevolucion || '';
    document.querySelector(S.proveedorCertificaciones).value = proveedor.certificaciones || '';
    document.querySelector(S.proveedorNotas).value = proveedor.notas || '';

    const submitBtn = document.querySelector(S.proveedorSubmitBtn);
    submitBtn.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> Guardar cambios';
    document.querySelector(S.proveedorCancelEditBtn).hidden = false;

    document.querySelector(S.proveedorForm).scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelector(S.proveedorNombreLegal).focus();
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
    const form = document.querySelector(CONFIG.SELECTORS.proveedorForm);
    form.reset();
    document.querySelector(CONFIG.SELECTORS.proveedorId).value = '';
    document.querySelector(CONFIG.SELECTORS.proveedorSubmitBtn).innerHTML =
      '<i class="fa-solid fa-plus" aria-hidden="true"></i> Agregar proveedor';
    document.querySelector(CONFIG.SELECTORS.proveedorCancelEditBtn).hidden = true;
    document.querySelector(CONFIG.SELECTORS.proveedorError).hidden = true;
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
    const idExistente = document.querySelector(CONFIG.SELECTORS.insumoId).value || null;

    const datos = {
      nombre,
      categoria: document.querySelector(CONFIG.SELECTORS.insumoCategoria).value,
      cantidad: Number(cantidadRaw),
      unidad,
      costoUnitario: costoRaw === '' ? null : Number(costoRaw),
      stockMinimo: stockMinRaw === '' ? null : Number(stockMinRaw),
      proveedor: document.querySelector(CONFIG.SELECTORS.insumoProveedor).value.trim(),
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

  async _handleProveedorSubmit() {
    const S = CONFIG.SELECTORS;
    const errorEl = document.querySelector(S.proveedorError);
    const errorMsgEl = document.querySelector(S.proveedorErrorMsg);

    const nombreLegal = document.querySelector(S.proveedorNombreLegal).value.trim();

    if (!nombreLegal) {
      errorMsgEl.textContent = 'El nombre o razón social del proveedor es obligatorio.';
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const leadTimeRaw = document.querySelector(S.proveedorLeadTime).value;
    const pedidoMinimoRaw = document.querySelector(S.proveedorPedidoMinimo).value;
    const idExistente = document.querySelector(S.proveedorId).value || null;

    const datos = {
      nombreLegal,
      nombreComercial: document.querySelector(S.proveedorNombreComercial).value.trim(),
      identificacionFiscal: document.querySelector(S.proveedorIdFiscal).value.trim(),
      giroComercial: document.querySelector(S.proveedorGiro).value.trim(),
      direccion: document.querySelector(S.proveedorDireccion).value.trim(),
      contactoNombre: document.querySelector(S.proveedorContactoNombre).value.trim(),
      contactoCargo: document.querySelector(S.proveedorContactoCargo).value.trim(),
      emailGeneral: document.querySelector(S.proveedorEmailGeneral).value.trim(),
      emailContacto: document.querySelector(S.proveedorEmailContacto).value.trim(),
      telefonoEmpresa: document.querySelector(S.proveedorTelEmpresa).value.trim(),
      telefonoCelular: document.querySelector(S.proveedorTelCelular).value.trim(),
      banco: document.querySelector(S.proveedorBanco).value.trim(),
      numeroCuenta: document.querySelector(S.proveedorNumeroCuenta).value.trim(),
      clabeIban: document.querySelector(S.proveedorClabeIban).value.trim(),
      condicionesPago: document.querySelector(S.proveedorCondicionesPago).value.trim(),
      moneda: document.querySelector(S.proveedorMoneda).value,
      metodoFacturacion: document.querySelector(S.proveedorMetodoFacturacion).value.trim(),
      leadTimeDias: leadTimeRaw === '' ? null : Number(leadTimeRaw),
      pedidoMinimo: pedidoMinimoRaw === '' ? null : Number(pedidoMinimoRaw),
      politicasDevolucion: document.querySelector(S.proveedorPoliticasDevolucion).value.trim(),
      certificaciones: document.querySelector(S.proveedorCertificaciones).value.trim(),
      notas: document.querySelector(S.proveedorNotas).value.trim(),
    };

    const submitBtn = document.querySelector(S.proveedorSubmitBtn);
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

  _switchView(targetId) {
    const views = [
      CONFIG.SELECTORS.dashboardView,
      CONFIG.SELECTORS.insumosView,
      CONFIG.SELECTORS.proveedoresView,
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
    const navEl = document.querySelector(CONFIG.SELECTORS.adminNav);

    if (Auth.isAuthenticated()) {
      if (loginView) loginView.hidden = true;
      if (navEl) navEl.hidden = false;
      if (dashView) dashView.hidden = false;
      if (insumosView) insumosView.hidden = true;
      if (proveedoresView) proveedoresView.hidden = true;

      // Actualizar fecha
      const dateEl = document.querySelector(CONFIG.SELECTORS.date);
      if (dateEl) {
        dateEl.textContent = Format.todayDate();
        dateEl.dateTime = new Date().toISOString().slice(0, 10);
      }

      this.refresh();
    } else {
      if (loginView) loginView.hidden = false;
      if (navEl) navEl.hidden = true;
      if (dashView) dashView.hidden = true;
      if (insumosView) insumosView.hidden = true;
      if (proveedoresView) proveedoresView.hidden = true;
      const pwd = document.querySelector(CONFIG.SELECTORS.password);
      if (pwd) pwd.value = '';
    }
  },
};

/* ═══════════════════════════════════════════
   8. ARRANQUE
   ═══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => App.init());

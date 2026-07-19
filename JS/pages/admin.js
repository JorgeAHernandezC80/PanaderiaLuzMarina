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
  TOKEN_KEY:   'plm_admin_token',  // token recibido del backend tras autenticación
  SELECTORS: {
    loginView:     '#login-view',
    dashboardView: '#dashboard-view',
    loginForm:     '#login-form',
    password:      '#password',
    loginError:    '#login-error',
    loginErrorMsg: '#login-error [data-login-error-msg]',
    logoutBtn:     '#btn-logout',
    date:          '#dashboard-date',
    statOrdenes:   '#stat-ordenes',
    statIngresos:  '#stat-ingresos',
    statPrep:      '#stat-preparadas',
    statPend:      '#stat-pendientes',
    orders:        '#orders-container',
    tplGroup:      '#tpl-order-group',
    tplRow:        '#tpl-order-row',
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
    const res = await fetch(`${API_BASE}/auth`, {
      method: 'POST',
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
        headers: { 'Authorization': `Bearer ${Auth.getToken()}` },
      });
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
          'Authorization': `Bearer ${Auth.getToken()}`,
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

      socket.addEventListener('open', () => { intento = 0; });

      socket.addEventListener('message', e => {
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
   5. MÓDULO: RENDERIZADO
   ═══════════════════════════════════════════ */
const Render = {
  updateStats(orders) {
    const lista = orders || [];
    const total = lista.length;
    const ingresos = lista.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const preparadas = lista.filter(o => o.estado === 'preparada').length;
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
      container.appendChild(this._emptyState('No se pudo conectar con el servidor de pedidos. Verifica que el backend esté corriendo.'));
      return;
    }

    if (orders.length === 0) {
      container.appendChild(this._emptyState());
      return;
    }

    const groups = this._groupByPickup(orders);
    const sortedTimes = Object.keys(groups).sort();

    sortedTimes.forEach(time => {
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
    node.querySelector('.order-group__count').textContent =
      pluralizeEs(orders.length, 'pedido');
    node.querySelector('.order-group__subtotal').textContent = Format.currency(subtotal);

    const tbody = node.querySelector('.order-table tbody');
    orders.forEach(order => tbody.appendChild(this._renderRow(order)));

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
      .map(p => `${Number(p.cantidad) || 0}× ${escapeHTML(p.nombre)}`)
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
};

/* ═══════════════════════════════════════════
   6. APP: ORQUESTADOR PRINCIPAL
   ═══════════════════════════════════════════ */
const App = {
  _liveConnected: false,

  init() {
    this._bindEvents();
    this._showCorrectView();
  },

  async refresh() {
    const orders = await Api.getTodayOrders();
    Render.updateStats(orders);
    Render.renderOrders(orders);

    if (orders !== null && !this._liveConnected) {
      this._liveConnected = true;
      Api.connectLive(() => this.refresh());
    }
  },

  _bindEvents() {
    // Login
    document.querySelector(CONFIG.SELECTORS.loginForm)
      .addEventListener('submit', async e => {
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
          this._showLoginError('No se pudo conectar con el servidor. Intenta de nuevo en unos segundos.');
        } finally {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true"></i> Entrar';
        }
      });

    // Logout
    document.querySelector(CONFIG.SELECTORS.logoutBtn)
      .addEventListener('click', () => {
        Auth.logout();
        this._showCorrectView();
      });
  },

  _showLoginError(mensaje) {
    const errorEl = document.querySelector(CONFIG.SELECTORS.loginError);
    const msgEl = document.querySelector(CONFIG.SELECTORS.loginErrorMsg);
    if (msgEl) msgEl.textContent = mensaje;
    if (errorEl) errorEl.hidden = false;
    document.querySelector(CONFIG.SELECTORS.password).focus();
  },

  _showCorrectView() {
    const loginView = document.querySelector(CONFIG.SELECTORS.loginView);
    const dashView = document.querySelector(CONFIG.SELECTORS.dashboardView);

    if (Auth.isAuthenticated()) {
      loginView.hidden = true;
      dashView.hidden = false;

      // Actualizar fecha
      const dateEl = document.querySelector(CONFIG.SELECTORS.date);
      dateEl.textContent = Format.todayDate();
      dateEl.dateTime = new Date().toISOString().slice(0, 10);

      this.refresh();
    } else {
      loginView.hidden = false;
      dashView.hidden = true;
      document.querySelector(CONFIG.SELECTORS.password).value = '';
    }
  },
};

/* ═══════════════════════════════════════════
   7. ARRANQUE
   ═══════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => App.init());
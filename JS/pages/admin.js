/**
 * Panel Admin · Panadería Luz Marina
 * Organización: Configuración → Auth → Storage → Render → App
 */

/* ═══════════════════════════════════════════
   1. CONFIGURACIÓN
   ═══════════════════════════════════════════ */
const CONFIG = Object.freeze({
  PASSWORD: 'plm2026',
  STORAGE_KEY: 'plm_ordenes',
  SESSION_KEY: 'plm_admin_session',
  SELECTORS: {
    loginView:     '#login-view',
    dashboardView: '#dashboard-view',
    loginForm:     '#login-form',
    password:      '#password',
    loginError:    '#login-error',
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
  login(password) {
    if (password !== CONFIG.PASSWORD) return false;
    sessionStorage.setItem(CONFIG.SESSION_KEY, '1');
    return true;
  },

  logout() {
    sessionStorage.removeItem(CONFIG.SESSION_KEY);
  },

  isAuthenticated() {
    return sessionStorage.getItem(CONFIG.SESSION_KEY) === '1';
  },
};

/* ═══════════════════════════════════════════
   3. MÓDULO: ALMACENAMIENTO
   ═══════════════════════════════════════════ */
const Storage = {
  getOrders() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || '[]');
    } catch {
      console.error('[Storage] Error leyendo órdenes');
      return [];
    }
  },

  saveOrders(orders) {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(orders));
  },

  getTodayOrders() {
    const today = new Date().toISOString().slice(0, 10);
    return this.getOrders().filter(o => o.fecha && o.fecha.startsWith(today));
  },

  markAsPrepared(orderId) {
    const orders = this.getOrders();
    const order = orders.find(o => o.id === orderId);
    if (order) {
      order.preparada = true;
      this.saveOrders(orders);
      return true;
    }
    return false;
  },
};

/* ═══════════════════════════════════════════
   4. MÓDULO: FORMATO
   ═══════════════════════════════════════════ */
const Format = {
  currency(value) {
    const num = Number(value) || 0;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    }).format(num);
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
   5. MÓDULO: RENDERIZADO
   ═══════════════════════════════════════════ */
const Render = {
  updateStats(orders) {
    const total = orders.length;
    const ingresos = orders.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const preparadas = orders.filter(o => o.preparada).length;
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
      const time = order.datos?.retiro || 'Sin horario definido';
      if (!acc[time]) acc[time] = [];
      acc[time].push(order);
      return acc;
    }, {});
  },

  _emptyState() {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `
      <span class="empty-state__icon" aria-hidden="true">🧺</span>
      <h2 class="empty-state__title">Sin pedidos hoy</h2>
      <p class="empty-state__text">
        Los pedidos aparecerán aquí cuando los clientes completen el checkout.
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
      `${orders.length} pedido${orders.length !== 1 ? 's' : ''}`;
    node.querySelector('.order-group__subtotal').textContent = Format.currency(subtotal);

    const tbody = node.querySelector('.order-table tbody');
    orders.forEach(order => tbody.appendChild(this._renderRow(order)));

    return article;
  },

  _renderRow(order) {
    const tpl = document.querySelector(CONFIG.SELECTORS.tplRow);
    const row = tpl.content.cloneNode(true);
    const tr = row.querySelector('tr');

    if (order.preparada) tr.classList.add('order-row--done');

    row.querySelector('.order-table__id').textContent = order.id || '—';
    row.querySelector('.order-table__cliente').textContent = order.datos?.nombre || '—';

    const tel = order.datos?.telefono || '';
    row.querySelector('.order-table__telefono').innerHTML = tel
      ? `<a href="tel:${tel}">${tel}</a>`
      : '—';

    const productos = (order.productos || [])
      .map(p => `${p.cantidad}× ${p.nombre}`)
      .join('<br>');
    row.querySelector('.order-table__productos').innerHTML = productos || '—';

    row.querySelector('.order-table__total').textContent = Format.currency(order.total);

    const estadoCell = row.querySelector('.order-table__estado');
    if (order.preparada) {
      estadoCell.innerHTML = `
        <span class="order-status order-status--done">✓ Lista</span>
      `;
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--action';
      btn.textContent = 'Marcar lista';
      btn.addEventListener('click', () => {
        Storage.markAsPrepared(order.id);
        App.refresh();
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
  init() {
    this._bindEvents();
    this._showCorrectView();
  },

  refresh() {
    const orders = Storage.getTodayOrders();
    Render.updateStats(orders);
    Render.renderOrders(orders);
  },

  _bindEvents() {
    // Login
    document.querySelector(CONFIG.SELECTORS.loginForm)
      .addEventListener('submit', e => {
        e.preventDefault();
        const pwd = document.querySelector(CONFIG.SELECTORS.password).value;
        const errorEl = document.querySelector(CONFIG.SELECTORS.loginError);

        if (Auth.login(pwd)) {
          errorEl.hidden = true;
          this._showCorrectView();
        } else {
          errorEl.hidden = false;
          document.querySelector(CONFIG.SELECTORS.password).focus();
        }
      });

    // Logout
    document.querySelector(CONFIG.SELECTORS.logoutBtn)
      .addEventListener('click', () => {
        Auth.logout();
        this._showCorrectView();
      });
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
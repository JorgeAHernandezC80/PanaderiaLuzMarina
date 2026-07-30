/**
 * PANADERÍA LUZ MARINA — Backend: Servidor
 * Express + better-sqlite3 + WebSocket.
 */

const cors = require('cors');
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const {
  validarOrden,
  ValidationError,
  NUMERO_ORDEN_RE,
  ORDER_STATES,
  validarInsumo,
  INSUMO_ID_RE,
  validarProveedor,
  PROVEEDOR_ID_RE,
  validarHorneada,
  HORNEADA_ID_RE,
  PRODUCTOS_CATALOGO,
  validarAjusteInventario,
  AJUSTE_ID_RE,
  validarStockMinimo,
} = require('./validation');

const PORT = process.env.PORT || 3001;

/* FRONTEND_ORIGIN debe estar configurado como variable de entorno en Render.
   Si no está, se usa el dominio de Netlify por defecto. Acepta varios orígenes
   separados por coma y normaliza la barra final, que un navegador nunca envía
   en la cabecera Origin (un valor con "/" al final nunca haría match). */
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGIN || 'https://luzmarpanaderia.netlify.app')
  .split(',')
  .map((origen) => origen.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/* ADMIN_TOKEN: contraseña del panel admin, definida como variable de entorno en Render.
   Nunca debe estar en el código fuente. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.warn(
    '[server] ADVERTENCIA: ADMIN_TOKEN no está configurado. El panel admin estará inaccesible.',
  );
}

/* Secreto para firmar los tokens de sesión del panel admin. */
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_TOKEN || '';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 8 * 60 * 60 * 1000;

/**
 * Emite un token de sesión firmado (HMAC-SHA256) con expiración.
 */
function issueSessionToken() {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString(
    'base64url',
  );
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verifica un token de sesión: firma válida y no expirado.
 */
function verifySessionToken(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  return Boolean(payload) && typeof payload.exp === 'number' && Date.now() <= payload.exp;
}

/** Middleware que protege endpoints del panel admin. */
function requireAuth(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Panel admin no configurado en el servidor.' });
  }
  const auth = req.headers['authorization'] ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifySessionToken(token)) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  next();
}

/* ═══════════════════════════════════════════
   CONFIGURACIÓN DE EXPRESS Y MIDDLEWARES
   ═══════════════════════════════════════════ */
const app = express();
app.disable('x-powered-by');

// 1. Parseo de JSON con límite de seguridad
app.use(express.json({ limit: '100kb' }));

// 2. Configuración de CORS unificada y segura (Reemplaza el bloque manual antiguo)
app.use(
  cors({
    origin: [
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      ...FRONTEND_ORIGINS, // Dominios de producción (configurables por entorno)
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// 3. Cabeceras de seguridad en todas las respuestas (defensa en profundidad)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; connect-src 'self' ${FRONTEND_ORIGINS.join(' ')} wss://${req.headers.host}; frame-ancestors 'none'; base-uri 'none'`,
  );
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  next();
});

/* ═══════════════════════════════════════════
   RATE LIMITING
   ═══════════════════════════════════════════ */
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

const rateLimiters = [];
function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  rateLimiters.push(hits);
  return function rateLimiter(req, res, next) {
    const ip = getClientIp(req);
    const ahora = Date.now();
    const registro = hits.get(ip) || { count: 0, desde: ahora };
    if (ahora - registro.desde > windowMs) {
      registro.count = 0;
      registro.desde = ahora;
    }
    registro.count++;
    hits.set(ip, registro);
    if (registro.count > max) {
      res.setHeader('Retry-After', Math.ceil((registro.desde + windowMs - ahora) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

const rateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ORDERS_MAX_PER_WINDOW) || 20,
  message: 'Demasiadas solicitudes. Intenta en unos minutos.',
});

const authRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_MAX_ATTEMPTS) || 10,
  message: 'Demasiados intentos de acceso. Espera unos minutos e intenta de nuevo.',
});

const cleanupTimer = setInterval(
  () => {
    const ahora = Date.now();
    for (const hits of rateLimiters) {
      for (const [ip, registro] of hits) {
        if (ahora - registro.desde > 60 * 60 * 1000) hits.delete(ip);
      }
    }
  },
  30 * 60 * 1000,
);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

function resetRateLimits() {
  for (const hits of rateLimiters) hits.clear();
}

/* ═══════════════════════════════════════════
   WEBSOCKET Y RUTAS
   ═══════════════════════════════════════════ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(data);
  });
}

// Ruta raíz - Documentación de la API
app.get('/', (req, res) => {
  res.json({
    servicio: 'Panadería Luz Marina API',
    version: '1.0.0',
    estado: 'operativo',
    documentacion: {
      health: 'GET /health',
      auth: 'POST /auth (body: { password: "tu_token" })',
      crearOrden: 'POST /ordenes',
      listarOrdenes: 'GET /ordenes (Authorization: Bearer token)',
      actualizarOrden: 'PATCH /ordenes/:numero (Authorization: Bearer token)',
      listarInsumos: 'GET /insumos (Authorization: Bearer token)',
      crearInsumo: 'POST /insumos (Authorization: Bearer token)',
      actualizarInsumo: 'PUT /insumos/:id (Authorization: Bearer token)',
      eliminarInsumo: 'DELETE /insumos/:id (Authorization: Bearer token)',
      listarProveedores: 'GET /proveedores (Authorization: Bearer token)',
      crearProveedor: 'POST /proveedores (Authorization: Bearer token)',
      actualizarProveedor: 'PUT /proveedores/:id (Authorization: Bearer token)',
      eliminarProveedor: 'DELETE /proveedores/:id (Authorization: Bearer token)',
      listarHorneadas: 'GET /horneadas?fecha=YYYY-MM-DD (Authorization: Bearer token)',
      crearHorneada: 'POST /horneadas (Authorization: Bearer token)',
      actualizarHorneada: 'PUT /horneadas/:id (Authorization: Bearer token)',
      eliminarHorneada: 'DELETE /horneadas/:id (Authorization: Bearer token)',
      listarAjustesInventario:
        'GET /ajustes-inventario?fecha=YYYY-MM-DD (Authorization: Bearer token)',
      crearAjusteInventario: 'POST /ajustes-inventario (Authorization: Bearer token)',
      actualizarAjusteInventario: 'PUT /ajustes-inventario/:id (Authorization: Bearer token)',
      eliminarAjusteInventario: 'DELETE /ajustes-inventario/:id (Authorization: Bearer token)',
      actualizarStockMinimo: 'PUT /productos/:id/stock-minimo (Authorization: Bearer token)',
      verInventario: 'GET /inventario?fecha=YYYY-MM-DD (Authorization: Bearer token)',
      verDisponiblePublico:
        'GET /inventario/disponible (público, sin token — usado por catalogo.html)',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

app.post('/auth', authRateLimit, (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Panel admin no configurado.' });
  }
  const { password } = req.body ?? {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Falta la contraseña.' });
  }
  const expected = Buffer.from(ADMIN_TOKEN);
  const received = Buffer.from(password.slice(0, 200));

  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }

  const token = issueSessionToken();
  return res.json({ token, expiresIn: SESSION_TTL_MS });
});

app.post('/ordenes', rateLimit, (req, res) => {
  let orden;
  try {
    orden = validarOrden(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO ordenes (numero, fecha_iso, fecha_texto, cliente, telefono, retiro, items_json, total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      orden.numero,
      orden.fechaISO,
      orden.fechaTexto,
      orden.cliente,
      orden.telefono,
      orden.retiro,
      JSON.stringify(orden.items),
      orden.total,
    );
    const ordenGuardada = { ...orden, estado: 'pendiente' };
    broadcast({ tipo: 'orden:nueva', orden: ordenGuardada });
    res.status(201).json(ordenGuardada);
  } catch (err) {
    const esConflicto = /UNIQUE constraint failed/i.test(err.message || '');
    if (esConflicto) {
      return res.status(409).json({ error: 'Ya existe una orden con ese número.' });
    }
    console.error('[POST /ordenes]', err.message);
    res.status(500).json({ error: 'Error al guardar la orden.' });
  }
});

app.get('/ordenes', requireAuth, (req, res) => {
  const { fecha, estado } = req.query;

  let sql = 'SELECT * FROM ordenes WHERE 1=1';
  const params = [];

  if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    sql += ' AND fecha_iso LIKE ?';
    params.push(`${fecha}%`);
  }
  if (estado && ORDER_STATES.includes(estado)) {
    sql += ' AND estado = ?';
    params.push(estado);
  }
  sql += ' ORDER BY fecha_iso DESC LIMIT 200';

  try {
    const rows = db.prepare(sql).all(...params);
    const ordenes = rows.map((r) => ({
      numero: r.numero,
      fechaISO: r.fecha_iso,
      fechaTexto: r.fecha_texto,
      cliente: r.cliente,
      telefono: r.telefono,
      retiro: r.retiro,
      items: JSON.parse(r.items_json),
      total: r.total,
      estado: r.estado,
    }));
    res.json(ordenes);
  } catch (err) {
    console.error('[GET /ordenes]', err.message);
    res.status(500).json({ error: 'Error al consultar órdenes.' });
  }
});

app.patch('/ordenes/:numero', requireAuth, (req, res) => {
  const { numero } = req.params;
  const { estado } = req.body ?? {};

  if (!NUMERO_ORDEN_RE.test(numero)) {
    return res.status(400).json({ error: 'Número de orden inválido.' });
  }
  if (!ORDER_STATES.includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido.' });
  }

  try {
    const info = db.prepare('UPDATE ordenes SET estado = ? WHERE numero = ?').run(estado, numero);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Orden no encontrada.' });
    }
    broadcast({ tipo: 'orden:actualizada', numero, estado });
    res.json({ numero, estado });
  } catch (err) {
    console.error('[PATCH /ordenes/:numero]', err.message);
    res.status(500).json({ error: 'Error al actualizar la orden.' });
  }
});

/* ═══════════════════════════════════════════
   INSUMOS — CRUD protegido (solo panel admin)
   ═══════════════════════════════════════════ */
function serializeInsumo(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    categoria: row.categoria,
    cantidad: row.cantidad,
    unidad: row.unidad,
    costoUnitario: row.costo_unitario,
    stockMinimo: row.stock_minimo,
    proveedor: row.proveedor,
    notas: row.notas,
    creadoEn: row.creado_en,
    actualizadoEn: row.actualizado_en,
  };
}

app.get('/insumos', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM insumos ORDER BY nombre COLLATE NOCASE ASC').all();
    res.json(rows.map(serializeInsumo));
  } catch (err) {
    console.error('[GET /insumos]', err.message);
    res.status(500).json({ error: 'Error al consultar insumos.' });
  }
});

app.post('/insumos', requireAuth, rateLimit, (req, res) => {
  let datos;
  try {
    datos = validarInsumo(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO insumos (id, nombre, categoria, cantidad, unidad, costo_unitario, stock_minimo, proveedor, notas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      datos.nombre,
      datos.categoria,
      datos.cantidad,
      datos.unidad,
      datos.costoUnitario,
      datos.stockMinimo,
      datos.proveedor,
      datos.notas,
    );
    const fila = db.prepare('SELECT * FROM insumos WHERE id = ?').get(id);
    res.status(201).json(serializeInsumo(fila));
  } catch (err) {
    console.error('[POST /insumos]', err.message);
    res.status(500).json({ error: 'Error al guardar el insumo.' });
  }
});

app.put('/insumos/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!INSUMO_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de insumo inválido.' });
  }

  let datos;
  try {
    datos = validarInsumo(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  try {
    const info = db
      .prepare(
        `UPDATE insumos
         SET nombre = ?, categoria = ?, cantidad = ?, unidad = ?, costo_unitario = ?,
             stock_minimo = ?, proveedor = ?, notas = ?, actualizado_en = datetime('now')
         WHERE id = ?`,
      )
      .run(
        datos.nombre,
        datos.categoria,
        datos.cantidad,
        datos.unidad,
        datos.costoUnitario,
        datos.stockMinimo,
        datos.proveedor,
        datos.notas,
        id,
      );
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Insumo no encontrado.' });
    }
    const fila = db.prepare('SELECT * FROM insumos WHERE id = ?').get(id);
    res.json(serializeInsumo(fila));
  } catch (err) {
    console.error('[PUT /insumos/:id]', err.message);
    res.status(500).json({ error: 'Error al actualizar el insumo.' });
  }
});

app.delete('/insumos/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!INSUMO_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de insumo inválido.' });
  }
  try {
    const info = db.prepare('DELETE FROM insumos WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Insumo no encontrado.' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /insumos/:id]', err.message);
    res.status(500).json({ error: 'Error al eliminar el insumo.' });
  }
});

/* ═══════════════════════════════════════════
   PROVEEDORES — CRUD protegido (solo panel admin)
   ═══════════════════════════════════════════ */
function serializeProveedor(row) {
  return {
    id: row.id,
    razonSocial: row.razon_social,
    nombreComercial: row.nombre_comercial,
    identificacionFiscal: row.identificacion_fiscal,
    giroComercial: row.giro_comercial,
    direccion: row.direccion,
    codigoPostal: row.codigo_postal,
    ciudad: row.ciudad,
    pais: row.pais,
    contactoNombre: row.contacto_nombre,
    emailFacturacion: row.email_facturacion,
    emailContacto: row.email_contacto,
    telefonoFijo: row.telefono_fijo,
    celular: row.celular,
    banco: row.banco,
    numeroCuenta: row.numero_cuenta,
    clabeIban: row.clabe_iban,
    condicionesPago: row.condiciones_pago,
    moneda: row.moneda,
    metodoFacturacion: row.metodo_facturacion,
    leadTimeDias: row.lead_time_dias,
    pedidoMinimo: row.pedido_minimo,
    politicasDevolucion: row.politicas_devolucion,
    certificaciones: row.certificaciones,
    notas: row.notas,
    creadoEn: row.creado_en,
    actualizadoEn: row.actualizado_en,
  };
}

/** Columnas en el mismo orden que los valores de `valoresProveedor`. */
const COLUMNAS_PROVEEDOR = [
  'razon_social',
  'nombre_comercial',
  'identificacion_fiscal',
  'giro_comercial',
  'direccion',
  'codigo_postal',
  'ciudad',
  'pais',
  'contacto_nombre',
  'email_facturacion',
  'email_contacto',
  'telefono_fijo',
  'celular',
  'banco',
  'numero_cuenta',
  'clabe_iban',
  'condiciones_pago',
  'moneda',
  'metodo_facturacion',
  'lead_time_dias',
  'pedido_minimo',
  'politicas_devolucion',
  'certificaciones',
  'notas',
];

function valoresProveedor(datos) {
  return [
    datos.razonSocial,
    datos.nombreComercial,
    datos.identificacionFiscal,
    datos.giroComercial,
    datos.direccion,
    datos.codigoPostal,
    datos.ciudad,
    datos.pais,
    datos.contactoNombre,
    datos.emailFacturacion,
    datos.emailContacto,
    datos.telefonoFijo,
    datos.celular,
    datos.banco,
    datos.numeroCuenta,
    datos.clabeIban,
    datos.condicionesPago,
    datos.moneda,
    datos.metodoFacturacion,
    datos.leadTimeDias,
    datos.pedidoMinimo,
    datos.politicasDevolucion,
    datos.certificaciones,
    datos.notas,
  ];
}

app.get('/proveedores', requireAuth, (req, res) => {
  try {
    const rows = db
      .prepare('SELECT * FROM proveedores ORDER BY razon_social COLLATE NOCASE ASC')
      .all();
    res.json(rows.map(serializeProveedor));
  } catch (err) {
    console.error('[GET /proveedores]', err.message);
    res.status(500).json({ error: 'Error al consultar proveedores.' });
  }
});

app.post('/proveedores', requireAuth, rateLimit, (req, res) => {
  let datos;
  try {
    datos = validarProveedor(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const id = crypto.randomUUID();
  const placeholders = COLUMNAS_PROVEEDOR.map(() => '?').join(', ');
  try {
    db.prepare(
      `INSERT INTO proveedores (id, ${COLUMNAS_PROVEEDOR.join(', ')})
       VALUES (?, ${placeholders})`,
    ).run(id, ...valoresProveedor(datos));
    const fila = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(id);
    res.status(201).json(serializeProveedor(fila));
  } catch (err) {
    console.error('[POST /proveedores]', err.message);
    res.status(500).json({ error: 'Error al guardar el proveedor.' });
  }
});

app.put('/proveedores/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!PROVEEDOR_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de proveedor inválido.' });
  }

  let datos;
  try {
    datos = validarProveedor(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const asignaciones = COLUMNAS_PROVEEDOR.map((col) => `${col} = ?`).join(', ');
  try {
    const info = db
      .prepare(
        `UPDATE proveedores
         SET ${asignaciones}, actualizado_en = datetime('now')
         WHERE id = ?`,
      )
      .run(...valoresProveedor(datos), id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Proveedor no encontrado.' });
    }
    const fila = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(id);
    res.json(serializeProveedor(fila));
  } catch (err) {
    console.error('[PUT /proveedores/:id]', err.message);
    res.status(500).json({ error: 'Error al actualizar el proveedor.' });
  }
});

app.delete('/proveedores/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!PROVEEDOR_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de proveedor inválido.' });
  }
  try {
    const info = db.prepare('DELETE FROM proveedores WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Proveedor no encontrado.' });
    }
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /proveedores/:id]', err.message);
    res.status(500).json({ error: 'Error al eliminar el proveedor.' });
  }
});

/* ═══════════════════════════════════════════
   HORNEADAS — CRUD protegido (solo panel admin)
   Registro manual de producción: qué se horneó, cuánto y a qué hora.
   Es la base de datos que luego alimentará Inventario/Stock y
   Analítica de Productos/Ventas.
   ═══════════════════════════════════════════ */
function serializeHorneada(row) {
  return {
    id: row.id,
    productoId: row.producto_id,
    productoNombre: row.producto_nombre,
    cantidad: row.cantidad,
    fecha: row.fecha,
    hora: row.hora,
    registradoPor: row.registrado_por,
    notas: row.notas,
    creadoEn: row.creado_en,
    actualizadoEn: row.actualizado_en,
  };
}

app.get('/horneadas', requireAuth, (req, res) => {
  const { fecha } = req.query;

  let sql = 'SELECT * FROM horneadas WHERE 1=1';
  const params = [];

  if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    sql += ' AND fecha = ?';
    params.push(fecha);
  }
  sql += ' ORDER BY fecha DESC, hora ASC';

  try {
    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(serializeHorneada));
  } catch (err) {
    console.error('[GET /horneadas]', err.message);
    res.status(500).json({ error: 'Error al consultar horneadas.' });
  }
});

app.post('/horneadas', requireAuth, rateLimit, (req, res) => {
  let datos;
  try {
    datos = validarHorneada(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO horneadas (id, producto_id, producto_nombre, cantidad, fecha, hora, registrado_por, notas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      datos.productoId,
      datos.productoNombre,
      datos.cantidad,
      datos.fecha,
      datos.hora,
      datos.registradoPor,
      datos.notas,
    );
    const fila = db.prepare('SELECT * FROM horneadas WHERE id = ?').get(id);
    broadcast({ tipo: 'horneada:nueva', horneada: serializeHorneada(fila) });
    res.status(201).json(serializeHorneada(fila));
  } catch (err) {
    console.error('[POST /horneadas]', err.message);
    res.status(500).json({ error: 'Error al guardar la horneada.' });
  }
});

app.put('/horneadas/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!HORNEADA_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de horneada inválido.' });
  }

  let datos;
  try {
    datos = validarHorneada(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  try {
    const info = db
      .prepare(
        `UPDATE horneadas
         SET producto_id = ?, producto_nombre = ?, cantidad = ?, fecha = ?, hora = ?,
             registrado_por = ?, notas = ?, actualizado_en = datetime('now')
         WHERE id = ?`,
      )
      .run(
        datos.productoId,
        datos.productoNombre,
        datos.cantidad,
        datos.fecha,
        datos.hora,
        datos.registradoPor,
        datos.notas,
        id,
      );
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Horneada no encontrada.' });
    }
    const fila = db.prepare('SELECT * FROM horneadas WHERE id = ?').get(id);
    broadcast({ tipo: 'horneada:actualizada', horneada: serializeHorneada(fila) });
    res.json(serializeHorneada(fila));
  } catch (err) {
    console.error('[PUT /horneadas/:id]', err.message);
    res.status(500).json({ error: 'Error al actualizar la horneada.' });
  }
});

app.delete('/horneadas/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!HORNEADA_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de horneada inválido.' });
  }
  try {
    const info = db.prepare('DELETE FROM horneadas WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Horneada no encontrada.' });
    }
    broadcast({ tipo: 'horneada:eliminada', id });
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /horneadas/:id]', err.message);
    res.status(500).json({ error: 'Error al eliminar la horneada.' });
  }
});

/* ═══════════════════════════════════════════
   AJUSTES DE INVENTARIO — CRUD protegido (mermas, errores de conteo, etc.)
   Mismo patrón que Horneadas. Se restan del disponible junto con lo
   preparado/vendido del día.
   ═══════════════════════════════════════════ */
function serializeAjuste(row) {
  return {
    id: row.id,
    productoId: row.producto_id,
    productoNombre: row.producto_nombre,
    cantidad: row.cantidad,
    motivo: row.motivo,
    fecha: row.fecha,
    hora: row.hora,
    registradoPor: row.registrado_por,
    notas: row.notas,
    creadoEn: row.creado_en,
    actualizadoEn: row.actualizado_en,
  };
}

app.get('/ajustes-inventario', requireAuth, (req, res) => {
  const { fecha } = req.query;

  let sql = 'SELECT * FROM ajustes_inventario WHERE 1=1';
  const params = [];

  if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    sql += ' AND fecha = ?';
    params.push(fecha);
  }
  sql += ' ORDER BY fecha DESC, hora ASC';

  try {
    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(serializeAjuste));
  } catch (err) {
    console.error('[GET /ajustes-inventario]', err.message);
    res.status(500).json({ error: 'Error al consultar ajustes de inventario.' });
  }
});

app.post('/ajustes-inventario', requireAuth, rateLimit, (req, res) => {
  let datos;
  try {
    datos = validarAjusteInventario(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO ajustes_inventario
         (id, producto_id, producto_nombre, cantidad, motivo, fecha, hora, registrado_por, notas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      datos.productoId,
      datos.productoNombre,
      datos.cantidad,
      datos.motivo,
      datos.fecha,
      datos.hora,
      datos.registradoPor,
      datos.notas,
    );
    const fila = db.prepare('SELECT * FROM ajustes_inventario WHERE id = ?').get(id);
    broadcast({ tipo: 'ajuste:nuevo', ajuste: serializeAjuste(fila) });
    res.status(201).json(serializeAjuste(fila));
  } catch (err) {
    console.error('[POST /ajustes-inventario]', err.message);
    res.status(500).json({ error: 'Error al guardar el ajuste de inventario.' });
  }
});

app.put('/ajustes-inventario/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!AJUSTE_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de ajuste inválido.' });
  }

  let datos;
  try {
    datos = validarAjusteInventario(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  try {
    const info = db
      .prepare(
        `UPDATE ajustes_inventario
         SET producto_id = ?, producto_nombre = ?, cantidad = ?, motivo = ?, fecha = ?, hora = ?,
             registrado_por = ?, notas = ?, actualizado_en = datetime('now')
         WHERE id = ?`,
      )
      .run(
        datos.productoId,
        datos.productoNombre,
        datos.cantidad,
        datos.motivo,
        datos.fecha,
        datos.hora,
        datos.registradoPor,
        datos.notas,
        id,
      );
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Ajuste no encontrado.' });
    }
    const fila = db.prepare('SELECT * FROM ajustes_inventario WHERE id = ?').get(id);
    broadcast({ tipo: 'ajuste:actualizado', ajuste: serializeAjuste(fila) });
    res.json(serializeAjuste(fila));
  } catch (err) {
    console.error('[PUT /ajustes-inventario/:id]', err.message);
    res.status(500).json({ error: 'Error al actualizar el ajuste de inventario.' });
  }
});

app.delete('/ajustes-inventario/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!AJUSTE_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de ajuste inválido.' });
  }
  try {
    const info = db.prepare('DELETE FROM ajustes_inventario WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Ajuste no encontrado.' });
    }
    broadcast({ tipo: 'ajuste:eliminado', id });
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /ajustes-inventario/:id]', err.message);
    res.status(500).json({ error: 'Error al eliminar el ajuste de inventario.' });
  }
});

/* ═══════════════════════════════════════════
   STOCK MÍNIMO POR PRODUCTO — usado por las alertas de Inventario
   ═══════════════════════════════════════════ */
app.put('/productos/:id/stock-minimo', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!PRODUCTOS_CATALOGO[Number(id)]) {
    return res.status(400).json({ error: 'Producto inválido.' });
  }

  let datos;
  try {
    datos = validarStockMinimo(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const productoId = String(Number(id));
  try {
    db.prepare(
      `INSERT INTO producto_stock_minimo (producto_id, stock_minimo, actualizado_en)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(producto_id) DO UPDATE SET
         stock_minimo = excluded.stock_minimo,
         actualizado_en = datetime('now')`,
    ).run(productoId, datos.stockMinimo);
    res.json({ productoId, stockMinimo: datos.stockMinimo });
  } catch (err) {
    console.error('[PUT /productos/:id/stock-minimo]', err.message);
    res.status(500).json({ error: 'Error al actualizar el stock mínimo.' });
  }
});

/* ═══════════════════════════════════════════
   INVENTARIO — vista agregada (solo lectura, no es una tabla propia)
   Disponible = Horneado (hoy) − Vendido (hoy) − Preparado (hoy) − Ajustes.
   "Vendido" son órdenes en estado entregada; "Preparado" son órdenes en
   estado preparada que ya reservaron el pan pero aún no salieron. El cruce
   con órdenes es por productoId cuando el item lo trae (checkout.js lo
   manda desde JS/pages/checkout.js), y cae de vuelta al nombre para
   órdenes creadas antes de ese cambio. Un producto que no exista en
   PRODUCTOS_CATALOGO no se cuenta.
   ═══════════════════════════════════════════ */
const STOCK_MINIMO_DEFAULT = 5;

/** Calcula el disponible por producto para una fecha. Compartida por el
 * endpoint admin (GET /inventario, detalle completo) y el público
 * (GET /inventario/disponible, solo el número que ve el cliente) para no
 * duplicar la lógica de cruce entre ambos. */
function calcularInventario(fechaConsulta) {
  // Arranca con todos los productos del catálogo en cero, para que se
  // vean incluso los que no tuvieron ningún movimiento ese día. También
  // se indexa por id, para cruzar por productoId cuando esté disponible.
  const porProducto = new Map();
  const porProductoId = new Map();
  for (const [id, nombre] of Object.entries(PRODUCTOS_CATALOGO)) {
    const entry = {
      productoId: String(id),
      productoNombre: nombre,
      horneado: 0,
      preparado: 0,
      vendido: 0,
      ajustes: 0,
    };
    porProducto.set(nombre, entry);
    porProductoId.set(String(id), entry);
  }

  const horneadoRows = db
    .prepare(
      'SELECT producto_id, producto_nombre, SUM(cantidad) AS total FROM horneadas WHERE fecha = ? GROUP BY producto_id',
    )
    .all(fechaConsulta);
  for (const row of horneadoRows) {
    const entry = porProducto.get(row.producto_nombre);
    if (entry) entry.horneado = row.total;
  }

  const ordenesRows = db
    .prepare(
      "SELECT items_json, estado FROM ordenes WHERE fecha_iso LIKE ? AND estado IN ('preparada', 'entregada')",
    )
    .all(`${fechaConsulta}%`);
  for (const row of ordenesRows) {
    let items;
    try {
      items = JSON.parse(row.items_json);
    } catch {
      items = [];
    }
    for (const item of items) {
      // Preferimos cruzar por productoId (exacto, no se rompe si el
      // nombre del producto cambia en el catálogo). Las órdenes creadas
      // antes de este cambio no tienen productoId: para esas, caemos de
      // vuelta al cruce por nombre.
      const entry = item.productoId
        ? porProductoId.get(String(item.productoId))
        : porProducto.get(item.nombre);
      if (!entry) continue; // producto fuera del catálogo actual: no se cruza
      if (row.estado === 'preparada') entry.preparado += item.cantidad;
      if (row.estado === 'entregada') entry.vendido += item.cantidad;
    }
  }

  const ajustesRows = db
    .prepare(
      'SELECT producto_id, producto_nombre, SUM(cantidad) AS total FROM ajustes_inventario WHERE fecha = ? GROUP BY producto_id',
    )
    .all(fechaConsulta);
  for (const row of ajustesRows) {
    const entry = porProducto.get(row.producto_nombre);
    if (entry) entry.ajustes = row.total;
  }

  const stockMinimoRows = db
    .prepare('SELECT producto_id, stock_minimo FROM producto_stock_minimo')
    .all();
  const stockMinimoPorId = new Map(stockMinimoRows.map((r) => [r.producto_id, r.stock_minimo]));

  return [...porProducto.values()].map((e) => {
    const disponible = e.horneado - e.vendido - e.preparado - e.ajustes;
    return {
      ...e,
      disponible,
      stockMinimo: stockMinimoPorId.get(e.productoId) ?? STOCK_MINIMO_DEFAULT,
      bajoStock: disponible < (stockMinimoPorId.get(e.productoId) ?? STOCK_MINIMO_DEFAULT),
    };
  });
}

app.get('/inventario', requireAuth, (req, res) => {
  const { fecha } = req.query;
  const fechaConsulta =
    fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : new Date().toISOString().slice(0, 10);

  try {
    const productos = calcularInventario(fechaConsulta);
    res.json({ fecha: fechaConsulta, productos });
  } catch (err) {
    console.error('[GET /inventario]', err.message);
    res.status(500).json({ error: 'Error al calcular el inventario.' });
  }
});

/* Endpoint PÚBLICO (sin auth) para catalogo.html: solo expone cuánto pan
 * disponible hay de cada producto AHORA MISMO. Nunca de otra fecha, y nunca
 * el desglose (horneado/preparado/vendido/ajustes) ni el stock mínimo — eso
 * es información operativa interna, no algo para mostrarle al cliente. El
 * disponible se acota a 0 hacia abajo: un número negativo sería un detalle
 * de contabilidad interna sin sentido para quien solo quiere saber si hay
 * pan o no. */
app.get('/inventario/disponible', (req, res) => {
  const hoy = new Date().toISOString().slice(0, 10);
  try {
    const productos = calcularInventario(hoy).map((p) => ({
      productoId: p.productoId,
      disponible: Math.max(0, p.disponible),
    }));
    res.json({ fecha: hoy, productos });
  } catch (err) {
    console.error('[GET /inventario/disponible]', err.message);
    res.status(500).json({ error: 'Error al calcular el disponible.' });
  }
});

/* ---- 404 y errores ---- */
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada.' });
});

app.use((err, req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[server] Escuchando en el puerto ${PORT}`);
  });
}

module.exports = { app, server, wss, resetRateLimits, issueSessionToken, verifySessionToken };

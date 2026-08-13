/**
 * PANADERÍA LUZ MARINA — Backend: Servidor
 * Express + better-sqlite3 + WebSocket.
 */

const cors = require('cors');
const helmet = require('helmet');
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { convertirAGramos, costoPorGramo, FACTOR_A_ML, UNIDADES_DE_VOLUMEN } = require('./units');
const AnalyticsEngine = require('./analyticsEngine');
const Auditoria = require('./auditoria');
const CalidadDatos = require('./calidadDatos');
const AutoML = require('./autoML');
const Lotes = require('./lotes');
const Mermas = require('./mermas');

/* Zona horaria de referencia del negocio (Houston). El backend calcula
   "hoy" con esto cuando no viene fecha explícita en la petición (ej.
   GET /horneadas sin ?fecha=) — nunca con
   new Date().toISOString().slice(0, 10), que da la fecha en UTC y se
   adelanta un día por las noches (Houston va 5-6h detrás de UTC). */
const HOUSTON_TZ = 'America/Chicago';

function hoyHouston() {
  return new Date().toLocaleDateString('en-CA', { timeZone: HOUSTON_TZ });
}

/* SQLite guarda datetime('now') como "AAAA-MM-DD HH:MM:SS" en UTC, pero SIN
   la 'Z' ni ningún indicador de zona horaria. Si eso se manda tal cual al
   navegador y se le pasa a `new Date(...)`, el navegador lo interpreta como
   hora LOCAL del usuario, no UTC — el mismo tipo de bug de zona horaria que
   ya se corrigió antes para "hoy" (ver hoyHouston arriba), pero acá con
   hora y minutos en vez de solo la fecha. Se convierte a ISO 8601 real
   (con 'T' y 'Z') antes de exponerlo, para que `new Date()` del lado del
   cliente lo lea bien sin importar en qué zona horaria esté el navegador. */
function sqliteDatetimeAIso(valor) {
  if (!valor) return null;
  return `${valor.replace(' ', 'T')}Z`;
}

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
  obtenerProducto,
  validarProducto,
  validarAjusteInventario,
  AJUSTE_ID_RE,
  validarStockMinimo,
  validarReceta,
  RECETA_ID_RE,
  validarProduccion,
  PRODUCCION_ID_RE,
  validarInicioEtapa,
  validarFinEtapa,
  ETAPA_ID_RE,
  validarOrdenCompra,
  validarCambioEstadoOrdenCompra,
  validarRecepcionOrdenCompra,
  ORDEN_COMPRA_ID_RE,
  OC_ESTADOS,
  OC_ESTADOS_RECEPCION,
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

// 3. Cabeceras de seguridad estándar, vía helmet (se actualiza solo con
//    `npm update` en vez de tener que mantener cada cabecera a mano).
//    La Content-Security-Policy se desactiva aquí porque depende de
//    FRONTEND_ORIGINS y del host de cada petición (para el wss:// del
//    WebSocket) — eso se define abajo, a medida.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  }),
);

// 3b. Cabeceras que helmet no cubre: CSP a medida (depende del host de cada
//     petición) y Permissions-Policy.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; connect-src 'self' ${FRONTEND_ORIGINS.join(' ')} wss://${req.headers.host}; frame-ancestors 'none'; base-uri 'none'`,
  );
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
// verifyClient corre ANTES de aceptar la conexión (durante el handshake),
// no después — así una conexión sin token válido nunca llega a entrar a
// wss.clients ni a recibir los broadcast() con pedidos/producción en vivo.
// Reutiliza el mismo verifySessionToken que ya protege las rutas REST, en
// vez de inventar un segundo mecanismo de auth aparte.
const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }, callback) => {
    if (!ADMIN_TOKEN) {
      return callback(false, 503, 'Panel admin no configurado.');
    }
    let token = '';
    try {
      token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    } catch {
      // req.url malformado — token se queda vacío y verifySessionToken lo rechaza abajo.
    }
    if (!verifySessionToken(token)) {
      return callback(false, 401, 'No autorizado.');
    }
    callback(true);
  },
});

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
      listarRecetas: 'GET /recetas (Authorization: Bearer token)',
      crearReceta: 'POST /recetas (Authorization: Bearer token)',
      actualizarReceta: 'PUT /recetas/:id (Authorization: Bearer token)',
      eliminarReceta: 'DELETE /recetas/:id (Authorization: Bearer token)',
      listarProducciones: 'GET /producciones?fecha=YYYY-MM-DD (Authorization: Bearer token)',
      crearProduccion: 'POST /producciones (Authorization: Bearer token)',
      eliminarProduccion: 'DELETE /producciones/:id (Authorization: Bearer token)',
      iniciarEtapa: 'POST /producciones/:id/etapas (Authorization: Bearer token)',
      finalizarEtapa: 'PUT /producciones/:id/etapas/:etapaId (Authorization: Bearer token)',
      listarOrdenesCompra:
        'GET /ordenes-compra?estado=&proveedorId=&desde=&hasta= (Authorization: Bearer token)',
      verOrdenCompra: 'GET /ordenes-compra/:id (Authorization: Bearer token)',
      crearOrdenCompra: 'POST /ordenes-compra (Authorization: Bearer token)',
      actualizarOrdenCompra: 'PUT /ordenes-compra/:id (solo en borrador)',
      cambiarEstadoOrdenCompra: 'PATCH /ordenes-compra/:id/estado (Authorization: Bearer token)',
      recibirOrdenCompra: 'POST /ordenes-compra/:id/recepciones (Authorization: Bearer token)',
      trazabilidadOrdenCompra: 'GET /ordenes-compra/:id/trazabilidad (Authorization: Bearer token)',
      eliminarOrdenCompra: 'DELETE /ordenes-compra/:id (solo en borrador y sin recepciones)',
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
      creadoEn: sqliteDatetimeAIso(r.creado_en),
      actualizadoEn: sqliteDatetimeAIso(r.actualizado_en),
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
    const info = db
      .prepare("UPDATE ordenes SET estado = ?, actualizado_en = datetime('now') WHERE numero = ?")
      .run(estado, numero);
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
  const insumo = {
    id: row.id,
    nombre: row.nombre,
    categoria: row.categoria,
    cantidad: row.cantidad,
    unidad: row.unidad,
    costoUnitario: row.costo_unitario,
    stockMinimo: row.stock_minimo,
    stockMaximo: row.stock_maximo,
    proveedor: row.proveedor,
    proveedorSecundario: row.proveedor_secundario,
    marca: row.marca,
    sku: row.sku,
    fechaVencimiento: row.fecha_vencimiento,
    ubicacion: row.ubicacion,
    presentacionCompra: row.presentacion_compra,
    condicionesAlmacenamiento: row.condiciones_almacenamiento,
    loteProveedor: row.lote_proveedor,
    vidaUtilAbiertoDias: row.vida_util_abierto_dias,
    leadTimeDias: row.lead_time_dias,
    impuestoPorcentaje: row.impuesto_porcentaje,
    alergenos: row.alergenos ? JSON.parse(row.alergenos) : [],
    equivalenciaGramos: row.equivalencia_gramos,
    notas: row.notas,
    creadoEn: row.creado_en,
    actualizadoEn: row.actualizado_en,
  };
  // Gramaje total en existencia, cuando se puede calcular (unidades de peso
  // siempre; unidades de conteo solo si se cargó equivalenciaGramos). Es
  // informativo por ahora — todavía no descuenta nada automáticamente.
  insumo.cantidadEnGramos = convertirAGramos({
    unidad: row.unidad,
    cantidad: row.cantidad,
    equivalenciaGramos: row.equivalencia_gramos,
  });
  // Costo por gramo — información lista para cuando se conecte el costeo
  // real de una receta; no se usa todavía en ningún cálculo.
  insumo.costoPorGramo = costoPorGramo({
    unidad: row.unidad,
    costoUnitario: row.costo_unitario,
    equivalenciaGramos: row.equivalencia_gramos,
  });
  return insumo;
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
      `INSERT INTO insumos (
         id, nombre, categoria, cantidad, unidad, costo_unitario, stock_minimo, stock_maximo,
         proveedor, proveedor_secundario, marca, sku, fecha_vencimiento, ubicacion,
         presentacion_compra, condiciones_almacenamiento, lote_proveedor,
         vida_util_abierto_dias, lead_time_dias, impuesto_porcentaje, alergenos,
         equivalencia_gramos, notas
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      datos.nombre,
      datos.categoria,
      datos.cantidad,
      datos.unidad,
      datos.costoUnitario,
      datos.stockMinimo,
      datos.stockMaximo,
      datos.proveedor,
      datos.proveedorSecundario,
      datos.marca,
      datos.sku,
      datos.fechaVencimiento,
      datos.ubicacion,
      datos.presentacionCompra,
      datos.condicionesAlmacenamiento,
      datos.loteProveedor,
      datos.vidaUtilAbiertoDias,
      datos.leadTimeDias,
      datos.impuestoPorcentaje,
      datos.alergenos,
      datos.equivalenciaGramos,
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
             stock_minimo = ?, stock_maximo = ?, proveedor = ?, proveedor_secundario = ?,
             marca = ?, sku = ?, fecha_vencimiento = ?, ubicacion = ?,
             presentacion_compra = ?, condiciones_almacenamiento = ?, lote_proveedor = ?,
             vida_util_abierto_dias = ?, lead_time_dias = ?, impuesto_porcentaje = ?,
             alergenos = ?, equivalencia_gramos = ?, notas = ?, actualizado_en = datetime('now')
         WHERE id = ?`,
      )
      .run(
        datos.nombre,
        datos.categoria,
        datos.cantidad,
        datos.unidad,
        datos.costoUnitario,
        datos.stockMinimo,
        datos.stockMaximo,
        datos.proveedor,
        datos.proveedorSecundario,
        datos.marca,
        datos.sku,
        datos.fechaVencimiento,
        datos.ubicacion,
        datos.presentacionCompra,
        datos.condicionesAlmacenamiento,
        datos.loteProveedor,
        datos.vidaUtilAbiertoDias,
        datos.leadTimeDias,
        datos.impuestoPorcentaje,
        datos.alergenos,
        datos.equivalenciaGramos,
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
    // insumo_id en receta_ingredientes/produccion_ingredientes tiene FK —
    // mismo caso que recetas más abajo, un insumo usado en alguna receta o
    // producción no se puede borrar sin dejar huérfano ese historial.
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({
        error:
          'No se puede eliminar: este insumo ya se usó en alguna receta o producción registrada. El historial se conserva a propósito.',
      });
    }
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
    produccionId: row.produccion_id,
    temperaturaHorneadoRealC: row.temperatura_horneado_real_c,
    tiempoHorneadoRealMin: row.tiempo_horneado_real_min,
    mermaRealPct: row.merma_real_pct,
    temperaturaPisoHornoC: row.temperatura_piso_horno_c,
    pesoPanCocidoTotalG: row.peso_pan_cocido_total_g,
    costoEstimadoEnergiaLote: row.costo_estimado_energia_lote,
    unidadesSegundaCalidad: row.unidades_segunda_calidad,
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

  if (datos.produccionId) {
    const produccion = db
      .prepare('SELECT producto_id, peso_total_masa_g FROM producciones WHERE id = ?')
      .get(datos.produccionId);
    if (!produccion) {
      return res.status(400).json({ error: 'La producción indicada no existe.' });
    }
    if (produccion.producto_id !== datos.productoId) {
      return res
        .status(400)
        .json({ error: 'Esta horneada no coincide con el producto de la producción indicada.' });
    }
    // Una tanda de masa se hornea una sola vez — si ya hay otra horneada
    // vinculada a esta misma producción, contarla de nuevo duplicaría el
    // "horneado" en el cálculo de inventario disponible.
    const yaVinculada = db
      .prepare('SELECT id FROM horneadas WHERE produccion_id = ?')
      .get(datos.produccionId);
    if (yaVinculada) {
      return res.status(400).json({
        error:
          'Esta producción ya tiene una horneada registrada. Cada tanda se hornea una sola vez.',
      });
    }
    // Cruce entre tablas (SQLite no lo puede validar solo con un CHECK,
    // que no ve más allá de su propia fila): el pan ya horneado pesa
    // menos que la masa cruda de la que salió (pierde agua al hornear),
    // nunca más.
    if (
      datos.pesoPanCocidoTotalG !== null &&
      produccion.peso_total_masa_g !== null &&
      datos.pesoPanCocidoTotalG >= produccion.peso_total_masa_g
    ) {
      return res.status(400).json({
        error: 'El peso del pan cocido debe ser menor al peso de la masa cruda de la producción.',
      });
    }
  }

  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO horneadas (
         id, producto_id, producto_nombre, cantidad, fecha, hora, registrado_por, notas,
         produccion_id, temperatura_horneado_real_c, tiempo_horneado_real_min, merma_real_pct,
         temperatura_piso_horno_c, peso_pan_cocido_total_g, costo_estimado_energia_lote,
         unidades_segunda_calidad
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      datos.productoId,
      datos.productoNombre,
      datos.cantidad,
      datos.fecha,
      datos.hora,
      datos.registradoPor,
      datos.notas,
      datos.produccionId,
      datos.temperaturaHorneadoRealC,
      datos.tiempoHorneadoRealMin,
      datos.mermaRealPct,
      datos.temperaturaPisoHornoC,
      datos.pesoPanCocidoTotalG,
      datos.costoEstimadoEnergiaLote,
      datos.unidadesSegundaCalidad,
    );
    const fila = db.prepare('SELECT * FROM horneadas WHERE id = ?').get(id);
    Auditoria.registrarEnCadena({
      entidad: 'horneadas',
      entidadId: fila.id,
      accion: 'crear',
      datos: {
        productoId: fila.producto_id,
        productoNombre: fila.producto_nombre,
        cantidad: fila.cantidad,
        fecha: fila.fecha,
        hora: fila.hora,
      },
      actualizadoPor: fila.registrado_por,
    });
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
  const existente = db.prepare('SELECT * FROM horneadas WHERE id = ?').get(id);

  let datos;
  try {
    datos = validarHorneada(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  if (datos.produccionId) {
    const produccion = db
      .prepare('SELECT producto_id, peso_total_masa_g FROM producciones WHERE id = ?')
      .get(datos.produccionId);
    if (!produccion) {
      return res.status(400).json({ error: 'La producción indicada no existe.' });
    }
    if (produccion.producto_id !== datos.productoId) {
      return res
        .status(400)
        .json({ error: 'Esta horneada no coincide con el producto de la producción indicada.' });
    }
    // Igual que en el POST, pero excluyendo esta misma horneada: si ya
    // estaba vinculada a esta producción antes de editar, no es un
    // duplicado nuevo.
    const yaVinculada = db
      .prepare('SELECT id FROM horneadas WHERE produccion_id = ? AND id != ?')
      .get(datos.produccionId, id);
    if (yaVinculada) {
      return res.status(400).json({
        error:
          'Esta producción ya tiene otra horneada registrada. Cada tanda se hornea una sola vez.',
      });
    }
    // Cruce entre tablas (SQLite no lo puede validar solo con un CHECK,
    // que no ve más allá de su propia fila): el pan ya horneado pesa
    // menos que la masa cruda de la que salió (pierde agua al hornear),
    // nunca más.
    if (
      datos.pesoPanCocidoTotalG !== null &&
      produccion.peso_total_masa_g !== null &&
      datos.pesoPanCocidoTotalG >= produccion.peso_total_masa_g
    ) {
      return res.status(400).json({
        error: 'El peso del pan cocido debe ser menor al peso de la masa cruda de la producción.',
      });
    }
  }

  try {
    const info = db
      .prepare(
        `UPDATE horneadas
         SET producto_id = ?, producto_nombre = ?, cantidad = ?, fecha = ?, hora = ?,
             registrado_por = ?, notas = ?, produccion_id = ?,
             temperatura_horneado_real_c = ?, tiempo_horneado_real_min = ?, merma_real_pct = ?,
             temperatura_piso_horno_c = ?, peso_pan_cocido_total_g = ?,
             costo_estimado_energia_lote = ?, unidades_segunda_calidad = ?,
             actualizado_en = datetime('now')
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
        datos.produccionId,
        datos.temperaturaHorneadoRealC,
        datos.tiempoHorneadoRealMin,
        datos.mermaRealPct,
        datos.temperaturaPisoHornoC,
        datos.pesoPanCocidoTotalG,
        datos.costoEstimadoEnergiaLote,
        datos.unidadesSegundaCalidad,
        id,
      );
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Horneada no encontrada.' });
    }
    const fila = db.prepare('SELECT * FROM horneadas WHERE id = ?').get(id);
    Auditoria.registrarEnCadena({
      entidad: 'horneadas',
      entidadId: fila.id,
      accion: 'actualizar',
      datos: {
        antes: { cantidad: existente.cantidad, fecha: existente.fecha, hora: existente.hora },
        despues: { cantidad: fila.cantidad, fecha: fila.fecha, hora: fila.hora },
      },
      actualizadoPor: fila.registrado_por,
    });
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
    const existente = db.prepare('SELECT * FROM horneadas WHERE id = ?').get(id);
    const info = db.prepare('DELETE FROM horneadas WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Horneada no encontrada.' });
    }
    Auditoria.registrarEnCadena({
      entidad: 'horneadas',
      entidadId: id,
      accion: 'eliminar',
      datos: {
        productoNombre: existente.producto_nombre,
        cantidad: existente.cantidad,
        fecha: existente.fecha,
        hora: existente.hora,
      },
      actualizadoPor: existente.registrado_por,
    });
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
    Auditoria.registrarEnCadena({
      entidad: 'ajustes_inventario',
      entidadId: fila.id,
      accion: 'crear',
      datos: {
        productoNombre: fila.producto_nombre,
        cantidad: fila.cantidad,
        motivo: fila.motivo,
        fecha: fila.fecha,
        hora: fila.hora,
      },
      actualizadoPor: fila.registrado_por,
    });
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
  const existente = db.prepare('SELECT * FROM ajustes_inventario WHERE id = ?').get(id);

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
    Auditoria.registrarEnCadena({
      entidad: 'ajustes_inventario',
      entidadId: fila.id,
      accion: 'actualizar',
      datos: {
        antes: { cantidad: existente.cantidad, motivo: existente.motivo },
        despues: { cantidad: fila.cantidad, motivo: fila.motivo },
      },
      actualizadoPor: fila.registrado_por,
    });
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
    const existente = db.prepare('SELECT * FROM ajustes_inventario WHERE id = ?').get(id);
    const info = db.prepare('DELETE FROM ajustes_inventario WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Ajuste no encontrado.' });
    }
    Auditoria.registrarEnCadena({
      entidad: 'ajustes_inventario',
      entidadId: id,
      accion: 'eliminar',
      datos: {
        productoNombre: existente.producto_nombre,
        cantidad: existente.cantidad,
        motivo: existente.motivo,
      },
      actualizadoPor: existente.registrado_por,
    });
    broadcast({ tipo: 'ajuste:eliminado', id });
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /ajustes-inventario/:id]', err.message);
    res.status(500).json({ error: 'Error al eliminar el ajuste de inventario.' });
  }
});

/* ═══════════════════════════════════════════
   PRODUCTOS — antes vivían fijos en código (PRODUCTOS_CATALOGO en
   validation.js); ahora es una tabla real (ver db.js) con precio de
   verdad, para que validarItem pueda cruzarlo contra lo que manda
   cada pedido. Sin DELETE a propósito: un producto sale de circulación
   cambiando su estado a 'descontinuado', nunca borrándolo — ya tiene
   historial en recetas, producciones, horneadas, ajustes y pedidos, y
   borrarlo dejaría todo eso huérfano.
   ═══════════════════════════════════════════ */
function serializeProducto(row) {
  return {
    id: row.id,
    nombre: row.nombre,
    categoria: row.categoria,
    precio: row.precio,
    estado: row.estado,
    sku: row.sku,
    descripcion: row.descripcion,
    imagenBase: row.imagen_base,
    altImagen: row.alt_imagen,
    vidaUtilHoras: row.vida_util_horas,
    actualizadoPor: row.actualizado_por,
    creadoEn: sqliteDatetimeAIso(row.creado_en),
    actualizadoEn: sqliteDatetimeAIso(row.actualizado_en),
  };
}

/** Serializa un producto Y lo enriquece con sus estadísticas (Patrón 1,
 *  "Flujo Operativo Automático" — ver analyticsEngine.js). `forzar` pisa
 *  el caché de 30 min: úsalo en creación/edición explícita de ESE
 *  producto (POST/PUT), no en listados de alta frecuencia como
 *  GET /productos, donde el caché evita recorrer 90 días de historial
 *  por producto en cada carga del panel. */
function serializeProductoConEstadisticas(row, { forzar = false } = {}) {
  const { produccionSugeridaManana, ...estadisticas } =
    AnalyticsEngine.enriquecerProductoConEstadisticas(row, { forzar });
  return {
    ...serializeProducto(row),
    estadisticas: { ...estadisticas, produccionSugeridaManana },
  };
}

/** Fila completa de un producto (todas las columnas, incluidas las de
 *  caché de estadísticas) — a diferencia de obtenerProducto (validation.js),
 *  que solo trae las columnas que necesita la validación de pedidos. */
function obtenerProductoCompleto(id) {
  return db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
}

/** Un producto solo se puede pedir/hornear/producir cuando está activo;
 *  los demás estados existen para sacarlo de circulación sin borrarlo. */
function productosActivos() {
  return db
    .prepare("SELECT * FROM productos WHERE estado = 'activo' ORDER BY nombre COLLATE NOCASE ASC")
    .all();
}

app.get('/productos', requireAuth, (req, res) => {
  try {
    const filas = db.prepare('SELECT * FROM productos ORDER BY nombre COLLATE NOCASE ASC').all();
    res.json(filas.map((fila) => serializeProductoConEstadisticas(fila)));
  } catch (err) {
    console.error('[GET /productos]', err.message);
    res.status(500).json({ error: 'Error al obtener los productos.' });
  }
});

app.post('/productos', requireAuth, rateLimit, (req, res) => {
  let datos;
  try {
    datos = validarProducto(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }
  try {
    const info = db
      .prepare(
        `INSERT INTO productos
           (nombre, categoria, precio, estado, sku, descripcion, imagen_base, alt_imagen, vida_util_horas, actualizado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        datos.nombre,
        datos.categoria,
        datos.precio,
        datos.estado ?? 'activo',
        datos.sku ?? null,
        datos.descripcion ?? null,
        datos.imagenBase ?? null,
        datos.altImagen ?? null,
        datos.vidaUtilHoras ?? null,
        datos.actualizadoPor ?? null,
      );
    const fila = db.prepare('SELECT * FROM productos WHERE id = ?').get(info.lastInsertRowid);
    Auditoria.registrarEnCadena({
      entidad: 'productos',
      entidadId: fila.id,
      accion: 'crear',
      datos: {
        nombre: fila.nombre,
        categoria: fila.categoria,
        precio: fila.precio,
        estado: fila.estado,
      },
      actualizadoPor: fila.actualizado_por,
    });
    const productoSerializado = serializeProductoConEstadisticas(fila, { forzar: true });
    broadcast({ tipo: 'producto:nuevo', producto: productoSerializado });
    res.status(201).json(productoSerializado);
  } catch (err) {
    if (esConflictoDeSku(err)) {
      return res.status(409).json({ error: 'Ese SKU ya lo usa otro producto.' });
    }
    console.error('[POST /productos]', err.message);
    res.status(500).json({ error: 'Error al crear el producto.' });
  }
});

app.put('/productos/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const idNum = Number(id);
  if (!Number.isInteger(idNum) || idNum <= 0) {
    return res.status(400).json({ error: 'Identificador de producto inválido.' });
  }
  const existente = obtenerProducto(idNum);
  if (!existente) {
    return res.status(404).json({ error: 'Producto no encontrado.' });
  }

  let datos;
  try {
    datos = validarProducto(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  try {
    // estado/sku/descripcion/imagenBase/altImagen/vidaUtilHoras/actualizadoPor
    // son opcionales en validarProducto (ver validation.js) — si no vienen en
    // la petición, se conserva lo que el producto ya tenía.
    const estado = datos.estado !== undefined ? datos.estado : existente.estado;
    const sku = datos.sku !== undefined ? datos.sku : existente.sku;
    const descripcion = datos.descripcion !== undefined ? datos.descripcion : existente.descripcion;
    const imagenBase = datos.imagenBase !== undefined ? datos.imagenBase : existente.imagen_base;
    const altImagen = datos.altImagen !== undefined ? datos.altImagen : existente.alt_imagen;
    const vidaUtilHoras =
      datos.vidaUtilHoras !== undefined ? datos.vidaUtilHoras : existente.vida_util_horas;
    const actualizadoPor =
      datos.actualizadoPor !== undefined ? datos.actualizadoPor : existente.actualizado_por;
    db.prepare(
      `UPDATE productos
       SET nombre = ?, categoria = ?, precio = ?, estado = ?, sku = ?, descripcion = ?,
           imagen_base = ?, alt_imagen = ?, vida_util_horas = ?, actualizado_por = ?,
           actualizado_en = datetime('now')
       WHERE id = ?`,
    ).run(
      datos.nombre,
      datos.categoria,
      datos.precio,
      estado,
      sku,
      descripcion,
      imagenBase,
      altImagen,
      vidaUtilHoras,
      actualizadoPor,
      idNum,
    );
    const fila = db.prepare('SELECT * FROM productos WHERE id = ?').get(idNum);
    Auditoria.registrarEnCadena({
      entidad: 'productos',
      entidadId: fila.id,
      accion: 'actualizar',
      datos: {
        antes: {
          nombre: existente.nombre,
          categoria: existente.categoria,
          precio: existente.precio,
          estado: existente.estado,
        },
        despues: {
          nombre: fila.nombre,
          categoria: fila.categoria,
          precio: fila.precio,
          estado: fila.estado,
        },
      },
      actualizadoPor,
    });
    const productoSerializado = serializeProductoConEstadisticas(fila, { forzar: true });
    broadcast({ tipo: 'producto:actualizado', producto: productoSerializado });
    res.json(productoSerializado);
  } catch (err) {
    if (esConflictoDeSku(err)) {
      return res.status(409).json({ error: 'Ese SKU ya lo usa otro producto.' });
    }
    console.error('[PUT /productos/:id]', err.message);
    res.status(500).json({ error: 'Error al actualizar el producto.' });
  }
});

/** El único UNIQUE de la tabla productos es sku, así que un choque de
 *  unicidad solo puede venir de ahí. Los demás errores de constraint
 *  (los CHECK de precio/estado) no son un conflicto de SKU y deben
 *  seguir su camino normal — validarProducto ya los ataja antes. */
function esConflictoDeSku(err) {
  return err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/* Catálogo público (sin token): el catálogo del cliente ya no puede
   depender de los precios escritos a mano en catalogo.html, porque
   validarItem ahora rechaza cualquier pedido cuyo precio no coincida
   con el de la tabla productos. Si el HTML quedara desactualizado tras
   un cambio de precio en el panel, los pedidos se perderían en
   silencio (checkout.js manda la orden sin bloquear el flujo de
   WhatsApp). Con este endpoint el precio se sincroniza en el navegador
   antes de armar el carrito.

   Las tarjetas de catalogo.html ahora se arman en JS a partir de esta
   respuesta (ver JS/pages/catalogo.js), así que además del precio se
   expone descripcion e imagenBase/altImagen — lo mínimo para dibujar
   una tarjeta. Sigue sin exponer sku, estado ni metadatos internos. */
app.get('/catalogo', (req, res) => {
  try {
    res.json({
      productos: productosActivos().map((fila) => ({
        id: fila.id,
        nombre: fila.nombre,
        categoria: fila.categoria,
        precio: fila.precio,
        descripcion: fila.descripcion,
        imagenBase: fila.imagen_base,
        altImagen: fila.alt_imagen,
      })),
    });
  } catch (err) {
    console.error('[GET /catalogo]', err.message);
    res.status(500).json({ error: 'Error al obtener el catálogo.' });
  }
});

/* ═══════════════════════════════════════════
   STOCK MÍNIMO POR PRODUCTO — usado por las alertas de Inventario
   ═══════════════════════════════════════════ */
app.put('/productos/:id/stock-minimo', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!obtenerProducto(Number(id))) {
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
   órdenes creadas antes de ese cambio. Un producto inactivo (o que no
   exista) no se cuenta.
   ═══════════════════════════════════════════ */
const STOCK_MINIMO_DEFAULT = 5;

/** Calcula el disponible por producto para una fecha. Compartida por el
 * endpoint admin (GET /inventario, detalle completo) y el público
 * (GET /inventario/disponible, solo el número que ve el cliente) para no
 * duplicar la lógica de cruce entre ambos. */
function calcularInventario(fechaConsulta) {
  // Arranca con todos los productos ACTIVOS en cero, para que se vean
  // incluso los que no tuvieron ningún movimiento ese día. También se
  // indexa por id, para cruzar por productoId cuando esté disponible.
  // Los productos desactivados no aparecen acá — ya no se venden/
  // producen, no tiene sentido mostrarlos en el inventario del día.
  const porProducto = new Map();
  const porProductoId = new Map();
  for (const { id, nombre } of productosActivos()) {
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
  const fechaConsulta = fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : hoyHouston();

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
  const hoy = hoyHouston();
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

/* ═══════════════════════════════════════════
   ESTADÍSTICAS DE DEMANDA — forecasting para saber cuánto hornear.
   Toda la orquestación (recorrer ordenes/horneadas/ajustes_inventario,
   cachear sobre la fila del producto) vive en analyticsEngine.js
   (Patrón 1, "Flujo Operativo Automático"); acá solo se llama.
   ═══════════════════════════════════════════ */

app.get('/productos/:id/estadisticas', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Id de producto inválido.' });
  }

  const producto = obtenerProductoCompleto(id);
  if (!producto) {
    return res.status(404).json({ error: 'Producto no encontrado.' });
  }

  try {
    res.json({
      productoId: producto.id,
      productoNombre: producto.nombre,
      ...AnalyticsEngine.enriquecerProductoConEstadisticas(producto, { forzar: true }),
    });
  } catch (err) {
    console.error('[GET /productos/:id/estadisticas]', err.message);
    res.status(500).json({ error: 'Error al calcular las estadísticas.' });
  }
});

/* Versión en lote: el panel necesita esto para todos los productos
 * activos a la vez (por ejemplo, para sugerir cuánto hornear de cada
 * uno mañana) — pedirlo uno por uno sería un GET por producto. No fuerza
 * el recálculo: usa el mismo caché que ya se refrescó en GET /productos
 * al entrar al panel (ver Productos view), así esta consulta no vuelve a
 * recorrer 90 días de historial por producto. */
app.get('/productos/estadisticas', requireAuth, (req, res) => {
  try {
    const resultado = productosActivos().map((producto) => ({
      productoId: producto.id,
      productoNombre: producto.nombre,
      ...AnalyticsEngine.enriquecerProductoConEstadisticas(producto),
    }));
    res.json({ productos: resultado });
  } catch (err) {
    console.error('[GET /productos/estadisticas]', err.message);
    res.status(500).json({ error: 'Error al calcular las estadísticas.' });
  }
});

/* ═══════════════════════════════════════════
   AUDITORÍA — cadena de hashes (hash-chain) sobre horneadas, ajustes de
   inventario y productos. Ver auditoria.js para el detalle de cómo se
   arma y se verifica; acá solo se exponen los dos endpoints de lectura.
   No hay POST/PUT/DELETE: la cadena solo crece desde adentro de los
   endpoints de cada módulo (Auditoria.registrarEnCadena), nunca desde
   afuera — si se pudiera escribir directo, dejaría de ser confiable.
   ═══════════════════════════════════════════ */

/** Historial completo o filtrado por entidad/entidadId — para mostrar
 *  "qué cambió y cuándo" en el panel (ej. el historial de un producto
 *  puntual). Sin filtro, trae toda la cadena (más reciente primero). */
app.get('/auditoria', requireAuth, (req, res) => {
  try {
    const { entidad, entidadId } = req.query;
    let filas;
    if (entidad && entidadId) {
      filas = Auditoria.historialDe(String(entidad), String(entidadId));
    } else {
      filas = db.prepare('SELECT * FROM auditoria_cadena ORDER BY id DESC LIMIT 200').all();
    }
    res.json({
      bloques: filas.map((f) => ({
        id: f.id,
        entidad: f.entidad,
        entidadId: f.entidad_id,
        accion: f.accion,
        datos: JSON.parse(f.datos),
        actualizadoPor: f.actualizado_por,
        hash: f.hash,
        hashAnterior: f.hash_anterior,
        creadoEn: f.creado_en,
      })),
    });
  } catch (err) {
    console.error('[GET /auditoria]', err.message);
    res.status(500).json({ error: 'Error al obtener la auditoría.' });
  }
});

/** Recorre toda la cadena y confirma que cada bloque enlaza con el
 *  anterior y que su contenido no fue alterado. Es intencionalmente una
 *  operación pesada (recorre TODA la tabla) — por eso es GET bajo
 *  auth, no algo que se llame en cada carga de página. */
app.get('/auditoria/verificar', requireAuth, (req, res) => {
  try {
    res.json(Auditoria.verificarCadena());
  } catch (err) {
    console.error('[GET /auditoria/verificar]', err.message);
    res.status(500).json({ error: 'Error al verificar la cadena de auditoría.' });
  }
});

/** Inspecciona/agrupa/modela la cadena para la vista Auditoría del panel
 *  (gráficos de barras por entidad y por acción, línea de tiempo,
 *  registros con más cambios). Ver Auditoria.analizarCadena. */
app.get('/auditoria/analisis', requireAuth, (req, res) => {
  try {
    res.json(Auditoria.analizarCadena());
  } catch (err) {
    console.error('[GET /auditoria/analisis]', err.message);
    res.status(500).json({ error: 'Error al analizar la cadena de auditoría.' });
  }
});

/* ═══════════════════════════════════════════
   CALIDAD DE DATOS (ADM — Gestión de Datos Aumentada). Ver calidadDatos.js
   para las reglas; acá solo se expone el reporte. Es intencionalmente
   de solo lectura: esto avisa qué falta, no lo corrige solo — corregir
   un precio o una fecha de vencimiento sigue siendo una decisión humana.
   ═══════════════════════════════════════════ */
app.get('/calidad-datos', requireAuth, (req, res) => {
  try {
    res.json(CalidadDatos.evaluarCalidadGeneral());
  } catch (err) {
    console.error('[GET /calidad-datos]', err.message);
    res.status(500).json({ error: 'Error al evaluar la calidad de los datos.' });
  }
});

/* ═══════════════════════════════════════════
   LOTES — cada horneada vista como un lote rastreable, con su análisis
   exploratorio, sus tendencias y su validación. Todo el trabajo de datos
   vive en lotes.js (extracción/armado) y lotesAnalitica.js (aritmética);
   acá solo se validan los parámetros y se responde. Es de solo lectura: un
   lote se crea registrando una horneada, no por este módulo — si se
   pudiera crear por los dos lados, habría dos versiones de la verdad.
   ═══════════════════════════════════════════ */

/** Rango y producto son los tres únicos parámetros de todos los endpoints
 *  de Lotes. Devuelve null cuando algo no cuadra (el caller responde 400):
 *  una fecha mal formada se ignora silenciosamente en el resto del panel,
 *  pero acá cambiaría el período analizado sin que se note. */
function leerFiltrosLotes(query) {
  const { desde, hasta, productoId } = query;
  for (const fecha of [desde, hasta]) {
    if (fecha !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  }
  if (productoId !== undefined && !/^\d+$/.test(String(productoId))) return null;
  return { desde, hasta, productoId };
}

app.get('/lotes', requireAuth, (req, res) => {
  const filtros = leerFiltrosLotes(req.query);
  if (!filtros) {
    return res.status(400).json({ error: 'Filtros inválidos: revisa las fechas y el producto.' });
  }
  try {
    res.json(Lotes.obtenerLotes(filtros));
  } catch (err) {
    console.error('[GET /lotes]', err.message);
    res.status(500).json({ error: 'Error al consultar los lotes.' });
  }
});

/* Va ANTES de /lotes/:id: si estuviera después, Express tomaría
   "analisis" como un id de lote y siempre respondería 404. */
app.get('/lotes/analisis', requireAuth, (req, res) => {
  const filtros = leerFiltrosLotes(req.query);
  if (!filtros) {
    return res.status(400).json({ error: 'Filtros inválidos: revisa las fechas y el producto.' });
  }
  try {
    res.json(Lotes.analizarLotes(filtros));
  } catch (err) {
    console.error('[GET /lotes/analisis]', err.message);
    res.status(500).json({ error: 'Error al analizar los lotes.' });
  }
});

/** Un lote con su trazabilidad completa: la tanda de masa que lo originó,
 *  los insumos que se usaron y el lote del proveedor de cada uno. */
app.get('/lotes/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!HORNEADA_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de lote inválido.' });
  }
  try {
    const lote = Lotes.obtenerLote(id);
    if (!lote) return res.status(404).json({ error: 'Lote no encontrado.' });
    res.json(lote);
  } catch (err) {
    console.error('[GET /lotes/:id]', err.message);
    res.status(500).json({ error: 'Error al consultar el lote.' });
  }
});

/* ═══════════════════════════════════════════
   MERMAS — pipeline de datos (recopilación → almacenamiento →
   procesamiento → limpieza) sobre las tres señales de merma que ya
   existen (cocción, ajuste manual, segunda calidad). Todo el trabajo
   vive en mermas.js / mermasAnalitica.js; acá solo se validan los
   parámetros y se responde. Reutiliza el mismo validador de filtros
   que Lotes (mismo rango/producto, misma forma de fallar). El análisis
   (fase 5 del pipeline: EDA, inferencial, clasificación) todavía no
   tiene endpoint — este es el dataset limpio que esa fase va a consumir.
   ═══════════════════════════════════════════ */
app.get('/mermas', requireAuth, (req, res) => {
  const filtros = leerFiltrosLotes(req.query);
  if (!filtros) {
    return res.status(400).json({ error: 'Filtros inválidos: revisa las fechas y el producto.' });
  }
  try {
    res.json(Mermas.ejecutarPipelineMermas(filtros));
  } catch (err) {
    console.error('[GET /mermas]', err.message);
    res.status(500).json({ error: 'Error al procesar los datos de mermas.' });
  }
});

/* Fase 5 del pipeline (EDA, hipótesis, modelos) sobre el mismo dataset
   limpio de arriba — endpoint aparte porque analizarMermas() hace bastante
   más trabajo (regresiones, entrenar el clasificador) y una vista que solo
   necesita el dataset crudo no debería pagar ese costo en cada carga. */
app.get('/mermas/analisis', requireAuth, (req, res) => {
  const filtros = leerFiltrosLotes(req.query);
  if (!filtros) {
    return res.status(400).json({ error: 'Filtros inválidos: revisa las fechas y el producto.' });
  }
  try {
    res.json(Mermas.analizarMermas(filtros));
  } catch (err) {
    console.error('[GET /mermas/analisis]', err.message);
    res.status(500).json({ error: 'Error al analizar los datos de mermas.' });
  }
});

/* ═══════════════════════════════════════════
   AUTOML — pronóstico de demanda con selección automática de modelo.
   Ver autoML.js para el detalle de qué técnicas prueba y cómo elige.
   No se cachea (a diferencia de AnalyticsEngine): el backtest sobre la
   serie diaria de UN producto es aritmética simple, barata de repetir,
   y acá vale más que el resultado esté siempre fresco que ahorrarse el
   cálculo. ═══════════════════════════════════════════ */
app.get('/productos/:id/prediccion-automl', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Id de producto inválido.' });
  }

  const producto = obtenerProductoCompleto(id);
  if (!producto) {
    return res.status(404).json({ error: 'Producto no encontrado.' });
  }

  try {
    const serie = AnalyticsEngine.obtenerSerieVentasDiarias(producto);
    res.json({
      productoId: producto.id,
      productoNombre: producto.nombre,
      ...AutoML.seleccionarMejorModelo(serie),
    });
  } catch (err) {
    console.error('[GET /productos/:id/prediccion-automl]', err.message);
    res.status(500).json({ error: 'Error al calcular la predicción.' });
  }
});

/* Versión en lote: la tarjeta de AutoML en la vista Productos necesita
 * esto para todos los productos activos a la vez — pedirlo uno por uno
 * sería un GET por producto, igual que ya resolvimos para
 * GET /productos/estadisticas. */
app.get('/productos/prediccion-automl', requireAuth, (req, res) => {
  try {
    const resultado = productosActivos().map((producto) => ({
      productoId: producto.id,
      productoNombre: producto.nombre,
      ...AutoML.seleccionarMejorModelo(AnalyticsEngine.obtenerSerieVentasDiarias(producto)),
    }));
    res.json({ productos: resultado });
  } catch (err) {
    console.error('[GET /productos/prediccion-automl]', err.message);
    res.status(500).json({ error: 'Error al calcular las predicciones.' });
  }
});

function serializeReceta(row, ingredientes) {
  return {
    id: row.id,
    productoId: row.producto_id,
    productoNombre: row.producto_nombre,
    categoria: obtenerProducto(Number(row.producto_id))?.categoria ?? null,
    pesoMasaPorUnidadG: row.peso_masa_por_unidad_g,
    tiempoFermentacionMin: row.tiempo_fermentacion_min,
    tiempoHorneadoMin: row.tiempo_horneado_min,
    temperaturaHorneadoC: row.temperatura_horneado_c,
    tiempoManoObraMin: row.tiempo_mano_obra_min,
    mermaCoccionPct: row.merma_coccion_pct,
    hidratacionObjetivoPorcentaje: row.hidratacion_objetivo_porcentaje,
    pasos: row.pasos,
    notas: row.notas,
    ingredientes: ingredientes.map((i) => ({
      id: i.id,
      insumoId: i.insumo_id,
      insumoNombre: i.insumo_nombre,
      gramos: i.gramos,
      orden: i.orden,
    })),
    creadoEn: row.creado_en,
    actualizadoEn: row.actualizado_en,
  };
}

/** Valida que cada insumoId de una lista exista de verdad en el catálogo de
 *  Insumos, y devuelve un mapa id -> nombre para denormalizar. Lanza
 *  ValidationError (400) si alguno no existe — es la única forma de
 *  detectar esto, porque validation.js no toca la base de datos. */
function resolverInsumos(ingredientes) {
  const nombresPorId = new Map();
  for (const ing of ingredientes) {
    const insumo = db.prepare('SELECT id, nombre FROM insumos WHERE id = ?').get(ing.insumoId);
    if (!insumo) {
      throw new ValidationError(`El insumo "${ing.insumoId}" no existe en el catálogo de Insumos.`);
    }
    nombresPorId.set(ing.insumoId, insumo.nombre);
  }
  return nombresPorId;
}

app.get('/recetas', requireAuth, (req, res) => {
  try {
    const recetas = db.prepare('SELECT * FROM recetas ORDER BY producto_nombre').all();
    const resultado = recetas.map((r) => {
      const ingredientes = db
        .prepare('SELECT * FROM receta_ingredientes WHERE receta_id = ? ORDER BY orden')
        .all(r.id);
      return serializeReceta(r, ingredientes);
    });
    res.json(resultado);
  } catch (err) {
    console.error('[GET /recetas]', err.message);
    res.status(500).json({ error: 'Error al consultar recetas.' });
  }
});

app.post('/recetas', requireAuth, rateLimit, (req, res) => {
  let datos;
  try {
    datos = validarReceta(req.body);
    const nombresPorId = resolverInsumos(datos.ingredientes);
    datos.ingredientes = datos.ingredientes.map((ing) => ({
      ...ing,
      insumoNombre: nombresPorId.get(ing.insumoId),
    }));
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const existente = db
    .prepare('SELECT id FROM recetas WHERE producto_id = ?')
    .get(datos.productoId);
  if (existente) {
    return res.status(400).json({
      error: `Ya existe una receta para ${datos.productoNombre}. Edítala en vez de crear otra.`,
    });
  }

  const id = crypto.randomUUID();
  try {
    const crear = db.transaction(() => {
      db.prepare(
        `INSERT INTO recetas (
           id, producto_id, producto_nombre, peso_masa_por_unidad_g, tiempo_fermentacion_min,
           tiempo_horneado_min, temperatura_horneado_c, tiempo_mano_obra_min, merma_coccion_pct,
           hidratacion_objetivo_porcentaje, pasos, notas
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        datos.productoId,
        datos.productoNombre,
        datos.pesoMasaPorUnidadG,
        datos.tiempoFermentacionMin,
        datos.tiempoHorneadoMin,
        datos.temperaturaHorneadoC,
        datos.tiempoManoObraMin,
        datos.mermaCoccionPct,
        datos.hidratacionObjetivoPorcentaje,
        datos.pasos,
        datos.notas,
      );

      datos.ingredientes.forEach((ing, idx) => {
        db.prepare(
          `INSERT INTO receta_ingredientes (id, receta_id, insumo_id, insumo_nombre, gramos, orden)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(crypto.randomUUID(), id, ing.insumoId, ing.insumoNombre, ing.gramos, idx);
      });
    });
    crear();

    const fila = db.prepare('SELECT * FROM recetas WHERE id = ?').get(id);
    const ingredientes = db
      .prepare('SELECT * FROM receta_ingredientes WHERE receta_id = ? ORDER BY orden')
      .all(id);
    res.status(201).json(serializeReceta(fila, ingredientes));
  } catch (err) {
    console.error('[POST /recetas]', err.message);
    res.status(500).json({ error: 'Error al guardar la receta.' });
  }
});

app.put('/recetas/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!RECETA_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de receta inválido.' });
  }

  let datos;
  try {
    datos = validarReceta(req.body);
    const nombresPorId = resolverInsumos(datos.ingredientes);
    datos.ingredientes = datos.ingredientes.map((ing) => ({
      ...ing,
      insumoNombre: nombresPorId.get(ing.insumoId),
    }));
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  try {
    const actualizar = db.transaction(() => {
      const info = db
        .prepare(
          `UPDATE recetas
           SET producto_id = ?, producto_nombre = ?, peso_masa_por_unidad_g = ?,
               tiempo_fermentacion_min = ?, tiempo_horneado_min = ?, temperatura_horneado_c = ?,
               tiempo_mano_obra_min = ?, merma_coccion_pct = ?,
               hidratacion_objetivo_porcentaje = ?, pasos = ?, notas = ?,
               actualizado_en = datetime('now')
           WHERE id = ?`,
        )
        .run(
          datos.productoId,
          datos.productoNombre,
          datos.pesoMasaPorUnidadG,
          datos.tiempoFermentacionMin,
          datos.tiempoHorneadoMin,
          datos.temperaturaHorneadoC,
          datos.tiempoManoObraMin,
          datos.mermaCoccionPct,
          datos.hidratacionObjetivoPorcentaje,
          datos.pasos,
          datos.notas,
          id,
        );
      if (info.changes === 0) return false;

      db.prepare('DELETE FROM receta_ingredientes WHERE receta_id = ?').run(id);
      datos.ingredientes.forEach((ing, idx) => {
        db.prepare(
          `INSERT INTO receta_ingredientes (id, receta_id, insumo_id, insumo_nombre, gramos, orden)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(crypto.randomUUID(), id, ing.insumoId, ing.insumoNombre, ing.gramos, idx);
      });
      return true;
    });

    if (!actualizar()) {
      return res.status(404).json({ error: 'Receta no encontrada.' });
    }

    const fila = db.prepare('SELECT * FROM recetas WHERE id = ?').get(id);
    const ingredientes = db
      .prepare('SELECT * FROM receta_ingredientes WHERE receta_id = ? ORDER BY orden')
      .all(id);
    res.json(serializeReceta(fila, ingredientes));
  } catch (err) {
    console.error('[PUT /recetas/:id]', err.message);
    res.status(500).json({ error: 'Error al actualizar la receta.' });
  }
});

app.delete('/recetas/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!RECETA_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de receta inválido.' });
  }
  try {
    const info = db.prepare('DELETE FROM recetas WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Receta no encontrada.' });
    }
    res.status(204).end();
  } catch (err) {
    // producciones.receta_id tiene FOREIGN KEY (sin ON DELETE) — con
    // foreign_keys=ON, SQLite bloquea el DELETE si alguna producción ya
    // usó esta receta, en vez de dejarla huérfana. Antes esto caía al
    // catch genérico de abajo y devolvía un 500 sin explicar nada.
    if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || err.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({
        error:
          'No se puede eliminar: esta receta ya se usó en al menos una producción registrada. El historial de producción se conserva a propósito.',
      });
    }
    console.error('[DELETE /recetas/:id]', err.message);
    res.status(500).json({ error: 'Error al eliminar la receta.' });
  }
});

/* ═══════════════════════════════════════════
   PRODUCCIÓN — una tanda de masa: ingredientes reales usados + las 8
   etapas del proceso (pesado → segunda fermentación). La 9na etapa
   (horneado) la cubre horneadas.produccion_id.
   ═══════════════════════════════════════════ */
function serializeProduccion(row, ingredientes, etapas) {
  return {
    id: row.id,
    productoId: row.producto_id,
    productoNombre: row.producto_nombre,
    recetaId: row.receta_id,
    fecha: row.fecha,
    horaInicio: row.hora_inicio,
    pesoTotalMasaG: row.peso_total_masa_g,
    unidadesEstimadas: row.unidades_estimadas,
    tiempoManoObraRealMin: row.tiempo_mano_obra_real_min,
    edadMasaMadreHoras: row.edad_masa_madre_horas,
    temperaturaAmbienteC: row.temperatura_ambiente_c,
    temperaturaAguaC: row.temperatura_agua_c,
    registradoPor: row.registrado_por,
    notas: row.notas,
    ingredientes: ingredientes.map((i) => ({
      id: i.id,
      insumoId: i.insumo_id,
      insumoNombre: i.insumo_nombre,
      gramos: i.gramos,
    })),
    etapas: etapas.map((e) => ({
      id: e.id,
      etapa: e.etapa,
      horaInicio: e.hora_inicio,
      horaFin: e.hora_fin,
      notas: e.notas,
    })),
    creadoEn: row.creado_en,
    actualizadoEn: row.actualizado_en,
  };
}

function cargarProduccion(id) {
  const fila = db.prepare('SELECT * FROM producciones WHERE id = ?').get(id);
  if (!fila) return null;
  const ingredientes = db
    .prepare('SELECT * FROM produccion_ingredientes WHERE produccion_id = ?')
    .all(id);
  const etapas = db
    .prepare('SELECT * FROM produccion_etapas WHERE produccion_id = ? ORDER BY hora_inicio')
    .all(id);
  const horneadasLigadas = db
    .prepare('SELECT * FROM horneadas WHERE produccion_id = ? ORDER BY hora ASC')
    .all(id)
    .map(serializeHorneada);
  return { ...serializeProduccion(fila, ingredientes, etapas), horneadas: horneadasLigadas };
}

app.get('/producciones', requireAuth, (req, res) => {
  const { fecha } = req.query;
  try {
    let sql = 'SELECT id FROM producciones WHERE 1=1';
    const params = [];
    if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      sql += ' AND fecha = ?';
      params.push(fecha);
    }
    sql += ' ORDER BY fecha DESC, hora_inicio ASC';
    const ids = db
      .prepare(sql)
      .all(...params)
      .map((r) => r.id);
    res.json(ids.map((id) => cargarProduccion(id)));
  } catch (err) {
    console.error('[GET /producciones]', err.message);
    res.status(500).json({ error: 'Error al consultar producciones.' });
  }
});

app.post('/producciones', requireAuth, rateLimit, (req, res) => {
  let datos;
  let receta;
  try {
    datos = validarProduccion(req.body);
    const nombresPorId = resolverInsumos(datos.ingredientes);
    datos.ingredientes = datos.ingredientes.map((ing) => ({
      ...ing,
      insumoNombre: nombresPorId.get(ing.insumoId),
    }));

    receta = db.prepare('SELECT * FROM recetas WHERE producto_id = ?').get(datos.productoId);
    if (!receta) {
      throw new ValidationError(
        `No existe una receta para ${datos.productoNombre} todavía. Créala primero en la pestaña Recetas.`,
      );
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  // El peso total y las unidades estimadas se calculan aquí, con lo que
  // realmente se pesó — nunca se confían al cliente.
  const pesoTotalMasaG = datos.ingredientes.reduce((sum, i) => sum + i.gramos, 0);
  const unidadesEstimadas = Math.round(pesoTotalMasaG / receta.peso_masa_por_unidad_g);

  const id = crypto.randomUUID();
  try {
    const crear = db.transaction(() => {
      db.prepare(
        `INSERT INTO producciones
           (id, producto_id, producto_nombre, receta_id, fecha, hora_inicio, peso_total_masa_g,
            unidades_estimadas, tiempo_mano_obra_real_min, edad_masa_madre_horas,
            temperatura_ambiente_c, temperatura_agua_c, registrado_por, notas)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        datos.productoId,
        datos.productoNombre,
        receta.id,
        datos.fecha,
        datos.horaInicio,
        pesoTotalMasaG,
        unidadesEstimadas,
        datos.tiempoManoObraRealMin,
        datos.edadMasaMadreHoras,
        datos.temperaturaAmbienteC,
        datos.temperaturaAguaC,
        datos.registradoPor,
        datos.notas,
      );

      datos.ingredientes.forEach((ing) => {
        db.prepare(
          `INSERT INTO produccion_ingredientes (id, produccion_id, insumo_id, insumo_nombre, gramos)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(crypto.randomUUID(), id, ing.insumoId, ing.insumoNombre, ing.gramos);
      });
    });
    crear();

    const resultado = cargarProduccion(id);
    broadcast({ tipo: 'produccion:nueva', produccion: resultado });
    res.status(201).json(resultado);
  } catch (err) {
    console.error('[POST /producciones]', err.message);
    res.status(500).json({ error: 'Error al guardar la producción.' });
  }
});

app.delete('/producciones/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!PRODUCCION_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de producción inválido.' });
  }
  try {
    const info = db.prepare('DELETE FROM producciones WHERE id = ?').run(id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Producción no encontrada.' });
    }
    broadcast({ tipo: 'produccion:eliminada', id });
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /producciones/:id]', err.message);
    res.status(500).json({ error: 'Error al eliminar la producción.' });
  }
});

/* ---- Etapas de una producción (pesado → segunda fermentación) ---- */
app.post('/producciones/:id/etapas', requireAuth, rateLimit, (req, res) => {
  const { id } = req.params;
  if (!PRODUCCION_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de producción inválido.' });
  }
  const produccion = db.prepare('SELECT id FROM producciones WHERE id = ?').get(id);
  if (!produccion) {
    return res.status(404).json({ error: 'Producción no encontrada.' });
  }

  let datos;
  try {
    datos = validarInicioEtapa(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const yaExiste = db
    .prepare('SELECT id FROM produccion_etapas WHERE produccion_id = ? AND etapa = ?')
    .get(id, datos.etapa);
  if (yaExiste) {
    return res.status(400).json({ error: 'Esa etapa ya se inició para esta producción.' });
  }

  const etapaId = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO produccion_etapas (id, produccion_id, etapa, hora_inicio, notas)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(etapaId, id, datos.etapa, datos.horaInicio, datos.notas);
    const resultado = cargarProduccion(id);
    broadcast({ tipo: 'produccion:etapa-iniciada', produccion: resultado });
    res.status(201).json(resultado);
  } catch (err) {
    console.error('[POST /producciones/:id/etapas]', err.message);
    res.status(500).json({ error: 'Error al iniciar la etapa.' });
  }
});

app.put('/producciones/:id/etapas/:etapaId', requireAuth, (req, res) => {
  const { id, etapaId } = req.params;
  if (!PRODUCCION_ID_RE.test(id) || !ETAPA_ID_RE.test(etapaId)) {
    return res.status(400).json({ error: 'Identificador inválido.' });
  }

  let datos;
  try {
    datos = validarFinEtapa(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  try {
    const etapaActual = db
      .prepare(
        'SELECT etapa, hora_inicio FROM produccion_etapas WHERE id = ? AND produccion_id = ?',
      )
      .get(etapaId, id);
    if (!etapaActual) {
      return res.status(404).json({ error: 'Etapa no encontrada.' });
    }

    // hora_inicio/hora_fin son solo "HH:MM", sin fecha — comparar como texto
    // funciona para etapas normales (duran minutos, mismo día), pero NO para
    // retardación en frío, que declaradamente puede durar hasta 72h y cruzar
    // medianoche/varios días (ver MAX en validation.js). Ahí no hay forma de
    // saber con solo la hora si "08:00" es el mismo día o dos días después,
    // así que esa etapa se deja sin este chequeo — corregirlo bien requiere
    // guardar fecha además de hora en produccion_etapas (pendiente).
    if (etapaActual.etapa !== 'retardacion_frio' && datos.horaFin <= etapaActual.hora_inicio) {
      return res.status(400).json({
        error: 'La hora de fin no puede ser igual o anterior a la hora de inicio de la etapa.',
      });
    }

    const info = db
      .prepare(
        `UPDATE produccion_etapas SET hora_fin = ?, notas = ?
         WHERE id = ? AND produccion_id = ?`,
      )
      .run(datos.horaFin, datos.notas, etapaId, id);
    if (info.changes === 0) {
      return res.status(404).json({ error: 'Etapa no encontrada.' });
    }
    const resultado = cargarProduccion(id);
    broadcast({ tipo: 'produccion:etapa-finalizada', produccion: resultado });
    res.json(resultado);
  } catch (err) {
    console.error('[PUT /producciones/:id/etapas/:etapaId]', err.message);
    res.status(500).json({ error: 'Error al cerrar la etapa.' });
  }
});

/* ═══════════════════════════════════════════
   ÓRDENES DE COMPRA — el documento que se le manda al proveedor, con su
   detalle, sus recepciones parciales y su bitácora. Ver
   docs/modelo-ordenes-compra.md para el modelo completo.

   Tres reglas que se sostienen en todo este bloque:
     1. Los totales de la orden y cantidad_recibida de cada ítem SIEMPRE
        se recalculan acá; nunca se aceptan del cliente.
     2. Los ítems solo se pueden tocar mientras la orden esté en
        borrador — después la corrección es cancelar y emitir otra.
     3. Todo cambio deja dos rastros: una fila en orden_compra_eventos
        (la línea de tiempo que ve el panel) y un bloque en
        auditoria_cadena (la copia encadenada por hash).
   ═══════════════════════════════════════════ */

/** Genera el número visible de la orden: OC-AAAAMMDD-NNNN, correlativo
 *  dentro del día de emisión. Mismo formato que LM-... de los pedidos. */
function generarNumeroOrdenCompra(fechaEmision) {
  const dia = fechaEmision.replace(/-/g, '');
  const { usados } = db
    .prepare('SELECT COUNT(*) AS usados FROM ordenes_compra WHERE numero LIKE ?')
    .get(`OC-${dia}-%`);
  return `OC-${dia}-${String(usados + 1).padStart(4, '0')}`;
}

/** Redondeo a centavos: sin esto, sumar líneas con impuestos arrastra el
 *  error de coma flotante y el total de la orden termina en .30000000004. */
function redondearDinero(valor) {
  return Math.round(valor * 100) / 100;
}

/** Totales de una línea y de la orden completa, calculados siempre acá.
 *  descuento e impuesto son porcentajes por línea; el flete es un monto
 *  fijo de la cabecera que se suma al final. */
function calcularTotalesOrdenCompra(items, flete) {
  let subtotalBruto = 0;
  let descuento = 0;
  let impuestos = 0;

  const itemsConTotales = items.map((item) => {
    const bruto = item.cantidadPedida * item.costoUnitario;
    const descuentoLinea = bruto * (item.descuentoPorcentaje / 100);
    const subtotal = bruto - descuentoLinea;
    const impuestoLinea = subtotal * (item.impuestoPorcentaje / 100);

    subtotalBruto += bruto;
    descuento += descuentoLinea;
    impuestos += impuestoLinea;

    return {
      ...item,
      subtotal: redondearDinero(subtotal),
      totalLinea: redondearDinero(subtotal + impuestoLinea),
    };
  });

  const subtotal = redondearDinero(subtotalBruto);
  const descuentoTotal = redondearDinero(descuento);
  const impuestosTotal = redondearDinero(impuestos);

  return {
    items: itemsConTotales,
    subtotal,
    descuento: descuentoTotal,
    impuestos: impuestosTotal,
    flete: redondearDinero(flete),
    total: redondearDinero(subtotal - descuentoTotal + impuestosTotal + flete),
  };
}

/** Cruza cada insumoId contra el catálogo real y devuelve el mapa
 *  id -> fila. Mismo criterio que resolverInsumos (recetas): validation.js
 *  no consulta la base, así que la existencia se verifica acá. */
function resolverInsumosCompra(items) {
  const porId = new Map();
  for (const item of items) {
    const insumo = db.prepare('SELECT * FROM insumos WHERE id = ?').get(item.insumoId);
    if (!insumo) {
      throw new ValidationError(
        `El insumo "${item.insumoId}" no existe en el catálogo de Insumos.`,
      );
    }
    porId.set(item.insumoId, insumo);
  }
  return porId;
}

/** Convierte lo recibido (en la unidad de la línea de la orden) a la
 *  unidad en la que el insumo lleva su existencia. Si no hay forma de
 *  convertir con los datos cargados (ej. litros contra kilos, sin
 *  densidad), lanza en vez de sumar peras con manzanas. */
function convertirAUnidadDelInsumo(cantidad, unidadOrigen, insumo) {
  if (unidadOrigen === insumo.unidad) return cantidad;

  if (UNIDADES_DE_VOLUMEN.includes(unidadOrigen) && UNIDADES_DE_VOLUMEN.includes(insumo.unidad)) {
    return (cantidad * FACTOR_A_ML[unidadOrigen]) / FACTOR_A_ML[insumo.unidad];
  }

  const equivalenciaGramos = insumo.equivalencia_gramos;
  const gramosRecibidos = convertirAGramos({ unidad: unidadOrigen, cantidad, equivalenciaGramos });
  const gramosPorUnidadDestino = convertirAGramos({
    unidad: insumo.unidad,
    cantidad: 1,
    equivalenciaGramos,
  });

  if (!gramosRecibidos || !gramosPorUnidadDestino) {
    throw new ValidationError(
      `No se puede convertir ${unidadOrigen} a ${insumo.unidad} para "${insumo.nombre}". Carga la equivalencia en gramos del insumo o usa la misma unidad en la orden.`,
    );
  }

  return gramosRecibidos / gramosPorUnidadDestino;
}

function registrarEventoOrdenCompra({
  ordenCompraId,
  tipo,
  estadoAnterior = null,
  estadoNuevo = null,
  descripcion,
  datos = null,
  usuario = null,
}) {
  db.prepare(
    `INSERT INTO orden_compra_eventos
       (orden_compra_id, tipo, estado_anterior, estado_nuevo, descripcion, datos, usuario)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ordenCompraId,
    tipo,
    estadoAnterior,
    estadoNuevo,
    descripcion,
    datos ? JSON.stringify(datos) : null,
    usuario || null,
  );
}

function serializeOrdenCompraItem(row) {
  return {
    id: row.id,
    insumoId: row.insumo_id,
    insumoNombre: row.insumo_nombre,
    cantidadPedida: row.cantidad_pedida,
    unidad: row.unidad,
    costoUnitario: row.costo_unitario,
    impuestoPorcentaje: row.impuesto_porcentaje,
    descuentoPorcentaje: row.descuento_porcentaje,
    subtotal: row.subtotal,
    totalLinea: row.total_linea,
    cantidadRecibida: row.cantidad_recibida,
    cantidadPendiente: redondearDinero(row.cantidad_pedida - row.cantidad_recibida),
    orden: row.orden,
    notas: row.notas,
  };
}

function serializeOrdenCompra(row, items, recepciones, eventos) {
  const pedido = items.reduce((acc, i) => acc + i.cantidad_pedida, 0);
  const recibido = items.reduce((acc, i) => acc + i.cantidad_recibida, 0);

  return {
    id: row.id,
    numero: row.numero,
    proveedorId: row.proveedor_id,
    proveedorRazonSocial: row.proveedor_razon_social,
    estado: row.estado,
    fechaEmision: row.fecha_emision,
    fechaEntregaEstimada: row.fecha_entrega_estimada,
    condicionesPago: row.condiciones_pago,
    moneda: row.moneda,
    subtotal: row.subtotal,
    impuestos: row.impuestos,
    descuento: row.descuento,
    flete: row.flete,
    total: row.total,
    solicitadoPor: row.solicitado_por,
    aprobadoPor: row.aprobado_por,
    aprobadoEn: sqliteDatetimeAIso(row.aprobado_en),
    lugarEntrega: row.lugar_entrega,
    notas: row.notas,
    motivoCancelacion: row.motivo_cancelacion,
    // Avance de recepción en porcentaje: lo que pinta la barra del panel
    // sin que el navegador tenga que recorrer los ítems otra vez.
    avanceRecepcionPct: pedido > 0 ? Math.round((recibido / pedido) * 1000) / 10 : 0,
    items: items.map(serializeOrdenCompraItem),
    recepciones: recepciones.map((recepcion) => ({
      id: recepcion.id,
      fecha: recepcion.fecha,
      hora: recepcion.hora,
      recibidoPor: recepcion.recibido_por,
      documentoReferencia: recepcion.documento_referencia,
      notas: recepcion.notas,
      creadoEn: sqliteDatetimeAIso(recepcion.creado_en),
      items: recepcion.items.map((linea) => ({
        id: linea.id,
        itemId: linea.item_id,
        insumoId: linea.insumo_id,
        insumoNombre: linea.insumo_nombre,
        cantidadRecibida: linea.cantidad_recibida,
        cantidadRechazada: linea.cantidad_rechazada,
        motivoRechazo: linea.motivo_rechazo,
        loteProveedor: linea.lote_proveedor,
        fechaVencimiento: linea.fecha_vencimiento,
        temperaturaRecepcionC: linea.temperatura_recepcion_c,
        notas: linea.notas,
      })),
    })),
    eventos: eventos.map((evento) => ({
      id: evento.id,
      tipo: evento.tipo,
      estadoAnterior: evento.estado_anterior,
      estadoNuevo: evento.estado_nuevo,
      descripcion: evento.descripcion,
      datos: evento.datos ? JSON.parse(evento.datos) : null,
      usuario: evento.usuario,
      creadoEn: sqliteDatetimeAIso(evento.creado_en),
    })),
    creadoEn: sqliteDatetimeAIso(row.creado_en),
    actualizadoEn: sqliteDatetimeAIso(row.actualizado_en),
  };
}

function cargarOrdenCompra(id) {
  const fila = db.prepare('SELECT * FROM ordenes_compra WHERE id = ?').get(id);
  if (!fila) return null;

  const items = db
    .prepare('SELECT * FROM orden_compra_items WHERE orden_compra_id = ? ORDER BY orden ASC')
    .all(id);

  const recepciones = db
    .prepare(
      `SELECT * FROM orden_compra_recepciones
       WHERE orden_compra_id = ? ORDER BY fecha ASC, hora ASC, creado_en ASC`,
    )
    .all(id)
    .map((recepcion) => ({
      ...recepcion,
      items: db
        .prepare('SELECT * FROM orden_compra_recepcion_items WHERE recepcion_id = ?')
        .all(recepcion.id),
    }));

  const eventos = db
    .prepare('SELECT * FROM orden_compra_eventos WHERE orden_compra_id = ? ORDER BY id ASC')
    .all(id);

  return serializeOrdenCompra(fila, items, recepciones, eventos);
}

/** Recalcula cantidad_recibida de cada ítem sumando sus recepciones y
 *  deduce el estado de la orden: todo recibido => 'recibida', algo
 *  recibido => 'recibida_parcial'. Se llama dentro de la transacción de
 *  recepción, nunca suelto. */
function recalcularAvanceOrdenCompra(ordenCompraId) {
  db.prepare(
    `UPDATE orden_compra_items
     SET cantidad_recibida = (
       SELECT COALESCE(SUM(ri.cantidad_recibida), 0)
       FROM orden_compra_recepcion_items ri
       WHERE ri.item_id = orden_compra_items.id
     )
     WHERE orden_compra_id = ?`,
  ).run(ordenCompraId);

  const items = db
    .prepare(
      'SELECT cantidad_pedida, cantidad_recibida FROM orden_compra_items WHERE orden_compra_id = ?',
    )
    .all(ordenCompraId);

  const completa = items.every((i) => i.cantidad_recibida >= i.cantidad_pedida);
  const algo = items.some((i) => i.cantidad_recibida > 0);

  return completa ? 'recibida' : algo ? 'recibida_parcial' : null;
}

app.get('/ordenes-compra', requireAuth, (req, res) => {
  const { estado, proveedorId, desde, hasta } = req.query;

  let sql = 'SELECT id FROM ordenes_compra WHERE 1=1';
  const params = [];

  if (estado) {
    if (!OC_ESTADOS.includes(estado)) {
      return res.status(400).json({ error: 'Estado de orden de compra inválido.' });
    }
    sql += ' AND estado = ?';
    params.push(estado);
  }
  if (proveedorId) {
    if (!PROVEEDOR_ID_RE.test(proveedorId)) {
      return res.status(400).json({ error: 'Identificador de proveedor inválido.' });
    }
    sql += ' AND proveedor_id = ?';
    params.push(proveedorId);
  }
  if (desde && /^\d{4}-\d{2}-\d{2}$/.test(desde)) {
    sql += ' AND fecha_emision >= ?';
    params.push(desde);
  }
  if (hasta && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
    sql += ' AND fecha_emision <= ?';
    params.push(hasta);
  }
  sql += ' ORDER BY fecha_emision DESC, numero DESC';

  try {
    const ids = db
      .prepare(sql)
      .all(...params)
      .map((r) => r.id);
    res.json(ids.map(cargarOrdenCompra));
  } catch (err) {
    console.error('[GET /ordenes-compra]', err.message);
    res.status(500).json({ error: 'Error al consultar órdenes de compra.' });
  }
});

app.get('/ordenes-compra/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!ORDEN_COMPRA_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de orden de compra inválido.' });
  }
  try {
    const orden = cargarOrdenCompra(id);
    if (!orden) return res.status(404).json({ error: 'Orden de compra no encontrada.' });
    res.json(orden);
  } catch (err) {
    console.error('[GET /ordenes-compra/:id]', err.message);
    res.status(500).json({ error: 'Error al consultar la orden de compra.' });
  }
});

app.post('/ordenes-compra', requireAuth, (req, res) => {
  let datos;
  let proveedor;
  let insumosPorId;
  try {
    datos = validarOrdenCompra(req.body);
    proveedor = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(datos.proveedorId);
    if (!proveedor) {
      throw new ValidationError('El proveedor no existe en el catálogo de Proveedores.');
    }
    insumosPorId = resolverInsumosCompra(datos.items);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const emitirDeInmediato = req.body?.emitir === true;
  const estadoInicial = emitirDeInmediato ? 'emitida' : 'borrador';
  const totales = calcularTotalesOrdenCompra(datos.items, datos.flete);
  const id = crypto.randomUUID();

  try {
    const numero = generarNumeroOrdenCompra(datos.fechaEmision);

    const crear = db.transaction(() => {
      db.prepare(
        `INSERT INTO ordenes_compra (
           id, numero, proveedor_id, proveedor_razon_social, estado, fecha_emision,
           fecha_entrega_estimada, condiciones_pago, moneda, subtotal, impuestos, descuento,
           flete, total, solicitado_por, aprobado_por, aprobado_en, lugar_entrega, notas
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        numero,
        datos.proveedorId,
        proveedor.razon_social,
        estadoInicial,
        datos.fechaEmision,
        datos.fechaEntregaEstimada,
        datos.condicionesPago,
        datos.moneda,
        totales.subtotal,
        totales.impuestos,
        totales.descuento,
        totales.flete,
        totales.total,
        datos.solicitadoPor,
        emitirDeInmediato ? datos.solicitadoPor : null,
        emitirDeInmediato ? new Date().toISOString() : null,
        datos.lugarEntrega,
        datos.notas,
      );

      totales.items.forEach((item, idx) => {
        db.prepare(
          `INSERT INTO orden_compra_items (
             id, orden_compra_id, insumo_id, insumo_nombre, cantidad_pedida, unidad,
             costo_unitario, impuesto_porcentaje, descuento_porcentaje, subtotal,
             total_linea, orden, notas
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          crypto.randomUUID(),
          id,
          item.insumoId,
          insumosPorId.get(item.insumoId).nombre,
          item.cantidadPedida,
          item.unidad,
          item.costoUnitario,
          item.impuestoPorcentaje,
          item.descuentoPorcentaje,
          item.subtotal,
          item.totalLinea,
          idx,
          item.notas,
        );
      });

      registrarEventoOrdenCompra({
        ordenCompraId: id,
        tipo: 'creada',
        estadoNuevo: estadoInicial,
        descripcion: `Orden ${numero} creada para ${proveedor.razon_social} con ${totales.items.length} línea(s).`,
        datos: { total: totales.total, moneda: datos.moneda },
        usuario: datos.solicitadoPor,
      });

      if (emitirDeInmediato) {
        registrarEventoOrdenCompra({
          ordenCompraId: id,
          tipo: 'emitida',
          estadoAnterior: 'borrador',
          estadoNuevo: 'emitida',
          descripcion: 'Orden emitida al proveedor.',
          usuario: datos.solicitadoPor,
        });
      }
    });
    crear();

    Auditoria.registrarEnCadena({
      entidad: 'ordenes_compra',
      entidadId: id,
      accion: 'crear',
      datos: {
        numero,
        proveedor: proveedor.razon_social,
        estado: estadoInicial,
        total: totales.total,
        lineas: totales.items.length,
      },
      actualizadoPor: datos.solicitadoPor || null,
    });

    const orden = cargarOrdenCompra(id);
    broadcast({ tipo: 'orden-compra:nueva', ordenCompra: orden });
    res.status(201).json(orden);
  } catch (err) {
    console.error('[POST /ordenes-compra]', err.message);
    res.status(500).json({ error: 'Error al guardar la orden de compra.' });
  }
});

app.put('/ordenes-compra/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!ORDEN_COMPRA_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de orden de compra inválido.' });
  }

  const existente = db.prepare('SELECT * FROM ordenes_compra WHERE id = ?').get(id);
  if (!existente) {
    return res.status(404).json({ error: 'Orden de compra no encontrada.' });
  }
  if (existente.estado !== 'borrador') {
    return res.status(409).json({
      error:
        'Solo se puede editar una orden en borrador. Una orden ya emitida se corrige cancelándola y emitiendo otra.',
    });
  }

  let datos;
  let proveedor;
  let insumosPorId;
  try {
    datos = validarOrdenCompra(req.body);
    proveedor = db.prepare('SELECT * FROM proveedores WHERE id = ?').get(datos.proveedorId);
    if (!proveedor) {
      throw new ValidationError('El proveedor no existe en el catálogo de Proveedores.');
    }
    insumosPorId = resolverInsumosCompra(datos.items);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const totales = calcularTotalesOrdenCompra(datos.items, datos.flete);

  try {
    const actualizar = db.transaction(() => {
      db.prepare(
        `UPDATE ordenes_compra
         SET proveedor_id = ?, proveedor_razon_social = ?, fecha_emision = ?,
             fecha_entrega_estimada = ?, condiciones_pago = ?, moneda = ?, subtotal = ?,
             impuestos = ?, descuento = ?, flete = ?, total = ?, solicitado_por = ?,
             lugar_entrega = ?, notas = ?, actualizado_en = datetime('now')
         WHERE id = ?`,
      ).run(
        datos.proveedorId,
        proveedor.razon_social,
        datos.fechaEmision,
        datos.fechaEntregaEstimada,
        datos.condicionesPago,
        datos.moneda,
        totales.subtotal,
        totales.impuestos,
        totales.descuento,
        totales.flete,
        totales.total,
        datos.solicitadoPor,
        datos.lugarEntrega,
        datos.notas,
        id,
      );

      db.prepare('DELETE FROM orden_compra_items WHERE orden_compra_id = ?').run(id);
      totales.items.forEach((item, idx) => {
        db.prepare(
          `INSERT INTO orden_compra_items (
             id, orden_compra_id, insumo_id, insumo_nombre, cantidad_pedida, unidad,
             costo_unitario, impuesto_porcentaje, descuento_porcentaje, subtotal,
             total_linea, orden, notas
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          crypto.randomUUID(),
          id,
          item.insumoId,
          insumosPorId.get(item.insumoId).nombre,
          item.cantidadPedida,
          item.unidad,
          item.costoUnitario,
          item.impuestoPorcentaje,
          item.descuentoPorcentaje,
          item.subtotal,
          item.totalLinea,
          idx,
          item.notas,
        );
      });

      registrarEventoOrdenCompra({
        ordenCompraId: id,
        tipo: 'editada',
        estadoAnterior: 'borrador',
        estadoNuevo: 'borrador',
        descripcion: 'Borrador editado.',
        datos: { antes: { total: existente.total }, despues: { total: totales.total } },
        usuario: datos.solicitadoPor,
      });
    });
    actualizar();

    Auditoria.registrarEnCadena({
      entidad: 'ordenes_compra',
      entidadId: id,
      accion: 'actualizar',
      datos: {
        numero: existente.numero,
        antes: { total: existente.total, proveedor: existente.proveedor_razon_social },
        despues: { total: totales.total, proveedor: proveedor.razon_social },
      },
      actualizadoPor: datos.solicitadoPor || null,
    });

    const orden = cargarOrdenCompra(id);
    broadcast({ tipo: 'orden-compra:actualizada', ordenCompra: orden });
    res.json(orden);
  } catch (err) {
    console.error('[PUT /ordenes-compra/:id]', err.message);
    res.status(500).json({ error: 'Error al actualizar la orden de compra.' });
  }
});

app.patch('/ordenes-compra/:id/estado', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!ORDEN_COMPRA_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de orden de compra inválido.' });
  }

  const existente = db.prepare('SELECT * FROM ordenes_compra WHERE id = ?').get(id);
  if (!existente) {
    return res.status(404).json({ error: 'Orden de compra no encontrada.' });
  }

  let datos;
  try {
    datos = validarCambioEstadoOrdenCompra(req.body, existente.estado);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  // Una orden que ya movió inventario no se anula: lo recibido existe de
  // verdad en la bodega, y cancelarla dejaría el stock sin respaldo documental.
  if (datos.estado === 'cancelada') {
    const { recibidas } = db
      .prepare(
        'SELECT COUNT(*) AS recibidas FROM orden_compra_recepciones WHERE orden_compra_id = ?',
      )
      .get(id);
    if (recibidas > 0) {
      return res.status(409).json({
        error:
          'No se puede cancelar: la orden ya tiene mercancía recibida. Registra la diferencia como rechazo en una recepción.',
      });
    }
  }

  try {
    const cambiar = db.transaction(() => {
      db.prepare(
        `UPDATE ordenes_compra
         SET estado = ?,
             motivo_cancelacion = CASE WHEN ? = 'cancelada' THEN ? ELSE motivo_cancelacion END,
             aprobado_por = CASE WHEN ? = 'emitida' THEN ? ELSE aprobado_por END,
             aprobado_en = CASE WHEN ? = 'emitida' THEN ? ELSE aprobado_en END,
             actualizado_en = datetime('now')
         WHERE id = ?`,
      ).run(
        datos.estado,
        datos.estado,
        datos.motivo,
        datos.estado,
        datos.usuario || null,
        datos.estado,
        new Date().toISOString(),
        id,
      );

      registrarEventoOrdenCompra({
        ordenCompraId: id,
        tipo: datos.estado,
        estadoAnterior: existente.estado,
        estadoNuevo: datos.estado,
        descripcion: datos.motivo
          ? `Estado: ${existente.estado} → ${datos.estado}. Motivo: ${datos.motivo}`
          : `Estado: ${existente.estado} → ${datos.estado}.`,
        usuario: datos.usuario,
      });
    });
    cambiar();

    Auditoria.registrarEnCadena({
      entidad: 'ordenes_compra',
      entidadId: id,
      accion: 'actualizar',
      datos: {
        numero: existente.numero,
        antes: { estado: existente.estado },
        despues: { estado: datos.estado },
        motivo: datos.motivo || null,
      },
      actualizadoPor: datos.usuario || null,
    });

    const orden = cargarOrdenCompra(id);
    broadcast({ tipo: 'orden-compra:actualizada', ordenCompra: orden });
    res.json(orden);
  } catch (err) {
    console.error('[PATCH /ordenes-compra/:id/estado]', err.message);
    res.status(500).json({ error: 'Error al cambiar el estado de la orden de compra.' });
  }
});

app.post('/ordenes-compra/:id/recepciones', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!ORDEN_COMPRA_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de orden de compra inválido.' });
  }

  const existente = db.prepare('SELECT * FROM ordenes_compra WHERE id = ?').get(id);
  if (!existente) {
    return res.status(404).json({ error: 'Orden de compra no encontrada.' });
  }
  if (!OC_ESTADOS_RECEPCION.includes(existente.estado)) {
    return res.status(409).json({
      error: `Una orden en estado "${existente.estado}" no admite recepciones. Emítela primero.`,
    });
  }

  let datos;
  let lineas;
  try {
    datos = validarRecepcionOrdenCompra(req.body);

    // Cada línea de la recepción tiene que apuntar a una línea real de ESTA
    // orden y caber en lo que todavía falta por recibir. Lo que llegue de
    // más se anota como rechazo, no se suma al inventario en silencio.
    lineas = datos.items.map((linea) => {
      const item = db
        .prepare('SELECT * FROM orden_compra_items WHERE id = ? AND orden_compra_id = ?')
        .get(linea.itemId, id);
      if (!item) {
        throw new ValidationError('Una de las líneas no pertenece a esta orden de compra.');
      }
      const pendiente = item.cantidad_pedida - item.cantidad_recibida;
      if (linea.cantidadRecibida > pendiente + 1e-9) {
        throw new ValidationError(
          `"${item.insumo_nombre}": se intenta recibir ${linea.cantidadRecibida} ${item.unidad} y solo faltan ${redondearDinero(pendiente)} ${item.unidad}.`,
        );
      }
      const insumo = db.prepare('SELECT * FROM insumos WHERE id = ?').get(item.insumo_id);
      if (!insumo) {
        throw new ValidationError(`El insumo "${item.insumo_nombre}" ya no existe en el catálogo.`);
      }
      const cantidadEnUnidadInsumo = convertirAUnidadDelInsumo(
        linea.cantidadRecibida,
        item.unidad,
        insumo,
      );
      return { linea, item, insumo, cantidadEnUnidadInsumo };
    });
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const recepcionId = crypto.randomUUID();

  try {
    let estadoFinal = existente.estado;

    const recibir = db.transaction(() => {
      db.prepare(
        `INSERT INTO orden_compra_recepciones
           (id, orden_compra_id, fecha, hora, recibido_por, documento_referencia, notas)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        recepcionId,
        id,
        datos.fecha,
        datos.hora,
        datos.recibidoPor,
        datos.documentoReferencia,
        datos.notas,
      );

      for (const { linea, item, insumo, cantidadEnUnidadInsumo } of lineas) {
        db.prepare(
          `INSERT INTO orden_compra_recepcion_items (
             id, recepcion_id, item_id, insumo_id, insumo_nombre, cantidad_recibida,
             cantidad_rechazada, motivo_rechazo, lote_proveedor, fecha_vencimiento,
             temperatura_recepcion_c, notas
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          crypto.randomUUID(),
          recepcionId,
          item.id,
          item.insumo_id,
          item.insumo_nombre,
          linea.cantidadRecibida,
          linea.cantidadRechazada,
          linea.motivoRechazo,
          linea.loteProveedor,
          linea.fechaVencimiento,
          linea.temperaturaRecepcionC,
          linea.notas,
        );

        // El efecto real en bodega: sube la existencia del insumo y se le
        // copia el costo pactado y el lote/vencimiento de ESTA entrega, que
        // es lo que después permite rastrear una tanda de masa hasta su
        // orden de compra.
        if (linea.cantidadRecibida > 0) {
          db.prepare(
            `UPDATE insumos
             SET cantidad = cantidad + ?,
                 costo_unitario = ?,
                 lote_proveedor = COALESCE(NULLIF(?, ''), lote_proveedor),
                 fecha_vencimiento = COALESCE(?, fecha_vencimiento),
                 actualizado_en = datetime('now')
             WHERE id = ?`,
          ).run(
            cantidadEnUnidadInsumo,
            item.unidad === insumo.unidad
              ? item.costo_unitario
              : (insumo.costo_unitario ?? item.costo_unitario),
            linea.loteProveedor,
            linea.fechaVencimiento,
            insumo.id,
          );
        }
      }

      const estadoDerivado = recalcularAvanceOrdenCompra(id);
      if (estadoDerivado && estadoDerivado !== existente.estado) {
        estadoFinal = estadoDerivado;
        db.prepare(
          "UPDATE ordenes_compra SET estado = ?, actualizado_en = datetime('now') WHERE id = ?",
        ).run(estadoDerivado, id);
      }

      const resumen = lineas
        .map(({ linea, item }) => `${item.insumo_nombre}: ${linea.cantidadRecibida} ${item.unidad}`)
        .join(', ');

      registrarEventoOrdenCompra({
        ordenCompraId: id,
        tipo: 'recepcion_registrada',
        estadoAnterior: existente.estado,
        estadoNuevo: estadoFinal,
        descripcion: `Recepción del ${datos.fecha} ${datos.hora}: ${resumen}.`,
        datos: {
          recepcionId,
          documentoReferencia: datos.documentoReferencia || null,
          lineas: lineas.map(({ linea, item }) => ({
            insumo: item.insumo_nombre,
            recibido: linea.cantidadRecibida,
            rechazado: linea.cantidadRechazada,
            lote: linea.loteProveedor || null,
          })),
        },
        usuario: datos.recibidoPor,
      });
    });
    recibir();

    Auditoria.registrarEnCadena({
      entidad: 'ordenes_compra',
      entidadId: id,
      accion: 'actualizar',
      datos: {
        numero: existente.numero,
        recepcionId,
        fecha: datos.fecha,
        hora: datos.hora,
        estado: estadoFinal,
        lineas: lineas.map(({ linea, item }) => ({
          insumo: item.insumo_nombre,
          recibido: linea.cantidadRecibida,
          rechazado: linea.cantidadRechazada,
          lote: linea.loteProveedor || null,
        })),
      },
      actualizadoPor: datos.recibidoPor || null,
    });

    const orden = cargarOrdenCompra(id);
    broadcast({ tipo: 'orden-compra:recepcion', ordenCompra: orden });
    res.status(201).json(orden);
  } catch (err) {
    console.error('[POST /ordenes-compra/:id/recepciones]', err.message);
    res.status(500).json({ error: 'Error al registrar la recepción.' });
  }
});

/** Trazabilidad completa: la bitácora legible de la orden más los bloques
 *  de la cadena de hashes que le corresponden, con el veredicto de
 *  integridad de la cadena. */
app.get('/ordenes-compra/:id/trazabilidad', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!ORDEN_COMPRA_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de orden de compra inválido.' });
  }
  try {
    const orden = cargarOrdenCompra(id);
    if (!orden) return res.status(404).json({ error: 'Orden de compra no encontrada.' });

    res.json({
      numero: orden.numero,
      estado: orden.estado,
      eventos: orden.eventos,
      recepciones: orden.recepciones,
      bloques: Auditoria.historialDe('ordenes_compra', id).map((b) => ({
        id: b.id,
        accion: b.accion,
        datos: JSON.parse(b.datos),
        actualizadoPor: b.actualizado_por,
        hash: b.hash,
        hashAnterior: b.hash_anterior,
        creadoEn: b.creado_en,
      })),
      integridadCadena: Auditoria.verificarCadena(),
    });
  } catch (err) {
    console.error('[GET /ordenes-compra/:id/trazabilidad]', err.message);
    res.status(500).json({ error: 'Error al consultar la trazabilidad.' });
  }
});

app.delete('/ordenes-compra/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  if (!ORDEN_COMPRA_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Identificador de orden de compra inválido.' });
  }

  const existente = db.prepare('SELECT * FROM ordenes_compra WHERE id = ?').get(id);
  if (!existente) {
    return res.status(404).json({ error: 'Orden de compra no encontrada.' });
  }
  // Solo el borrador es descartable. Una orden emitida ya salió del negocio
  // hacia el proveedor: se cancela (queda el rastro), no se borra.
  if (existente.estado !== 'borrador') {
    return res.status(409).json({
      error: 'Solo se puede eliminar un borrador. Una orden emitida se cancela, no se borra.',
    });
  }

  try {
    db.prepare('DELETE FROM ordenes_compra WHERE id = ?').run(id);
    Auditoria.registrarEnCadena({
      entidad: 'ordenes_compra',
      entidadId: id,
      accion: 'eliminar',
      datos: {
        numero: existente.numero,
        proveedor: existente.proveedor_razon_social,
        total: existente.total,
      },
      actualizadoPor: existente.solicitado_por,
    });
    broadcast({ tipo: 'orden-compra:eliminada', id });
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /ordenes-compra/:id]', err.message);
    res.status(500).json({ error: 'Error al eliminar la orden de compra.' });
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

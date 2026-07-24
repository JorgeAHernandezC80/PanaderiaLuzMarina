/**
 * PANADERÍA LUZ MARINA — Backend: Servidor
 * Express + better-sqlite3 + WebSocket.
 */

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { validarOrden, ValidationError, NUMERO_ORDEN_RE, ORDER_STATES } = require('./validation');

const PORT = process.env.PORT || 3001;

/* FRONTEND_ORIGIN debe estar configurado como variable de entorno en Render.
   Si no está, el servidor arranca pero rechaza todos los orígenes cruzados —
   esto es intencional: no queremos CORS abierto en producción. */
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;
if (!FRONTEND_ORIGIN) {
  console.warn(
    '[server] ADVERTENCIA: FRONTEND_ORIGIN no está configurado. Las peticiones CORS serán rechazadas.',
  );
}

/* ADMIN_TOKEN: contraseña del panel admin, definida como variable de entorno en Render.
   Nunca debe estar en el código fuente.
   Ejemplo: ADMIN_TOKEN=LuzMarina2026 (cambia esto por algo tuyo).
   Si no está configurada, el panel admin no va a funcionar — intencional. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.warn(
    '[server] ADVERTENCIA: ADMIN_TOKEN no está configurado. El panel admin estará inaccesible.',
  );
}

/* Secreto para firmar los tokens de sesión del panel admin. Se recomienda uno
   dedicado (SESSION_SECRET); si no está, se deriva del ADMIN_TOKEN. */
const SESSION_SECRET = process.env.SESSION_SECRET || ADMIN_TOKEN || '';
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 8 * 60 * 60 * 1000;

/**
 * Emite un token de sesión firmado (HMAC-SHA256) con expiración.
 * A diferencia de devolver el ADMIN_TOKEN, este token caduca y puede rotarse
 * sin exponer la contraseña del panel.
 * @returns {string} token con forma `<payloadBase64Url>.<firmaBase64Url>`
 */
function issueSessionToken() {
  const body = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS })).toString(
    'base64url',
  );
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verifica un token de sesión: firma válida y no expirado. Usa comparación de
 * tiempo constante para no filtrar información por timing.
 * @param {unknown} token
 * @returns {boolean}
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

/** Middleware que protege endpoints del panel admin.
 *  Requiere header: Authorization: Bearer <token de sesión firmado>
 */
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

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

/* Cabeceras de seguridad en todas las respuestas (defensa en profundidad).
   La API sólo devuelve JSON, por eso una CSP muy restrictiva es segura aquí. */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' " + FRONTEND_ORIGIN + " wss://" + req.headers.host + "; frame-ancestors 'none'; base-uri 'none'",
  );
  /* HSTS: sólo lo aplican los navegadores sobre HTTPS (Render sirve TLS). */
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  next();
});

/* Rate limiting por IP. Un limitador independiente por endpoint sensible para
   que el abuso de uno no afecte al otro. */
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

/* POST /ordenes: evita spam de órdenes falsas hacia el WhatsApp del negocio. */
const rateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.ORDERS_MAX_PER_WINDOW) || 20,
  message: 'Demasiadas solicitudes. Intenta en unos minutos.',
});

/* POST /auth: frena ataques de fuerza bruta contra la contraseña del panel. */
const authRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_MAX_ATTEMPTS) || 10,
  message: 'Demasiados intentos de acceso. Espera unos minutos e intenta de nuevo.',
});

/* Limpieza periódica de contadores viejos para evitar crecimiento ilimitado del
   mapa en memoria. `unref()` evita que el timer mantenga vivo el proceso. */
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

/** Solo para pruebas: reinicia los contadores de rate limiting. */
function resetRateLimits() {
  for (const hits of rateLimiters) hits.clear();
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (FRONTEND_ORIGIN && origin === FRONTEND_ORIGIN) {
    res.header('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
  } else if (!FRONTEND_ORIGIN) {
    // Sin variable configurada: rechaza silenciosamente
  } else if (!origin) {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
      actualizarOrden: 'PATCH /ordenes/:numero (Authorization: Bearer token)'
    }
  });
});

/* ---- GET /health ---- */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

/* ---- POST /auth — validar password del panel admin ---- */
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
  return res.json({ token });
});

/* ---- POST /ordenes ---- */
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

/* ---- GET /ordenes — solo panel admin autenticado ---- */
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

/* ---- PATCH /ordenes/:numero — solo panel admin autenticado ---- */
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

/* ---- 404 y errores ---- */
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada." });
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

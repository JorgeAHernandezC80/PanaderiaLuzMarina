/**
 * PANADERÍA LUZ MARINA — Backend: Servidor
 * Express + better-sqlite3 + WebSocket.
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { validarOrden, ValidationError, NUMERO_ORDEN_RE, ORDER_STATES } = require('./validation');

const PORT = process.env.PORT || 3001;

/* FRONTEND_ORIGIN debe estar configurado como variable de entorno en Render.
   Si no está, el servidor arranca pero rechaza todos los orígenes cruzados —
   esto es intencional: no queremos CORS abierto en producción. */
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;
if (!FRONTEND_ORIGIN) {
  console.warn('[server] ADVERTENCIA: FRONTEND_ORIGIN no está configurado. Las peticiones CORS serán rechazadas.');
}

/* ADMIN_TOKEN: contraseña del panel admin, definida como variable de entorno en Render.
   Nunca debe estar en el código fuente.
   Ejemplo: ADMIN_TOKEN=LuzMarina2026 (cambia esto por algo tuyo).
   Si no está configurada, el panel admin no va a funcionar — intencional. */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.warn('[server] ADVERTENCIA: ADMIN_TOKEN no está configurado. El panel admin estará inaccesible.');
}

/* ---- Capa de sesión ----
   Los tokens de sesión son aleatorios y temporales, desacoplados del ADMIN_TOKEN.
   Se guardan server-side con expiración. Autenticarse ya NO expone el secreto:
   el cliente recibe un token de sesión revocable, no la contraseña maestra. */
const crypto = require('crypto');
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 horas
const sesiones = new Map(); // token -> expiración (epoch ms)

function crearSesion() {
  const token = crypto.randomBytes(32).toString('hex');
  sesiones.set(token, Date.now() + SESSION_TTL);
  return token;
}

function sesionValida(token) {
  if (!token) return false;
  const exp = sesiones.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    sesiones.delete(token); // expirada: limpiar
    return false;
  }
  return true;
}

/* Limpieza periódica de sesiones expiradas para que el Map no crezca sin límite. */
setInterval(() => {
  const ahora = Date.now();
  for (const [token, exp] of sesiones) {
    if (ahora > exp) sesiones.delete(token);
  }
}, 60 * 60 * 1000).unref();

/** Middleware que protege endpoints del panel admin.
 *  Requiere header: Authorization: Bearer <token de sesión>
 */
function requireAuth(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Panel admin no configurado en el servidor.' });
  }
  const auth = req.headers['authorization'] ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!sesionValida(token)) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  next();
}

const app = express();
/* Render corre detrás de un proxy: confiar en él para que req.ip sea la IP real
   del cliente y no la del proxy. Sin esto, x-forwarded-for es falsificable. */
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

/* Rate limiting reutilizable. Fábrica que produce un middleware con su propia
   ventana, límite y almacén de contadores por IP.
   Nota: el almacén es en memoria — se resetea al reiniciar el proceso (Render Free).
   Aceptable para el volumen actual; documentado como deuda técnica. */
function crearRateLimit({ ventana, limite, mensaje }) {
  const registros = new Map();
  return function rateLimit(req, res, next) {
    const ip = req.ip || 'unknown';
    const ahora = Date.now();
    const registro = registros.get(ip) || { count: 0, desde: ahora };
    if (ahora - registro.desde > ventana) {
      registro.count = 0;
      registro.desde = ahora;
    }
    registro.count++;
    registros.set(ip, registro);
    if (registro.count > limite) {
      return res.status(429).json({ error: mensaje });
    }
    next();
  };
}

/* POST /ordenes: 20 req / 15 min por IP — previene spam de órdenes falsas. */
const rateLimit = crearRateLimit({
  ventana: 15 * 60 * 1000,
  limite: 20,
  mensaje: 'Demasiadas solicitudes. Intenta en unos minutos.',
});

/* POST /auth: 5 intentos / 15 min por IP — freno estricto a la fuerza bruta. */
const authRateLimit = crearRateLimit({
  ventana: 15 * 60 * 1000,
  limite: 5,
  mensaje: 'Demasiados intentos de acceso. Intenta más tarde.',
});

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
  wss.clients.forEach(client => {
    if (client.readyState === client.OPEN) client.send(data);
  });
}

/* ---- GET /health ---- */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

/* ---- POST /auth — validar password del panel admin ----
   Protegido con authRateLimit (fuerza bruta) y emite un token de sesión
   temporal, no el ADMIN_TOKEN. */
app.post('/auth', authRateLimit, (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Panel admin no configurado.' });
  }
  const { password } = req.body ?? {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Falta la contraseña.' });
  }
  /* Comparación de tiempo constante para evitar timing attacks */
  const expected = Buffer.from(ADMIN_TOKEN);
  const received = Buffer.from(password.slice(0, 200)); // límite razonable
  const match = expected.length === received.length &&
    crypto.timingSafeEqual(expected, received);

  if (!match) {
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }
  /* Éxito: entregar un token de sesión revocable, NUNCA el secreto. */
  res.json({ token: crearSesion() });
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
      orden.numero, orden.fechaISO, orden.fechaTexto, orden.cliente,
      orden.telefono, orden.retiro, JSON.stringify(orden.items), orden.total
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
    const ordenes = rows.map(r => ({
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
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[server] Panadería Luz Marina backend escuchando en http://localhost:${PORT}`);
  });
}

module.exports = { app, server, wss };

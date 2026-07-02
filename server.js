/**
 * PANADERÍA LUZ MARINA — Backend: Servidor
 * Express + better-sqlite3 + WebSocket.
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { validarOrden, ValidationError } = require('./validation');

const PORT = process.env.PORT || 3001;

/* FRONTEND_ORIGIN debe estar configurado como variable de entorno en Render.
   Si no está, el servidor arranca pero rechaza todos los orígenes cruzados —
   esto es intencional: no queremos CORS abierto en producción. */
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;
if (!FRONTEND_ORIGIN) {
  console.warn('[server] ADVERTENCIA: FRONTEND_ORIGIN no está configurado. Las peticiones CORS serán rechazadas.');
}

const app = express();
app.use(express.json({ limit: '100kb' }));

/* Rate limiting: máximo 20 peticiones por IP por 15 minutos en POST /ordenes.
   Previene spam de órdenes falsas hacia el WhatsApp del negocio. */
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ahora = Date.now();
  const ventana = 15 * 60 * 1000; // 15 minutos
  const limite = 20;

  const registro = rateLimitMap.get(ip) || { count: 0, desde: ahora };
  if (ahora - registro.desde > ventana) {
    registro.count = 0;
    registro.desde = ahora;
  }
  registro.count++;
  rateLimitMap.set(ip, registro);

  if (registro.count > limite) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta en unos minutos.' });
  }
  next();
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (FRONTEND_ORIGIN && origin === FRONTEND_ORIGIN) {
    res.header('Access-Control-Allow-Origin', FRONTEND_ORIGIN);
  } else if (!FRONTEND_ORIGIN) {
    // Sin variable configurada: rechaza silenciosamente (no envía el header)
  } else if (!origin) {
    // Petición sin Origin (ej. Postman, curl) — permitir para facilitar pruebas locales
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
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

/* ---- GET /ordenes ---- */
app.get('/ordenes', (req, res) => {
  const { fecha, estado } = req.query;

  let sql = 'SELECT * FROM ordenes WHERE 1=1';
  const params = [];

  if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    sql += ' AND fecha_iso LIKE ?';
    params.push(`${fecha}%`);
  }
  if (estado && ['pendiente', 'preparada'].includes(estado)) {
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

/* ---- PATCH /ordenes/:numero ---- */
app.patch('/ordenes/:numero', (req, res) => {
  const { numero } = req.params;
  const { estado } = req.body ?? {};

  if (!/^LM-\d{8}-\d{4}$/.test(numero)) {
    return res.status(400).json({ error: 'Número de orden inválido.' });
  }
  if (!['pendiente', 'preparada'].includes(estado)) {
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

server.listen(PORT, () => {
  console.log(`[server] Panadería Luz Marina backend escuchando en http://localhost:${PORT}`);
});

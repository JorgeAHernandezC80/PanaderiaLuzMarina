/**
 * PANADERÍA LUZ MARINA — Backend: Servidor
 * Express + SQLite + WebSocket.
 *
 * Endpoints:
 *   POST /ordenes         — crea una orden (consumido por checkout.js)
 *   GET  /ordenes          — lista órdenes del día (consumido por admin.html)
 *   PATCH /ordenes/:numero — cambia estado (ej. "preparada")
 *
 * WebSocket en el mismo puerto: cuando entra una orden nueva,
 * se hace broadcast a todos los clientes conectados (el panel admin
 * se actualiza solo, sin recargar ni hacer polling).
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const db = require('./db');
const { validarOrden, ValidationError } = require('./validation');

const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json({ limit: '100kb' })); // límite duro: una orden nunca pesa esto

// CORS mínimo — Laragon sirve el frontend en otro puerto/host.
// En producción, restringir ORIGIN a un dominio fijo, no a '*'.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.FRONTEND_ORIGIN || '*');
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

/* ---- POST /ordenes — crear orden ---- */
app.post('/ordenes', (req, res) => {
  let orden;
  try {
    orden = validarOrden(req.body);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  const sql = `
    INSERT INTO ordenes (numero, fecha_iso, fecha_texto, cliente, telefono, retiro, items_json, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    orden.numero, orden.fechaISO, orden.fechaTexto, orden.cliente,
    orden.telefono, orden.retiro, JSON.stringify(orden.items), orden.total,
  ];

  db.run(sql, params, function (err) {
    if (err) {
      const esConflicto = err.code === 'SQLITE_CONSTRAINT'
        || /UNIQUE constraint failed/i.test(err.message || '');
      if (esConflicto) {
        return res.status(409).json({ error: 'Ya existe una orden con ese número.' });
      }
      console.error('[POST /ordenes]', err.message);
      return res.status(500).json({ error: 'Error al guardar la orden.' });
    }

    const ordenGuardada = { ...orden, estado: 'pendiente' };
    broadcast({ tipo: 'orden:nueva', orden: ordenGuardada });
    res.status(201).json(ordenGuardada);
  });
});

/* ---- GET /ordenes — listar (panel admin) ---- */
app.get('/ordenes', (req, res) => {
  const { fecha, estado } = req.query;

  let sql = 'SELECT * FROM ordenes WHERE 1=1';
  const params = [];

  // fecha=YYYY-MM-DD — filtra por día exacto
  if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
    sql += ' AND fecha_iso LIKE ?';
    params.push(`${fecha}%`);
  }
  if (estado && ['pendiente', 'preparada'].includes(estado)) {
    sql += ' AND estado = ?';
    params.push(estado);
  }
  sql += ' ORDER BY fecha_iso DESC LIMIT 200';

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error('[GET /ordenes]', err.message);
      return res.status(500).json({ error: 'Error al consultar órdenes.' });
    }
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
  });
});

/* ---- PATCH /ordenes/:numero — marcar como preparada ---- */
app.patch('/ordenes/:numero', (req, res) => {
  const { numero } = req.params;
  const { estado } = req.body ?? {};

  if (!/^LM-\d{8}-\d{4}$/.test(numero)) {
    return res.status(400).json({ error: 'Número de orden inválido.' });
  }
  if (!['pendiente', 'preparada'].includes(estado)) {
    return res.status(400).json({ error: 'Estado inválido.' });
  }

  db.run('UPDATE ordenes SET estado = ? WHERE numero = ?', [estado, numero], function (err) {
    if (err) {
      console.error('[PATCH /ordenes/:numero]', err.message);
      return res.status(500).json({ error: 'Error al actualizar la orden.' });
    }
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Orden no encontrada.' });
    }
    broadcast({ tipo: 'orden:actualizada', numero, estado });
    res.json({ numero, estado });
  });
});

/* ---- 404 y manejo de errores ---- */
app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

app.use((err, req, res, next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

server.listen(PORT, () => {
  console.log(`[server] Panadería Luz Marina backend escuchando en http://localhost:${PORT}`);
});
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
const { convertirAGramos, costoPorGramo } = require('./units');

/* Zona horaria de referencia del negocio (Houston). El backend calcula
   "hoy" con esto cuando no viene fecha explícita en la petición (ej.
   GET /horneadas sin ?fecha=) — nunca con
   new Date().toISOString().slice(0, 10), que da la fecha en UTC y se
   adelanta un día por las noches (Houston va 5-6h detrás de UTC). */
const HOUSTON_TZ = 'America/Chicago';

function hoyHouston() {
  return new Date().toLocaleDateString('en-CA', { timeZone: HOUSTON_TZ });
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
  PRODUCTOS_CATALOGO,
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
  for (const [id, producto] of Object.entries(PRODUCTOS_CATALOGO)) {
    const entry = {
      productoId: String(id),
      productoNombre: producto.nombre,
      horneado: 0,
      preparado: 0,
      vendido: 0,
      ajustes: 0,
    };
    porProducto.set(producto.nombre, entry);
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
   RECETAS — ficha técnica por producto (ingredientes + peso por unidad).
   Es la base de la que depende Producción.
   ═══════════════════════════════════════════ */
function serializeReceta(row, ingredientes) {
  return {
    id: row.id,
    productoId: row.producto_id,
    productoNombre: row.producto_nombre,
    categoria: PRODUCTOS_CATALOGO[Number(row.producto_id)]?.categoria ?? null,
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

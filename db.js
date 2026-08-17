/**
 * PANADERÍA LUZ MARINA — Backend: Base de datos
 * better-sqlite3: API síncrona, mejor compatibilidad con entornos Linux (Render).
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'luzmarina.db');

let db;
try {
  db = new Database(DB_PATH);

  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  /* Migración: agregar actualizado_en a ordenes (insumos/horneadas/
     producciones ya lo tenían; ordenes se quedó atrás). Sin esto, el
     Reporte Clínico no tiene forma de calcular cuánto tardó una orden en
     pasar de "pendiente" a "entregada" — solo existe el momento de
     creación, nunca el de la última actualización de estado. */
  const ordenesExiste = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ordenes'")
    .get();
  if (ordenesExiste) {
    const columnasActuales = db
      .prepare('PRAGMA table_info(ordenes)')
      .all()
      .map((c) => c.name);
    if (!columnasActuales.includes('actualizado_en')) {
      console.log('[db] Agregando columna ordenes.actualizado_en (migración)...');
      db.exec(
        "ALTER TABLE ordenes ADD COLUMN actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))",
      );
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ordenes (
      numero        TEXT PRIMARY KEY,
      fecha_iso     TEXT NOT NULL,
      fecha_texto   TEXT NOT NULL,
      cliente       TEXT NOT NULL,
      telefono      TEXT NOT NULL,
      retiro        TEXT NOT NULL,
      items_json    TEXT NOT NULL,
      total         REAL NOT NULL,
      estado        TEXT NOT NULL DEFAULT 'pendiente',
      creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_ordenes_fecha ON ordenes(fecha_iso)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ordenes_estado ON ordenes(estado)');

  /* Metadatos del checkout. El pedido se cierra por WhatsApp, sin pasarela:
     el único momento en que el navegador del cliente habla con nosotros es
     el POST /ordenes, así que es ahí o nunca. Sin esto no hay forma de
     responder "¿cuánta venta real entra por teléfono?" y priorizar la UX
     móvil con datos en vez de intuición.
     Sobre "localización aproximada": no se guarda IP ni coordenadas (dato
     personal que el negocio no necesita). La zona horaria IANA y el idioma
     que declara el navegador ubican al cliente con la granularidad que
     sirve para operar — región y lengua —, y no identifican a nadie. */
  for (const [columna, tipo] of [
    ['user_agent', 'TEXT'],
    ['dispositivo', 'TEXT'],
    ['zona_horaria', 'TEXT'],
    ['idioma', 'TEXT'],
  ]) {
    const columnasOrdenes = db
      .prepare('PRAGMA table_info(ordenes)')
      .all()
      .map((c) => c.name);
    if (!columnasOrdenes.includes(columna)) {
      console.log(`[db] Agregando columna ordenes.${columna} (migración)...`);
      db.exec(`ALTER TABLE ordenes ADD COLUMN ${columna} ${tipo}`);
    }
  }

  /* Historial de estados de las órdenes. `ordenes.estado` se sobreescribe
     en cada paso, así que por sí solo no dice cuánto tardó el pedido en
     cada etapa: al pasar de 'pendiente' a 'entregada' el tiempo que estuvo
     'en_preparacion' desaparece. Cada transición se guarda acá como una
     fila nueva (append-only), y de ahí salen el lead time por etapa y el
     cuello de botella de la cocina.
     estado_origen es NULL en la fila de creación del pedido: nada precede
     al primer estado, y usar 'pendiente' ahí falsearía una transición que
     nunca ocurrió. El id autoincremental desempata dos transiciones del
     mismo segundo, igual que en orden_compra_eventos. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS orden_status_log (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_numero   TEXT NOT NULL REFERENCES ordenes(numero) ON DELETE CASCADE,
      estado_origen  TEXT,
      estado_destino TEXT NOT NULL,
      usuario_admin  TEXT,
      sesion_admin   TEXT,
      fecha_hora     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_orden_status_log_orden ON orden_status_log(orden_numero, id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_orden_status_log_fecha ON orden_status_log(fecha_hora, estado_destino)',
  );

  /* Relleno inicial para los pedidos que ya estaban en la base antes de que
     existiera el historial. Solo se escribe lo que la propia fila prueba:
     el pedido nació (creado_en) y, si su estado ya no es 'pendiente', llegó
     a su estado actual (actualizado_en). Los pasos intermedios NO se
     inventan — no quedó registro de ellos, y rellenarlos con horas
     estimadas contaminaría justo la métrica que este historial existe para
     medir. Esas transiciones quedan marcadas con sesion_admin =
     'migracion' para poder excluirlas de cualquier análisis. */
  const logVacio =
    db.prepare('SELECT COUNT(*) AS n FROM orden_status_log').get().n === 0 &&
    db.prepare('SELECT COUNT(*) AS n FROM ordenes').get().n > 0;
  if (logVacio) {
    console.log('[db] Rellenando orden_status_log con el historial conocido de ordenes...');
    const insertar = db.prepare(`
      INSERT INTO orden_status_log
        (orden_numero, estado_origen, estado_destino, usuario_admin, sesion_admin, fecha_hora)
      VALUES (?, NULL, ?, NULL, 'migracion', ?)
    `);
    const rellenar = db.transaction(() => {
      for (const fila of db
        .prepare('SELECT numero, estado, creado_en, actualizado_en FROM ordenes')
        .all()) {
        insertar.run(fila.numero, 'pendiente', fila.creado_en);
        if (fila.estado !== 'pendiente')
          insertar.run(fila.numero, fila.estado, fila.actualizado_en);
      }
    });
    rellenar();
  }

  /* Migración: si la tabla insumos ya existía de una versión anterior (por
     ejemplo, tu base de datos local mientras probabas el panel), le pueden
     faltar columnas agregadas después. A diferencia de proveedores (una
     columna renombrada), aquí solo se agregan columnas nuevas —
     ALTER TABLE ADD COLUMN es seguro y nunca toca los datos existentes. */
  const insumosExiste = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'insumos'")
    .get();
  if (insumosExiste) {
    const columnasActuales = db
      .prepare('PRAGMA table_info(insumos)')
      .all()
      .map((c) => c.name);
    const columnasNuevas = {
      marca: 'TEXT',
      fecha_vencimiento: 'TEXT',
      ubicacion: 'TEXT',
      sku: 'TEXT',
      stock_maximo: 'REAL',
      presentacion_compra: 'TEXT',
      condiciones_almacenamiento: 'TEXT',
      lote_proveedor: 'TEXT',
      vida_util_abierto_dias: 'INTEGER',
      proveedor_secundario: 'TEXT',
      lead_time_dias: 'INTEGER',
      impuesto_porcentaje: 'REAL',
      alergenos: 'TEXT',
      equivalencia_gramos: 'REAL',
    };
    for (const [columna, tipo] of Object.entries(columnasNuevas)) {
      if (!columnasActuales.includes(columna)) {
        console.log(`[db] Agregando columna insumos.${columna} (migración)...`);
        db.exec(`ALTER TABLE insumos ADD COLUMN ${columna} ${tipo}`);
      }
    }
  }

  /* Migración: activo (0/1) -> estado (activo/borrador/agotado/
     descontinuado) + sku/descripcion/actualizado_por nuevas. SQLite no
     permite cambiar el tipo de una columna existente con ALTER TABLE —
     mismo procedimiento de reconstrucción ya usado para insumo_id
     (sección de receta_ingredientes/produccion_ingredientes): crear
     tabla nueva, copiar datos, borrar la vieja, renombrar. Acá no hace
     falta tocar `PRAGMA foreign_keys` como allá porque ninguna tabla
     referencia productos(id) — el resto guarda producto_id sin FK.
     Los productos que estaban activo=0 pasan a 'agotado' (no
     'descontinuado') — es la lectura más segura de un valor booleano
     que no decía POR QUÉ estaba desactivado; revísalos y ajústalos a
     mano si alguno en realidad ya no se vende más. */
  function migrarProductosEstadoYMetadata() {
    const existe = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'productos'")
      .get();
    if (!existe) return; // base de datos nueva: el CREATE TABLE de abajo ya crea el esquema final

    const columnas = db
      .prepare('PRAGMA table_info(productos)')
      .all()
      .map((c) => c.name);
    if (columnas.includes('estado')) return; // ya migrada en un arranque anterior

    console.log(
      '[db] Reconstruyendo productos: activo -> estado + sku/descripcion/actualizado_por (migración)...',
    );
    const migrar = db.transaction(() => {
      db.exec(`
        CREATE TABLE productos_nueva (
          id              INTEGER PRIMARY KEY,
          nombre          TEXT NOT NULL,
          categoria       TEXT NOT NULL,
          precio          REAL NOT NULL CHECK (precio > 0 AND precio <= 1000),
          estado          TEXT NOT NULL DEFAULT 'activo'
                            CHECK (estado IN ('activo', 'borrador', 'agotado', 'descontinuado')),
          sku             TEXT UNIQUE,
          descripcion     TEXT,
          actualizado_por TEXT,
          creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
          actualizado_en  TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.exec(`
        INSERT INTO productos_nueva (id, nombre, categoria, precio, estado, creado_en, actualizado_en)
        SELECT id, nombre, categoria, precio,
               CASE WHEN activo = 1 THEN 'activo' ELSE 'agotado' END,
               creado_en, actualizado_en
        FROM productos
      `);
      db.exec('DROP TABLE productos');
      db.exec('ALTER TABLE productos_nueva RENAME TO productos');
    });
    migrar();
  }
  migrarProductosEstadoYMetadata();

  /* Productos: antes vivían fijos en código (PRODUCTOS_CATALOGO, en
     validation.js) — 9 productos con id numérico 1-9, sin precio
     guardado en ningún lado (el precio real solo existía como texto
     en catalogo.html, nunca se validaba contra nada del lado del
     servidor — hueco de seguridad real, cualquiera podía mandar el
     precio que quisiera en un pedido). Ahora es una tabla real.

     La siembra usa los MISMOS ids 1-9 y los MISMOS precios que ya
     estaban en catalogo.html — así ninguna receta/producción/
     horneada/orden/ajuste que ya guardó ese productoId se rompe, y
     ningún precio cambia solo por migrar de código a base de datos. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS productos (
      id              INTEGER PRIMARY KEY,
      nombre          TEXT NOT NULL,
      categoria       TEXT NOT NULL,
      precio          REAL NOT NULL CHECK (precio > 0 AND precio <= 1000),
      estado          TEXT NOT NULL DEFAULT 'activo'
                        CHECK (estado IN ('activo', 'borrador', 'agotado', 'descontinuado')),
      sku             TEXT UNIQUE,
      descripcion     TEXT,
      actualizado_por TEXT,
      creado_en       TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  /* Migración: imagen_base + alt_imagen. El catálogo público (catalogo.html)
     tenía las 9 tarjetas escritas a mano —imagen, descripción, i18n— y solo
     el precio/nombre se sincronizaban desde /catalogo. Para que un producto
     nuevo aparezca solo, las tarjetas ahora se arman en JS a partir de
     GET /catalogo, que necesita de dónde sacar la imagen. ALTER TABLE ADD
     COLUMN, mismo patrón no destructivo que insumos: no rompe filas
     existentes, columnas quedan NULL hasta que algo las llene. */
  const columnasProductos = db
    .prepare('PRAGMA table_info(productos)')
    .all()
    .map((c) => c.name);
  if (!columnasProductos.includes('imagen_base')) {
    db.exec('ALTER TABLE productos ADD COLUMN imagen_base TEXT');
  }
  if (!columnasProductos.includes('alt_imagen')) {
    db.exec('ALTER TABLE productos ADD COLUMN alt_imagen TEXT');
  }
  /* Migración: vida_util_horas — cuántas horas se considera fresco un
     lote de este producto después de horneado. Es el dato que le falta
     a probabilidadVencimiento (ver estadisticas.js) para saber si un
     lote se vendió a tiempo o no; sin esto, esa métrica no se puede
     calcular en absoluto (queda en null hasta que alguien lo configure
     desde el panel). */
  if (!columnasProductos.includes('vida_util_horas')) {
    db.exec('ALTER TABLE productos ADD COLUMN vida_util_horas REAL');
  }
  /* Migración: caché de estadísticas sobre el propio producto (Patrón 1,
     "Flujo Operativo Automático" — AnalyticsEngine.enriquecerProductoConEstadisticas).
     Antes estos 5 indicadores se calculaban al vuelo en cada
     GET /productos/estadisticas, recorriendo 90 días de órdenes/horneadas
     por producto en cada llamada. Ahora se guardan acá y solo se
     recalculan cuando el caché está viejo — ver
     analyticsEngine.js:necesitaRecalculo. factor_estacionalidad y
     probabilidad_vencimiento son objetos, se guardan como TEXT (JSON). */
  const columnasEstadisticas = [
    'tasa_rotacion_diaria REAL',
    'desviacion_estandar_demanda REAL',
    'factor_estacionalidad TEXT',
    'tasa_merma_historica REAL',
    'probabilidad_vencimiento TEXT',
    'estadisticas_dias_considerados INTEGER',
    'estadisticas_actualizado_en TEXT',
  ];
  for (const definicion of columnasEstadisticas) {
    const nombreColumna = definicion.split(' ')[0];
    if (!columnasProductos.includes(nombreColumna)) {
      db.exec(`ALTER TABLE productos ADD COLUMN ${definicion}`);
    }
  }

  const productosSemilla = [
    {
      id: 1,
      nombre: 'Donuts Glaseadas',
      categoria: 'frituras',
      precio: 1.5,
      imagenBase: 'donuts',
      altImagen: 'Donuts glaseadas',
      descripcion: 'Suaves por dentro, crujientes por fuera, con glaseado de vainilla.',
    },
    {
      id: 2,
      nombre: 'Buñuelos',
      categoria: 'frituras',
      precio: 2.5,
      imagenBase: 'bunuelos',
      altImagen: 'Buñuelos colombianos',
      descripcion:
        'Buñuelos dorados de masa de queso, crujientes por fuera y suaves por dentro. Un clásico colombiano para acompañar el café.',
    },
    {
      id: 3,
      nombre: 'Roscón de Arequipe',
      categoria: 'reposteria',
      precio: 2.5,
      imagenBase: 'roscon-de-arequipe',
      altImagen: 'Roscón relleno de arequipe o guayaba',
      descripcion:
        'Suave y esponjoso, relleno de arequipe o guayaba. Ideal para acompañar el café o la merienda.',
    },
    {
      id: 4,
      nombre: 'Croissant',
      categoria: 'bolleria',
      precio: 2.0,
      imagenBase: 'croissant',
      altImagen: 'Croissants con dulce de leche',
      descripcion: 'Hojaldre crujiente con mantequilla, acompañado de dulce de leche.',
    },
    {
      id: 5,
      nombre: 'Almojábanas',
      categoria: 'panaderia',
      precio: 2.5,
      imagenBase: 'almojabana',
      altImagen: 'Almojábanas colombianas',
      descripcion:
        'Panecillos tradicionales de harina de maíz y queso. Crujientes por fuera, esponjosos por dentro. Perfectas con café o chocolate.',
    },
    {
      id: 6,
      nombre: 'Pandebono',
      categoria: 'panaderia',
      precio: 2.5,
      imagenBase: 'pandebono',
      altImagen: 'Pandebono colombiano',
      descripcion:
        'Panecillo del Valle del Cauca, hecho con almidón de yuca y queso costeño. Crujiente por fuera, esponjoso por dentro.',
    },
    {
      id: 7,
      nombre: 'Pan de Yuca',
      categoria: 'panaderia',
      precio: 2.5,
      imagenBase: 'pan-de-yuca',
      altImagen: 'Pan de yuca colombiano tradicional',
      descripcion:
        'Hecho con almidón de yuca, queso y huevo. Suave, esponjoso y con delicioso sabor a queso. Perfecto solo o con chocolate.',
    },
    {
      id: 8,
      nombre: 'Conchas',
      categoria: 'reposteria',
      precio: 1.75,
      imagenBase: 'pan-concha',
      altImagen: 'Conchas de vainilla y chocolate',
      descripcion:
        'Pan dulce tradicional con su clásica cubierta crujiente de vainilla o chocolate. Perfectas para el desayuno o la merienda.',
    },
    {
      id: 9,
      nombre: 'Pan mariquiteño',
      categoria: 'reposteria',
      precio: 2.5,
      imagenBase: 'pan-mariquiteño',
      altImagen: 'Pan mariquiteño colombiano',
      descripcion:
        'Un pan que destaca por su distintiva forma curva, su textura suave y su rico aroma. Perfecto para acompañar el café o la merienda.',
    },
  ];
  const insertarProducto = db.prepare(
    'INSERT OR IGNORE INTO productos (id, nombre, categoria, precio) VALUES (?, ?, ?, ?)',
  );
  const sembrarProductos = db.transaction((filas) => {
    for (const p of filas) insertarProducto.run(p.id, p.nombre, p.categoria, p.precio);
  });
  sembrarProductos(productosSemilla);

  /* Backfill para instalaciones que ya tenían la tabla productos de antes
     de imagen_base/alt_imagen/descripcion (INSERT OR IGNORE de arriba no
     toca filas que ya existen). Solo llena lo que esté vacío — si alguien
     ya editó la descripción o la imagen desde el panel, esto no la pisa. */
  const backfillProducto = db.prepare(`
    UPDATE productos
    SET imagen_base = COALESCE(imagen_base, ?),
        alt_imagen = COALESCE(alt_imagen, ?),
        descripcion = COALESCE(descripcion, ?)
    WHERE id = ?
  `);
  const backfillProductos = db.transaction((filas) => {
    for (const p of filas) backfillProducto.run(p.imagenBase, p.altImagen, p.descripcion, p.id);
  });
  backfillProductos(productosSemilla);

  db.exec(`
    CREATE TABLE IF NOT EXISTS insumos (
      id                          TEXT PRIMARY KEY,
      nombre                      TEXT NOT NULL,
      categoria                   TEXT NOT NULL DEFAULT 'otros',
      cantidad                    REAL NOT NULL,
      unidad                      TEXT NOT NULL,
      costo_unitario              REAL,
      stock_minimo                REAL,
      stock_maximo                REAL,
      proveedor                   TEXT,
      proveedor_secundario        TEXT,
      marca                       TEXT,
      sku                         TEXT,
      fecha_vencimiento           TEXT,
      ubicacion                   TEXT,
      presentacion_compra         TEXT,
      condiciones_almacenamiento  TEXT,
      lote_proveedor              TEXT,
      vida_util_abierto_dias      INTEGER,
      lead_time_dias              INTEGER,
      impuesto_porcentaje         REAL,
      alergenos                   TEXT,
      equivalencia_gramos         REAL,
      notas                       TEXT,
      creado_en                   TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en              TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_insumos_nombre ON insumos(nombre)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_insumos_fecha_vencimiento ON insumos(fecha_vencimiento)');

  /* Migración: la tabla proveedores pudo haber sido creada por una
     implementación anterior con la columna nombre_legal. CREATE TABLE
     IF NOT EXISTS no toca una tabla que ya existe, así que si detectamos
     el esquema viejo la renombramos a un respaldo, dejamos que se cree
     la tabla nueva más abajo, y luego copiamos los datos preservando
     cualquier proveedor ya guardado. */
  const proveedoresInfo = db.prepare('PRAGMA table_info(proveedores)').all();
  const proveedoresColumnas = proveedoresInfo.map((c) => c.name);
  const proveedoresEsquemaViejo =
    proveedoresColumnas.includes('nombre_legal') && !proveedoresColumnas.includes('razon_social');

  if (proveedoresEsquemaViejo) {
    console.log(
      '[db] Migrando tabla proveedores del esquema antiguo (nombre_legal) al nuevo (razon_social)...',
    );
    db.exec('ALTER TABLE proveedores RENAME TO proveedores_legacy_backup');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS proveedores (
      id                     TEXT PRIMARY KEY,
      razon_social           TEXT NOT NULL,
      nombre_comercial       TEXT,
      identificacion_fiscal  TEXT,
      giro_comercial         TEXT,
      direccion              TEXT,
      codigo_postal          TEXT,
      ciudad                 TEXT,
      pais                   TEXT,
      contacto_nombre        TEXT,
      email_facturacion      TEXT,
      email_contacto         TEXT,
      telefono_fijo          TEXT,
      celular                TEXT,
      banco                  TEXT,
      numero_cuenta          TEXT,
      clabe_iban             TEXT,
      condiciones_pago       TEXT NOT NULL DEFAULT 'contado',
      moneda                 TEXT NOT NULL DEFAULT 'COP',
      metodo_facturacion     TEXT,
      lead_time_dias         REAL,
      pedido_minimo          REAL,
      politicas_devolucion   TEXT,
      certificaciones        TEXT,
      notas                  TEXT,
      creado_en              TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en         TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_proveedores_razon ON proveedores(razon_social)');

  if (proveedoresEsquemaViejo) {
    db.exec(`
      INSERT INTO proveedores (
        id, razon_social, nombre_comercial, identificacion_fiscal, giro_comercial,
        direccion, contacto_nombre, email_facturacion, email_contacto,
        telefono_fijo, celular, banco, numero_cuenta, clabe_iban,
        condiciones_pago, moneda, metodo_facturacion, lead_time_dias,
        pedido_minimo, politicas_devolucion, certificaciones, notas,
        creado_en, actualizado_en
      )
      SELECT
        id, nombre_legal, nombre_comercial, identificacion_fiscal, giro_comercial,
        direccion, contacto_nombre, email_general, email_contacto,
        telefono_empresa, telefono_celular, banco, numero_cuenta, clabe_iban,
        COALESCE(NULLIF(condiciones_pago, ''), 'contado'),
        COALESCE(NULLIF(moneda, ''), 'COP'),
        metodo_facturacion, lead_time_dias, pedido_minimo, politicas_devolucion,
        certificaciones, notas, creado_en, actualizado_en
      FROM proveedores_legacy_backup
    `);
    console.log(
      '[db] Migración completada. Respaldo conservado en la tabla proveedores_legacy_backup.',
    );
  }
  /* Migración: agrega a horneadas los campos "reales" de horneado (lo que
     de verdad pasó en esa tanda), para comparar contra el objetivo que
     vive en recetas — mismo patrón no destructivo que insumos. */
  const horneadasExiste = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'horneadas'")
    .get();
  if (horneadasExiste) {
    const columnasActuales = db
      .prepare('PRAGMA table_info(horneadas)')
      .all()
      .map((c) => c.name);
    const columnasNuevas = {
      temperatura_horneado_real_c: 'REAL',
      tiempo_horneado_real_min: 'INTEGER',
      merma_real_pct: 'REAL',
      // Nuevas (medición/análisis/resultados de horneado artesanal). Todas
      // opcionales (NULL permitido) — no toda horneada necesita este nivel
      // de detalle. Rangos generosos pero reales, mismo criterio que las
      // columnas de arriba (ver MAX_* equivalentes en validation.js).
      temperatura_piso_horno_c:
        'INTEGER CHECK (temperatura_piso_horno_c IS NULL OR (temperatura_piso_horno_c >= 50 AND temperatura_piso_horno_c <= 500))',
      peso_pan_cocido_total_g:
        'REAL CHECK (peso_pan_cocido_total_g IS NULL OR peso_pan_cocido_total_g > 0)',
      costo_estimado_energia_lote:
        'REAL CHECK (costo_estimado_energia_lote IS NULL OR costo_estimado_energia_lote >= 0)',
      // Cruce con la MISMA fila (SQLite sí puede validar esto en un CHECK,
      // a diferencia de comparar contra otra tabla): no puede haber más
      // panes de segunda calidad que panes horneados en total.
      unidades_segunda_calidad:
        'INTEGER CHECK (unidades_segunda_calidad IS NULL OR (unidades_segunda_calidad >= 0 AND unidades_segunda_calidad <= cantidad))',
    };
    for (const [columna, tipo] of Object.entries(columnasNuevas)) {
      if (!columnasActuales.includes(columna)) {
        console.log(`[db] Agregando columna horneadas.${columna} (migración)...`);
        db.exec(`ALTER TABLE horneadas ADD COLUMN ${columna} ${tipo}`);
      }
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS horneadas (
      id                            TEXT PRIMARY KEY,
      producto_id                   TEXT NOT NULL,
      producto_nombre               TEXT NOT NULL,
      cantidad                      INTEGER NOT NULL,
      fecha                         TEXT NOT NULL,
      hora                          TEXT NOT NULL,
      registrado_por                TEXT,
      notas                         TEXT,
      produccion_id                 TEXT,
      temperatura_horneado_real_c   REAL,
      tiempo_horneado_real_min      INTEGER,
      merma_real_pct                REAL,
      temperatura_piso_horno_c      INTEGER CHECK (temperatura_piso_horno_c IS NULL OR (temperatura_piso_horno_c >= 50 AND temperatura_piso_horno_c <= 500)),
      peso_pan_cocido_total_g       REAL CHECK (peso_pan_cocido_total_g IS NULL OR peso_pan_cocido_total_g > 0),
      costo_estimado_energia_lote   REAL CHECK (costo_estimado_energia_lote IS NULL OR costo_estimado_energia_lote >= 0),
      unidades_segunda_calidad      INTEGER CHECK (unidades_segunda_calidad IS NULL OR (unidades_segunda_calidad >= 0 AND unidades_segunda_calidad <= cantidad)),
      creado_en                     TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en                TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_horneadas_fecha ON horneadas(fecha)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_horneadas_producto ON horneadas(producto_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_horneadas_produccion ON horneadas(produccion_id)');

  /* Ajustes de inventario: mermas, errores de conteo, consumo interno, etc.
     Se restan del disponible junto con lo preparado/vendido del día. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS ajustes_inventario (
      id               TEXT PRIMARY KEY,
      producto_id      TEXT NOT NULL,
      producto_nombre  TEXT NOT NULL,
      cantidad         INTEGER NOT NULL,
      motivo           TEXT NOT NULL DEFAULT 'merma',
      fecha            TEXT NOT NULL,
      hora             TEXT NOT NULL,
      registrado_por   TEXT,
      notas            TEXT,
      creado_en        TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en   TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_ajustes_inventario_fecha ON ajustes_inventario(fecha)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_ajustes_inventario_producto ON ajustes_inventario(producto_id)',
  );

  /* Stock mínimo configurable por producto, para las alertas de "quiebre de
     stock" en la pestaña Inventario. Una fila por producto; si no existe,
     el backend aplica un default razonable al calcular el inventario. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS producto_stock_minimo (
      producto_id     TEXT PRIMARY KEY,
      stock_minimo    INTEGER NOT NULL DEFAULT 5,
      actualizado_en  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  /* ═══════════════════════════════════════════
     RECETAS — ficha técnica por producto: qué ingredientes lleva, en qué
     proporción, y cuánto pesa cada unidad. Es la base de la que depende
     Producción (no registra nada del día a día por sí sola).
     ═══════════════════════════════════════════ */
  /* Migración: agrega a recetas los campos "objetivo" de ficha técnica
     que faltaban (horneado, mano de obra, merma esperada, pasos) —
     mismo patrón no destructivo que insumos/horneadas. */
  const recetasExiste = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recetas'")
    .get();
  if (recetasExiste) {
    const columnasActuales = db
      .prepare('PRAGMA table_info(recetas)')
      .all()
      .map((c) => c.name);
    const columnasNuevas = {
      tiempo_horneado_min: 'INTEGER',
      temperatura_horneado_c: 'REAL',
      tiempo_mano_obra_min: 'INTEGER',
      merma_coccion_pct: 'REAL',
      pasos: 'TEXT',
      // Hidratación OBJETIVO de la ficha técnica (no se deriva de
      // receta_ingredientes: ese cálculo asumiría cuál ingrediente es
      // "la harina" y cuál "el agua" por nombre, frágil; esto es un
      // valor que el panadero define a propósito).
      hidratacion_objetivo_porcentaje:
        'REAL CHECK (hidratacion_objetivo_porcentaje IS NULL OR (hidratacion_objetivo_porcentaje > 0 AND hidratacion_objetivo_porcentaje <= 150))',
    };
    for (const [columna, tipo] of Object.entries(columnasNuevas)) {
      if (!columnasActuales.includes(columna)) {
        console.log(`[db] Agregando columna recetas.${columna} (migración)...`);
        db.exec(`ALTER TABLE recetas ADD COLUMN ${columna} ${tipo}`);
      }
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS recetas (
      id                              TEXT PRIMARY KEY,
      producto_id                     TEXT NOT NULL UNIQUE,
      producto_nombre                 TEXT NOT NULL,
      peso_masa_por_unidad_g          REAL NOT NULL,
      tiempo_fermentacion_min         INTEGER,
      tiempo_horneado_min             INTEGER,
      temperatura_horneado_c          REAL,
      tiempo_mano_obra_min            INTEGER,
      merma_coccion_pct               REAL,
      pasos                           TEXT,
      hidratacion_objetivo_porcentaje REAL CHECK (hidratacion_objetivo_porcentaje IS NULL OR (hidratacion_objetivo_porcentaje > 0 AND hidratacion_objetivo_porcentaje <= 150)),
      notas                           TEXT,
      creado_en                       TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en                  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  /* Migración: agregar FOREIGN KEY a insumo_id en receta_ingredientes y
     produccion_ingredientes. Antes era un TEXT suelto sin ninguna relación
     declarada — se podía borrar un insumo usado en una receta o producción
     y dejar el registro huérfano sin que nada lo impidiera (a diferencia de
     receta_id/produccion_id, que sí tenían FK desde el principio).
     SQLite no permite agregar una FK con ALTER TABLE a una columna ya
     existente — hay que reconstruir la tabla completa (crear nueva con la
     FK, copiar filas, borrar la vieja, renombrar), siguiendo el
     procedimiento que la propia documentación de SQLite recomienda para
     este tipo de cambio de esquema. */
  function migrarForeignKeyInsumoId(tabla, columnasDef, indiceSQL) {
    const existe = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tabla);
    if (!existe) return; // Base de datos nueva: el CREATE TABLE de abajo ya la crea bien.

    const yaTieneFk = db
      .prepare(`PRAGMA foreign_key_list(${tabla})`)
      .all()
      .some((fk) => fk.from === 'insumo_id');
    if (yaTieneFk) return; // Ya migrada en un arranque anterior.

    // Chequeo de seguridad: si ya hay filas con un insumo_id que apunta a
    // un insumo borrado hace tiempo (de antes de que existiera cualquier
    // bloqueo), agregar la FK ahora rompería la migración a medio camino
    // y el servidor no arrancaría más. Se detiene y avisa en el log en vez
    // de dejar la base de datos en un estado a medio migrar.
    const huerfanas = db
      .prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE insumo_id NOT IN (SELECT id FROM insumos)`)
      .get().n;
    if (huerfanas > 0) {
      console.error(
        `[db] ${tabla} tiene ${huerfanas} fila(s) con insumo_id que ya no existe en insumos — ` +
          `no se puede agregar la Foreign Key hasta resolver eso a mano (revisar y corregir esas ` +
          `filas, o el insumo que falta). Se omite esta migración por ahora; el resto del arranque ` +
          `sigue normal.`,
      );
      return;
    }

    console.log(
      `[db] Reconstruyendo ${tabla} para agregar Foreign Key en insumo_id (migración)...`,
    );
    // OJO con esto — verificado a mano antes de escribirlo así: SQLite
    // ignora en silencio cualquier cambio a `PRAGMA foreign_keys` mientras
    // hay una transacción abierta. Ponerlo DENTRO de db.transaction() (como
    // estaba en un borrador anterior de este código) habría dejado las
    // Foreign Keys de TODA la base de datos apagadas por el resto de la
    // vida del proceso, no solo las de esta tabla — un bug silencioso y
    // grave. Por eso el `ON` final va DESPUÉS de que la transacción ya
    // cerró, no adentro.
    const migrar = db.transaction(() => {
      db.exec(`CREATE TABLE ${tabla}_nueva (${columnasDef})`);
      db.exec(`INSERT INTO ${tabla}_nueva SELECT * FROM ${tabla}`);
      db.exec(`DROP TABLE ${tabla}`);
      db.exec(`ALTER TABLE ${tabla}_nueva RENAME TO ${tabla}`);
      db.exec(indiceSQL);
    });
    migrar();
    db.pragma('foreign_keys = ON');
  }

  migrarForeignKeyInsumoId(
    'receta_ingredientes',
    `id                    TEXT PRIMARY KEY,
     receta_id             TEXT NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
     insumo_id             TEXT NOT NULL REFERENCES insumos(id),
     insumo_nombre         TEXT NOT NULL,
     gramos                REAL NOT NULL,
     orden                 INTEGER NOT NULL DEFAULT 0`,
    'CREATE INDEX IF NOT EXISTS idx_receta_ingredientes_receta ON receta_ingredientes(receta_id)',
  );

  /* Ingredientes de una receta, referenciando el catálogo de Insumos por id
     (no por texto libre) para que el costo y las unidades siempre crucen
     bien — el mismo problema que ya resolvimos entre órdenes y catálogo. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS receta_ingredientes (
      id                    TEXT PRIMARY KEY,
      receta_id             TEXT NOT NULL REFERENCES recetas(id) ON DELETE CASCADE,
      insumo_id             TEXT NOT NULL REFERENCES insumos(id),
      insumo_nombre         TEXT NOT NULL,
      gramos                 REAL NOT NULL,
      orden                 INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_receta_ingredientes_receta ON receta_ingredientes(receta_id)',
  );

  /* ═══════════════════════════════════════════
     PRODUCCIÓN — una tanda de masa: desde que se pesan los ingredientes
     hasta que queda lista para hornear (etapas 1-8). La etapa 9 (horneado)
     ya la cubre la tabla horneadas, ligada por produccion_id.
     ═══════════════════════════════════════════ */
  /* Migración: agrega a producciones la mano de obra real de la tanda
     (etapas 1-8) y las condiciones ambientales del día — mismo patrón
     no destructivo que las anteriores. */
  const produccionesExiste = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'producciones'")
    .get();
  if (produccionesExiste) {
    const columnasActuales = db
      .prepare('PRAGMA table_info(producciones)')
      .all()
      .map((c) => c.name);
    const columnasNuevas = {
      tiempo_mano_obra_real_min: 'INTEGER',
      // Condiciones REALES de esa tanda (varían día a día — por eso van
      // en producciones, no en recetas, que es la ficha fija).
      edad_masa_madre_horas:
        'INTEGER CHECK (edad_masa_madre_horas IS NULL OR (edad_masa_madre_horas >= 0 AND edad_masa_madre_horas <= 72))',
      temperatura_ambiente_c:
        'REAL CHECK (temperatura_ambiente_c IS NULL OR (temperatura_ambiente_c >= -10 AND temperatura_ambiente_c <= 50))',
      temperatura_agua_c:
        'REAL CHECK (temperatura_agua_c IS NULL OR (temperatura_agua_c >= 0 AND temperatura_agua_c <= 60))',
    };
    for (const [columna, tipo] of Object.entries(columnasNuevas)) {
      if (!columnasActuales.includes(columna)) {
        console.log(`[db] Agregando columna producciones.${columna} (migración)...`);
        db.exec(`ALTER TABLE producciones ADD COLUMN ${columna} ${tipo}`);
      }
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS producciones (
      id                          TEXT PRIMARY KEY,
      producto_id                 TEXT NOT NULL,
      producto_nombre             TEXT NOT NULL,
      receta_id                   TEXT REFERENCES recetas(id),
      fecha                       TEXT NOT NULL,
      hora_inicio                  TEXT NOT NULL,
      peso_total_masa_g           REAL NOT NULL,
      unidades_estimadas          INTEGER NOT NULL,
      tiempo_mano_obra_real_min   INTEGER,
      edad_masa_madre_horas       INTEGER CHECK (edad_masa_madre_horas IS NULL OR (edad_masa_madre_horas >= 0 AND edad_masa_madre_horas <= 72)),
      temperatura_ambiente_c      REAL CHECK (temperatura_ambiente_c IS NULL OR (temperatura_ambiente_c >= -10 AND temperatura_ambiente_c <= 50)),
      temperatura_agua_c          REAL CHECK (temperatura_agua_c IS NULL OR (temperatura_agua_c >= 0 AND temperatura_agua_c <= 60)),
      registrado_por              TEXT,
      notas                       TEXT,
      creado_en                   TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en              TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_producciones_fecha ON producciones(fecha)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_producciones_producto ON producciones(producto_id)');

  migrarForeignKeyInsumoId(
    'produccion_ingredientes',
    `id             TEXT PRIMARY KEY,
     produccion_id  TEXT NOT NULL REFERENCES producciones(id) ON DELETE CASCADE,
     insumo_id      TEXT NOT NULL REFERENCES insumos(id),
     insumo_nombre  TEXT NOT NULL,
     gramos         REAL NOT NULL`,
    'CREATE INDEX IF NOT EXISTS idx_produccion_ingredientes_produccion ON produccion_ingredientes(produccion_id)',
  );

  /* Gramos reales usados en ESA tanda (pueden diferir de la receta base:
     la ejecución diaria es libre aunque la fórmula sea fija). */
  db.exec(`
    CREATE TABLE IF NOT EXISTS produccion_ingredientes (
      id             TEXT PRIMARY KEY,
      produccion_id  TEXT NOT NULL REFERENCES producciones(id) ON DELETE CASCADE,
      insumo_id      TEXT NOT NULL REFERENCES insumos(id),
      insumo_nombre  TEXT NOT NULL,
      gramos         REAL NOT NULL
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_produccion_ingredientes_produccion ON produccion_ingredientes(produccion_id)',
  );

  /* Las 8 etapas del proceso (pesado → segunda fermentación), cada una con
     hora de inicio y, cuando termina, hora de fin. Una fila por etapa por
     producción — se van creando/actualizando a medida que el panadero
     avanza, no todas de una vez. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS produccion_etapas (
      id             TEXT PRIMARY KEY,
      produccion_id  TEXT NOT NULL REFERENCES producciones(id) ON DELETE CASCADE,
      etapa          TEXT NOT NULL,
      hora_inicio    TEXT NOT NULL,
      hora_fin       TEXT,
      notas          TEXT
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_produccion_etapas_produccion ON produccion_etapas(produccion_id)',
  );

  /* ÓRDENES DE COMPRA — el documento que se le manda al proveedor.
     Cinco tablas, cada una con un propósito distinto y a propósito
     separadas (ver docs/modelo-ordenes-compra.md):

       ordenes_compra                → lo PACTADO (cabecera)
       orden_compra_items            → lo PACTADO (detalle por insumo)
       orden_compra_recepciones      → lo OCURRIDO (cada entrega física)
       orden_compra_recepcion_items  → lo OCURRIDO (línea a línea, con lote)
       orden_compra_eventos          → la BITÁCORA (append-only)

     Los totales de la cabecera y cantidad_recibida de cada ítem son
     derivados: los calcula server.js, nunca llegan del cliente. Los
     campos *_nombre / *_razon_social son fotos del momento de emitir,
     mismo criterio que horneadas.producto_nombre. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS ordenes_compra (
      id                      TEXT PRIMARY KEY,
      numero                  TEXT NOT NULL UNIQUE,
      proveedor_id            TEXT NOT NULL REFERENCES proveedores(id),
      proveedor_razon_social  TEXT NOT NULL,
      estado                  TEXT NOT NULL DEFAULT 'borrador',
      fecha_emision           TEXT NOT NULL,
      fecha_entrega_estimada  TEXT,
      condiciones_pago        TEXT NOT NULL DEFAULT 'contado',
      moneda                  TEXT NOT NULL DEFAULT 'COP',
      subtotal                REAL NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
      impuestos               REAL NOT NULL DEFAULT 0 CHECK (impuestos >= 0),
      descuento               REAL NOT NULL DEFAULT 0 CHECK (descuento >= 0),
      flete                   REAL NOT NULL DEFAULT 0 CHECK (flete >= 0),
      total                   REAL NOT NULL DEFAULT 0 CHECK (total >= 0),
      solicitado_por          TEXT,
      aprobado_por            TEXT,
      aprobado_en             TEXT,
      lugar_entrega           TEXT,
      notas                   TEXT,
      motivo_cancelacion      TEXT,
      creado_en               TEXT NOT NULL DEFAULT (datetime('now')),
      actualizado_en          TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_ordenes_compra_estado ON ordenes_compra(estado)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_ordenes_compra_proveedor ON ordenes_compra(proveedor_id)',
  );
  db.exec('CREATE INDEX IF NOT EXISTS idx_ordenes_compra_fecha ON ordenes_compra(fecha_emision)');

  /* cantidad_recibida NO la escribe nadie a mano: la recalcula server.js
     sumando las recepciones después de cada entrega. El CHECK impide que
     una recepción registre más de lo pedido (la sobre-entrega se anota
     como cantidad_rechazada en la línea de recepción). */
  db.exec(`
    CREATE TABLE IF NOT EXISTS orden_compra_items (
      id                     TEXT PRIMARY KEY,
      orden_compra_id        TEXT NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
      insumo_id              TEXT NOT NULL REFERENCES insumos(id),
      insumo_nombre          TEXT NOT NULL,
      cantidad_pedida        REAL NOT NULL CHECK (cantidad_pedida > 0),
      unidad                 TEXT NOT NULL,
      costo_unitario         REAL NOT NULL CHECK (costo_unitario >= 0),
      impuesto_porcentaje    REAL NOT NULL DEFAULT 0 CHECK (impuesto_porcentaje >= 0 AND impuesto_porcentaje <= 100),
      descuento_porcentaje   REAL NOT NULL DEFAULT 0 CHECK (descuento_porcentaje >= 0 AND descuento_porcentaje <= 100),
      subtotal               REAL NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
      total_linea            REAL NOT NULL DEFAULT 0 CHECK (total_linea >= 0),
      cantidad_recibida      REAL NOT NULL DEFAULT 0 CHECK (cantidad_recibida >= 0 AND cantidad_recibida <= cantidad_pedida),
      orden                  INTEGER NOT NULL DEFAULT 0,
      notas                  TEXT
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_orden_compra_items_orden ON orden_compra_items(orden_compra_id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_orden_compra_items_insumo ON orden_compra_items(insumo_id)',
  );

  /* Una orden puede llegar en varias entregas. Cada recepción es un
     documento propio e inmutable: no hay UPDATE ni DELETE sobre estas dos
     tablas desde la API — corregir una recepción mal cargada se hace
     registrando otra, igual que un asiento contable. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS orden_compra_recepciones (
      id                    TEXT PRIMARY KEY,
      orden_compra_id       TEXT NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
      fecha                 TEXT NOT NULL,
      hora                  TEXT NOT NULL,
      recibido_por          TEXT,
      documento_referencia  TEXT,
      notas                 TEXT,
      creado_en             TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_orden_compra_recepciones_orden ON orden_compra_recepciones(orden_compra_id)',
  );

  /* El eslabón fino de la trazabilidad: lote_proveedor y
     fecha_vencimiento se copian al insumo al recibir, y son lo que
     permite rastrear hacia atrás desde una tanda de masa hasta la
     orden de compra y el lote del proveedor que la surtió. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS orden_compra_recepcion_items (
      id                       TEXT PRIMARY KEY,
      recepcion_id             TEXT NOT NULL REFERENCES orden_compra_recepciones(id) ON DELETE CASCADE,
      item_id                  TEXT NOT NULL REFERENCES orden_compra_items(id) ON DELETE CASCADE,
      insumo_id                TEXT NOT NULL REFERENCES insumos(id),
      insumo_nombre            TEXT NOT NULL,
      cantidad_recibida        REAL NOT NULL CHECK (cantidad_recibida >= 0),
      cantidad_rechazada       REAL NOT NULL DEFAULT 0 CHECK (cantidad_rechazada >= 0),
      motivo_rechazo           TEXT,
      lote_proveedor           TEXT,
      fecha_vencimiento        TEXT,
      temperatura_recepcion_c  REAL CHECK (temperatura_recepcion_c IS NULL OR (temperatura_recepcion_c >= -50 AND temperatura_recepcion_c <= 100)),
      notas                    TEXT
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_orden_compra_recepcion_items_recepcion ON orden_compra_recepcion_items(recepcion_id)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_orden_compra_recepcion_items_item ON orden_compra_recepcion_items(item_id)',
  );

  /* Bitácora append-only de la orden: quién hizo qué y cuándo. Es la
     línea de tiempo que se pinta en el panel; la copia a prueba de
     manipulación vive además en auditoria_cadena. El id es un entero
     autoincremental, no un UUID: creado_en solo tiene precisión de
     segundos, así que dos eventos del mismo segundo (crear + emitir en
     la misma petición) necesitan el id para desempatar el orden. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS orden_compra_eventos (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_compra_id  TEXT NOT NULL REFERENCES ordenes_compra(id) ON DELETE CASCADE,
      tipo             TEXT NOT NULL,
      estado_anterior  TEXT,
      estado_nuevo     TEXT,
      descripcion      TEXT NOT NULL,
      datos            TEXT,
      usuario          TEXT,
      creado_en        TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_orden_compra_eventos_orden ON orden_compra_eventos(orden_compra_id)',
  );

  /* Cadena de auditoría (hash-chain, estilo blockchain): un registro
     append-only donde cada bloque incluye el hash del bloque anterior.
     No es una blockchain distribuida (no hay red ni consenso — es un
     solo servidor con una sola base de datos), pero da la misma
     propiedad que Jorge pidió: si alguien edita un bloque viejo
     directamente en la base de datos (fuera de la API), su hash deja de
     coincidir con lo que el siguiente bloque esperaba como
     "hash_anterior", y GET /auditoria/verificar lo detecta recorriendo
     toda la cadena. La aritmética del hash vive en auditoria.js. */
  db.exec(`
    CREATE TABLE IF NOT EXISTS auditoria_cadena (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      entidad          TEXT NOT NULL,
      entidad_id       TEXT NOT NULL,
      accion           TEXT NOT NULL,
      datos            TEXT NOT NULL,
      actualizado_por  TEXT,
      hash_anterior    TEXT NOT NULL,
      hash             TEXT NOT NULL UNIQUE,
      creado_en        TEXT NOT NULL
    )
  `);

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_auditoria_cadena_entidad ON auditoria_cadena(entidad, entidad_id)',
  );

  /* Vista de solo lectura para herramientas de BI externas (Power BI,
     Excel, etc. vía ODBC): ordenes.items_json es un blob JSON con los
     productos de cada pedido, y una tabla de este tipo no se puede
     modelar en una herramienta tabular como Power BI sin aplanarla
     primero. json_each() (SQLite core desde hace años, sin extensión
     aparte) la convierte en una fila por ítem de pedido — un "orden
     items" de verdad, listo para conectar directo. Es una VIEW, no una
     tabla: no ocupa espacio propio, se recalcula al vuelo en cada
     consulta desde ordenes. */
  db.exec(`
    CREATE VIEW IF NOT EXISTS vista_orden_items AS
    SELECT
      o.numero                                   AS orden_numero,
      o.fecha_iso                                AS fecha_iso,
      o.estado                                   AS estado,
      o.cliente                                  AS cliente,
      json_extract(item.value, '$.productoId')   AS producto_id,
      json_extract(item.value, '$.nombre')       AS producto_nombre,
      json_extract(item.value, '$.cantidad')     AS cantidad,
      json_extract(item.value, '$.precio')       AS precio,
      json_extract(item.value, '$.cantidad') * json_extract(item.value, '$.precio') AS subtotal
    FROM ordenes o, json_each(o.items_json) AS item
  `);
} catch (err) {
  /* Sin base de datos no hay backend: fallar de forma ruidosa y con contexto,
     en lugar de dejar que un error opaco tumbe el arranque. */
  console.error(`[db] No se pudo inicializar la base de datos en ${DB_PATH}:`, err.message);
  throw err;
}

module.exports = db;

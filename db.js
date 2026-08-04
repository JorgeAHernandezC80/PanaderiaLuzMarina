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

  const productosSemilla = [
    { id: 1, nombre: 'Donuts Glaseadas', categoria: 'frituras', precio: 1.5 },
    { id: 2, nombre: 'Buñuelos', categoria: 'frituras', precio: 2.5 },
    { id: 3, nombre: 'Roscón de Arequipe', categoria: 'reposteria', precio: 2.5 },
    { id: 4, nombre: 'Croissant', categoria: 'bolleria', precio: 2.0 },
    { id: 5, nombre: 'Almojábanas', categoria: 'panaderia', precio: 2.5 },
    { id: 6, nombre: 'Pandebono', categoria: 'panaderia', precio: 2.5 },
    { id: 7, nombre: 'Pan de Yuca', categoria: 'panaderia', precio: 2.5 },
    { id: 8, nombre: 'Conchas', categoria: 'reposteria', precio: 1.75 },
    { id: 9, nombre: 'Pan mariquiteño', categoria: 'reposteria', precio: 2.5 },
  ];
  const insertarProducto = db.prepare(
    'INSERT OR IGNORE INTO productos (id, nombre, categoria, precio) VALUES (?, ?, ?, ?)',
  );
  const sembrarProductos = db.transaction((filas) => {
    for (const p of filas) insertarProducto.run(p.id, p.nombre, p.categoria, p.precio);
  });
  sembrarProductos(productosSemilla);

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
} catch (err) {
  /* Sin base de datos no hay backend: fallar de forma ruidosa y con contexto,
     en lugar de dejar que un error opaco tumbe el arranque. */
  console.error(`[db] No se pudo inicializar la base de datos en ${DB_PATH}:`, err.message);
  throw err;
}

module.exports = db;

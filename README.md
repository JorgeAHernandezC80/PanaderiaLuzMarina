# 🍞 Panadería Luz Marina

> **Copyright (c) 2026 Jorge A. Hernández C. Todos los derechos reservados.**
> Este software y su código fuente son propiedad de Jorge A. Hernández C. No se
> concede ningún permiso para usar, copiar, modificar, fusionar, publicar,
> distribuir, sublicenciar y/o vender copias de este software, ni para permitir
> que terceros lo hagan, sin el consentimiento previo y por escrito del autor.
> Todos los derechos no otorgados expresamente quedan reservados. Ver [LICENSE](LICENSE).
>
> **Copyright (c) 2026 Jorge A. Hernández C. All rights reserved.**
> This software and its source code are the property of Jorge A. Hernández C.
> No permission is granted to use, copy, modify, merge, publish, distribute,
> sublicense, and/or sell copies of this software, or to permit persons to whom
> it is furnished to do so, without the prior written consent of the author.
> All rights not expressly granted are reserved.

Tienda en línea para una panadería artesanal: catálogo de productos, carrito de compras,
checkout que arma el pedido y lo manda por WhatsApp, y un panel de administración en
tiempo real para llevar el negocio del día a día — desde las órdenes hasta la producción
y el inventario.

El proyecto tiene dos partes:

- **Frontend** — páginas HTML estáticas con JavaScript modular (ES Modules) y CSS por
  componentes. Se despliega como sitio estático (Netlify).
- **Backend** — una API en Express con SQLite (`better-sqlite3`) y notificaciones en
  tiempo real por WebSocket. Se despliega como servicio Node (Render).

## 📋 Tabla de contenidos

- [Qué hace](#-qué-hace)
- [Tecnologías](#-tecnologías)
- [Estructura del proyecto](#-estructura-del-proyecto)
- [Módulos de interfaz](#-módulos-de-interfaz)
- [Requisitos](#-requisitos)
- [Instalación](#-instalación)
- [Variables de entorno](#-variables-de-entorno)
- [Ejecución](#-ejecución)
- [El ciclo de una orden](#-el-ciclo-de-una-orden)
- [Cómo se calcula el disponible](#-cómo-se-calcula-el-disponible)
- [API del backend](#-api-del-backend)
- [Pruebas](#-pruebas)
- [Despliegue](#-despliegue)
- [Seguridad](#-seguridad)
- [Contribución](#-contribución)
- [Licencia](#-licencia)

## ✨ Qué hace

**Para quien compra**

- Catálogo de productos con carrito que persiste entre visitas y se mantiene
  sincronizado si el cliente tiene varias pestañas abiertas.
- Checkout que arma el pedido y lo envía por WhatsApp — sin pasarela de pagos,
  igual que funciona un negocio de barrio.
- Modo oscuro y sitio bilingüe (español/inglés), con foco en verse bien desde el
  celular.

**Para el negocio (panel de administración)**

- Las órdenes aparecen en el panel apenas llegan, en tiempo real, sin recargar la
  página.
- Cada orden avanza por un ciclo de 4 pasos: Recibida → En preparación → Preparada →
  Entregada (más detalle en [El ciclo de una orden](#-el-ciclo-de-una-orden)).
- **Insumos**: control de materia prima, con alerta cuando algo cae por debajo del
  mínimo.
- **Proveedores**: ficha completa por proveedor — contacto, condiciones de pago,
  tiempos de entrega.
- **Horneadas**: registro diario de producción (qué se horneó, cuánto, a qué hora y
  quién lo hizo), con historial consultable de cualquier fecha.
- **Inventario**: cuánto pan queda disponible ahora mismo, calculado automáticamente
  a partir de lo horneado, lo vendido y las mermas del día.
- Acceso protegido por token, con sesión que expira y protección contra intentos de
  fuerza bruta.

**Por debajo**

- Validación estricta de todo lo que llega por la API.
- Límite de peticiones por IP, CORS restringido y cabeceras de seguridad (CSP, HSTS).
- Consultas SQL siempre parametrizadas — nunca se arma una consulta pegando texto.

## 🛠️ Tecnologías

**Frontend**

- HTML5 semántico
- CSS3 con arquitectura modular (`base/`, `components/`, `pages/`)
- JavaScript (ES Modules), sin framework
- Font Awesome 6

**Backend**

- Node.js 20
- Express 5
- better-sqlite3 (SQLite embebido, API síncrona)
- ws (WebSocket)

**Tooling**

- Jest + Supertest (entornos `jsdom` y `node`)
- ESLint + Prettier
- GitHub Actions (CI)

## 📁 Estructura del proyecto

```
PanaderiaLuzMarina/
├── index.html               # Página principal
├── catalogo.html            # Catálogo de productos
├── carrito.html              # Carrito de compras
├── checkout.html             # Checkout / envío por WhatsApp
├── contacto.html              # Contacto
├── nosotros.html              # Información del negocio
├── admin.html                 # Panel de administración
│
├── CSS/
│   ├── base/                  # Reset, variables y utilidades
│   ├── components/            # Bloques reutilizables entre páginas
│   │   ├── _buttons.css
│   │   ├── _cards.css
│   │   ├── _features.css      #   Módulo de ganchos (.features-grid)
│   │   ├── _footer.css
│   │   ├── _forms.css
│   │   ├── _header.css
│   │   ├── _hero.css          #   Hero y acción dual (.hero-actions)
│   │   └── _steps.css         #   Módulo instructivo (.steps-section)
│   └── pages/                  # Estilos por página (incluye admin.css)
│
├── JS/
│   ├── core/                   # Lógica compartida
│   │   ├── api.js              #   Cliente HTTP contra el backend
│   │   ├── cart.js             #   Estado del carrito (localStorage)
│   │   ├── format.js           #   Formateo de precios/valores
│   │   ├── i18n.js             #   Internacionalización
│   │   ├── theme.js            #   Modo claro/oscuro
│   │   └── ui.js               #   Comportamiento común de UI
│   └── pages/                   # Punto de entrada por página (incluye admin.js)
│
├── IMG/                         # Imágenes de productos
│
├── server.js                    # Servidor Express + WebSocket (backend)
├── db.js                        # Esquema e inicialización de SQLite
├── validation.js                 # Validación/saneamiento de todo lo que entra por la API
│
├── tests/                        # Suite de pruebas (Jest) — 14 archivos
├── docs/                         # Documentación adicional (auditoría de seguridad, etc.)
│
├── vercel.json                   # Config de Vercel: URLs limpias (cleanUrls)
├── _headers                      # Cabeceras de seguridad para Netlify (CSP, HSTS...)
├── .env.example                  # Plantilla de variables de entorno
├── jest.config.js
├── babel.config.js
├── package.json
├── LICENSE
├── SECURITY.md                   # Política de reporte de vulnerabilidades
└── CONTRIBUTING.md               # Flujo de trabajo y convenciones de commits
```

## 🧩 Módulos de interfaz

Bloques semánticos reutilizables. La clase de la izquierda es el contrato estable:
si cambia, hay que actualizar el CSS y las claves de traducción a la vez.

| Módulo           | Archivo CSS                    | Página          | Función                                                                       |
| ---------------- | ------------------------------ | --------------- | ----------------------------------------------------------------------------- |
| `.features-grid` | `CSS/components/_features.css` | `index.html`    | Tres ganchos bajo el hero: qué se hornea, cómo se encarga y cómo se paga.     |
| `.hero-actions`  | `CSS/components/_hero.css`     | `index.html`    | Acción dual: segmenta el tráfico hacia encargo en línea o hacia el mostrador. |
| `.steps-section` | `CSS/components/_steps.css`    | `catalogo.html` | Secuencia de tres pasos (carrito → canasta → WhatsApp) antes del listado.     |

Convenciones al tocar o añadir módulos:

- **Orden de la cascada** — en el `<head>`: `base/` → `components/` → `pages/`.
  Un componente cargado después de la hoja de página deja de poder sobrescribirse
  sin `!important`.
- **Traducciones obligatorias** — todo texto visible lleva `data-i18n="clave"`, y la
  clave debe existir en los diccionarios `es` **y** `en` de `JS/core/i18n.js`. Los
  atributos se traducen con `data-i18n-aria-label` / `data-i18n-placeholder`.
- **Semántica antes que clases** — la estructura la marcan las etiquetas nativas
  (`<section>`, `<article>`, `<ol>`, `<h3>`); las clases solo aplican estilo. El
  instructivo usa `<ol>` porque el orden de los pasos es información, no adorno.

## ✅ Requisitos

- [Node.js](https://nodejs.org/) **20.x** — versiones más nuevas pueden fallar al
  compilar `better-sqlite3` si no hay un binario precompilado disponible.
- npm 10+

## 📦 Instalación

```bash
git clone https://github.com/JorgeAHernandezC80/PanaderiaLuzMarina.git
cd PanaderiaLuzMarina
npm install
```

## 🔐 Variables de entorno

El backend se configura mediante variables de entorno. Copia el ejemplo y ajústalo:

```bash
cp .env.example .env
```

| Variable                | Requerida   | Descripción                                                                                                   |
| ----------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | No          | Puerto del backend. Por defecto `3001`.                                                                       |
| `FRONTEND_ORIGIN`       | Sí (prod)   | Orígenes permitidos para CORS, separados por coma (p. ej. `https://tu-sitio.netlify.app`). Sin barra final.   |
| `ADMIN_TOKEN`           | Sí (prod)   | Contraseña/token del panel de administración. Sin él, el panel queda inaccesible.                             |
| `SESSION_SECRET`        | Recomendada | Secreto para firmar los tokens de sesión del panel (HMAC). Si se omite, se deriva del `ADMIN_TOKEN`.          |
| `SESSION_TTL_MS`        | No          | Duración de la sesión admin en ms. Por defecto `28800000` (8 h).                                              |
| `AUTH_MAX_ATTEMPTS`     | No          | Intentos de login por IP cada 15 min antes de responder `429`. Por defecto `10`.                              |
| `ORDERS_MAX_PER_WINDOW` | No          | Peticiones de escritura por IP cada 15 min (crear órdenes, insumos, horneadas, ajustes...). Por defecto `20`. |
| `DB_PATH`               | No          | Ruta del archivo SQLite. Por defecto `./luzmarina.db`.                                                        |

> ⚠️ La base de datos (`*.db`) contiene datos de clientes (PII) y **no** se versiona.
> El archivo `.env` tampoco: nunca subas secretos al repositorio.

## ▶️ Ejecución

**Backend**

```bash
npm start          # inicia el servidor en http://localhost:3001
```

**Frontend**

Las páginas son estáticas; sírvelas con cualquier servidor de archivos estáticos, por ejemplo:

```bash
npx serve .        # o la extensión "Live Server" de VS Code
```

Ajusta `API_BASE` en `JS/core/api.js` si tu backend no corre en la URL por defecto.

## 🔄 El ciclo de una orden

Una orden nace cuando el cliente hace checkout y va pasando por cuatro estados, en
este orden:

1. **Recibida** (`pendiente`) — acaba de llegar, todavía no se ha tocado.
2. **En preparación** (`en_preparacion`) — alguien ya empezó a armarla.
3. **Preparada** (`preparada`) — está lista y separada, pero el cliente aún no la
   retira. Desde este punto ya se resta del disponible en Inventario, porque ese pan
   está reservado aunque no haya salido físicamente.
4. **Entregada** (`entregada`) — el cliente ya se la llevó. Estado final.

El panel admin muestra un botón para avanzar cada orden al siguiente paso; no se
puede saltar pasos ni retroceder desde la interfaz.

## 📊 Cómo se calcula el disponible

La pestaña Inventario no guarda un número de "stock" que haya que actualizar a mano
— lo calcula al vuelo, cada vez que se consulta, con esta fórmula por producto y por
día:

```
Disponible = Horneado (hoy) − Vendido (hoy) − Preparado (hoy) − Ajustes (mermas)
```

- **Horneado** sale del registro de la pestaña Horneadas.
- **Vendido** son las órdenes que ya llegaron a estado Entregada.
- **Preparado** son las órdenes en estado Preparada — ya están separadas para un
  cliente, aunque técnicamente no hayan salido de la panadería.
- **Ajustes** son mermas, errores de conteo u otras pérdidas que se registran a
  mano en la pestaña Inventario.

El cruce entre una orden y un producto del catálogo se hace por el id del producto
(no por su nombre), así que renombrar un producto en el catálogo no rompe el cálculo.

## 🔌 API del backend

Los endpoints marcados **Admin** requieren la cabecera `Authorization: Bearer <token>`,
donde `<token>` es el **token de sesión firmado** que devuelve `POST /auth` (no el
`ADMIN_TOKEN` en sí). El token caduca según `SESSION_TTL_MS`, y `/auth` está protegido
contra fuerza bruta.

**Órdenes**

| Método  | Ruta               | Auth  | Descripción                                  |
| ------- | ------------------ | ----- | -------------------------------------------- |
| `GET`   | `/health`          | No    | Healthcheck (`{ status: "ok" }`).            |
| `POST`  | `/auth`            | No    | Valida la contraseña del panel admin.        |
| `POST`  | `/ordenes`         | No\*  | Crea una orden (validación + rate limiting). |
| `GET`   | `/ordenes`         | Admin | Lista órdenes (filtros `fecha`, `estado`).   |
| `PATCH` | `/ordenes/:numero` | Admin | Avanza el estado de una orden.               |

**Productos**

| Método | Ruta             | Auth  | Descripción                                                                                  |
| ------ | ---------------- | ----- | -------------------------------------------------------------------------------------------- |
| `GET`  | `/catalogo`      | No    | Catálogo público: id, nombre, categoría, precio, descripción e imagen de lo que está activo. |
| `GET`  | `/productos`     | Admin | Lista el catálogo completo, incluidos los que no están activos.                              |
| `POST` | `/productos`     | Admin | Crea un producto.                                                                            |
| `PUT`  | `/productos/:id` | Admin | Actualiza un producto.                                                                       |

Los productos no se borran: se les cambia el `estado` (`activo`, `borrador`, `agotado`,
`descontinuado`), porque recetas, producciones, horneadas, ajustes y órdenes guardan su id.
Solo los `activo` aparecen en `/catalogo` y en el inventario del día, y `POST /ordenes`
rechaza cualquier item cuyo producto no esté activo o cuyo precio no coincida con el de la
tabla.

`catalogo.html` ya no tiene tarjetas escritas a mano: `JS/pages/catalogo.js` las arma en el
navegador a partir de `GET /catalogo`, así que un producto nuevo creado desde el panel
aparece solo, sin tocar el HTML. La imagen se arma con `imagenBase` (nombre del archivo en
`IMG/webp/`, sin extensión — debe existir `<imagenBase>-400.webp` y `<imagenBase>-800.webp`);
si el producto no tiene `imagenBase`, la tarjeta muestra un ícono en su lugar en vez de una
imagen rota. La descripción en español sale de `productos.descripcion`; la traducción al
inglés vive en `JS/core/i18n.js` por id de producto (`prod_desc_<id>`) y, si no existe, cae a
la descripción en español. Como el catálogo depende de que el backend responda, si
`GET /catalogo` falla se muestra un aviso en vez de una grilla vacía.

**Insumos**

| Método   | Ruta           | Auth  | Descripción          |
| -------- | -------------- | ----- | -------------------- |
| `GET`    | `/insumos`     | Admin | Lista insumos.       |
| `POST`   | `/insumos`     | Admin | Crea un insumo.      |
| `PUT`    | `/insumos/:id` | Admin | Actualiza un insumo. |
| `DELETE` | `/insumos/:id` | Admin | Elimina un insumo.   |

**Proveedores**

| Método   | Ruta               | Auth  | Descripción             |
| -------- | ------------------ | ----- | ----------------------- |
| `GET`    | `/proveedores`     | Admin | Lista proveedores.      |
| `POST`   | `/proveedores`     | Admin | Crea un proveedor.      |
| `PUT`    | `/proveedores/:id` | Admin | Actualiza un proveedor. |
| `DELETE` | `/proveedores/:id` | Admin | Elimina un proveedor.   |

**Horneadas**

| Método   | Ruta             | Auth  | Descripción                                    |
| -------- | ---------------- | ----- | ---------------------------------------------- |
| `GET`    | `/horneadas`     | Admin | Lista horneadas (filtro `fecha`, default hoy). |
| `POST`   | `/horneadas`     | Admin | Registra una horneada.                         |
| `PUT`    | `/horneadas/:id` | Admin | Corrige una horneada ya registrada.            |
| `DELETE` | `/horneadas/:id` | Admin | Elimina un registro de horneada.               |

**Inventario**

| Método   | Ruta                          | Auth  | Descripción                                                  |
| -------- | ----------------------------- | ----- | ------------------------------------------------------------ |
| `GET`    | `/inventario`                 | Admin | Disponible por producto para una fecha (ver fórmula arriba). |
| `GET`    | `/ajustes-inventario`         | Admin | Lista ajustes/mermas (filtro `fecha`).                       |
| `POST`   | `/ajustes-inventario`         | Admin | Registra un ajuste (merma, error de conteo, etc.).           |
| `PUT`    | `/ajustes-inventario/:id`     | Admin | Corrige un ajuste ya registrado.                             |
| `DELETE` | `/ajustes-inventario/:id`     | Admin | Elimina un ajuste.                                           |
| `PUT`    | `/productos/:id/stock-minimo` | Admin | Configura el umbral de alerta de stock bajo de un producto.  |

\* Protegido por rate limiting (`ORDERS_MAX_PER_WINDOW` peticiones por IP cada 15 min).

Al crear o actualizar una orden, el servidor emite un evento por WebSocket
(`orden:nueva` / `orden:actualizada`) para que el panel se actualice en vivo. Horneadas
y Ajustes de inventario emiten sus propios eventos (`horneada:nueva`, `ajuste:nuevo`,
etc.) con el mismo propósito.

## 🧪 Pruebas

```bash
npm test               # ejecuta la suite completa
npm run test:watch     # modo watch
npm run test:coverage  # con reporte de cobertura
```

## 🚀 Despliegue

- **Frontend** → Netlify (sitio estático). Configura la variable `NODE_VERSION=20`.
- **Backend** → Render (servicio web Node). Define `FRONTEND_ORIGIN`, `ADMIN_TOKEN` y
  `SESSION_SECRET` en el panel de variables de entorno de Render.
- **Cabeceras del frontend**: el archivo [`_headers`](_headers) aplica CSP, HSTS y
  demás cabeceras de seguridad en Netlify automáticamente.

## 🔒 Seguridad

El proyecto aplica endurecimiento de seguridad: tokens de sesión firmados con
expiración, rate limiting anti fuerza bruta, cabeceras de seguridad (CSP, HSTS,
etc.) en backend y frontend, validación estricta de entrada y SQL parametrizado.

- Política de reporte de vulnerabilidades: [SECURITY.md](SECURITY.md).
- Informe de auditoría: [docs/auditoria-seguridad.md](docs/auditoria-seguridad.md).

## 🤝 Contribución

Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para el flujo de trabajo, estilo de código
y convenciones de commits.

## 📄 Licencia

Todos los derechos reservados. Este código es propiedad de Jorge A. Hernández C.
y no está disponible para uso, copia, modificación ni distribución por terceros
sin autorización previa por escrito. Consulta [LICENSE](LICENSE).

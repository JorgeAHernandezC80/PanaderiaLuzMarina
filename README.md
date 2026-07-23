# 🍞 Panadería Luz Marina

Sistema de e-commerce para una panadería artesanal: catálogo de productos, carrito
de compras, checkout con envío del pedido por WhatsApp y un panel de administración
en tiempo real (WebSocket) para gestionar las órdenes entrantes.

El proyecto tiene dos partes:

- **Frontend** — páginas HTML estáticas + módulos ES (JavaScript) y CSS modular.
  Pensado para desplegarse como sitio estático (Netlify).
- **Backend** — API REST con Express + SQLite (`better-sqlite3`) y notificaciones en
  tiempo real vía WebSocket. Pensado para desplegarse en un servidor Node (Render).

## 📋 Tabla de contenidos

- [Características](#-características)
- [Tecnologías](#-tecnologías)
- [Estructura del proyecto](#-estructura-del-proyecto)
- [Módulos de interfaz](#-módulos-de-interfaz)
- [Requisitos](#-requisitos)
- [Instalación](#-instalación)
- [Variables de entorno](#-variables-de-entorno)
- [Ejecución](#-ejecución)
- [API del backend](#-api-del-backend)
- [Pruebas](#-pruebas)
- [Despliegue](#-despliegue)
- [Seguridad](#-seguridad)
- [Contribución](#-contribución)
- [Licencia](#-licencia)

## ✨ Características

- 🛒 **Carrito reactivo** — persiste en `localStorage` y sincroniza los badges entre pestañas.
- 📱 **Pedido por WhatsApp** — el checkout arma el mensaje y abre WhatsApp con la orden.
- 🧾 **Panel de administración** — vista en tiempo real de las órdenes, protegida por token.
- 🔴 **Tiempo real** — el backend emite eventos WebSocket al crear/actualizar órdenes.
- 🌙 **Modo oscuro** — preferencia recordada por el usuario.
- 🌍 **Bilingüe (ES/EN)** — internacionalización ligera sin dependencias.
- 🧭 **Compra guiada** — módulos que explican el flujo antes de pedir: ganchos en la
  portada e instructivo de tres pasos sobre el catálogo.
- ♿ **Accesibilidad** — landmarks semánticos, `aria-label` en bloques y acciones,
  foco visible y `prefers-reduced-motion` respetado.
- 🛡️ **Backend endurecido** — validación de entrada, rate limiting, CORS restringido y
  comparación de contraseña en tiempo constante.

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

- Jest + Testing (jsdom / node) + Supertest
- ESLint + Prettier
- GitHub Actions (CI)

## 📁 Estructura del proyecto

```
PanaderiaLuzMarina/
├── index.html              # Página principal
├── catalogo.html           # Catálogo de productos
├── carrito.html            # Carrito de compras
├── checkout.html           # Checkout / envío por WhatsApp
├── contacto.html           # Contacto
├── nosotros.html           # Información del negocio
├── admin.html              # Panel de administración
│
├── CSS/
│   ├── base/               # Reset, variables y utilidades
│   ├── components/         # Bloques reutilizables entre páginas
│   │   ├── _buttons.css
│   │   ├── _cards.css
│   │   ├── _features.css   #   Módulo de ganchos (.features-grid)
│   │   ├── _footer.css
│   │   ├── _forms.css
│   │   ├── _header.css
│   │   ├── _hero.css       #   Hero y acción dual (.hero-actions)
│   │   └── _steps.css      #   Módulo instructivo (.steps-section)
│   └── pages/              # Estilos por página
│
├── JS/
│   ├── core/               # Lógica compartida
│   │   ├── api.js          #   Cliente HTTP contra el backend
│   │   ├── cart.js         #   Estado del carrito (localStorage)
│   │   ├── format.js       #   Formateo de precios/valores
│   │   ├── i18n.js         #   Internacionalización
│   │   ├── theme.js        #   Modo claro/oscuro
│   │   └── ui.js           #   Comportamiento común de UI
│   └── pages/              # Punto de entrada por página
│
├── IMG/                    # Imágenes de productos
│
├── server.js               # Servidor Express + WebSocket (backend)
├── db.js                   # Inicialización de SQLite
├── validation.js           # Validación/saneamiento de órdenes
│
├── tests/                  # Suite de pruebas (Jest)
├── jest.config.js
├── babel.config.js
└── package.json
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

- [Node.js](https://nodejs.org/) **20.x**
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

| Variable                | Requerida   | Descripción                                                                                                      |
| ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | No          | Puerto del backend. Por defecto `3001`.                                                                          |
| `FRONTEND_ORIGIN`       | Sí (prod)   | Origen permitido para CORS (p. ej. `https://tu-sitio.netlify.app`). Sin él, se rechazan las peticiones cruzadas. |
| `ADMIN_TOKEN`           | Sí (prod)   | Contraseña/token del panel de administración. Sin él, el panel queda inaccesible.                                |
| `SESSION_SECRET`        | Recomendada | Secreto para firmar los tokens de sesión del panel (HMAC). Si se omite, se deriva del `ADMIN_TOKEN`.             |
| `SESSION_TTL_MS`        | No          | Duración de la sesión admin en ms. Por defecto `28800000` (8 h).                                                 |
| `AUTH_MAX_ATTEMPTS`     | No          | Intentos de login por IP cada 15 min antes de responder `429`. Por defecto `10`.                                 |
| `ORDERS_MAX_PER_WINDOW` | No          | Creaciones de orden por IP cada 15 min. Por defecto `20`.                                                        |
| `DB_PATH`               | No          | Ruta del archivo SQLite. Por defecto `./luzmarina.db`.                                                           |

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

## 🔌 API del backend

| Método  | Ruta               | Auth  | Descripción                                      |
| ------- | ------------------ | ----- | ------------------------------------------------ |
| `GET`   | `/health`          | No    | Healthcheck (`{ status: "ok" }`).                |
| `POST`  | `/auth`            | No    | Valida la contraseña del panel admin.            |
| `POST`  | `/ordenes`         | No\*  | Crea una orden (con validación y rate limiting). |
| `GET`   | `/ordenes`         | Admin | Lista órdenes (filtros `fecha`, `estado`).       |
| `PATCH` | `/ordenes/:numero` | Admin | Actualiza el estado de una orden.                |

\* Protegido por rate limiting (20 peticiones por IP cada 15 min).
Los endpoints **Admin** requieren la cabecera `Authorization: Bearer <token>`, donde
`<token>` es el **token de sesión firmado** que devuelve `POST /auth` (no el `ADMIN_TOKEN`).
El token caduca (`SESSION_TTL_MS`) y `/auth` está protegido contra fuerza bruta.

Al crear o actualizar una orden, el servidor emite un evento por WebSocket
(`orden:nueva` / `orden:actualizada`) para que el panel se actualice en vivo.

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

Distribuido bajo la licencia MIT. Consulta [LICENSE](LICENSE).

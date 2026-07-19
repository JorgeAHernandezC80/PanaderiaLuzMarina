# Auditoría de Seguridad — Panadería Luz Marina

Auditoría de la lógica algorítmica, el flujo de datos y las superficies de ataque
del frontend estático y del backend (Express + SQLite + WebSocket). Para cada
punto se indica el **hallazgo** y la **remediación** aplicada en este PR (o el
motivo por el que no aplica).

> Leyenda: ✅ corregido / mitigado · ➖ no aplica (con justificación) · ⚠️ residual (aceptado / seguimiento)

## Resumen del modelo de amenazas

- **Frontend**: sitio estático (Netlify). No hay cookies de sesión ni datos
  sensibles en el cliente salvo el token de sesión del admin en `sessionStorage`.
- **Backend**: API JSON (Render). Un único rol privilegiado (administrador de la
  panadería) autenticado con contraseña. Endpoints públicos: `GET /health`,
  `POST /auth`, `POST /ordenes`. Endpoints protegidos: `GET /ordenes`,
  `PATCH /ordenes/:numero`.
- **Datos sensibles**: nombre y teléfono de clientes en las órdenes (PII).

---

## 1. Auditoría de la página web (Frontend y Servidor)

### 1.1 Encabezados de seguridad (CSP y HSTS) — ✅

- **Hallazgo**: no se enviaban cabeceras de seguridad ni en el frontend ni en el
  backend. Sin CSP el impacto de un XSS es total; sin HSTS hay riesgo de
  degradación a HTTP.
- **Remediación**:
  - Backend (`server.js`): middleware que añade en todas las respuestas
    `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`
    (la API sólo devuelve JSON), `Strict-Transport-Security`,
    `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
    `Referrer-Policy: no-referrer`, `Permissions-Policy` y
    `Cross-Origin-Resource-Policy`. Se deshabilita `X-Powered-By`.
  - Frontend (`_headers` de Netlify): CSP con `script-src 'self'` (posible tras
    externalizar el único script inline de tema a `JS/theme-init.js`),
    `style-src` restringido a Google Fonts y cdnjs, `connect-src` limitado al
    backend de Render (`https` y `wss`), `frame-ancestors 'none'`,
    `object-src 'none'`, `upgrade-insecure-requests`, más HSTS,
    `X-Frame-Options`, `Referrer-Policy` y `Permissions-Policy`.

### 1.2 Manejo de sesiones y cookies (Secure, HttpOnly, SameSite) — ➖ / ✅

- **Hallazgo**: la aplicación **no usa cookies**. El token del admin viaja en el
  header `Authorization: Bearer` y se guarda en `sessionStorage`. Por tanto los
  atributos `Secure/HttpOnly/SameSite` no aplican.
- **Mejora relacionada aplicada**: antes el login devolvía el `ADMIN_TOKEN` en
  crudo (equivalente a exponer la contraseña de forma permanente). Ahora
  `POST /auth` emite un **token de sesión firmado (HMAC-SHA256) con expiración**
  (`SESSION_TTL_MS`, 8 h por defecto). El servidor verifica firma y expiración en
  tiempo constante y **ya no acepta el `ADMIN_TOKEN` crudo** como Bearer. Al
  expirar, el panel fuerza reinicio de sesión.
- ⚠️ Residual: `sessionStorage` es accesible por JavaScript. La CSP estricta del
  frontend reduce el riesgo de robo por XSS; la expiración limita la ventana de
  uso de un token filtrado.

### 1.3 Inyección de código (XSS y SQLi) — ✅

- **SQLi**: todas las consultas usan **sentencias preparadas** de better-sqlite3
  con parámetros posicionales. Los filtros de `GET /ordenes` (`fecha`, `estado`)
  se validan con regex / lista blanca antes de parametrizarse. Sin concatenación
  de entrada del usuario en SQL. **No se encontró SQLi.**
- **XSS**: el panel admin renderiza datos de órdenes provenientes de clientes. Se
  verificó que se usa `textContent` para número y cliente, y `escapeHTML()` para
  teléfono y nombres de productos antes de interpolarlos en `innerHTML`. El
  backend valida longitud/tipo de cada campo (`validation.js`). Como defensa en
  profundidad se añadió CSP con `script-src 'self'`. **No se encontró XSS
  explotable.**

### 1.4 Falsificación de solicitudes (CSRF) — ➖

- **Hallazgo**: la autenticación es por **token Bearer en un header**, no por
  cookies. Un sitio de terceros no puede forzar al navegador a adjuntar ese
  header, por lo que el vector CSRF clásico no aplica. Además CORS está
  restringido a `FRONTEND_ORIGIN`. No se requieren tokens anti-CSRF.

---

## 2. Auditoría de la API (Backend y Endpoints)

### 2.1 BOLA / autorización a nivel de objeto — ➖ / ⚠️

- **Hallazgo**: no hay multi-tenancy: existe un único rol (admin). Los objetos
  (`ordenes`) no pertenecen a usuarios finales; leerlos o modificarlos exige
  autenticación de admin. No hay IDs de usuario en las rutas que permitan acceder
  a recursos de "otros usuarios".
- ⚠️ Observación: el número de orden (`LM-YYYYMMDD-####`) tiene sólo 4 dígitos
  aleatorios, pero su lectura/edición requiere admin y un duplicado responde
  `409` sin filtrar datos. Riesgo bajo; documentado.

### 2.2 Abuso de límites de tasa (Rate Limiting) — ✅

- **Hallazgo**: `POST /ordenes` tenía rate limiting, pero **`POST /auth` no** →
  la contraseña del panel era vulnerable a fuerza bruta.
- **Remediación**: limitador independiente por endpoint. `POST /auth` limita a
  `AUTH_MAX_ATTEMPTS` (10 por defecto) por IP cada 15 min y responde `429` con
  `Retry-After`. Se corrigió además el crecimiento ilimitado del mapa en memoria
  con una limpieza periódica (`setInterval(...).unref()`).

### 2.3 Exposición de datos innecesarios — ✅

- **Hallazgo**: las respuestas se inspeccionaron campo a campo. `GET /ordenes`
  devuelve PII (nombre, teléfono) pero está **protegido por autenticación** y es
  necesario para el panel. `POST /ordenes` sólo devuelve la propia orden recién
  creada. No hay campos internos, hashes ni secretos en las respuestas. Se
  eliminó la cabecera `X-Powered-By` (fingerprinting).

### 2.4 Inyección de comandos en parámetros — ✅

- **Hallazgo**: no se usa `child_process`/`exec` ni evaluación dinámica. Los
  parámetros de filtrado/paginación (`fecha`, `estado`) se validan y parametrizan;
  caracteres especiales no alteran la consulta ni ejecutan comandos. **No se
  encontró inyección de comandos.**

### 2.5 Mecanismo de autenticación — ✅

- La API usa **token de portador (Bearer)**. Antes era el `ADMIN_TOKEN` estático;
  ahora es un **token de sesión propio, firmado con HMAC-SHA256 y con
  expiración** — un esquema tipo JWT minimalista y sin dependencias. La
  contraseña se compara en tiempo constante (`crypto.timingSafeEqual`).

---

## Cambios de configuración recomendados en producción

- Definir un `SESSION_SECRET` **dedicado** (distinto del `ADMIN_TOKEN`) y largo.
- Usar un `ADMIN_TOKEN` largo y aleatorio.
- Mantener `FRONTEND_ORIGIN` apuntando exactamente al dominio del frontend.
- Servir siempre sobre HTTPS (Render y Netlify lo hacen) para que HSTS aplique.

## Herramientas sugeridas para verificación continua

- **OWASP ZAP** o **Burp Suite** para escaneo dinámico (DAST) del frontend y la
  API.
- **Postman/newman** para pruebas de autorización y rate limiting.
- Cabeceras: verificables con [securityheaders.com](https://securityheaders.com)
  y la CSP con la consola del navegador.

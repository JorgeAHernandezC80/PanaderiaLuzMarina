# Política de Seguridad

## Versiones soportadas

Se da soporte de seguridad a la rama `main` (última versión desplegada).

## Reportar una vulnerabilidad

Si encuentras una vulnerabilidad, **no abras un issue público**. Repórtala de
forma privada:

- Usa **GitHub Security Advisories** (pestaña _Security → Report a vulnerability_)
  de este repositorio, o
- Contacta al mantenedor por un canal privado.

Incluye, si es posible: descripción, pasos para reproducir, impacto estimado y
cualquier PoC. Intentaremos responder en un plazo razonable y coordinar la
divulgación una vez publicado el arreglo.

## Prácticas de seguridad del proyecto

- **Secretos fuera del código**: `ADMIN_TOKEN` y `SESSION_SECRET` se definen por
  variables de entorno (ver `.env.example`). `.env` y `*.db` no se versionan.
- **Datos personales (PII)**: la base de datos SQLite guarda nombre y teléfono de
  clientes. No debe subirse al repositorio ni exponerse públicamente.
- **Autenticación del panel admin**: contraseña comparada en tiempo constante; el
  login emite un **token de sesión firmado (HMAC-SHA256) con expiración**, no la
  contraseña. Rate limiting anti fuerza bruta en `/auth`.
- **Cabeceras de seguridad**: HSTS, CSP, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy` y `Permissions-Policy` tanto en el backend
  (JSON API) como en el frontend estático (`_headers` de Netlify).
- **Entrada no confiable**: validación estricta de esquema en el backend
  (`validation.js`), consultas SQL siempre parametrizadas (better-sqlite3) y
  escape de HTML al renderizar datos en el panel admin.

Consulta el detalle completo del análisis en
[`docs/auditoria-seguridad.md`](docs/auditoria-seguridad.md).

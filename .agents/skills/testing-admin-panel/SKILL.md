---
name: testing-admin-panel
description: How to run and test the Panadería Luz Marina admin panel (login, pedidos, insumos) locally end-to-end.
---

# Testing the admin panel locally

## Servicios
1. Backend (Express + SQLite). **No carga `.env`** (no usa dotenv): exporta las variables al arrancar.
   ```
   PORT=3000 FRONTEND_ORIGIN=http://localhost:5500 ADMIN_TOKEN=<clave> SESSION_SECRET=<algo> node server.js
   ```
   Debe imprimir `Escuchando en el puerto 3000`. Si dice "ADMIN_TOKEN no está configurado", el panel no dejará entrar.
2. Frontend estático **obligatoriamente en el puerto 5500**:
   ```
   npx --yes serve -l 5500 .
   ```
   Motivo: `JS/core/api.js` usa `http://localhost:3000` cuando el hostname es localhost, y la allowlist CORS de `server.js` solo incluye `http://localhost:5500` y `http://127.0.0.1:5500`. En cualquier otro puerto el login falla con "No se pudo conectar con el servidor" (error de CORS, no del código bajo prueba).
3. Abrir `http://localhost:5500/admin.html` y entrar con el valor de `ADMIN_TOKEN` como contraseña.

## Notas
- Arrancar procesos en segundo plano con `&`/`nohup` desde el shell one-shot puede matarlos; usa una sesión de shell persistente (tty).
- La sesión se guarda en `sessionStorage` (`plm_admin_session` / `plm_admin_token`), así que sobrevive a F5 pero no a una pestaña nueva.
- Insumos: pestaña «Insumos» en `#admin-nav`; CRUD contra `/insumos` (GET/POST/PUT/DELETE con `Authorization: Bearer`). El badge «Stock bajo» aparece cuando cantidad <= stock mínimo.
- Posible flake: un clic en «Eliminar» puede devolver a la pantalla de login sin borrar (aparente 401 en un refresh de fondo). Si pasa, vuelve a entrar y repite; verifica el estado real con `GET /insumos` usando un token obtenido por `POST /auth`.
- Para validar el estado del backend sin la UI:
  `T=$(curl -s -X POST localhost:3000/auth -H 'Content-Type: application/json' -d '{"password":"<clave>"}' | jq -r .token); curl -s localhost:3000/insumos -H "Authorization: Bearer $T"`

## Devin Secrets Needed
- Ninguno para pruebas locales: define tú `ADMIN_TOKEN` y `SESSION_SECRET`.

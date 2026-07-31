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

## Sidebar del panel (`#admin-nav`)

- Ítems: `.admin-nav__btn[data-view-target]`; los "Pronto" están `disabled` y quedan fuera de la navegación con teclado
  (por eso `End` lleva a **Proveedores**, no a "Dashboard").
- Rail colapsable: botón `#admin-nav-collapse`; el estado se guarda en `localStorage['plm_admin_nav_collapsed']`
  (`'1'`/`'0'`) y sobrevive a F5. Comprueba el ancho real con `document.getElementById('admin-nav').offsetWidth`
  (~285px expandido a 1424px de viewport, ~80px en rail).
- Buscador `#admin-nav-search`: filtra por label normalizado (sin acentos); Enter abre el primer resultado, Escape
  limpia; `#admin-nav-empty` muestra "Sin secciones que coincidan".
- Los badges de conteo (`#horneadas-count`, `#insumos-count`, …) sólo se actualizan al cargar cada vista, así que
  arrancan en `0`. Para verlos con datos, siembra por API antes de probar, p. ej.:
  `curl -s -X POST localhost:3000/insumos -H 'Content-Type: application/json' -H "Authorization: Bearer $T" -d '{"nombre":"Harina","categoria":"harinas","cantidad":25,"unidad":"kg","costoUnitario":3500,"stockMinimo":5}'`
  (horneadas requieren `{"productoId":1,"cantidad":24,"fecha":"YYYY-MM-DD","hora":"07:30"}`; proveedores
  `{"razonSocial":"X","condicionesPago":"contado","moneda":"COP"}`).
- Los tooltips del rail son `::after` con `attr(data-tooltip)` dentro de `.admin-nav__groups`, que tiene `overflow:auto`:
  pueden quedar **recortados e invisibles**. No los des por buenos porque el DOM/CSS diga `opacity: 1`; verifica en
  píxeles con una captura mientras el cursor está encima.
- El sidebar usa `100dvh` con `top` desplazado por el padding del shell, por lo que el botón "Cerrar sesión" puede
  quedar cortado bajo el viewport. Comprueba con
  `document.getElementById('btn-logout').getBoundingClientRect().bottom <= innerHeight`.
- El ítem activo puede perder contraste (texto blanco sobre fondo crema) al hacer hover/foco: revísalo con capturas,
  no sólo con el DOM.

## Probar tamaños de pantalla (sin devtools)

- Redimensionar la ventana: `wmctrl -r :ACTIVE: -b remove,maximized_vert,maximized_horz` y luego
  `wmctrl -r :ACTIVE: -e 0,0,0,<W>,<H>`. El viewport queda ~32px más estrecho que la ventana.
- **Chrome no baja de ~532px de ancho de ventana**, así que para móvil (~400px CSS) usa zoom nativo (`ctrl+KP_Add`;
  `ctrl+plus` a veces no lo capta xdotool) y para TV (≥1600 / ≥2400 CSS px) usa zoom-out (`ctrl+minus`) en la ventana
  maximizada. `ctrl+0` restablece. Confirma siempre el ancho real con `innerWidth` en consola.
- El breakpoint del drawer es `<900px`; 900–1279 compacto; ≥1600 y ≥2400 agrandado.

## Devin Secrets Needed

- Ninguno para pruebas locales: define tú `ADMIN_TOKEN` y `SESSION_SECRET`.

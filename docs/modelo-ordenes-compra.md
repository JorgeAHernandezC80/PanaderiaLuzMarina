# Modelo estructural — Órdenes de Compra (OC)

Documento de referencia del módulo **Órdenes de compra** del panel (`admin.html`,
pestaña _Stock & Compras → Órdenes compra_). Describe las entidades, el ciclo de
vida, las reglas de negocio y los puntos de trazabilidad. El código que lo
implementa vive en `db.js` (esquema), `validation.js` (reglas), `server.js`
(API + bitácora) y `JS/pages/admin.js` (panel).

## 1. Por qué existe

Antes de este módulo, la compra de materia prima no dejaba rastro: alguien
pedía harina por WhatsApp, llegaba, y lo único que cambiaba era el número en
`insumos.cantidad`. No había forma de responder preguntas básicas de auditoría:

- ¿Quién autorizó esta compra y cuándo?
- ¿Qué se pidió, a qué precio pactado, y qué llegó de verdad?
- ¿Cuánto de lo pedido sigue pendiente de entrega?
- ¿De qué orden y de qué lote del proveedor salió el insumo que se usó en la
  tanda de masa del martes?

El modelo responde las cuatro con **tres niveles de registro**: lo _pactado_
(orden + ítems), lo _ocurrido_ (recepciones + ítems recibidos) y la _bitácora_
(eventos + cadena de hashes de auditoría).

## 2. Entidades

```
proveedores ──1:N──> ordenes_compra ──1:N──> orden_compra_items ──┐
                          │                        ▲              │
                          │                        │ (item_id)    │ (insumo_id)
                          ├──1:N──> orden_compra_recepciones      │
                          │              └──1:N──> orden_compra_recepcion_items
                          │                                       │
                          └──1:N──> orden_compra_eventos          ▼
                                                              insumos
```

### 2.1 `ordenes_compra` — la cabecera (lo pactado)

| Columna                                                | Tipo                              | Nota                                                                                     |
| ------------------------------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------- |
| `id`                                                   | TEXT PK                           | UUID                                                                                     |
| `numero`                                               | TEXT UNIQUE                       | `OC-AAAAMMDD-NNNN`, correlativo por día. Es el identificador que se le dice al proveedor |
| `proveedor_id`                                         | TEXT NOT NULL → `proveedores(id)` | FK real, sin `ON DELETE`: un proveedor con OC no se puede borrar                         |
| `proveedor_razon_social`                               | TEXT NOT NULL                     | **Snapshot** del nombre al momento de emitir                                             |
| `estado`                                               | TEXT                              | Ver §3                                                                                   |
| `fecha_emision`                                        | TEXT `AAAA-MM-DD`                 | Fecha del documento                                                                      |
| `fecha_entrega_estimada`                               | TEXT                              | Se precalcula con `proveedores.lead_time_dias`                                           |
| `condiciones_pago`, `moneda`                           | TEXT                              | Heredadas del proveedor, editables por orden                                             |
| `subtotal`, `impuestos`, `descuento`, `flete`, `total` | REAL                              | **Calculados en el servidor** a partir de los ítems; nunca se confía en el cliente       |
| `solicitado_por`                                       | TEXT                              | Quién pide                                                                               |
| `aprobado_por`, `aprobado_en`                          | TEXT                              | Se llenan solos al pasar a `emitida`                                                     |
| `lugar_entrega`, `notas`                               | TEXT                              |                                                                                          |
| `motivo_cancelacion`                                   | TEXT                              | Obligatorio al cancelar                                                                  |
| `creado_en`, `actualizado_en`                          | TEXT                              |                                                                                          |

Snapshot deliberado: `proveedor_razon_social`, `insumo_nombre` y
`costo_unitario` se copian en la orden. Si mañana el proveedor cambia de razón
social o sube el precio, la orden histórica sigue diciendo lo que se pactó ese
día — mismo criterio que ya usan `horneadas.producto_nombre` y
`receta_ingredientes.insumo_nombre`.

### 2.2 `orden_compra_items` — el detalle pactado

| Columna                                       | Nota                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `id`, `orden_compra_id` (CASCADE)             |                                                                                                |
| `insumo_id` → `insumos(id)`, `insumo_nombre`  | FK + snapshot                                                                                  |
| `cantidad_pedida`, `unidad`                   | La unidad se toma del insumo (`UNIDADES_INSUMO`)                                               |
| `costo_unitario`                              | Precio pactado por unidad                                                                      |
| `impuesto_porcentaje`, `descuento_porcentaje` | Por línea                                                                                      |
| `subtotal`, `total_linea`                     | Calculados: `subtotal = cantidad × costo × (1 − desc%)`, `total_linea = subtotal × (1 + imp%)` |
| `cantidad_recibida`                           | **Derivada**: suma de las recepciones. Nunca se escribe a mano                                 |
| `orden`                                       | Posición en el documento                                                                       |
| `notas`                                       |                                                                                                |

Invariante: `cantidad_recibida ≤ cantidad_pedida × (1 + TOLERANCIA)`. La
tolerancia por sobre-entrega es 0 por defecto — si llega de más, se registra
como línea rechazada, no como recepción silenciosa.

### 2.3 `orden_compra_recepciones` — lo que de verdad llegó

Una orden puede recibirse en varias entregas. Cada recepción es un documento
propio, inmutable una vez creado:

`id`, `orden_compra_id` (CASCADE), `fecha`, `hora`, `recibido_por`,
`documento_referencia` (remisión/factura del proveedor), `notas`, `creado_en`.

### 2.4 `orden_compra_recepcion_items` — trazabilidad fina

Es la tabla que hace posible el rastreo hacia atrás desde una tanda de masa:

`id`, `recepcion_id` (CASCADE), `item_id` → `orden_compra_items(id)`,
`insumo_id`, `cantidad_recibida`, `cantidad_rechazada`, `motivo_rechazo`,
`lote_proveedor`, `fecha_vencimiento`, `temperatura_recepcion_c`, `notas`.

`lote_proveedor` y `fecha_vencimiento` se copian al insumo al recibir, que es
lo que conecta la compra con `insumos.lote_proveedor` / `fecha_vencimiento` y,
por esa vía, con las recetas y producciones que usaron ese insumo.

### 2.5 `orden_compra_eventos` — bitácora append-only

Cada cambio relevante escribe una fila; nada se actualiza ni se borra:

`id`, `orden_compra_id` (CASCADE), `tipo`, `estado_anterior`, `estado_nuevo`,
`descripcion`, `datos` (JSON), `usuario`, `creado_en`.

Tipos: `creada`, `editada`, `emitida`, `confirmada`, `recepcion_registrada`,
`recibida_parcial`, `recibida`, `cerrada`, `cancelada`.

Además, todos esos eventos se replican en `auditoria_cadena`
(`Auditoria.registrarEnCadena`, entidad `ordenes_compra`), que es la cadena de
hashes ya existente del proyecto: si alguien edita la bitácora directamente en
SQLite, `GET /auditoria/verificar` lo detecta.

## 3. Ciclo de vida (`OC_ESTADOS`)

```
borrador ──> emitida ──> confirmada ──> recibida_parcial ──> recibida ──> cerrada
    │            │            │                │
    └────────────┴────────────┴────────────────┴──> cancelada  (motivo obligatorio)
```

| Estado             | Significa                 | Qué se puede hacer                               |
| ------------------ | ------------------------- | ------------------------------------------------ |
| `borrador`         | Se está armando           | Editar cabecera e ítems, eliminar la orden       |
| `emitida`          | Enviada al proveedor      | Registrar recepciones. Ya no se editan ítems     |
| `confirmada`       | El proveedor la aceptó    | Registrar recepciones                            |
| `recibida_parcial` | Llegó una parte           | Registrar más recepciones. **Estado automático** |
| `recibida`         | Llegó todo lo pedido      | Cerrar. **Estado automático**                    |
| `cerrada`          | Conciliada con la factura | Nada: terminal                                   |
| `cancelada`        | Anulada                   | Nada: terminal                                   |

Reglas:

- `recibida_parcial` y `recibida` **no se fijan a mano**: los calcula el
  servidor comparando `cantidad_recibida` contra `cantidad_pedida` de todos los
  ítems después de cada recepción.
- Una orden con al menos una recepción no se puede cancelar ni eliminar: ya
  movió inventario.
- Los ítems solo son editables en `borrador`. Después, cualquier corrección se
  hace cancelando y emitiendo una orden nueva, para no reescribir la historia.

## 4. Efecto sobre el inventario

Registrar una recepción, dentro de una única transacción SQLite:

1. Inserta la recepción y sus líneas.
2. Suma `cantidad_recibida` a `insumos.cantidad` del insumo correspondiente
   (misma unidad que el ítem; si difieren, se convierte con `units.js` y si no
   es convertible se rechaza la recepción en vez de sumar peras con manzanas).
3. Actualiza `insumos.costo_unitario` con el costo pactado en la orden y
   `lote_proveedor` / `fecha_vencimiento` con los de la línea recibida.
4. Recalcula `cantidad_recibida` de cada ítem y el estado de la orden.
5. Escribe el evento en `orden_compra_eventos` y el bloque en
   `auditoria_cadena`.

Si algo falla, la transacción revierte todo: nunca queda inventario sumado sin
su recepción, ni recepción sin su evento.

## 5. API

Todas requieren `Authorization: Bearer <token>` (panel admin).

| Método | Ruta                                                 | Uso                                                            |
| ------ | ---------------------------------------------------- | -------------------------------------------------------------- |
| GET    | `/ordenes-compra?estado=&proveedorId=&desde=&hasta=` | Listado con filtros                                            |
| GET    | `/ordenes-compra/:id`                                | Orden completa: ítems, recepciones, eventos                    |
| POST   | `/ordenes-compra`                                    | Crea en `borrador` (o directo en `emitida` con `emitir: true`) |
| PUT    | `/ordenes-compra/:id`                                | Edita cabecera + ítems. Solo en `borrador`                     |
| PATCH  | `/ordenes-compra/:id/estado`                         | Transición de estado (`estado`, `usuario`, `motivo`)           |
| POST   | `/ordenes-compra/:id/recepciones`                    | Registra una entrega                                           |
| GET    | `/ordenes-compra/:id/trazabilidad`                   | Bitácora + bloques de la cadena de auditoría                   |
| DELETE | `/ordenes-compra/:id`                                | Solo en `borrador` y sin recepciones                           |

Eventos WebSocket emitidos: `orden-compra:nueva`, `orden-compra:actualizada`,
`orden-compra:recepcion`, `orden-compra:eliminada`.

## 6. Vista en `admin.html`

`#ordenes-compra-view`, con la misma estructura que el resto del panel:

1. **Tarjetas de resumen** — abiertas, por recibir, recibidas del mes, valor
   comprado del mes.
2. **Formulario de orden** — proveedor, fechas, condiciones, más un
   constructor de líneas (`#oc-items-lista`) con el mismo patrón que los
   ingredientes de Receta: fila por insumo con cantidad, costo, impuesto y
   descuento, y totales recalculados en vivo.
3. **Listado** — tarjeta por orden con estado, avance de recepción
   (`recibido / pedido`), botones de transición y "Registrar recepción".
4. **Panel de detalle** — ítems, recepciones y la **línea de tiempo de
   trazabilidad** (los eventos, con usuario y fecha).

## 7. Orden de construcción

El módulo se construyó en este orden, cada paso funcional por sí mismo:

1. Esquema y migraciones (`db.js`).
2. Reglas y sanitización (`validation.js`).
3. API + bitácora + efecto en inventario (`server.js`).
4. Vista, formulario y línea de tiempo (`admin.html`, `admin.js`, `CSS`).
5. Tests (`tests/ordenes-compra.test.js`).

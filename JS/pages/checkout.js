/**
 * PANADERÍA LUZ MARINA — Página: Checkout
 * - Carga items del carrito
 * - Valida formulario
 * - Genera número de orden + fecha para trazabilidad
 * - Guarda la orden en localStorage
 * - Abre WhatsApp con el pedido completo
 * - Muestra pantalla de confirmación con los datos de trazabilidad
 */

import { initUI } from '../core/ui.js';
import { getCart, getCartTotal, clearCart, escapeHTML } from '../core/cart.js';
import { formatPrice } from '../core/format.js';
import { apiFetch } from '../core/api.js';

/* ---- Número WhatsApp Business de Panadería Luz Marina ---- */
const WA_BUSINESS = '12817703825';

/* ---- Trazabilidad ---- */

/** Genera número de orden único: LM-YYYYMMDD-XXXX */
function generarNumeroOrden() {
  const ahora  = new Date();
  const fecha  = ahora.toISOString().slice(0, 10).replace(/-/g, '');
  const sufijo = String(Math.floor(1000 + Math.random() * 9000));
  return `LM-${fecha}-${sufijo}`;
}

/** Formatea fecha y hora en español legible */
function formatearFechaHora(date) {
  const dias   = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const meses  = ['enero','febrero','marzo','abril','mayo','junio',
                  'julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const dia    = dias[date.getDay()];
  const numero = date.getDate();
  const mes    = meses[date.getMonth()];
  const anio   = date.getFullYear();
  const hora   = date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true });
  return `${dia} ${numero} de ${mes}, ${anio} · ${hora}`;
}

/** Guarda la orden en localStorage para historial */
function guardarOrdenEnHistorial(orden) {
  try {
    const historial = JSON.parse(localStorage.getItem('plm_ordenes') ?? '[]');
    historial.unshift(orden); // más reciente primero
    // Conservar solo las últimas 20 órdenes
    localStorage.setItem('plm_ordenes', JSON.stringify(historial.slice(0, 20)));
  } catch {
    /* localStorage no disponible — continuar igual */
  }
}

/* ---- Renderizar resumen de items ---- */
function renderItems() {
  const items      = getCart();
  const container  = document.querySelector('[data-checkout-items]');
  const vacio      = document.querySelector('[data-checkout-vacio]');
  const subtotales = document.querySelectorAll('[data-checkout-subtotal]');
  const totales    = document.querySelectorAll('[data-checkout-total]');
  const resSubtotales = document.querySelectorAll('[data-resumen-subtotal]');
  const resTotales    = document.querySelectorAll('[data-resumen-total]');
  const btnEnviar  = document.querySelector('[data-btn-enviar-whatsapp]');

  const hay = items.length > 0;

  if (container) {
    container.innerHTML = items.map(item => `
      <div class="checkout-item" data-item-id="${escapeHTML(item.id)}">
        <div class="checkout-item__info">
          <span class="checkout-item__nombre">${escapeHTML(item.nombre)}</span>
          <span class="checkout-item__cantidad">× ${Number(item.cantidad)}</span>
        </div>
        <span class="checkout-item__precio">${formatPrice(item.precio * item.cantidad)}</span>
      </div>
    `).join('');
  }

  if (vacio) vacio.hidden = hay;

  const total = getCartTotal();
  const fmt   = formatPrice(total);

  [...subtotales, ...resSubtotales].forEach(el => el.textContent = fmt);
  [...totales,    ...resTotales   ].forEach(el => el.textContent = fmt);

  if (btnEnviar) btnEnviar.disabled = !hay;
}

/* ---- Validación ---- */
function showError(field, show) {
  const el = document.querySelector(`[data-error-${field}]`);
  if (el) el.hidden = !show;
}

function validateForm(form) {
  const nombre   = form.querySelector('[data-form-nombre]')?.value.trim()  ?? '';
  const telefono = form.querySelector('[data-form-telefono]')?.value.trim() ?? '';
  const hora     = form.querySelector('[data-form-hora]')?.value             ?? '';
  const minuto   = form.querySelector('[data-form-minuto]')?.value           ?? '';

  let valid = true;

  if (!nombre || nombre.length > 80) { showError('nombre', true); valid = false; } else showError('nombre', false);

  const telefonoDigitos = telefono.replace(/\D/g, '');
  if (!telefonoDigitos || telefonoDigitos.length < 7 || telefonoDigitos.length > 15)
                 { showError('telefono',true);  valid = false; } else showError('telefono',false);
  if (!hora || !minuto || !/^\d{1,2}$/.test(hora) || !/^\d{1,2}$/.test(minuto))
                 { showError('horario', true);  valid = false; } else showError('horario', false);

  return valid ? { nombre, telefono: telefonoDigitos, hora, minuto } : null;
}

/* ---- Construir mensaje WhatsApp con trazabilidad ---- */
function buildPedido(datos, items, total, orden) {
  const lineas = items.map(i =>
    `• ${i.nombre} × ${i.cantidad} = ${formatPrice(i.precio * i.cantidad)}`
  ).join('\n');

  return [
    `Hola Panadería Luz Marina 👋`,
    '',
    `🔖 *Orden:* ${orden.numero}`,
    `📅 *Fecha:* ${orden.fechaTexto}`,
    '',
    `👤 *Cliente:* ${datos.nombre}`,
    `📱 *Teléfono:* ${datos.telefono}`,
    '',
    '🛒 *Pedido:*',
    '',
    lineas,
    '',
    `*Total: ${formatPrice(total)}*`,
    '',
    `🕐 Retiro a las *${datos.hora}:${datos.minuto}*`,
    `📍 Avenida Rústica 1042`,
    `💵 Pago en efectivo al retirar`,
    '',
    '¡Gracias por su compra!',
  ].join('\n');
}

/* ---- Mostrar pantalla de confirmación ---- */
function mostrarConfirmacion(orden, datos) {
  const formSection = document.querySelector('.checkout');
  const stepper     = document.querySelector('.checkout__stepper');
  const pageTitle   = document.querySelector('.page-title');

  if (pageTitle) {
    pageTitle.querySelector('.page-title__text').textContent = '¡Pedido enviado!';
    pageTitle.querySelector('.page-title__subtitle').textContent =
      'Tu pedido fue enviado por WhatsApp a la panadería.';
  }

  if (stepper) stepper.hidden = true;

  if (formSection) {
    formSection.innerHTML = `
      <div class="confirmacion container">
        <div class="confirmacion__card">
          <span class="confirmacion__icono" aria-hidden="true">✅</span>

          <div class="confirmacion__trazabilidad">
            <div class="confirmacion__dato">
              <span class="confirmacion__dato-label">Número de orden</span>
              <span class="confirmacion__dato-valor confirmacion__dato-valor--orden">${orden.numero}</span>
            </div>
            <div class="confirmacion__dato">
              <span class="confirmacion__dato-label">Fecha y hora</span>
              <span class="confirmacion__dato-valor">${orden.fechaTexto}</span>
            </div>
            <div class="confirmacion__dato">
              <span class="confirmacion__dato-label">Cliente</span>
              <span class="confirmacion__dato-valor">${escapeHTML(datos.nombre)}</span>
            </div>
            <div class="confirmacion__dato">
              <span class="confirmacion__dato-label">Retiro</span>
              <span class="confirmacion__dato-valor">${escapeHTML(datos.hora)}:${escapeHTML(datos.minuto)} — Avenida Rústica 1042</span>
            </div>
          </div>

          <p class="confirmacion__nota">
            Guarda tu número de orden. La panadería te confirmará el pedido pronto.
          </p>

          <a href="catalogo.html" class="btn btn--primary">Seguir comprando</a>
        </div>
      </div>
    `;
  }
}

/** Envía la orden al backend para que el panel admin la vea en vivo.
 *  No bloqueante: si el backend está caído, el flujo de WhatsApp
 *  (canal principal del negocio) continúa sin interrupción.
 */
async function enviarOrdenAlBackend(orden) {
  try {
    const res = await apiFetch('/ordenes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orden),
      timeout: 10_000, // 10s máx
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.warn('[checkout] Backend rechazó la orden:', body.error || res.status);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn('[checkout] Backend tardó demasiado, se omitió el registro (WhatsApp sigue activo).');
    } else {
      console.warn('[checkout] No se pudo contactar al backend:', err.message);
    }
  }
}

/* ---- Submit ---- */
function initForm() {
  const form = document.querySelector('[data-checkout-form]');
  if (!form) return;

  form.addEventListener('submit', e => {
    e.preventDefault();

    const datos = validateForm(form);
    if (!datos) return;

    const items     = getCart();
    const total     = getCartTotal();
    const ahora     = new Date();

    /* Crear objeto de orden con trazabilidad */
    const orden = {
      numero:    generarNumeroOrden(),
      fechaISO:  ahora.toISOString(),
      fechaTexto:formatearFechaHora(ahora),
      cliente:   datos.nombre,
      telefono:  datos.telefono,
      retiro:    `${datos.hora}:${datos.minuto}`,
      items:     items.map(i => ({ nombre: i.nombre, cantidad: i.cantidad, precio: i.precio })),
      total:     total,
    };

    /* Guardar en historial de localStorage (respaldo local) */
    guardarOrdenEnHistorial(orden);

    /* Limpiar carrito inmediatamente — antes de cualquier redirección */
    clearCart();

    /* Enviar al backend para que el panel admin la vea — no bloqueante */
    enviarOrdenAlBackend(orden);

    /* Construir URL de WhatsApp */
    const mensaje = encodeURIComponent(buildPedido(datos, items, total, orden));
    const url     = `https://api.whatsapp.com/send?phone=${WA_BUSINESS}&text=${mensaje}`;

    /* Mostrar confirmación en la página */
    mostrarConfirmacion(orden, datos);

    /* Redirigir a WhatsApp — location.href nunca es bloqueado */
    window.location.href = url;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initUI();
  renderItems();
  initForm();
});
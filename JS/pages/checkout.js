/**
 * PANADERÍA LUZ MARINA — Página: Checkout
 * - Carga items del carrito
 * - Valida formulario
 * - Abre WhatsApp hacia el número de LA PANADERÍA para que el cliente
 *   envíe su pedido directamente desde su teléfono.
 */

import { initUI } from '../core/ui.js';
import { getCart, getCartTotal, formatPrice, clearCart } from '../core/cart.js';

/* ---- Número WhatsApp Business de Panadería Luz Marina ---- */
const WA_BUSINESS = '12817703825'; // dígitos puros, con código de país

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
      <div class="checkout-item" data-item-id="${item.id}">
        <div class="checkout-item__info">
          <span class="checkout-item__nombre">${item.nombre}</span>
          <span class="checkout-item__cantidad">× ${item.cantidad}</span>
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

  if (!nombre)   { showError('nombre',  true);  valid = false; } else showError('nombre',  false);
  if (!telefono || telefono.replace(/\D/g, '').length < 7)
                 { showError('telefono',true);  valid = false; } else showError('telefono',false);
  if (!hora || !minuto)
                 { showError('horario', true);  valid = false; } else showError('horario', false);

  return valid ? { nombre, telefono, hora, minuto } : null;
}

/* ---- Construir mensaje que el CLIENTE envía a la panadería ---- */
function buildPedido(datos, items, total) {
  const lineas = items.map(i =>
    `• ${i.nombre} × ${i.cantidad} = ${formatPrice(i.precio * i.cantidad)}`
  ).join('\n');

  return [
    `Hola Panadería Luz Marina 👋`,
    '',
    `Mi nombre es *${datos.nombre}*`,
    `📱 Teléfono: ${datos.telefono}`,
    '',
    '🛒 *Mi pedido:*',
    '',
    lineas,
    '',
    `*Total: ${formatPrice(total)}*`,
    '',
    `🕐 Paso a retirar a las *${datos.hora}:${datos.minuto}*`,
    '💵 Pago en efectivo al retirar',
    '',
    '¡Gracias!',
  ].join('\n');
}

/* ---- Submit ---- */
function initForm() {
  const form = document.querySelector('[data-checkout-form]');
  if (!form) return;

  form.addEventListener('submit', e => {
    e.preventDefault();

    const datos = validateForm(form);
    if (!datos) return;

    const items   = getCart();
    const total   = getCartTotal();
    const mensaje = encodeURIComponent(buildPedido(datos, items, total));

    // El cliente abre WhatsApp y le escribe directamente a la panadería
    const url = `https://wa.me/${WA_BUSINESS}?text=${mensaje}`;

    // Primero abrir WhatsApp, luego limpiar el carrito
    window.open(url, '_blank', 'noopener,noreferrer');
    clearCart();
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initUI();
  renderItems();
  initForm();
});
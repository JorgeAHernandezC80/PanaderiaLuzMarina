/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://panaderialuzmarina.netlify.app"}
 */

import { API_BASE } from '../JS/core/api.js';

test('apunta al backend de producción (Render) cuando el hostname no es localhost', () => {
  expect(window.location.hostname).toBe('panaderialuzmarina.netlify.app');
  expect(API_BASE).toBe('https://panaderialuzmarina.onrender.com');
});

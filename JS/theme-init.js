/**
 * Aplica el tema (claro/oscuro) antes del primer render para evitar el parpadeo
 * (FOUC). Se carga como script externo — no inline — para permitir una CSP
 * estricta (`script-src 'self'`) sin necesidad de 'unsafe-inline' ni hashes.
 */
(function () {
  var t = localStorage.getItem('plm_theme');
  if (!t) t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
})();

/* global SwaggerUIBundle */
// Remplace le swagger-initializer.js de swagger-ui-dist : charge /openapi.json (même origine) sans aucune ressource externe,
// pour respecter la CSP du serveur (script-src 'self', connect-src 'self').
window.onload = function () {
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis],
    layout: 'BaseLayout',
    docExpansion: 'list',
    defaultModelsExpandDepth: 0,
    displayRequestDuration: true,
    persistAuthorization: true,
    validatorUrl: null,
  });
};

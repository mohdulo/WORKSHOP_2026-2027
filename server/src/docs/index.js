'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const YAML = require('yaml');
const swaggerUiDist = require('swagger-ui-dist');

const SPEC_PATH = path.join(__dirname, 'openapi.yaml');
const UI_DIR = path.join(__dirname, 'ui');

/** Lit et parse openapi.yaml (source de vérité de la documentation). */
function loadOpenApi() {
  return YAML.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
}

/**
 * createDocsRouter() : documentation de l'API, publique (les clés de test figurent déjà dans le README).
 *  - GET /openapi.json, GET /openapi.yaml : la spécification OpenAPI 3.1 ;
 *  - GET /docs : Swagger UI. Les fichiers de swagger-ui-dist sont servis en local (pas de CDN) : compatible avec la CSP
 *    `script-src 'self'` de helmet, fonctionne hors ligne et dans Docker. index.html et swagger-initializer.js sont les
 *    nôtres (ui/) et passent AVANT ceux du paquet ; les chemins y sont absolus (/docs/…), donc /docs et /docs/ marchent.
 * À monter avant le front (mountSpa) ; '/docs', '/openapi.json' et '/openapi.yaml' sont dans API_PREFIXES (app.js)
 * pour qu'une URL inconnue sous /docs reçoive la 404 JSON de l'API et non la page du front.
 */
function createDocsRouter() {
  const router = express.Router();
  const yaml = fs.readFileSync(SPEC_PATH, 'utf8');
  const json = JSON.stringify(YAML.parse(yaml));

  router.get('/openapi.json', (req, res) => res.type('application/json').send(json));
  router.get('/openapi.yaml', (req, res) => res.type('application/yaml').send(yaml));
  router.use('/docs', express.static(UI_DIR, { index: 'index.html' }));
  router.use('/docs', express.static(swaggerUiDist.getAbsoluteFSPath(), { index: false }));
  return router;
}

module.exports = { createDocsRouter, loadOpenApi, SPEC_PATH };

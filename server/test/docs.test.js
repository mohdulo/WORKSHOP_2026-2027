'use strict';
const request = require('supertest');
const SwaggerParser = require('@apidevtools/swagger-parser');
const { makeApp } = require('./helpers');
const { loadOpenApi } = require('../src/docs');
const { EVENT_TYPES } = require('../src/modules/events/types');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Préfixe de montage d'un routeur Express 4 depuis sa regexp : /^\/v1\/?(?=\/|$)/i → "/v1" ; routeur sans chemin → "". */
function mountPath(layer) {
  if (layer.regexp.fast_slash) return '';
  const m = /^\^((?:\\\/[^\\?(]+)+)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  if (!m) throw new Error(`Chemin de montage non reconnu : ${layer.regexp}`);
  return m[1].replace(/\\\//g, '/');
}

/** Routes réellement montées, au format OpenAPI : "GET /v1/customers/{id}" (paramètres Express `:id` → `{id}`). */
function listRoutes(app) {
  const routes = new Set();
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.add(`${method.toUpperCase()} ${(prefix + layer.route.path).replace(/:([A-Za-z_]+)/g, '{$1}')}`);
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  walk(app._router.stack, '');
  return routes;
}

/** Opérations documentées : "GET /v1/customers/{id}". */
function listOperations(spec) {
  const ops = new Set();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) if (item[method]) ops.add(`${method.toUpperCase()} ${p}`);
  }
  return ops;
}

function* operations(spec) {
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) if (item[method]) yield { path: p, method, op: item[method] };
  }
}

// Routes ouvertes à la clé publique (PLAN §3) : les seules à déclarer `publishableKey`.
const PUBLISHABLE_ROUTES = [
  'POST /v1/payment_methods',
  'GET /v1/payment_intents/{id}',
  'POST /v1/payment_intents/{id}/confirm',
  'POST /v1/three_ds/{challenge_id}/complete',
];

describe('documentation OpenAPI (/openapi.json, /docs)', () => {
  let app;
  let spec;
  beforeAll(() => {
    ({ app } = makeApp());
    spec = loadOpenApi();
  });

  it('GET /openapi.json renvoie la spécification OpenAPI 3.1, sans clé API', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.type).toBe('application/json');
    expect(res.body.openapi).toMatch(/^3\.1\./);
    expect(res.body.info.title).toBe('PaySim API');
    expect(res.body).toEqual(spec);
  });

  it('GET /openapi.yaml renvoie le fichier source', async () => {
    const res = await request(app).get('/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/yaml/);
    expect(res.text.startsWith('openapi: 3.1.0')).toBe(true);
  });

  it('la spécification est un document OpenAPI valide (schéma 3.1, toutes les $ref résolues)', async () => {
    // swagger-parser modifie l'objet qu'il valide : on lui donne une copie.
    const api = await SwaggerParser.validate(structuredClone(spec));
    expect(Object.keys(api.paths).length).toBeGreaterThan(0);
  });

  it('chaque route Express est documentée, et chaque opération documentée existe (aucune dérive)', () => {
    const routes = [...listRoutes(app)].sort();
    const documented = [...listOperations(spec)].sort();
    expect(documented).toEqual(routes);
    expect(routes.length).toBeGreaterThanOrEqual(60);
  });

  it('chaque opération a un operationId unique, un résumé et un tag déclaré', () => {
    const tags = new Set(spec.tags.map((t) => t.name));
    const ids = new Set();
    for (const { path, method, op } of operations(spec)) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(op.operationId, where).toBeTruthy();
      expect(ids.has(op.operationId), `operationId dupliqué : ${op.operationId}`).toBe(false);
      ids.add(op.operationId);
      expect(op.summary, where).toBeTruthy();
      expect(op.tags && op.tags.length, where).toBeGreaterThan(0);
      for (const t of op.tags) expect(tags.has(t), `tag inconnu ${t} (${where})`).toBe(true);
    }
  });

  it('les opérations /v1 exigent une clé (sk, ou pk sur les 4 routes navigateur) ; /demo, /health et la doc sont publiques', () => {
    const schemes = Object.keys(spec.components.securitySchemes).sort();
    expect(schemes).toEqual(['publishableKey', 'secretKey']);
    const withPk = [];
    for (const { path, method, op } of operations(spec)) {
      const where = `${method.toUpperCase()} ${path}`;
      const security = op.security === undefined ? spec.security : op.security;
      if (path.startsWith('/v1/')) {
        expect(security.length, `${where} : security manquante`).toBeGreaterThan(0);
        const names = security.flatMap((s) => Object.keys(s));
        for (const n of names) expect(schemes.includes(n), `${where} : scheme inconnu ${n}`).toBe(true);
        expect(names.includes('secretKey'), `${where} : la clé secrète doit toujours être acceptée`).toBe(true);
        if (names.includes('publishableKey')) withPk.push(where);
      } else {
        expect(security, `${where} doit être public (security: [])`).toEqual([]);
      }
    }
    expect(withPk.sort()).toEqual([...PUBLISHABLE_ROUTES].sort());
  });

  it("l'énumération des types d'événements documentée est exactement EVENT_TYPES", () => {
    expect(spec.components.schemas.EventType.enum).toEqual([...EVENT_TYPES]);
  });

  it('GET /docs sert Swagger UI en local, sans script inline (CSP script-src self), sans clé API', async () => {
    // /docs → /docs/ (redirection standard de serve-static pour un dossier).
    const redirect = await request(app).get('/docs');
    expect(redirect.status).toBe(301);
    expect(redirect.headers.location).toBe('/docs/');

    const res = await request(app).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
    expect(res.text).toContain('id="swagger-ui"');
    expect(res.text).toContain('/docs/swagger-ui-bundle.js');
    // Aucun <script> sans src : helmet n'autorise que script-src 'self'.
    expect(res.text).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    // Aucune ressource externe (CDN, polices) : tout vient de ce serveur.
    expect(res.text).not.toMatch(/https?:\/\//i);
    const init = await request(app).get('/docs/swagger-initializer.js');
    expect(init.status).toBe(200);
    expect(init.text).toContain("url: '/openapi.json'");
    expect(init.text).not.toContain('petstore');
    for (const [asset, type] of [
      ['/docs/swagger-ui-bundle.js', /javascript/],
      ['/docs/swagger-ui.css', /css/],
      ['/docs/index.css', /css/],
      ['/docs/favicon-32x32.png', /png/],
    ]) {
      const res = await request(app).get(asset);
      expect(res.status, asset).toBe(200);
      expect(res.headers['content-type'], asset).toMatch(type);
    }
  });
});

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const pinoHttp = require('pino-http');
const { rateLimit } = require('express-rate-limit');

const { loadConfig } = require('./config');
const { openDb, seedApiKeys } = require('./db');
const { createClock } = require('./lib/clock');
const { createLogger } = require('./lib/logger');
const { newId } = require('./lib/ids');
const { rateLimitError } = require('./lib/errors');
const { idempotency } = require('./middleware/idempotency');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const { createEvents } = require('./modules/events/service');
const { createEventsRouter } = require('./modules/events/routes');
const { createLedger } = require('./modules/ledger/service');
const { createLedgerRouter } = require('./modules/ledger/routes');
const { createNetwork } = require('./modules/network/service');
const { createCustomers } = require('./modules/customers/service');
const { createCustomersRouter } = require('./modules/customers/routes');
const { createVault } = require('./modules/vault/service');
const { createVaultRouter } = require('./modules/vault/routes');
const { createPayments } = require('./modules/payments/service');
const { createPaymentsRouter } = require('./modules/payments/routes');
const { createRefunds } = require('./modules/refunds/service');
const { createRefundsRouter } = require('./modules/refunds/routes');
const { createConnect } = require('./modules/connect/service');
const { createConnectRouter } = require('./modules/connect/routes');
const { createBilling } = require('./modules/billing/service');
const { createBillingRouter } = require('./modules/billing/routes');
const { createTestClock } = require('./modules/testclock/service');
const { createTestClockRouter } = require('./modules/testclock/routes');
const { createWebhooks } = require('./modules/webhooks/service');
const { createWebhooksRouter } = require('./modules/webhooks/routes');
const { createDemo } = require('./demo/service');
const { createDemoRouter } = require('./demo/routes');

/**
 * REGISTRE DES MODULES — les phases suivantes ajoutent leurs entrées ici, dans l'ordre de dépendance.
 *   name    : clé du service dans ctx (ctx[name])
 *   service : (ctx) => objet service (logique métier, reçoit ctx)        — optionnel
 *   routes  : (ctx) => express.Router monté sous /v1                      — optionnel
 * Les services sont tous créés AVANT le montage des routers.
 */
const MODULES = [
  { name: 'events', service: createEvents, routes: createEventsRouter },
  { name: 'ledger', service: createLedger, routes: createLedgerRouter },
  // phase 2 : paiement unique
  { name: 'network', service: createNetwork },
  { name: 'customers', service: createCustomers, routes: createCustomersRouter },
  { name: 'vault', service: createVault, routes: createVaultRouter },
  { name: 'payments', service: createPayments, routes: createPaymentsRouter },
  // phase 3 : refunds, connect
  { name: 'refunds', service: createRefunds, routes: createRefundsRouter },
  { name: 'connect', service: createConnect, routes: createConnectRouter },
  // phase 4 : billing, testclock
  { name: 'billing', service: createBilling, routes: createBillingRouter },
  { name: 'testclock', service: createTestClock, routes: createTestClockRouter },
  // phase 5 : webhooks (APRÈS events et testclock : s'abonne à events.onEmit et enregistre deliverPending via testclock.onAdvance)
  { name: 'webhooks', service: createWebhooks, routes: createWebhooksRouter },
];

/** Masque les paramètres sensibles de la query string (ex : GET /v1/payment_intents/:id?client_secret=...). */
function maskUrl(url) {
  return typeof url === 'string' ? url.replace(/([?&](?:client_secret)=)[^&#]*/gi, '$1[Redacted]') : url;
}

/**
 * CSP de helmet, avec deux ajustements pour le front buildé (vérifiés en navigateur, cf. PLAN §5) :
 *  - polices et scripts : 'self' uniquement (Vite produit des fichiers, aucun script inline) ;
 *  - `upgrade-insecure-requests` seulement en production : en dev/démo le serveur est servi en http
 *    (localhost ou IP du réseau local) et la directive ferait charger les assets en https → échec.
 */
function cspDirectives(config) {
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    fontSrc: ["'self'", 'data:'],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    upgradeInsecureRequests: config.nodeEnv === 'production' ? [] : null,
  };
}

/** Préfixes servis par l'API : jamais remplacés par la page du front. */
const API_PREFIXES = ['/v1', '/demo', '/health'];
const isApiPath = (p) => API_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`));

/**
 * Sert web/dist : assets hashés (cache long) + fallback SPA (index.html) pour les GET/HEAD hors API qui acceptent du HTML.
 * Une route API inconnue garde sa 404 JSON.
 */
function mountSpa(app, dir, logger) {
  const indexPath = path.join(dir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    logger.warn({ dir }, 'front non buildé : lancer `npm run build` (web/dist absent), seules les routes API sont servies');
    return;
  }
  app.use(
    express.static(dir, {
      index: false,
      setHeaders(res, filePath) {
        res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isApiPath(req.path) || !req.accepts('html')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexPath);
  });
}

/**
 * createApp(options) -> { app, db, ctx }
 *  - dbPath    : chemin SQLite (défaut ':memory:')
 *  - logger    : instance pino (défaut : createLogger({ level: config.logLevel }))
 *  - clock     : horloge (défaut : createClock(), temps réel)
 *  - config    : config (défaut : loadConfig())
 *  - rateLimit : false pour désactiver (tests), ou { windowMs, limit }
 *  - modules   : modules supplémentaires (même format que MODULES), ex : routes de test
 *  - seedDemo  : true pour créer le catalogue de démo dès le démarrage (server.js) ; sinon il est créé
 *                au premier appel /demo (les tests des autres modules ne voient pas ces objets)
 *  - staticDir : dossier du front buildé (web/dist) servi avec fallback SPA (production : un seul `npm start`)
 */
function createApp(options = {}) {
  const config = options.config || loadConfig();
  const dbPath = options.dbPath || ':memory:';
  const logger = options.logger || createLogger({ level: config.logLevel });
  const clock = options.clock || createClock();

  const db = openDb(dbPath);
  seedApiKeys(db, config, clock.now());

  const ctx = { db, clock, logger, config };
  const modules = [...MODULES, ...(options.modules || [])];
  for (const mod of modules) {
    if (mod.service) ctx[mod.name] = mod.service(ctx);
  }
  // Phase 6 : marchand de démo (utilise les services avec les droits de la clé secrète, sans l'exposer).
  ctx.demo = createDemo(ctx);
  if (options.seedDemo) ctx.demo.seed();

  const app = express();
  app.locals.ctx = ctx;
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(helmet({ contentSecurityPolicy: { directives: cspDirectives(config) } }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = newId('req');
        res.setHeader('Request-Id', id);
        return id;
      },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      // Le corps n'est PAS journalisé : pino-http sérialise `req` à l'entrée du middleware, avant express.json
      // (cf. taskForLesson L2). Tout log explicite d'une carte reste masqué par `redact` (lib/logger.js).
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: maskUrl(req.url) }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // JSON uniquement ; le corps brut est conservé (signatures webhook, phase 5).
  app.use(
    express.json({
      limit: '100kb',
      verify: (req, res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  if (options.rateLimit !== false) {
    const rl = options.rateLimit || {};
    const limiter = rateLimit({
      windowMs: rl.windowMs || 60 * 1000,
      limit: rl.limit || 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      handler: (req, res, next) => next(rateLimitError()),
    });
    // /demo crée des objets SANS clé API : même limite que /v1.
    app.use(['/v1', '/demo'], limiter);
  }

  app.get('/health', (req, res) => res.json({ ok: true }));

  const v1 = express.Router();
  v1.use(idempotency());
  for (const mod of modules) {
    if (mod.routes) v1.use(mod.routes(ctx));
  }
  app.use('/v1', v1);

  app.use('/demo', createDemoRouter(ctx));

  if (options.staticDir) mountSpa(app, options.staticDir, logger);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, db, ctx };
}

module.exports = { createApp, MODULES, maskUrl, cspDirectives };

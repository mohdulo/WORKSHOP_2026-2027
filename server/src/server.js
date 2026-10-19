'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');
const { createLogger } = require('./lib/logger');
const { createApp } = require('./app');

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });

if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

// Front buildé (web/dist) servi par le même processus : un seul `npm start` après `npm run build`.
const staticDir = process.env.WEB_DIST_DIR ? path.resolve(process.env.WEB_DIST_DIR) : path.resolve(__dirname, '../../web/dist');

const { app, db, ctx } = createApp({ config, logger, dbPath: config.dbPath, seedDemo: true, staticDir });

// Worker de livraison des webhooks (serveur réel seulement : les tests utilisent createApp sans server.js).
const webhookWorker = config.webhookWorkerIntervalMs > 0 ? ctx.webhooks.startWorker({ intervalMs: config.webhookWorkerIntervalMs }) : null;

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, db: config.dbPath, env: config.nodeEnv }, `PaySim à l'écoute sur http://localhost:${config.port}`);
  // La clé PUBLIQUE est affichée (elle est publique par nature). La clé SECRÈTE n'apparaît jamais en clair dans
  // les logs (phase 6, taskForLesson L17) : seulement un indice pour la reconnaître. En dev, sa valeur par défaut
  // est dans config.js (DEV_DEFAULTS.SECRET_KEY) ; sinon c'est la variable d'environnement SECRET_KEY.
  const hint = `${config.secretKey.slice(0, 3)}…${config.secretKey.slice(-4)}`;
  logger.info({ publishableKey: config.publishableKey, secretKeyHint: hint }, 'Clés API de test (clé secrète masquée : variable SECRET_KEY)');
  const demo = ctx.demo.getCatalog();
  logger.info({ products: demo.products.length, subscriptionPrice: demo.subscriptionPrice.id, seller: demo.sellerId }, 'catalogue de démo prêt');
});

function shutdown(signal) {
  logger.info({ signal }, 'Arrêt du serveur');
  const workerDone = webhookWorker ? webhookWorker.stop() : Promise.resolve();
  server.close(() => {
    // On attend la fin du passage de livraison en cours avant de fermer la base.
    workerDone.finally(() => {
      db.close();
      process.exit(0);
    });
  });
  // Filet : un envoi webhook en cours peut durer jusqu'à webhookTimeoutMs.
  setTimeout(() => process.exit(1), config.webhookTimeoutMs + 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

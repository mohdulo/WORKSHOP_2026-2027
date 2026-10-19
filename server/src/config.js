'use strict';
const path = require('node:path');

/**
 * Configuration lue depuis l'environnement, avec des valeurs par défaut de DÉVELOPPEMENT.
 * Ces valeurs par défaut sont publiques (dépôt) : ne jamais les utiliser hors simulation.
 */
const DEV_DEFAULTS = {
  VAULT_KEY: '6f1c2a9b8e7d4c3b2a1908f7e6d5c4b3a29180f7e6d5c4b3a2918070f6e5d4c3',
  FINGERPRINT_KEY: 'paysim-dev-fingerprint-key-change-me',
  SECRET_KEY: 'sk_test_paysimDevSecretKey000000000000',
  PUBLISHABLE_KEY: 'pk_test_paysimDevPublishableKey00000000',
  PORT: '4000',
  DB_PATH: './data/paysim.db',
};

function loadConfig(env = process.env) {
  const get = (name) => (env[name] !== undefined && env[name] !== '' ? env[name] : DEV_DEFAULTS[name]);

  const config = {
    nodeEnv: env.NODE_ENV || 'development',
    vaultKey: get('VAULT_KEY'),
    fingerprintKey: get('FINGERPRINT_KEY'),
    secretKey: get('SECRET_KEY'),
    publishableKey: get('PUBLISHABLE_KEY'),
    port: Number(get('PORT')),
    dbPath: get('DB_PATH') === ':memory:' ? ':memory:' : path.resolve(get('DB_PATH')),
    logLevel: env.LOG_LEVEL || 'info',
    // Webhooks (phase 5) : timeout d'un envoi HTTP, période du worker (0 = worker désactivé).
    webhookTimeoutMs: env.WEBHOOK_TIMEOUT_MS ? Number(env.WEBHOOK_TIMEOUT_MS) : 5000,
    webhookWorkerIntervalMs: env.WEBHOOK_WORKER_INTERVAL_MS !== undefined && env.WEBHOOK_WORKER_INTERVAL_MS !== '' ? Number(env.WEBHOOK_WORKER_INTERVAL_MS) : 2000,
  };

  if (!/^[0-9a-fA-F]{64}$/.test(config.vaultKey)) throw new Error('VAULT_KEY doit faire 32 octets en hexadécimal (64 caractères).');
  if (!config.fingerprintKey || config.fingerprintKey.length < 16) throw new Error('FINGERPRINT_KEY doit faire au moins 16 caractères.');
  if (!/^sk_test_[0-9A-Za-z]{16,}$/.test(config.secretKey)) throw new Error('SECRET_KEY doit être de la forme sk_test_<16+ caractères alphanumériques>.');
  if (!/^pk_test_[0-9A-Za-z]{16,}$/.test(config.publishableKey)) throw new Error('PUBLISHABLE_KEY doit être de la forme pk_test_<16+ caractères alphanumériques>.');
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) throw new Error('PORT invalide.');
  if (!Number.isInteger(config.webhookTimeoutMs) || config.webhookTimeoutMs <= 0 || config.webhookTimeoutMs > 60000) throw new Error('WEBHOOK_TIMEOUT_MS doit être un entier entre 1 et 60000.');
  if (!Number.isInteger(config.webhookWorkerIntervalMs) || config.webhookWorkerIntervalMs < 0) throw new Error('WEBHOOK_WORKER_INTERVAL_MS doit être un entier ≥ 0.');
  if (config.nodeEnv === 'production' && config.vaultKey === DEV_DEFAULTS.VAULT_KEY) {
    throw new Error('VAULT_KEY de développement interdite en production.');
  }
  return Object.freeze(config);
}

module.exports = { loadConfig, DEV_DEFAULTS };

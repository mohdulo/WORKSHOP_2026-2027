'use strict';
const pino = require('pino');

/**
 * Chemins masqués dans TOUS les logs (PLAN §3 : un PAN ou un CVC ne doit jamais apparaître).
 * Les phases suivantes ajoutent ici leurs champs sensibles.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.card.number',
  'req.body.card.cvc',
  'req.body.client_secret',
  '*.card.number',
  '*.card.cvc',
  'card.number',
  'card.cvc',
  'err.body', // body-parser attache le corps brut aux erreurs de parsing
  'pan',
  '*.pan',
  // phase 2 : CVC/PAN à toute profondeur raisonnable, client_secret des payment intents,
  // chiffré du PAN (ligne payment_methods) et requête HTTP brute (query ?client_secret=).
  '*.*.card.number',
  '*.*.card.cvc',
  'cvc',
  '*.cvc',
  'client_secret',
  '*.client_secret',
  '*.*.client_secret',
  '*.*.*.client_secret',
  'pan_encrypted',
  '*.pan_encrypted',
  'req.query.client_secret',
  // phase 5 : secret des webhook endpoints (whsec_...) et sa forme chiffrée, en clair ou dans un objet journalisé.
  'secret',
  '*.secret',
  '*.*.secret',
  'secret_encrypted',
  '*.secret_encrypted',
  'res.body.secret',
];

/**
 * createLogger({ level, stream })
 *  - level 'silent' pour les tests ;
 *  - stream : flux de destination (ex : flux mémoire pour vérifier la rédaction dans un test).
 */
function createLogger({ level = process.env.LOG_LEVEL || 'info', stream } = {}) {
  const options = {
    level,
    base: { service: 'paysim' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  };
  return stream ? pino(options, stream) : pino(options);
}

module.exports = { createLogger, REDACT_PATHS };

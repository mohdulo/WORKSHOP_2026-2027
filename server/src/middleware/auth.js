'use strict';
const { sha256 } = require('../lib/crypto');
const { authError, permissionError } = require('../lib/errors');

/**
 * Authentifie la requête (Authorization: Bearer <clé>) et pose req.apiKey = { id, type }.
 * La clé est cherchée par son sha256 (index unique) : la clé en clair n'est jamais stockée.
 */
function authenticate(req) {
  if (req.apiKey) return req.apiKey;
  const header = req.get('authorization');
  if (!header) throw authError('Aucune clé API fournie. Utilisez « Authorization: Bearer <clé> ».', 'missing_api_key');
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw authError('En-tête Authorization invalide. Format attendu : « Bearer <clé> ».', 'invalid_api_key');
  const { db } = req.app.locals.ctx;
  const row = db.prepare('SELECT id, type FROM api_keys WHERE key_hash = ? AND revoked = 0').get(sha256(match[1]));
  if (!row) throw authError('Clé API invalide.', 'invalid_api_key');
  req.apiKey = { id: row.id, type: row.type };
  return req.apiKey;
}

/**
 * requireKey(kind) :
 *  - 'secret'      : clé sk_ uniquement (sinon 403) ;
 *  - 'publishable' : clé pk_ ou sk_ (la clé secrète a tous les droits, PLAN §3) ;
 *  - 'any'         : toute clé valide.
 * Sans clé ou clé inconnue → 401. Utilisable plusieurs fois sur une même requête (authentifie une seule fois).
 */
function requireKey(kind = 'secret') {
  if (!['secret', 'publishable', 'any'].includes(kind)) throw new Error(`requireKey: type inconnu ${kind}`);
  return function requireKeyMiddleware(req, res, next) {
    try {
      const key = authenticate(req);
      if (kind === 'secret' && key.type !== 'secret') {
        throw permissionError('Cette route exige la clé secrète (sk_test_...).', 'secret_key_required');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireKey, authenticate };

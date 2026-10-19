'use strict';
const { sha256, stableStringify } = require('../lib/crypto');
const { invalid, idempotencyError } = require('../lib/errors');
const { authenticate } = require('./auth');

const TTL_SECONDS = 24 * 3600;
const MAX_KEY_LENGTH = 255;

/**
 * Idempotence des POST (PLAN §3). Monté une fois pour tout /v1 dans app.js : si l'en-tête est présent,
 * la requête est authentifiée ici (authenticate) pour rattacher la clé à la clé API ; les droits fins
 * (sk/pk) restent vérifiés par requireKey() sur chaque route.
 *
 * Clé de stockage : (clé API, Idempotency-Key). Empreinte comparée : méthode + chemin + sha256(corps JSON à clés triées).
 *  - première requête : ligne "in_progress", la réponse est enregistrée au moment du res.json() ;
 *  - même clé, même empreinte, terminée : réponse rejouée à l'identique (status + corps), en-tête Idempotent-Replayed: true ;
 *  - même clé, empreinte différente : 409 idempotency_error / idempotency_key_reused ;
 *  - même clé encore en cours : 409 idempotency_error / idempotency_key_in_use ;
 *  - réponse 5xx (ou pas de réponse JSON) : la ligne est supprimée, le client peut réessayer ;
 *  - expiration 24 h selon ctx.clock.
 */
function idempotency() {
  return function idempotencyMiddleware(req, res, next) {
    const key = req.get('idempotency-key');
    if (req.method !== 'POST' || key === undefined) return next();

    try {
      if (key === '' || key.length > MAX_KEY_LENGTH) {
        throw invalid(`Idempotency-Key doit contenir entre 1 et ${MAX_KEY_LENGTH} caractères.`, 'Idempotency-Key', 'idempotency_key_invalid');
      }
      authenticate(req);

      const { db, clock } = req.app.locals.ctx;
      const now = clock.now();
      const apiKeyId = req.apiKey.id;
      const path = req.baseUrl + req.path;
      const requestHash = sha256(stableStringify(req.body ?? null));

      db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now);

      const existing = db.prepare('SELECT * FROM idempotency_keys WHERE api_key_id = ? AND idem_key = ?').get(apiKeyId, key);
      if (existing) {
        if (existing.method !== req.method || existing.path !== path || existing.request_hash !== requestHash) {
          throw idempotencyError(
            'Cette Idempotency-Key a déjà été utilisée avec une requête différente (méthode, chemin ou corps).',
            'idempotency_key_reused',
          );
        }
        if (existing.status !== 'done') {
          throw idempotencyError('Une requête avec cette Idempotency-Key est encore en cours de traitement.', 'idempotency_key_in_use');
        }
        res.set('Idempotent-Replayed', 'true');
        res.status(existing.response_status).type('application/json').send(existing.response_body);
        return;
      }

      db.prepare(`
        INSERT INTO idempotency_keys (api_key_id, idem_key, method, path, request_hash, status, created, expires_at)
        VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)
      `).run(apiKeyId, key, req.method, path, requestHash, now, now + TTL_SECONDS);

      let settled = false;
      const release = () => {
        if (settled) return;
        settled = true;
        db.prepare("DELETE FROM idempotency_keys WHERE api_key_id = ? AND idem_key = ? AND status = 'in_progress'").run(apiKeyId, key);
      };

      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (!settled) {
          if (res.statusCode >= 500) {
            release();
          } else {
            settled = true;
            db.prepare(`
              UPDATE idempotency_keys SET status = 'done', response_status = ?, response_body = ?
              WHERE api_key_id = ? AND idem_key = ?
            `).run(res.statusCode, JSON.stringify(body), apiKeyId, key);
          }
        }
        return originalJson(body);
      };
      // Connexion fermée sans réponse JSON : on libère la clé.
      res.on('close', release);
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { idempotency, TTL_SECONDS };

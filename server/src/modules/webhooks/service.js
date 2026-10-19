'use strict';
const crypto = require('node:crypto');
const { newId } = require('../../lib/ids');
const { encrypt, decrypt, deriveKey } = require('../../lib/crypto');
const { invalid, notFound } = require('../../lib/errors');
const { paginate } = require('../../lib/pagination');
const { EVENT_TYPE_SET } = require('../events/types');
const { signatureHeader } = require('./verify');

/** Délais avant la 2ᵉ, 3ᵉ, … 6ᵉ tentative (secondes, selon ctx.clock) : 1 min, 5 min, 30 min, 2 h, 8 h. */
const BACKOFF_SECONDS = Object.freeze([60, 300, 1800, 7200, 28800]);
const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1; // 1 envoi + 5 relances
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_BATCH = 100;
const SIGNATURE_HEADER = 'PaySim-Signature';
const USER_AGENT = 'PaySim-Webhooks/1.0';

/**
 * Horodatage `t=` de la signature : temps RÉEL (pas ctx.clock). C'est une protection anti-rejeu au niveau transport,
 * que le marchand compare à SA propre horloge (tolérance 300 s) : avec l'horloge de test décalée d'un mois,
 * toutes les signatures seraient rejetées. Seul écart assumé à « jamais Date.now() dans les services » (PLAN §4.9).
 */
const wallClockNow = () => Math.floor(Date.now() / 1000);

/** URL de webhook : http(s) uniquement, pas d'identifiants intégrés, ≤ 2048 caractères. Lève une 400 sinon. */
function validateUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw invalid('url doit être une URL http(s) de 2048 caractères au plus.', 'url');
  let u;
  try {
    u = new URL(value);
  } catch {
    throw invalid('url invalide.', 'url', 'url_invalid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw invalid('url : seuls les schémas http et https sont acceptés.', 'url', 'url_invalid');
  if (u.username || u.password) throw invalid('url ne doit pas contenir d’identifiants (user:pass@).', 'url', 'url_invalid');
  if (!u.hostname) throw invalid('url : hôte manquant.', 'url', 'url_invalid');
  return u.toString();
}

/** enabled_events : ["*"] seul, ou une liste non vide de types connus (doublons retirés). */
function validateEnabledEvents(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw invalid('enabled_events doit être ["*"] ou une liste non vide de types d’événements.', 'enabled_events');
  if (value.includes('*')) {
    if (value.length !== 1) throw invalid('"*" ne se combine pas avec d’autres types.', 'enabled_events');
    return ['*'];
  }
  const unknown = value.filter((t) => typeof t !== 'string' || !EVENT_TYPE_SET.has(t));
  if (unknown.length) throw invalid(`Type(s) d’événement inconnu(s) : ${unknown.map(String).join(', ')} (voir GET /v1/event_types).`, 'enabled_events', 'event_type_unknown');
  return [...new Set(value)];
}

const matches = (enabledEvents, type) => enabledEvents.includes('*') || enabledEvents.includes(type);

/**
 * Webhooks (PLAN §4.9).
 *  - Fan-out : à chaque ctx.events.emit, une livraison `pending` par endpoint ACTIF qui matche, dans la transaction de l'événement.
 *  - deliverPending({ now }) : réserve les livraisons échues (status `sending`, transaction synchrone) PUIS appelle fetch ;
 *    deux appels qui se chevauchent ne peuvent donc pas réserver la même ligne.
 *  - Secret `whsec_` chiffré en AES-256-GCM (sous-clé HKDF de VAULT_KEY, AAD = id de l'endpoint) : il faut le clair pour signer,
 *    mais une fuite de la base seule ne le révèle pas. Renvoyé UNIQUEMENT à la création.
 */
function createWebhooks(ctx) {
  const { db, clock, logger, config } = ctx;
  const secretKey = deriveKey(config.vaultKey, 'webhook_endpoint_secret');
  const timeoutMs = Number.isInteger(config.webhookTimeoutMs) && config.webhookTimeoutMs > 0 ? config.webhookTimeoutMs : DEFAULT_TIMEOUT_MS;

  const stmts = {
    insertEndpoint: db.prepare(`
      INSERT INTO webhook_endpoints (id, url, enabled_events, description, status, secret_encrypted, created)
      VALUES (@id, @url, @enabled_events, @description, 'enabled', @secret_encrypted, @created)`),
    getEndpoint: db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?'),
    updateEndpoint: db.prepare('UPDATE webhook_endpoints SET url = @url, enabled_events = @enabled_events, description = @description, status = @status WHERE id = @id'),
    deleteEndpoint: db.prepare('DELETE FROM webhook_endpoints WHERE id = ?'),
    enabledEndpoints: db.prepare("SELECT id, enabled_events FROM webhook_endpoints WHERE status = 'enabled' ORDER BY seq"),
    insertDelivery: db.prepare(`
      INSERT INTO webhook_deliveries (id, endpoint_id, event_id, event_seq, event_type, status, attempts, next_attempt_at, created)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`),
    getDelivery: db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?'),
    due: db.prepare(`
      SELECT d.id FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND e.status = 'enabled'
      ORDER BY d.event_seq, d.seq LIMIT ?`),
    reserve: db.prepare("UPDATE webhook_deliveries SET status = 'sending' WHERE id = ? AND status = 'pending'"),
    releaseOrphans: db.prepare("UPDATE webhook_deliveries SET status = 'pending' WHERE status = 'sending'"),
    getEvent: db.prepare('SELECT * FROM events WHERE id = ?'),
    markDelivered: db.prepare(`
      UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1, last_attempt_at = @now, last_status_code = @code,
        last_error = NULL, delivered_at = @now, next_attempt_at = NULL
      WHERE id = @id AND status = 'sending'`),
    markFailure: db.prepare(`
      UPDATE webhook_deliveries SET status = @status, attempts = @attempts, last_attempt_at = @now, last_status_code = @code,
        last_error = @error, next_attempt_at = @next
      WHERE id = @id AND status = 'sending'`),
  };

  // Une seule instance de PaySim écrit dans la base (SQLite) : une ligne `sending` au démarrage est orpheline
  // (arrêt pendant un envoi) → remise en `pending` (au pire le marchand reçoit un doublon, d'où l'id d'event à dédupliquer).
  stmts.releaseOrphans.run();

  // ---------- sérialisation ----------

  const endpointToApi = (row) => ({
    id: row.id,
    object: 'webhook_endpoint',
    url: row.url,
    enabled_events: JSON.parse(row.enabled_events),
    description: row.description,
    status: row.status,
    created: row.created,
  });

  const deliveryToApi = (row) => ({
    id: row.id,
    object: 'webhook_delivery',
    endpoint: row.endpoint_id,
    event: row.event_id,
    event_type: row.event_type,
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: row.next_attempt_at,
    last_attempt_at: row.last_attempt_at,
    last_status_code: row.last_status_code,
    last_error: row.last_error,
    delivered_at: row.delivered_at,
    created: row.created,
  });

  /** Objet event complet, dans l'ordre de clés documenté. */
  const eventToApi = (row) => ({ id: row.id, object: 'event', type: row.type, created: row.created, data: JSON.parse(row.data) });

  // ---------- endpoints ----------

  function getEndpointRow(id) {
    const row = typeof id === 'string' ? stmts.getEndpoint.get(id) : undefined;
    if (!row) throw notFound('webhook_endpoint', id);
    return row;
  }

  const revealSecret = (row) => decrypt(secretKey, row.secret_encrypted, row.id);

  const createEndpoint = db.transaction(({ url, enabled_events: enabledEvents, description }) => {
    const id = newId('we');
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    stmts.insertEndpoint.run({
      id,
      url: validateUrl(url),
      enabled_events: JSON.stringify(validateEnabledEvents(enabledEvents)),
      description: description ?? null,
      secret_encrypted: encrypt(secretKey, secret, id),
      created: clock.now(),
    });
    return { ...endpointToApi(stmts.getEndpoint.get(id)), secret };
  });

  const updateEndpoint = db.transaction((id, params) => {
    const row = getEndpointRow(id);
    const next = {
      id,
      url: params.url !== undefined ? validateUrl(params.url) : row.url,
      enabled_events: params.enabled_events !== undefined ? JSON.stringify(validateEnabledEvents(params.enabled_events)) : row.enabled_events,
      description: params.description !== undefined ? params.description : row.description,
      status: params.disabled === undefined ? row.status : params.disabled ? 'disabled' : 'enabled',
    };
    stmts.updateEndpoint.run(next);
    return endpointToApi(stmts.getEndpoint.get(id));
  });

  /** Suppression : les livraisons de l'endpoint sont supprimées avec lui (ON DELETE CASCADE). */
  const deleteEndpoint = db.transaction((id) => {
    getEndpointRow(id);
    stmts.deleteEndpoint.run(id);
    return { id, object: 'webhook_endpoint', deleted: true };
  });

  const getEndpoint = (id) => endpointToApi(getEndpointRow(id));

  function listEndpoints({ limit, startingAfter } = {}) {
    return paginate(db, { table: 'webhook_endpoints', limit, startingAfter, map: endpointToApi });
  }

  function listDeliveries(endpointId, { limit, startingAfter, status } = {}) {
    getEndpointRow(endpointId);
    const where = ['endpoint_id = ?'];
    const params = [endpointId];
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    return paginate(db, { table: 'webhook_deliveries', where: where.join(' AND '), params, limit, startingAfter, map: deliveryToApi });
  }

  const getDelivery = (id) => {
    const row = stmts.getDelivery.get(id);
    if (!row) throw notFound('webhook_delivery', id);
    return deliveryToApi(row);
  };

  // ---------- fan-out (dans la transaction de l'événement) ----------

  function fanOut(event, eventSeq) {
    for (const ep of stmts.enabledEndpoints.all()) {
      if (matches(JSON.parse(ep.enabled_events), event.type)) {
        stmts.insertDelivery.run(newId('whd'), ep.id, event.id, eventSeq, event.type, event.created, event.created);
      }
    }
  }
  ctx.events.onEmit(fanOut);

  // ---------- livraison ----------

  /** Réserve (pending → sending) les livraisons échues, par seq d'event. Transaction synchrone : aucun await ici. */
  const reserveDue = db.transaction((now, limit) => stmts.due.all(now, limit).map((r) => r.id).filter((id) => stmts.reserve.run(id).changes === 1));

  /** Un envoi HTTP. Ne lève jamais : renvoie { ok, code, error }. */
  async function send(url, body, header) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, [SIGNATURE_HEADER]: header },
        body,
        redirect: 'manual', // une redirection n'est pas un succès (et ne doit pas emmener la requête ailleurs)
        signal: controller.signal,
      });
      // On ne lit pas la réponse du marchand (on libère juste la connexion).
      if (res.body) await res.body.cancel().catch(() => {});
      return res.status >= 200 && res.status < 300 ? { ok: true, code: res.status } : { ok: false, code: res.status, error: `HTTP ${res.status}` };
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, code: null, error: `timeout après ${timeoutMs} ms` };
      const cause = err && err.cause;
      const detail = (cause && (cause.code || cause.message)) || (err && err.message) || 'erreur réseau';
      return { ok: false, code: null, error: `erreur réseau : ${String(detail).slice(0, 200)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Enregistre le résultat d'une tentative faite à `now` ; renvoie le nouveau statut. */
  function recordAttempt(row, result, now) {
    if (result.ok) {
      stmts.markDelivered.run({ id: row.id, now, code: result.code });
      return 'delivered';
    }
    const attempts = row.attempts + 1;
    const final = attempts >= MAX_ATTEMPTS;
    stmts.markFailure.run({
      id: row.id,
      status: final ? 'failed' : 'pending',
      attempts,
      now,
      code: result.code,
      error: result.error,
      // Pas de « rattrapage » des relances (≠ billing, L11) : chaque tentative est un VRAI appel HTTP fait à `now`,
      // le délai suivant part donc de cette tentative (sinon un saut d'horloge enverrait 6 requêtes en rafale).
      next: final ? null : now + BACKOFF_SECONDS[attempts - 1],
    });
    return final ? 'failed' : 'pending';
  }

  async function deliverOne(id, now) {
    const row = stmts.getDelivery.get(id);
    if (!row || row.status !== 'sending') return null; // supprimée entre-temps (endpoint supprimé)
    const endpoint = stmts.getEndpoint.get(row.endpoint_id);
    const event = stmts.getEvent.get(row.event_id);
    // Sérialisé UNE fois ; on signe exactement les octets envoyés.
    const body = Buffer.from(JSON.stringify(eventToApi(event)), 'utf8');
    const header = signatureHeader(revealSecret(endpoint), wallClockNow(), body);
    const result = await send(endpoint.url, body, header);
    let status;
    try {
      status = recordAttempt(row, result, now);
    } catch (err) {
      // Ex : base fermée pendant l'arrêt. La ligne reste `sending` et sera reprise au prochain démarrage.
      logger.error({ err, delivery: id }, 'webhook : impossible d’enregistrer la tentative');
      return null;
    }
    const log = { delivery: id, endpoint: row.endpoint_id, event: row.event_id, type: row.event_type, attempt: row.attempts + 1, status_code: result.code, status };
    if (result.ok) logger.info(log, 'webhook livré');
    else logger.warn({ ...log, error: result.error }, status === 'failed' ? 'webhook en échec définitif' : 'webhook : échec, nouvelle tentative programmée');
    return status;
  }

  /**
   * Envoie les livraisons échues à `now` (une tentative au plus par livraison et par appel).
   * Endpoints traités en parallèle ; pour un même endpoint, envoi séquentiel par seq d'event.
   * Renvoie { attempted, delivered[], retry_scheduled[], failed[] } (ids de livraison).
   */
  async function deliverPending({ now = clock.now(), limit = DEFAULT_BATCH } = {}) {
    const ids = reserveDue(now, limit);
    const summary = { attempted: ids.length, delivered: [], retry_scheduled: [], failed: [] };
    if (ids.length === 0) return summary;

    const byEndpoint = new Map();
    for (const id of ids) {
      const ep = stmts.getDelivery.get(id).endpoint_id;
      if (!byEndpoint.has(ep)) byEndpoint.set(ep, []);
      byEndpoint.get(ep).push(id);
    }
    await Promise.all(
      [...byEndpoint.values()].map(async (queue) => {
        for (const id of queue) {
          const status = await deliverOne(id, now);
          if (status === 'delivered') summary.delivered.push(id);
          else if (status === 'pending') summary.retry_scheduled.push(id);
          else if (status === 'failed') summary.failed.push(id);
        }
      }),
    );
    return summary;
  }

  // Branchement horloge de test : livraison après expiration + billing (testclock attend les hooks async).
  if (ctx.testclock) ctx.testclock.onAdvance('webhooks', (now) => deliverPending({ now }));

  /**
   * Worker périodique (serveur réel uniquement) : deliverPending toutes les `intervalMs`, sans chevauchement.
   * stop() arrête le timer et renvoie la promesse du passage en cours (à attendre avant db.close()).
   */
  function startWorker({ intervalMs = 2000 } = {}) {
    let current = null;
    const timer = setInterval(() => {
      if (current) return;
      current = deliverPending()
        .catch((err) => logger.error({ err }, 'webhook : échec du worker'))
        .finally(() => {
          current = null;
        });
    }, intervalMs);
    timer.unref();
    return {
      stop() {
        clearInterval(timer);
        return current || Promise.resolve();
      },
    };
  }

  return {
    createEndpoint,
    updateEndpoint,
    deleteEndpoint,
    getEndpoint,
    listEndpoints,
    listDeliveries,
    getDelivery,
    deliverPending,
    startWorker,
    timeoutMs,
  };
}

module.exports = { createWebhooks, validateUrl, validateEnabledEvents, BACKOFF_SECONDS, MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS, SIGNATURE_HEADER };

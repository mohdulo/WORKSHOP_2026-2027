'use strict';
/**
 * Vérification des signatures de webhooks PaySim — fichier AUTONOME, à copier tel quel côté marchand.
 * Seule dépendance : node:crypto (aucun require vers le reste du projet).
 *
 * En-tête reçu :  PaySim-Signature: t=<timestamp Unix>,v1=<hex HMAC-SHA256(secret, "<t>.<corps brut>")>
 * Plusieurs v1= sont possibles (rotation de secret) : la signature est valide si L'UNE d'elles correspond.
 *
 * Usage (Express) : vérifier sur le corps BRUT (octets reçus), jamais sur un JSON re-sérialisé :
 *   app.post('/webhooks', express.raw({ type: 'application/json' }), (req, res) => {
 *     if (!verifySignature(req.body, req.get('PaySim-Signature'), process.env.PAYSIM_WEBHOOK_SECRET)) return res.sendStatus(400);
 *     const event = JSON.parse(req.body); ...; res.sendStatus(200);
 *   });
 */
const crypto = require('node:crypto');

const SCHEME = 'v1';

function toBuffer(rawBody) {
  if (Buffer.isBuffer(rawBody)) return rawBody;
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  return null;
}

/** HMAC-SHA256(secret, "<t>.<rawBody>") en hexadécimal. */
function computeSignature(secret, timestamp, rawBody) {
  const body = toBuffer(rawBody);
  if (body === null) throw new TypeError('rawBody doit être un Buffer, un Uint8Array ou une chaîne.');
  return crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

/** Construit l'en-tête PaySim-Signature (utilisé par l'émetteur ; pratique aussi pour les tests du marchand). */
function signatureHeader(secret, timestamp, rawBody) {
  return `t=${timestamp},${SCHEME}=${computeSignature(secret, timestamp, rawBody)}`;
}

/**
 * Analyse "t=...,v1=...,v1=..." → { timestamp, signatures } ou null si malformé
 * (t absent, dupliqué ou non entier ; aucun v1 ; élément sans "=").
 * Les schémas inconnus (ex : v0=) sont ignorés.
 */
function parseSignatureHeader(header) {
  if (typeof header !== 'string' || header.length === 0 || header.length > 4096) return null;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) return null;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === SCHEME) {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * verifySignature(rawBody, header, secret, toleranceSec = 300, now = maintenant) → boolean
 *  - false si l'en-tête est malformé, si le timestamp est hors tolérance (passé OU futur),
 *    ou si aucune signature v1 ne correspond ;
 *  - comparaison en temps constant (crypto.timingSafeEqual sur 32 octets), toutes les v1 sont comparées.
 */
function verifySignature(rawBody, header, secret, toleranceSec = 300, now = Math.floor(Date.now() / 1000)) {
  if (typeof secret !== 'string' || secret.length === 0) return false;
  const body = toBuffer(rawBody);
  if (body === null) return false;
  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  if (!Number.isFinite(toleranceSec) || toleranceSec < 0) return false;
  if (Math.abs(now - parsed.timestamp) > toleranceSec) return false;

  const expected = Buffer.from(computeSignature(secret, parsed.timestamp, body), 'hex');
  let match = false;
  for (const candidate of parsed.signatures) {
    if (!/^[0-9a-f]{64}$/i.test(candidate)) continue;
    const ok = crypto.timingSafeEqual(expected, Buffer.from(candidate, 'hex'));
    match = match || ok;
  }
  return match;
}

module.exports = { verifySignature, computeSignature, signatureHeader, parseSignatureHeader };

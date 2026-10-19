'use strict';
const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const FORMAT = 'v1';

function toKey(key) {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'hex');
  if (buf.length !== 32) throw new Error('La clé AES-256 doit faire 32 octets (64 caractères hex).');
  return buf;
}

/** Chiffre en AES-256-GCM (IV aléatoire). Renvoie "v1.<iv>.<tag>.<ciphertext>" en base64url. */
function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, toKey(key), iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [FORMAT, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Déchiffre ; lève une erreur si le tag, l'IV, le texte chiffré ou l'AAD ont été altérés. */
function decrypt(key, payload, aad) {
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT) throw new Error('Format chiffré invalide.');
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv(ALGO, toKey(key), Buffer.from(ivB64, 'base64url'));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Dérive une sous-clé de 32 octets (HKDF-SHA256) depuis une clé maîtresse hex, par usage (`label`) :
 * séparation de domaine (le PAN, les secrets webhook et les réponses idempotentes n'utilisent pas la même clé).
 */
function deriveKey(masterHex, label) {
  return Buffer.from(crypto.hkdfSync('sha256', toKey(masterHex), Buffer.alloc(0), `paysim:${label}`, 32));
}

function hmac(key, data, encoding = 'hex') {
  return crypto.createHmac('sha256', key).update(data).digest(encoding);
}

function sha256(data, encoding = 'hex') {
  return crypto.createHash('sha256').update(data).digest(encoding);
}

/** Comparaison en temps constant, y compris quand les longueurs diffèrent (on compare des empreintes). */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

/** JSON.stringify avec clés triées (hash de corps indépendant de l'ordre des clés). */
function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

module.exports = { encrypt, decrypt, deriveKey, hmac, sha256, safeEqual, stableStringify };

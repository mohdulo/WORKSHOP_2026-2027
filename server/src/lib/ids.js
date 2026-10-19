'use strict';
const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 24;
// 62 * 4 = 248 : on rejette les octets >= 248 pour éviter le biais modulo.
const MAX_UNBIASED = 248;

/** Génère `<prefix>_<24 caractères base62>` à partir de crypto.randomBytes. */
function newId(prefix) {
  if (typeof prefix !== 'string' || !/^[a-z]+$/.test(prefix)) {
    throw new TypeError(`Préfixe d'ID invalide : ${prefix}`);
  }
  let out = '';
  while (out.length < ID_LENGTH) {
    const bytes = crypto.randomBytes(32);
    for (const b of bytes) {
      if (b < MAX_UNBIASED) {
        out += ALPHABET[b % 62];
        if (out.length === ID_LENGTH) break;
      }
    }
  }
  return `${prefix}_${out}`;
}

function isId(value, prefix) {
  return typeof value === 'string' && new RegExp(`^${prefix}_[0-9A-Za-z]{${ID_LENGTH}}$`).test(value);
}

module.exports = { newId, isId, ID_LENGTH };

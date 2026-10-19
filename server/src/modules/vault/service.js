'use strict';
const { newId } = require('../../lib/ids');
const { invalid, notFound } = require('../../lib/errors');
const { encrypt, decrypt, hmac } = require('../../lib/crypto');
const { paginate } = require('../../lib/pagination');

/**
 * Coffre-fort carte (PLAN §4.2).
 *  - Le PAN n'est stocké que chiffré (AES-256-GCM, IV aléatoire, AAD = id du pm : un chiffré ne peut pas
 *    être recopié sur une autre ligne). Empreinte = HMAC-SHA256(FINGERPRINT_KEY, PAN).
 *  - Le CVC est vérifié par le simulateur réseau à la création (cvc_check) puis oublié : aucune colonne ne le reçoit.
 *  - Les messages d'erreur ne contiennent jamais le numéro saisi.
 */

/** Luhn (mod 10) sur une chaîne de chiffres. */
function luhnValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** visa 4 ; mastercard 51–55 ou 2221–2720 ; amex 34/37. Sinon null. */
function detectBrand(digits) {
  if (/^4/.test(digits)) return 'visa';
  if (/^3[47]/.test(digits)) return 'amex';
  const two = Number(digits.slice(0, 2));
  const four = Number(digits.slice(0, 4));
  if ((two >= 51 && two <= 55) || (four >= 2221 && four <= 2720)) return 'mastercard';
  return null;
}

/** Normalise le numéro (espaces/tirets tolérés) ; renvoie la chaîne de chiffres ou lève 400 card.number. */
function normalizePan(number) {
  const digits = String(number).replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) throw invalid('Le numéro de carte doit comporter 13 à 19 chiffres.', 'card.number', 'invalid_number');
  if (!luhnValid(digits)) throw invalid("Le numéro de carte est invalide (contrôle de Luhn).", 'card.number', 'incorrect_number');
  return digits;
}

function createVault(ctx) {
  const { db, clock, config } = ctx;
  const stmts = {
    insert: db.prepare(`
      INSERT INTO payment_methods (id, customer_id, brand, last4, exp_month, exp_year, fingerprint, pan_encrypted, cvc_check, created)
      VALUES (@id, NULL, @brand, @last4, @exp_month, @exp_year, @fingerprint, @pan_encrypted, @cvc_check, @created)`),
    get: db.prepare('SELECT * FROM payment_methods WHERE id = ?'),
    attach: db.prepare('UPDATE payment_methods SET customer_id = ? WHERE id = ?'),
  };

  function toApi(row) {
    return {
      id: row.id,
      object: 'payment_method',
      type: 'card',
      card: {
        brand: row.brand,
        last4: row.last4,
        exp_month: row.exp_month,
        exp_year: row.exp_year,
        fingerprint: row.fingerprint,
        cvc_check: row.cvc_check,
      },
      customer: row.customer_id,
      created: row.created,
    };
  }

  /** Ligne brute (interne). `param` renseigné → 400 resource_missing (référence depuis un autre objet) ; sinon 404. */
  function getRow(id, param) {
    const row = typeof id === 'string' ? stmts.get.get(id) : undefined;
    if (!row) {
      if (param) throw invalid(`Aucun moyen de paiement "${id}".`, param, 'resource_missing');
      throw notFound('payment_method', id);
    }
    return row;
  }

  function assertNotExpired(expMonth, expYear) {
    const now = new Date(clock.now() * 1000);
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    // Une carte est valable jusqu'au dernier jour de son mois d'expiration.
    if (expYear < year || (expYear === year && expMonth < month)) {
      throw invalid('La carte a expiré.', expYear < year ? 'card.exp_year' : 'card.exp_month', 'invalid_expiry_year');
    }
    if (expYear > year + 50) throw invalid("Année d'expiration invalide.", 'card.exp_year', 'invalid_expiry_year');
  }

  /** Tokenisation : { number, exp_month, exp_year, cvc } → payment_method public. */
  const tokenize = db.transaction(({ number, exp_month, exp_year, cvc }) => {
    const pan = normalizePan(number);
    const brand = detectBrand(pan);
    if (!brand) throw invalid('Marque de carte non supportée (visa, mastercard, amex).', 'card.number', 'card_brand_unsupported');
    assertNotExpired(exp_month, exp_year);
    if (typeof cvc !== 'string' || !/^\d{3,4}$/.test(cvc)) throw invalid('Le CVC doit comporter 3 ou 4 chiffres.', 'card.cvc', 'invalid_cvc');

    const cvcCheck = ctx.network.checkCvc(pan, cvc); // le CVC n'est transmis qu'au simulateur, jamais stocké
    const id = newId('pm');
    stmts.insert.run({
      id,
      brand,
      last4: pan.slice(-4),
      exp_month,
      exp_year,
      fingerprint: hmac(config.fingerprintKey, pan),
      pan_encrypted: encrypt(config.vaultKey, pan, id),
      cvc_check: cvcCheck,
      created: clock.now(),
    });
    const pm = toApi(stmts.get.get(id));
    ctx.events.emit('payment_method.created', pm);
    return pm;
  });

  const attach = db.transaction((pmId, customerId) => {
    const row = getRow(pmId);
    ctx.customers.assertExists(customerId);
    if (row.customer_id && row.customer_id !== customerId) {
      throw invalid('Ce moyen de paiement est déjà rattaché à un autre client.', 'customer', 'payment_method_already_attached');
    }
    if (row.customer_id === customerId) return toApi(row);
    stmts.attach.run(customerId, pmId);
    const pm = toApi(stmts.get.get(pmId));
    ctx.events.emit('payment_method.attached', pm);
    return pm;
  });

  function get(id) {
    return toApi(getRow(id));
  }

  function listForCustomer(customerId, { limit, startingAfter } = {}) {
    ctx.customers.getRow(customerId); // 404 si le client n'existe pas
    return paginate(db, { table: 'payment_methods', where: 'customer_id = ?', params: [customerId], limit, startingAfter, map: toApi });
  }

  /**
   * INTERNE : déchiffre le PAN. Utilisé uniquement par le module payments pour appeler network.authorize.
   * Jamais exposé par une route, jamais journalisé.
   */
  function reveal(pmId) {
    const row = getRow(pmId);
    return decrypt(config.vaultKey, row.pan_encrypted, row.id);
  }

  return { tokenize, attach, get, getRow, listForCustomer, reveal, toApi };
}

module.exports = { createVault, luhnValid, detectBrand };

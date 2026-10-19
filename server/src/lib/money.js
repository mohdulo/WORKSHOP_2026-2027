'use strict';
const { invalid } = require('./errors');

const CURRENCY = 'eur';
const MAX_AMOUNT = 99999999; // garde-fou technique (le réseau refuse > 999999, cf. PLAN §4.3)

/** Vérifie qu'un montant est un entier de centimes strictement positif. Renvoie le montant. */
function assertAmount(amount, param = 'amount', { allowZero = false } = {}) {
  if (!Number.isSafeInteger(amount)) {
    throw invalid('Le montant doit être un entier en centimes.', param, 'amount_invalid');
  }
  if (amount < 0 || (!allowZero && amount === 0)) {
    throw invalid('Le montant doit être strictement positif.', param, 'amount_too_small');
  }
  if (amount > MAX_AMOUNT) {
    throw invalid('Montant trop élevé.', param, 'amount_too_large');
  }
  return amount;
}

function assertCurrency(currency, param = 'currency') {
  if (currency !== CURRENCY) throw invalid(`Devise non supportée : seule "${CURRENCY}" est acceptée.`, param, 'currency_invalid');
  return currency;
}

/**
 * Frais PSP : round(amount * 1,4 %) + 25 centimes.
 * Calcul en arithmétique entière (arrondi au demi supérieur) pour ne jamais manipuler de float :
 * round(a * 14 / 1000) = floor((a * 14 + 500) / 1000) pour a >= 0.
 */
function computePspFee(amount) {
  assertAmount(amount);
  return Math.floor((amount * 14 + 500) / 1000) + 25;
}

module.exports = { CURRENCY, MAX_AMOUNT, assertAmount, assertCurrency, computePspFee };

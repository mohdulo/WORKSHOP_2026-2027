'use strict';

/**
 * Simulateur banque/réseau carte (PLAN §4.3). Aucun argent réel ne circule.
 *
 * authorize({ pan, amount, offSession, threeDsCompleted, cvcCheck })
 *   → { approved: true }
 *   → { approved: false, requires_3ds: true }                       (3-D Secure exigé, on-session)
 *   → { approved: false, decline_code, code, message }              (refus)
 *
 * Ordre des contrôles : montant (> 999999 → amount_too_large), CVC échoué à la tokenisation (incorrect_cvc),
 * puis comportement propre à la carte de test.
 *
 * `decline_code` = le code de la table PLAN §4.3 ; `code` = code d'erreur API (façon Stripe) :
 * expired_card / incorrect_cvc / amount_too_large sont leurs propres codes, tout le reste est `card_declined`.
 */
const MAX_NETWORK_AMOUNT = 999999;

const TEST_CARDS = Object.freeze({
  '4242424242424242': { behavior: 'approve' },
  '5555555555554444': { behavior: 'approve' },
  '4000000000000002': { behavior: 'decline', decline_code: 'card_declined' },
  '4000000000009995': { behavior: 'decline', decline_code: 'insufficient_funds' },
  '4000000000000069': { behavior: 'decline', decline_code: 'expired_card' },
  '4000000000000127': { behavior: 'cvc_fail' },
  '4000000000003220': { behavior: 'three_ds' },
  '4000000000000341': { behavior: 'decline', decline_code: 'card_declined' },
});

const MESSAGES = {
  card_declined: 'La carte a été refusée.',
  insufficient_funds: 'Fonds insuffisants sur la carte.',
  expired_card: 'La carte a expiré.',
  incorrect_cvc: 'Le code de sécurité (CVC) est incorrect.',
  authentication_required: 'Ce paiement exige une authentification 3-D Secure, impossible hors session.',
  amount_too_large: 'Montant supérieur au plafond du réseau.',
};

const OWN_CODES = new Set(['expired_card', 'incorrect_cvc', 'amount_too_large']);

function decline(declineCode) {
  return {
    approved: false,
    decline_code: declineCode,
    code: OWN_CODES.has(declineCode) ? declineCode : 'card_declined',
    message: MESSAGES[declineCode] || MESSAGES.card_declined,
  };
}

function createNetwork() {
  /** Vérification CVC à la tokenisation : seule la carte 4000000000000127 échoue. Le CVC n'est jamais conservé. */
  function checkCvc(pan /* , cvc */) {
    const card = TEST_CARDS[pan];
    return card && card.behavior === 'cvc_fail' ? 'fail' : 'pass';
  }

  function authorize({ pan, amount, offSession = false, threeDsCompleted = false, cvcCheck = 'pass' }) {
    if (typeof pan !== 'string' || !Number.isSafeInteger(amount) || amount <= 0) throw new Error('network.authorize : paramètres invalides.');
    if (amount > MAX_NETWORK_AMOUNT) return decline('amount_too_large');
    const card = TEST_CARDS[pan] || { behavior: 'approve' };
    if (cvcCheck === 'fail' || card.behavior === 'cvc_fail') return decline('incorrect_cvc');
    switch (card.behavior) {
      case 'decline':
        return decline(card.decline_code);
      case 'three_ds':
        if (offSession) return decline('authentication_required');
        if (!threeDsCompleted) return { approved: false, requires_3ds: true };
        return { approved: true };
      default:
        return { approved: true };
    }
  }

  return { authorize, checkCvc, TEST_CARDS, MAX_NETWORK_AMOUNT };
}

module.exports = { createNetwork, TEST_CARDS, MAX_NETWORK_AMOUNT };

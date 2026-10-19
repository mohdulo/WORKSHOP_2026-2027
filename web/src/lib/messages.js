// Messages d'erreur en français destinés à l'acheteur, selon decline_code / code (PLAN §4.3).

const DECLINES = {
  card_declined: 'Votre banque a refusé ce paiement. Essayez avec une autre carte.',
  insufficient_funds: 'Fonds insuffisants : votre banque a refusé ce paiement. Essayez avec une autre carte.',
  expired_card: 'Cette carte est expirée. Utilisez une autre carte.',
  incorrect_cvc: 'Le code de sécurité (CVC) est incorrect. Vérifiez les chiffres au dos de la carte.',
  authentication_required: 'Cette carte exige une validation 3-D Secure, impossible pour un prélèvement automatique. Utilisez une autre carte.',
  authentication_failed: 'La validation 3-D Secure a été refusée : le paiement n’a pas eu lieu.',
  amount_too_large: 'Ce montant dépasse le plafond autorisé pour cette carte.',
  payment_intent_authentication_failure: 'La validation 3-D Secure a été refusée : le paiement n’a pas eu lieu.',
};

const CODES = {
  invalid_number: 'Le numéro de carte doit comporter entre 13 et 19 chiffres.',
  incorrect_number: 'Ce numéro de carte n’est pas valide. Vérifiez-le.',
  invalid_expiry_year: 'La date d’expiration n’est pas valide ou la carte est expirée.',
  invalid_cvc: 'Le code de sécurité doit comporter 3 ou 4 chiffres.',
  card_brand_unsupported: 'Seules les cartes Visa, Mastercard et American Express sont acceptées.',
  payment_method_already_attached: 'Cette carte est déjà utilisée par un autre abonné.',
  rate_limit: 'Trop de tentatives en peu de temps. Patientez une minute puis réessayez.',
  network_error: 'Serveur PaySim injoignable. Vérifiez qu’il est démarré.',
};

/** Message lisible pour une erreur de paiement (ApiError ou objet last_payment_error). */
export function paymentErrorMessage(err) {
  const decline = err?.declineCode ?? err?.decline_code;
  if (decline && DECLINES[decline]) return DECLINES[decline];
  if (err?.code && DECLINES[err.code]) return DECLINES[err.code];
  if (err?.code && CODES[err.code]) return CODES[err.code];
  if (err?.type === 'card_error') return DECLINES.card_declined;
  return err?.message || 'Le paiement n’a pas abouti. Réessayez.';
}

/** Libellés français des statuts. */
export const STATUS_LABELS = {
  requires_payment_method: 'En attente de carte',
  requires_confirmation: 'À confirmer',
  requires_action: '3-D Secure en attente',
  requires_capture: 'Autorisé, à capturer',
  succeeded: 'Réussi',
  canceled: 'Annulé',
  trialing: 'Essai',
  active: 'Actif',
  incomplete: 'Incomplet',
  past_due: 'Impayé',
  draft: 'Brouillon',
  open: 'À payer',
  paid: 'Payée',
  uncollectible: 'Irrécouvrable',
  void: 'Annulée',
  pending: 'En attente',
  sending: 'Envoi en cours',
  delivered: 'Livré',
  failed: 'Échec',
  enabled: 'Actif',
  disabled: 'Désactivé',
};

export const STATUS_TONES = {
  succeeded: 'ok', active: 'ok', paid: 'ok', delivered: 'ok', enabled: 'ok', trialing: 'info',
  requires_capture: 'warn', requires_action: 'warn', past_due: 'warn', open: 'warn', pending: 'warn', sending: 'warn', incomplete: 'warn',
  canceled: 'muted', void: 'muted', draft: 'muted', requires_payment_method: 'muted', requires_confirmation: 'muted', disabled: 'muted',
  failed: 'bad', uncollectible: 'bad',
};

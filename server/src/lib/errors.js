'use strict';

/** Erreur d'API sérialisée en { error: { type, code, message, param? } } (PLAN §3). */
class ApiError extends Error {
  constructor(status, type, code, message, param, extra) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
    this.extra = extra; // champs supplémentaires (ex : decline_code pour card_error)
  }

  toJSON() {
    const error = { type: this.type, code: this.code, message: this.message };
    if (this.param !== undefined && this.param !== null) error.param = this.param;
    if (this.extra) Object.assign(error, this.extra);
    return { error };
  }
}

const invalid = (message, param, code = 'parameter_invalid') =>
  new ApiError(400, 'invalid_request_error', code, message, param);

const authError = (message = 'Clé API manquante ou invalide.', code = 'invalid_api_key') =>
  new ApiError(401, 'authentication_error', code, message);

const permissionError = (message = "Cette clé API n'a pas accès à cette ressource.", code = 'insufficient_permissions') =>
  new ApiError(403, 'permission_error', code, message);

const notFound = (resource = 'resource', id) =>
  new ApiError(404, 'not_found', 'resource_missing', id ? `Aucun(e) ${resource} avec l'id "${id}".` : `${resource} introuvable.`, id ? 'id' : undefined);

const idempotencyError = (message, code = 'idempotency_key_reused') =>
  new ApiError(409, 'idempotency_error', code, message);

const stateError = (message, code = 'invalid_state') => new ApiError(409, 'state_error', code, message);

const cardError = (code, message, extra) => new ApiError(402, 'card_error', code, message, undefined, extra);

/**
 * Solde insuffisant pour un mouvement de fonds (transfer, payout) : 402, code insufficient_balance.
 * Type invalid_request_error (pas card_error : aucune carte en jeu), param = le montant demandé.
 */
const insufficientBalance = (message, param = 'amount') =>
  new ApiError(402, 'invalid_request_error', 'insufficient_balance', message, param);

const rateLimitError = () => new ApiError(429, 'rate_limit_error', 'rate_limit', 'Trop de requêtes, réessayez plus tard.');

const apiError = (message = 'Erreur interne.', code = 'internal_error') => new ApiError(500, 'api_error', code, message);

module.exports = {
  ApiError,
  invalid,
  authError,
  permissionError,
  notFound,
  idempotencyError,
  stateError,
  cardError,
  insufficientBalance,
  rateLimitError,
  apiError,
};

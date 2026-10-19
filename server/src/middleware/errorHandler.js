'use strict';
const { ApiError, invalid, apiError } = require('../lib/errors');

/** Erreurs de body-parser (JSON mal formé, corps trop gros, ...) → erreurs d'API propres. */
function fromBodyParser(err) {
  switch (err.type) {
    case 'entity.parse.failed':
      return invalid('Corps JSON invalide.', undefined, 'invalid_json');
    case 'entity.too.large': {
      const e = invalid('Corps de requête trop volumineux (100 ko max).', undefined, 'request_too_large');
      e.status = 413;
      return e;
    }
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return invalid('Encodage du corps non supporté.', undefined, 'unsupported_encoding');
    default:
      return null;
  }
}

function notFoundHandler(req, res, next) {
  next(new ApiError(404, 'not_found', 'route_not_found', `Route inconnue : ${req.method} ${req.originalUrl.split('?')[0]}`));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let apiErr = err instanceof ApiError ? err : fromBodyParser(err);
  if (!apiErr && err && err.expose && err.status >= 400 && err.status < 500) {
    apiErr = invalid(err.message, undefined, 'invalid_request');
    apiErr.status = err.status;
  }
  const log = req.log || req.app.locals.ctx.logger;
  if (!apiErr) {
    log.error({ err }, 'Erreur non gérée');
    apiErr = apiError('Une erreur interne est survenue.');
  } else if (apiErr.status >= 500) {
    log.error({ err }, apiErr.message);
  }
  if (res.headersSent) return req.socket.destroy();
  res.status(apiErr.status).json(apiErr.toJSON());
}

module.exports = { errorHandler, notFoundHandler };

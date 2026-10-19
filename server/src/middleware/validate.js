'use strict';
const { invalid } = require('../lib/errors');

/** Chemin zod ["card","number"] → "card.number" ; ["items",0,"price"] → "items[0].price". */
function formatPath(path) {
  return path.reduce((acc, seg) => (typeof seg === 'number' ? `${acc}[${seg}]` : acc ? `${acc}.${String(seg)}` : String(seg)), '');
}

/**
 * validate(schema, source = 'body') : valide req[source] avec zod, remplace par la valeur parsée.
 * Échec → 400 invalid_request_error, param = premier chemin en erreur.
 */
function validate(schema, source = 'body') {
  return function validateMiddleware(req, res, next) {
    const result = schema.safeParse(req[source]);
    if (result.success) {
      req[source] = result.data;
      return next();
    }
    const issue = result.error.issues[0];
    const param = formatPath(issue.path) || undefined;
    next(invalid(param ? `${param} : ${issue.message}` : issue.message, param, 'parameter_invalid'));
  };
}

module.exports = { validate, formatPath };

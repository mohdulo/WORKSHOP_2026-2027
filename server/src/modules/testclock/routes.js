'use strict';
const express = require('express');
const { z } = require('zod');
const { requireKey } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { ApiError } = require('../../lib/errors');

// Bornes (> 0, ≤ 5 ans) vérifiées par le service : un seul endroit fait foi.
const advanceSchema = z.object({ seconds: z.number().int() }).strict();

/** Désactivé en production : 404, identique à une route inconnue (on ne révèle pas son existence). */
function disabledInProduction(ctx) {
  return function testClockGuard(req, res, next) {
    if (ctx.config.nodeEnv === 'production') {
      return next(new ApiError(404, 'not_found', 'route_not_found', `Route inconnue : ${req.method} ${req.originalUrl.split('?')[0]}`));
    }
    next();
  };
}

function createTestClockRouter(ctx) {
  const router = express.Router();
  const guard = disabledInProduction(ctx);

  router.get('/test_clock', guard, requireKey('secret'), (req, res) => res.json(ctx.testclock.status()));

  // Handler async : Express 4 n'attrape pas les promesses rejetées → try/catch + next(err).
  router.post('/test_clock/advance', guard, requireKey('secret'), validate(advanceSchema), async (req, res, next) => {
    let result;
    try {
      result = await ctx.testclock.advance(req.body.seconds);
    } catch (err) {
      return next(err);
    }
    const { billing } = result.results;
    req.log.info(
      {
        now: result.now,
        advanced_by: result.advanced_by,
        expired: result.results.expired_authorizations.length,
        invoices_created: billing.invoices_created.length,
        payment_failures: billing.payment_failures.length,
        billing_errors: billing.errors.length,
      },
      'horloge de test avancée',
    );
    res.json(result);
  });

  return router;
}

module.exports = { createTestClockRouter };

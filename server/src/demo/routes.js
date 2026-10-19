'use strict';
const express = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');

// Schémas stricts : un champ `amount` (ou tout autre champ) envoyé par le navigateur est REFUSÉ (400),
// pas ignoré silencieusement — le montant vient toujours du catalogue serveur.
const checkoutSchema = z
  .object({
    productId: z.string().min(1).max(64),
    capture_method: z.enum(['automatic', 'manual']).optional(),
  })
  .strict();

const subscribeSchema = z
  .object({
    email: z.email().max(320),
    payment_method: z.string().min(1).max(64),
    priceId: z.string().min(1).max(64).optional(),
  })
  .strict();

/**
 * Routes du marchand de démo, montées sous /demo SANS clé API (PLAN §4.11) : elles représentent le serveur
 * d'un commerçant, qui agit avec SA clé secrète via les services. Aucune réponse ne contient la clé secrète
 * (test/demo.test.js le vérifie sur toutes les routes).
 */
function createDemoRouter(ctx) {
  const router = express.Router();
  const demo = ctx.demo;

  router.get('/config', (req, res) => {
    res.json(demo.config());
  });

  router.post('/checkout', validate(checkoutSchema), (req, res) => {
    const pi = demo.checkout(req.body);
    // Jamais le client_secret dans les logs (REDACT_PATHS le masquerait de toute façon).
    req.log.info({ payment_intent: pi.id, amount: pi.amount, product: req.body.productId }, 'démo : checkout créé');
    res.json(pi);
  });

  router.post('/subscribe', validate(subscribeSchema), (req, res) => {
    const { summary, error } = demo.subscribe(req.body);
    req.log.info({ subscription: summary.subscription.id, status: summary.subscription.status }, 'démo : abonnement');
    if (error) throw error; // refus carte : état committé AVANT la réponse 402 (taskForLesson L6)
    res.json(summary);
  });

  return router;
}

module.exports = { createDemoRouter };

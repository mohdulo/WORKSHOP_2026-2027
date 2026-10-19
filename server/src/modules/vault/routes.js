'use strict';
const express = require('express');
const { z } = require('zod');
const { requireKey } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { parseListParams } = require('../../lib/pagination');

// Validation STRUCTURELLE ici (types) ; Luhn, marque, expiration et format du CVC sont vérifiés par le service.
// Les messages zod ne reprennent jamais la valeur saisie (pas de PAN dans une réponse d'erreur).
const tokenizeSchema = z
  .object({
    type: z.literal('card').optional(),
    card: z
      .object({
        number: z.string().min(1).max(32),
        exp_month: z.number().int().min(1).max(12),
        exp_year: z.number().int().min(2000).max(2200),
        cvc: z.string().max(8),
      })
      .strict(),
  })
  .strict();

const attachSchema = z.object({ customer: z.string().min(1) }).strict();

function createVaultRouter(ctx) {
  const router = express.Router();

  // Clé publique autorisée : la carte va directement du navigateur au PSP (PLAN §5).
  router.post('/payment_methods', requireKey('publishable'), validate(tokenizeSchema), (req, res) => {
    const pm = ctx.vault.tokenize(req.body.card);
    // Jamais le corps : uniquement des champs non sensibles.
    req.log.info({ payment_method: pm.id, brand: pm.card.brand, last4: pm.card.last4, cvc_check: pm.card.cvc_check }, 'payment_method créé');
    res.json(pm);
  });

  router.post('/payment_methods/:id/attach', requireKey('secret'), validate(attachSchema), (req, res) => {
    res.json(ctx.vault.attach(req.params.id, req.body.customer));
  });

  router.get('/payment_methods/:id', requireKey('secret'), (req, res) => {
    res.json(ctx.vault.get(req.params.id));
  });

  router.get('/customers/:id/payment_methods', requireKey('secret'), (req, res) => {
    res.json(ctx.vault.listForCustomer(req.params.id, parseListParams(req.query)));
  });

  return router;
}

module.exports = { createVaultRouter };

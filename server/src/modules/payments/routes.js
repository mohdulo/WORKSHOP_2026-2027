'use strict';
const express = require('express');
const { z } = require('zod');
const { requireKey } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { parseListParams } = require('../../lib/pagination');
const { MAX_AMOUNT } = require('../../lib/money');
const { metadata } = require('../../lib/schemas');
const { failureToError } = require('./service');

const amount = z.number().int().positive().max(MAX_AMOUNT);

const createSchema = z
  .object({
    amount,
    currency: z.literal('eur'),
    customer: z.string().min(1).optional(),
    payment_method: z.string().min(1).optional(),
    capture_method: z.enum(['automatic', 'manual']).optional(),
    confirm: z.boolean().optional(),
    off_session: z.boolean().optional(),
    application_fee_amount: z.number().int().min(0).optional(),
    transfer_data: z.object({ destination: z.string().min(1) }).strict().optional(),
    description: z.string().max(1000).optional(),
    metadata: metadata.optional(),
  })
  .strict();

const confirmSchema = z
  .object({
    payment_method: z.string().min(1).optional(),
    client_secret: z.string().min(1).optional(),
  })
  .strict();

const captureSchema = z.object({ amount_to_capture: amount.optional() }).strict();

const cancelSchema = z
  .object({ cancellation_reason: z.enum(['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned']).optional() })
  .strict();

const threeDsSchema = z
  .object({
    result: z.enum(['approve', 'deny']),
    client_secret: z.string().min(1).optional(),
  })
  .strict();

/** { paymentIntent, failure? } → 200 avec le PI, ou 402 card_error (error.payment_intent = PI à jour). */
function sendOutcome(req, res, { paymentIntent, failure }) {
  if (failure) {
    req.log.info({ payment_intent: paymentIntent.id, code: failure.code, decline_code: failure.decline_code }, 'paiement refusé');
    throw failureToError(failure);
  }
  req.log.info({ payment_intent: paymentIntent.id, status: paymentIntent.status }, 'payment_intent mis à jour');
  res.json(paymentIntent);
}

function createPaymentsRouter(ctx) {
  const router = express.Router();
  const p = ctx.payments;

  router.post('/payment_intents', requireKey('secret'), validate(createSchema), (req, res) => {
    sendOutcome(req, res, p.create(req.body));
  });

  router.get('/payment_intents', requireKey('secret'), (req, res) => {
    const customer = typeof req.query.customer === 'string' ? req.query.customer : undefined;
    res.json(p.list({ ...parseListParams(req.query), customer }));
  });

  // pk autorisée avec ?client_secret= (affichage du statut côté navigateur).
  router.get('/payment_intents/:id', requireKey('publishable'), (req, res) => {
    const secret = typeof req.query.client_secret === 'string' ? req.query.client_secret : undefined;
    res.json(p.get(req.params.id, req.apiKey, secret));
  });

  // pk autorisée à condition de fournir le bon client_secret (PLAN §4.5).
  router.post('/payment_intents/:id/confirm', requireKey('publishable'), validate(confirmSchema), (req, res) => {
    const { client_secret: secret, ...params } = req.body;
    p.authorizeAccess(req.params.id, req.apiKey, secret);
    sendOutcome(req, res, p.confirm(req.params.id, params));
  });

  router.post('/payment_intents/:id/capture', requireKey('secret'), validate(captureSchema), (req, res) => {
    res.json(p.capture(req.params.id, req.body));
  });

  router.post('/payment_intents/:id/cancel', requireKey('secret'), validate(cancelSchema), (req, res) => {
    res.json(p.cancel(req.params.id, req.body));
  });

  router.post('/three_ds/:challenge_id/complete', requireKey('publishable'), validate(threeDsSchema), (req, res) => {
    sendOutcome(req, res, p.completeThreeDs(req.params.challenge_id, { result: req.body.result }, req.apiKey, req.body.client_secret));
  });

  router.get('/charges', requireKey('secret'), (req, res) => {
    const pi = typeof req.query.payment_intent === 'string' ? req.query.payment_intent : undefined;
    res.json(p.listCharges({ ...parseListParams(req.query), paymentIntent: pi }));
  });

  router.get('/charges/:id', requireKey('secret'), (req, res) => {
    res.json(p.getCharge(req.params.id));
  });

  return router;
}

module.exports = { createPaymentsRouter };

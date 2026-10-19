'use strict';
const express = require('express');
const { z } = require('zod');
const { requireKey } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { parseListParams } = require('../../lib/pagination');
const { MAX_AMOUNT } = require('../../lib/money');
const { metadata } = require('../../lib/schemas');
const { REASONS } = require('./service');

const createSchema = z
  .object({
    payment_intent: z.string().min(1),
    amount: z.number().int().positive().max(MAX_AMOUNT).optional(),
    reason: z.enum(REASONS).optional(),
    refund_application_fee: z.boolean().optional(),
    metadata: metadata.optional(),
  })
  .strict();

function createRefundsRouter(ctx) {
  const router = express.Router();

  router.post('/refunds', requireKey('secret'), validate(createSchema), (req, res) => {
    const refund = ctx.refunds.create(req.body);
    req.log.info({ refund: refund.id, payment_intent: refund.payment_intent, amount: refund.amount }, 'remboursement créé');
    res.json(refund);
  });

  router.get('/refunds', requireKey('secret'), (req, res) => {
    const pi = typeof req.query.payment_intent === 'string' ? req.query.payment_intent : undefined;
    res.json(ctx.refunds.list({ ...parseListParams(req.query), paymentIntent: pi }));
  });

  router.get('/refunds/:id', requireKey('secret'), (req, res) => {
    res.json(ctx.refunds.get(req.params.id));
  });

  return router;
}

module.exports = { createRefundsRouter };

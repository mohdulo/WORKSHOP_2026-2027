'use strict';
const express = require('express');
const { z } = require('zod');
const { requireKey } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { parseListParams } = require('../../lib/pagination');
const { MAX_AMOUNT } = require('../../lib/money');
const { metadata } = require('../../lib/schemas');
const { invalid } = require('../../lib/errors');
const { failureToError } = require('../payments/service');
const { INTERVALS, MAX_INTERVAL_COUNT } = require('./periods');

const productSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    metadata: metadata.optional(),
  })
  .strict();

const priceSchema = z
  .object({
    product: z.string().min(1),
    unit_amount: z.number().int().positive().max(MAX_AMOUNT),
    currency: z.literal('eur'),
    recurring: z
      .object({
        interval: z.enum(INTERVALS),
        interval_count: z.number().int().min(1).optional(),
      })
      .strict()
      .refine((r) => (r.interval_count ?? 1) <= MAX_INTERVAL_COUNT[r.interval], {
        message: 'Une période de facturation ne peut pas dépasser un an.',
        path: ['interval_count'],
      })
      .optional(),
    nickname: z.string().max(200).optional(),
    metadata: metadata.optional(),
  })
  .strict();

const subscriptionSchema = z
  .object({
    customer: z.string().min(1),
    price: z.string().min(1),
    trial_period_days: z.number().int().min(1).max(730).optional(),
    default_payment_method: z.string().min(1).optional(),
    metadata: metadata.optional(),
  })
  .strict();

const subscriptionUpdateSchema = z
  .object({
    default_payment_method: z.string().min(1).nullable().optional(),
    cancel_at_period_end: z.boolean().optional(),
  })
  .strict();

const cancelSchema = z.object({ at_period_end: z.boolean().optional() }).strict();
const paySchema = z.object({ payment_method: z.string().min(1).optional() }).strict();

const SUB_STATUSES = ['trialing', 'active', 'incomplete', 'past_due', 'canceled'];
const INVOICE_STATUSES = ['draft', 'open', 'paid', 'uncollectible', 'void'];

const queryString = (v) => (typeof v === 'string' ? v : undefined);
function queryEnum(v, allowed, param) {
  const s = queryString(v);
  if (s !== undefined && !allowed.includes(s)) throw invalid(`${param} doit valoir : ${allowed.join(', ')}.`, param);
  return s;
}

function createBillingRouter(ctx) {
  const router = express.Router();
  const b = ctx.billing;

  router.post('/products', requireKey('secret'), validate(productSchema), (req, res) => res.json(b.createProduct(req.body)));
  router.get('/products', requireKey('secret'), (req, res) => res.json(b.listProducts(parseListParams(req.query))));
  router.get('/products/:id', requireKey('secret'), (req, res) => res.json(b.getProduct(req.params.id)));

  router.post('/prices', requireKey('secret'), validate(priceSchema), (req, res) => res.json(b.createPrice(req.body)));
  router.get('/prices', requireKey('secret'), (req, res) =>
    res.json(b.listPrices({ ...parseListParams(req.query), product: queryString(req.query.product) })),
  );
  router.get('/prices/:id', requireKey('secret'), (req, res) => res.json(b.getPrice(req.params.id)));

  router.post('/subscriptions', requireKey('secret'), validate(subscriptionSchema), (req, res) => {
    const sub = b.createSubscription(req.body);
    req.log.info({ subscription: sub.id, status: sub.status }, 'abonnement créé');
    res.json(sub);
  });
  router.get('/subscriptions', requireKey('secret'), (req, res) =>
    res.json(
      b.listSubscriptions({
        ...parseListParams(req.query),
        customer: queryString(req.query.customer),
        status: queryEnum(req.query.status, SUB_STATUSES, 'status'),
      }),
    ),
  );
  router.get('/subscriptions/:id', requireKey('secret'), (req, res) => res.json(b.getSubscription(req.params.id)));
  router.post('/subscriptions/:id', requireKey('secret'), validate(subscriptionUpdateSchema), (req, res) =>
    res.json(b.updateSubscription(req.params.id, req.body)),
  );
  router.post('/subscriptions/:id/cancel', requireKey('secret'), validate(cancelSchema), (req, res) => {
    const sub = b.cancelSubscription(req.params.id, req.body);
    req.log.info({ subscription: sub.id, status: sub.status, cancel_at_period_end: sub.cancel_at_period_end }, 'abonnement résilié');
    res.json(sub);
  });

  router.get('/invoices', requireKey('secret'), (req, res) =>
    res.json(
      b.listInvoices({
        ...parseListParams(req.query),
        subscription: queryString(req.query.subscription),
        customer: queryString(req.query.customer),
        status: queryEnum(req.query.status, INVOICE_STATUSES, 'status'),
      }),
    ),
  );
  router.get('/invoices/:id', requireKey('secret'), (req, res) => res.json(b.getInvoice(req.params.id)));

  // Refus : l'échec est committé (attempt_count, relance, past_due/uncollectible) PUIS 402 (taskForLesson L6).
  router.post('/invoices/:id/pay', requireKey('secret'), validate(paySchema), (req, res) => {
    const { invoice, failure } = b.payInvoice(req.params.id, req.body);
    if (failure) {
      req.log.info({ invoice: invoice.id, code: failure.code, decline_code: failure.decline_code }, 'paiement de facture refusé');
      throw failureToError({ ...failure, paymentIntent: ctx.payments.get(invoice.payment_intent) });
    }
    req.log.info({ invoice: invoice.id, status: invoice.status }, 'facture payée');
    res.json(invoice);
  });

  return router;
}

module.exports = { createBillingRouter };

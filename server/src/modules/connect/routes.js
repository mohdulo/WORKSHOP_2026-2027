'use strict';
const express = require('express');
const { z } = require('zod');
const { requireKey } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { parseListParams } = require('../../lib/pagination');
const { MAX_AMOUNT } = require('../../lib/money');
const { metadata } = require('../../lib/schemas');

const amount = z.number().int().positive().max(MAX_AMOUNT);

const accountSchema = z
  .object({
    email: z.email().max(320),
    business_name: z.string().min(1).max(200).optional(),
  })
  .strict();

const transferSchema = z
  .object({
    amount,
    currency: z.literal('eur').optional(),
    destination: z.string().min(1),
    description: z.string().max(1000).optional(),
    metadata: metadata.optional(),
  })
  .strict();

const payoutSchema = z
  .object({
    account: z.string().min(1),
    amount,
    currency: z.literal('eur').optional(),
    description: z.string().max(1000).optional(),
    metadata: metadata.optional(),
  })
  .strict();

const queryString = (v) => (typeof v === 'string' ? v : undefined);

function createConnectRouter(ctx) {
  const router = express.Router();
  const c = ctx.connect;

  router.post('/accounts', requireKey('secret'), validate(accountSchema), (req, res) => {
    res.json(c.createAccount(req.body));
  });
  router.get('/accounts', requireKey('secret'), (req, res) => {
    res.json(c.listAccounts(parseListParams(req.query)));
  });
  router.get('/accounts/:id', requireKey('secret'), (req, res) => {
    res.json(c.getAccount(req.params.id));
  });
  router.get('/accounts/:id/balance', requireKey('secret'), (req, res) => {
    res.json(c.accountBalance(req.params.id));
  });

  router.post('/transfers', requireKey('secret'), validate(transferSchema), (req, res) => {
    const transfer = c.createTransfer(req.body);
    req.log.info({ transfer: transfer.id, destination: transfer.destination, amount: transfer.amount }, 'transfert créé');
    res.json(transfer);
  });
  router.get('/transfers', requireKey('secret'), (req, res) => {
    res.json(c.listTransfers({ ...parseListParams(req.query), destination: queryString(req.query.destination) }));
  });
  router.get('/transfers/:id', requireKey('secret'), (req, res) => {
    res.json(c.getTransfer(req.params.id));
  });

  router.post('/payouts', requireKey('secret'), validate(payoutSchema), (req, res) => {
    const payout = c.createPayout(req.body);
    req.log.info({ payout: payout.id, account: payout.account, amount: payout.amount }, 'payout effectué');
    res.json(payout);
  });
  router.get('/payouts', requireKey('secret'), (req, res) => {
    res.json(c.listPayouts({ ...parseListParams(req.query), account: queryString(req.query.account) }));
  });
  router.get('/payouts/:id', requireKey('secret'), (req, res) => {
    res.json(c.getPayout(req.params.id));
  });

  return router;
}

module.exports = { createConnectRouter };

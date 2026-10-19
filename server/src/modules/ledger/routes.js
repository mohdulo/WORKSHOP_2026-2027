'use strict';
const express = require('express');
const { requireKey } = require('../../middleware/auth');
const { parseListParams } = require('../../lib/pagination');
const { CURRENCY } = require('../../lib/money');

function createLedgerRouter(ctx) {
  const router = express.Router();

  router.get('/balance', requireKey('secret'), (req, res) => {
    res.json({ object: 'balance', available: [{ amount: ctx.ledger.balanceOf('platform_balance'), currency: CURRENCY }] });
  });

  router.get('/ledger/check', requireKey('secret'), (req, res) => {
    res.json(ctx.ledger.check());
  });

  router.get('/ledger/accounts', requireKey('secret'), (req, res) => {
    res.json(ctx.ledger.listAccounts());
  });

  router.get('/ledger/transactions', requireKey('secret'), (req, res) => {
    const { limit, startingAfter } = parseListParams(req.query);
    const refId = typeof req.query.ref_id === 'string' ? req.query.ref_id : undefined;
    res.json(ctx.ledger.listTransactions({ limit, startingAfter, refId }));
  });

  return router;
}

module.exports = { createLedgerRouter };

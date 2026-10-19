'use strict';
const express = require('express');
const { z } = require('zod');
const { requireKey } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { parseListParams } = require('../../lib/pagination');
const { metadata } = require('../../lib/schemas');

const createSchema = z
  .object({
    email: z.email().max(320),
    name: z.string().min(1).max(200).optional(),
    metadata: metadata.optional(),
  })
  .strict();

const updateSchema = z
  .object({
    email: z.email().max(320).optional(),
    name: z.string().min(1).max(200).nullable().optional(),
    metadata: metadata.optional(),
    invoice_settings: z.object({ default_payment_method: z.string().nullable() }).strict().optional(),
  })
  .strict();

function createCustomersRouter(ctx) {
  const router = express.Router();

  router.post('/customers', requireKey('secret'), validate(createSchema), (req, res) => {
    res.json(ctx.customers.create(req.body));
  });

  router.get('/customers', requireKey('secret'), (req, res) => {
    res.json(ctx.customers.list(parseListParams(req.query)));
  });

  router.get('/customers/:id', requireKey('secret'), (req, res) => {
    res.json(ctx.customers.get(req.params.id));
  });

  router.post('/customers/:id', requireKey('secret'), validate(updateSchema), (req, res) => {
    res.json(ctx.customers.update(req.params.id, req.body));
  });

  return router;
}

module.exports = { createCustomersRouter };

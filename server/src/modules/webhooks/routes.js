'use strict';
const express = require('express');
const { z } = require('zod');
const { requireKey } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { parseListParams } = require('../../lib/pagination');
const { invalid } = require('../../lib/errors');
const { EVENT_TYPES } = require('../events/types');

// La forme est vérifiée ici ; la sémantique (schéma http(s), types connus, "*" seul) par le service.
const createSchema = z
  .object({
    url: z.string().min(1).max(2048),
    enabled_events: z.array(z.string().min(1).max(100)).min(1).max(100),
    description: z.string().max(1000).optional(),
  })
  .strict();

const updateSchema = z
  .object({
    url: z.string().min(1).max(2048).optional(),
    enabled_events: z.array(z.string().min(1).max(100)).min(1).max(100).optional(),
    description: z.string().max(1000).nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

const DELIVERY_STATUSES = ['pending', 'sending', 'delivered', 'failed'];

function createWebhooksRouter(ctx) {
  const router = express.Router();
  const w = ctx.webhooks;

  router.get('/event_types', requireKey('secret'), (req, res) => {
    res.json({ object: 'list', data: [...EVENT_TYPES], has_more: false });
  });

  router.post('/webhook_endpoints', requireKey('secret'), validate(createSchema), (req, res) => {
    const endpoint = w.createEndpoint(req.body);
    // Jamais le secret dans les logs (REDACT_PATHS couvre aussi `secret` par défense en profondeur).
    req.log.info({ webhook_endpoint: endpoint.id, url: endpoint.url, enabled_events: endpoint.enabled_events }, 'webhook endpoint créé');
    res.json(endpoint);
  });

  router.get('/webhook_endpoints', requireKey('secret'), (req, res) => {
    res.json(w.listEndpoints(parseListParams(req.query)));
  });

  router.get('/webhook_endpoints/:id', requireKey('secret'), (req, res) => {
    res.json(w.getEndpoint(req.params.id));
  });

  router.post('/webhook_endpoints/:id', requireKey('secret'), validate(updateSchema), (req, res) => {
    res.json(w.updateEndpoint(req.params.id, req.body));
  });

  router.delete('/webhook_endpoints/:id', requireKey('secret'), (req, res) => {
    res.json(w.deleteEndpoint(req.params.id));
  });

  router.get('/webhook_endpoints/:id/deliveries', requireKey('secret'), (req, res) => {
    const { status } = req.query;
    if (status !== undefined && !DELIVERY_STATUSES.includes(status)) throw invalid(`status doit valoir ${DELIVERY_STATUSES.join(', ')}.`, 'status');
    res.json(w.listDeliveries(req.params.id, { ...parseListParams(req.query), status }));
  });

  return router;
}

module.exports = { createWebhooksRouter };

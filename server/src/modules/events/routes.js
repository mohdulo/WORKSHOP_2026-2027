'use strict';
const express = require('express');
const { requireKey } = require('../../middleware/auth');
const { parseListParams } = require('../../lib/pagination');
const { invalid } = require('../../lib/errors');

function createEventsRouter(ctx) {
  const router = express.Router();

  router.get('/events', requireKey('secret'), (req, res) => {
    const { limit, startingAfter } = parseListParams(req.query);
    const { type } = req.query;
    if (type !== undefined && typeof type !== 'string') throw invalid('type doit être une chaîne.', 'type');
    res.json(ctx.events.list({ limit, startingAfter, type }));
  });

  router.get('/events/:id', requireKey('secret'), (req, res) => {
    res.json(ctx.events.get(req.params.id));
  });

  return router;
}

module.exports = { createEventsRouter };

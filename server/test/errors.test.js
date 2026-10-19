'use strict';
const express = require('express');
const request = require('supertest');
const { z } = require('zod');
const { makeApp, auth } = require('./helpers');
const { requireKey } = require('../src/middleware/auth');
const { validate } = require('../src/middleware/validate');
const { stateError, cardError } = require('../src/lib/errors');

const testModule = {
  name: 'errorsTest',
  routes() {
    const r = express.Router();
    r.post(
      '/_test/validate',
      requireKey('secret'),
      validate(z.object({ card: z.object({ exp_month: z.number().int().min(1).max(12) }) })),
      (req, res) => res.json({ ok: true }),
    );
    r.post('/_test/state', requireKey('secret'), () => {
      throw stateError('Transition interdite.');
    });
    r.post('/_test/card', requireKey('secret'), () => {
      throw cardError('card_declined', 'Carte refusée.', { decline_code: 'generic_decline' });
    });
    return r;
  },
};

describe('errorHandler', () => {
  let app;
  beforeAll(() => {
    ({ app } = makeApp({ modules: [testModule] }));
  });

  it('JSON invalide → 400 JSON invalid_request_error', async () => {
    const res = await request(app).post('/v1/_test/validate').set(auth()).set('Content-Type', 'application/json').send('{"card": {');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toMatchObject({ type: 'invalid_request_error', code: 'invalid_json' });
  });

  it('corps > 100 ko → 413 JSON', async () => {
    const res = await request(app).post('/v1/_test/validate').set(auth()).send({ x: 'a'.repeat(110 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('request_too_large');
  });

  it('route inconnue → 404 JSON', async () => {
    const res = await request(app).get('/v1/nexiste_pas').set(auth());
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ type: 'not_found', code: 'route_not_found' });
    const res2 = await request(app).get('/autre');
    expect(res2.status).toBe(404);
    expect(res2.body.error.type).toBe('not_found');
  });

  it('validate → 400 avec param = premier chemin en erreur', async () => {
    const res = await request(app).post('/v1/_test/validate').set(auth()).send({ card: { exp_month: 13 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ type: 'invalid_request_error', param: 'card.exp_month' });
  });

  it('state_error → 409, card_error → 402 avec champs supplémentaires', async () => {
    const s = await request(app).post('/v1/_test/state').set(auth()).send({});
    expect(s.status).toBe(409);
    expect(s.body.error.type).toBe('state_error');
    const c = await request(app).post('/v1/_test/card').set(auth()).send({});
    expect(c.status).toBe(402);
    expect(c.body.error).toMatchObject({ type: 'card_error', code: 'card_declined', decline_code: 'generic_decline' });
  });

  it('GET /health → { ok: true } sans clé ; en-têtes helmet présents', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('rate limit', () => {
  it('au-delà de la limite → 429 rate_limit_error', async () => {
    const { createApp } = require('../src/app');
    const { config } = require('./helpers');
    const { createLogger } = require('../src/lib/logger');
    const { app } = createApp({ config, logger: createLogger({ level: 'silent' }), rateLimit: { windowMs: 60000, limit: 2 } });
    await request(app).get('/v1/balance').set(auth());
    await request(app).get('/v1/balance').set(auth());
    const r = await request(app).get('/v1/balance').set(auth());
    expect(r.status).toBe(429);
    expect(r.body.error.type).toBe('rate_limit_error');
  });
});

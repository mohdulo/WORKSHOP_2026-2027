'use strict';
const express = require('express');
const request = require('supertest');
const { z } = require('zod');
const { makeApp, auth, PK, T0 } = require('./helpers');
const { requireKey } = require('../src/middleware/auth');
const { validate } = require('../src/middleware/validate');
const { createClock } = require('../src/lib/clock');

/**
 * Module de TEST uniquement (monté via createApp({ modules })) : un POST qui a un effet réel
 * (écriture ledger + événement dans une même transaction SQL), pour vérifier « un seul effet ».
 */
const testModule = {
  name: 'testTransfers',
  routes(ctx) {
    const router = express.Router();
    const schema = z.object({ amount: z.number().int().positive(), memo: z.string().optional() }).strict();
    router.post('/_test/transfers', requireKey('secret'), validate(schema), (req, res) => {
      const txn = ctx.db.transaction(() => {
        const t = ctx.ledger.post('test_transfer', null, [
          { account: 'network_receivable', amount: req.body.amount },
          { account: 'platform_balance', amount: -req.body.amount },
        ]);
        ctx.events.emit('test.transfer_created', { id: t.id, amount: req.body.amount });
        return t;
      })();
      res.status(201).json({ id: txn.id, amount: req.body.amount });
    });
    let failures = 0;
    router.post('/_test/flaky', requireKey('secret'), (req, res) => {
      failures += 1;
      if (failures === 1) throw new Error('panne simulée');
      res.json({ ok: true, attempt: failures });
    });
    return router;
  },
};

describe('idempotence', () => {
  let app;
  let ctx;
  let clock;
  beforeEach(() => {
    clock = createClock(T0);
    ({ app, ctx } = makeApp({ modules: [testModule], clock }));
  });

  const countTxns = () => ctx.db.prepare('SELECT COUNT(*) AS n FROM ledger_transactions').get().n;

  it('même clé + même corps → réponse identique, un seul effet', async () => {
    const r1 = await request(app).post('/v1/_test/transfers').set(auth()).set('Idempotency-Key', 'k1').send({ amount: 500, memo: 'a' });
    expect(r1.status).toBe(201);
    // ordre des clés différent : même corps logique
    const r2 = await request(app).post('/v1/_test/transfers').set(auth()).set('Idempotency-Key', 'k1').send({ memo: 'a', amount: 500 });
    expect(r2.status).toBe(201);
    expect(r2.body).toEqual(r1.body);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(countTxns()).toBe(1);
    expect(ctx.ledger.balanceOf('platform_balance')).toBe(500);
    expect(ctx.events.list({ limit: 10 }).data).toHaveLength(1);
  });

  it('même clé + corps différent → 409 idempotency_error, aucun effet', async () => {
    await request(app).post('/v1/_test/transfers').set(auth()).set('Idempotency-Key', 'k2').send({ amount: 500 });
    const r = await request(app).post('/v1/_test/transfers').set(auth()).set('Idempotency-Key', 'k2').send({ amount: 999 });
    expect(r.status).toBe(409);
    expect(r.body.error.type).toBe('idempotency_error');
    expect(countTxns()).toBe(1);
  });

  it('sans clé : chaque POST a son effet', async () => {
    await request(app).post('/v1/_test/transfers').set(auth()).send({ amount: 100 });
    await request(app).post('/v1/_test/transfers').set(auth()).send({ amount: 100 });
    expect(countTxns()).toBe(2);
  });

  it('les erreurs 4xx sont rejouées à l\'identique', async () => {
    const r1 = await request(app).post('/v1/_test/transfers').set(auth()).set('Idempotency-Key', 'k3').send({ amount: -5 });
    expect(r1.status).toBe(400);
    expect(r1.body.error.param).toBe('amount');
    const r2 = await request(app).post('/v1/_test/transfers').set(auth()).set('Idempotency-Key', 'k3').send({ amount: -5 });
    expect(r2.status).toBe(400);
    expect(r2.body).toEqual(r1.body);
    expect(r2.headers['idempotent-replayed']).toBe('true');
  });

  it('les réponses 5xx ne sont pas stockées (le client peut réessayer)', async () => {
    const r1 = await request(app).post('/v1/_test/flaky').set(auth()).set('Idempotency-Key', 'k4').send({});
    expect(r1.status).toBe(500);
    expect(r1.body.error.type).toBe('api_error');
    const r2 = await request(app).post('/v1/_test/flaky').set(auth()).set('Idempotency-Key', 'k4').send({});
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ ok: true, attempt: 2 });
  });

  it('expiration après 24 h (horloge de test)', async () => {
    await request(app).post('/v1/_test/transfers').set(auth()).set('Idempotency-Key', 'k5').send({ amount: 100 });
    clock.advance(24 * 3600 + 1);
    const r = await request(app).post('/v1/_test/transfers').set(auth()).set('Idempotency-Key', 'k5').send({ amount: 200 });
    expect(r.status).toBe(201);
    expect(countTxns()).toBe(2);
  });

  it('clé isolée par clé API, et clé idempotence sur autre chemin → 409', async () => {
    await request(app).post('/v1/_test/transfers').set(auth()).set('Idempotency-Key', 'k6').send({});
    const r = await request(app).post('/v1/_test/flaky').set(auth()).set('Idempotency-Key', 'k6').send({});
    expect(r.status).toBe(409);
    // une clé pk avec la même Idempotency-Key n'entre pas en collision (et reste refusée par requireKey)
    const rPk = await request(app).post('/v1/_test/transfers').set(auth(PK)).set('Idempotency-Key', 'k6').send({});
    expect(rPk.status).toBe(403);
  });

  it('Idempotency-Key sans clé API → 401', async () => {
    const r = await request(app).post('/v1/_test/transfers').set('Idempotency-Key', 'k7').send({ amount: 1 });
    expect(r.status).toBe(401);
  });
});

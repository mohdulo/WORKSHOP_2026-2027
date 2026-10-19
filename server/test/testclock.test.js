'use strict';
const request = require('supertest');
const { createApp } = require('../src/app');
const { createClock } = require('../src/lib/clock');
const { createLogger } = require('../src/lib/logger');
const { makeApp, auth, PK, T0, pmFor, createPi, config } = require('./helpers');

const DAY = 86400;

describe('horloge de test', () => {
  let app;
  let ctx;
  beforeEach(() => {
    ({ app, ctx } = makeApp());
  });
  afterEach(() => {
    expect(ctx.ledger.check().balanced).toBe(true);
  });

  const advance = (body, key) => request(app).post('/v1/test_clock/advance').set(auth(key)).send(body);

  it('GET /v1/test_clock : instant courant (horloge gelée dans les tests)', async () => {
    const r = await request(app).get('/v1/test_clock').set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ object: 'test_clock', now: T0, frozen: true });
  });

  it('advance : avance l’horloge et renvoie le résultat des tâches', async () => {
    const r = await advance({ seconds: DAY });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: 'test_clock', now: T0 + DAY, previous: T0, advanced_by: DAY });
    expect(r.body.results).toMatchObject({ expired_authorizations: [], billing: { subscriptions_processed: 0, errors: [] }, hooks: {} });
    expect(ctx.clock.now()).toBe(T0 + DAY);
  });

  it('clé pk → 403, sans clé → 401', async () => {
    expect((await advance({ seconds: 60 }, PK)).status).toBe(403);
    expect((await request(app).get('/v1/test_clock').set(auth(PK))).status).toBe(403);
    expect((await request(app).post('/v1/test_clock/advance').send({ seconds: 60 })).status).toBe(401);
    expect(ctx.clock.now()).toBe(T0);
  });

  it('seconds ≤ 0, non entier, > 5 ans ou absent → 400 (horloge inchangée)', async () => {
    for (const body of [{ seconds: 0 }, { seconds: -5 }, { seconds: 1.5 }, { seconds: '60' }, {}, { seconds: 5 * 366 * DAY + 1 }, { seconds: 60, extra: 1 }]) {
      const r = await advance(body);
      expect(r.status).toBe(400);
      expect(r.body.error.type).toBe('invalid_request_error');
    }
    expect((await advance({ seconds: 0 })).body.error.param).toBe('seconds');
    expect(ctx.clock.now()).toBe(T0);
    expect((await advance({ seconds: 5 * 366 * DAY })).status).toBe(200);
  });

  it('404 en production (identique à une route inconnue)', async () => {
    const prodConfig = { ...config, nodeEnv: 'production' };
    const prod = createApp({ dbPath: ':memory:', config: prodConfig, clock: createClock(T0), logger: createLogger({ level: 'silent' }), rateLimit: false });
    const r1 = await request(prod.app).post('/v1/test_clock/advance').set(auth()).send({ seconds: 60 });
    const r2 = await request(prod.app).get('/v1/test_clock').set(auth());
    expect(r1.status).toBe(404);
    expect(r2.status).toBe(404);
    expect(r1.body.error.code).toBe('route_not_found');
    expect(prod.ctx.clock.now()).toBe(T0);
  });

  it('expiration des autorisations : PI manuel non capturé depuis plus de 7 j → canceled (expired)', async () => {
    const pm = await pmFor(app, '4242424242424242');
    const pi = (await createPi(app, { amount: 1000, payment_method: pm, confirm: true, capture_method: 'manual' })).body;
    expect(pi.status).toBe('requires_capture');
    const r1 = await advance({ seconds: 7 * DAY });
    expect(r1.body.results.expired_authorizations).toEqual([]); // borne stricte : exactement 7 j → pas encore
    const r2 = await advance({ seconds: 1 });
    expect(r2.body.results.expired_authorizations).toEqual([pi.id]);
    const after = (await request(app).get(`/v1/payment_intents/${pi.id}`).set(auth())).body;
    expect(after).toMatchObject({ status: 'canceled', cancellation_reason: 'expired' });
  });

  it('ordre : expiration, billing.run, puis hooks enregistrés (point d’extension phase 5)', async () => {
    const calls = [];
    const origExpire = ctx.payments.expireAuthorizations;
    const origRun = ctx.billing.run;
    ctx.payments.expireAuthorizations = (now) => (calls.push(['expire', now]), origExpire(now));
    ctx.billing.run = (now) => (calls.push(['billing', now]), origRun(now));
    ctx.testclock.onAdvance('webhooks', (now) => (calls.push(['webhooks', now]), { delivered: 0 }));
    ctx.testclock.onAdvance('boom', () => {
      throw new Error('hook en panne');
    });
    ctx.testclock.onAdvance('after', (now) => calls.push(['after', now]) && null);
    const r = await advance({ seconds: 3600 });
    expect(r.status).toBe(200);
    expect(calls).toEqual([['expire', T0 + 3600], ['billing', T0 + 3600], ['webhooks', T0 + 3600], ['after', T0 + 3600]]);
    expect(r.body.results.hooks).toEqual({ webhooks: { delivered: 0 }, boom: { error: 'hook en panne' }, after: null });
  });

  it('horloge temps réel (serveur) : advance décale l’horloge par offset', () => {
    const live = createClock();
    const before = live.now();
    live.advance(30 * DAY);
    expect(live.now() - before).toBeGreaterThanOrEqual(30 * DAY);
    expect(live.frozen).toBe(false);
  });
});

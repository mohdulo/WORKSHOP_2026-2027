'use strict';
const request = require('supertest');
const { makeApp, auth, PK, T0 } = require('./helpers');

describe('events', () => {
  let app;
  let ctx;
  beforeEach(() => {
    ({ app, ctx } = makeApp());
  });

  it('emit insère un evt_ avec horodatage de l\'horloge', () => {
    const evt = ctx.events.emit('payment_intent.created', { id: 'pi_1', object: 'payment_intent', amount: 100 });
    expect(evt.id).toMatch(/^evt_[0-9A-Za-z]{24}$/);
    expect(evt.created).toBe(T0);
    expect(ctx.events.get(evt.id)).toEqual(evt);
  });

  it('emit refuse un type mal formé', () => {
    expect(() => ctx.events.emit('Created', { id: 'x' })).toThrow();
  });

  it('GET /v1/events : liste paginée du plus récent au plus ancien', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(ctx.events.emit('charge.succeeded', { id: `ch_${i}`, n: i }).id);
    const expected = [...ids].reverse();

    const p1 = await request(app).get('/v1/events?limit=2').set(auth());
    expect(p1.status).toBe(200);
    expect(p1.body.object).toBe('list');
    expect(p1.body.has_more).toBe(true);
    expect(p1.body.data.map((e) => e.id)).toEqual(expected.slice(0, 2));
    expect(p1.body.data[0]).toMatchObject({ object: 'event', type: 'charge.succeeded', data: { object: { id: 'ch_4', n: 4 } } });

    const p2 = await request(app).get(`/v1/events?limit=2&starting_after=${p1.body.data[1].id}`).set(auth());
    expect(p2.body.data.map((e) => e.id)).toEqual(expected.slice(2, 4));
    expect(p2.body.has_more).toBe(true);

    const p3 = await request(app).get(`/v1/events?limit=2&starting_after=${p2.body.data[1].id}`).set(auth());
    expect(p3.body.data.map((e) => e.id)).toEqual(expected.slice(4));
    expect(p3.body.has_more).toBe(false);
  });

  it('limite par défaut 10, filtre par type, paramètres invalides → 400', async () => {
    for (let i = 0; i < 12; i++) ctx.events.emit(i % 2 ? 'a.b' : 'c.d', { i });
    const all = await request(app).get('/v1/events').set(auth());
    expect(all.body.data).toHaveLength(10);
    expect(all.body.has_more).toBe(true);
    const typed = await request(app).get('/v1/events?type=a.b&limit=100').set(auth());
    expect(typed.body.data).toHaveLength(6);
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'starting_after=evt_inconnu']) {
      const r = await request(app).get(`/v1/events?${q}`).set(auth());
      expect(r.status).toBe(400);
      expect(r.body.error.type).toBe('invalid_request_error');
    }
  });

  it('GET /v1/events/:id, 404 si inconnu, 403 avec pk', async () => {
    const evt = ctx.events.emit('customer.created', { id: 'cus_1' });
    const ok = await request(app).get(`/v1/events/${evt.id}`).set(auth());
    expect(ok.body.id).toBe(evt.id);
    const nf = await request(app).get('/v1/events/evt_nope').set(auth());
    expect(nf.status).toBe(404);
    expect(nf.body.error.type).toBe('not_found');
    const pk = await request(app).get(`/v1/events/${evt.id}`).set(auth(PK));
    expect(pk.status).toBe(403);
  });
});

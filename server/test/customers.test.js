'use strict';
const request = require('supertest');
const { makeApp, auth, PK, pmFor } = require('./helpers');

describe('customers', () => {
  let app;
  let ctx;
  beforeEach(() => {
    ({ app, ctx } = makeApp());
  });

  it('create / get / list / update', async () => {
    const c = await request(app).post('/v1/customers').set(auth()).send({ email: 'jean@example.com', name: 'Jean', metadata: { ref: '42' } });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ object: 'customer', email: 'jean@example.com', name: 'Jean', metadata: { ref: '42' }, invoice_settings: { default_payment_method: null } });
    expect(c.body.id).toMatch(/^cus_/);
    await request(app).post('/v1/customers').set(auth()).send({ email: 'b@example.com' });

    expect((await request(app).get(`/v1/customers/${c.body.id}`).set(auth())).body.email).toBe('jean@example.com');
    const list = await request(app).get('/v1/customers?limit=1').set(auth());
    expect(list.body).toMatchObject({ object: 'list', has_more: true });
    expect(list.body.data[0].email).toBe('b@example.com');

    const pm = await pmFor(app, '4242424242424242');
    // pm non rattaché → 400
    const bad = await request(app).post(`/v1/customers/${c.body.id}`).set(auth()).send({ invoice_settings: { default_payment_method: pm } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.param).toBe('invoice_settings.default_payment_method');
    await request(app).post(`/v1/payment_methods/${pm}/attach`).set(auth()).send({ customer: c.body.id }).expect(200);
    const up = await request(app).post(`/v1/customers/${c.body.id}`).set(auth()).send({ invoice_settings: { default_payment_method: pm }, name: 'Jean D.' });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ name: 'Jean D.', invoice_settings: { default_payment_method: pm } });
    expect(ctx.events.list({ type: 'customer.updated' }).data).toHaveLength(1);
  });

  it('validation et droits', async () => {
    const r = await request(app).post('/v1/customers').set(auth()).send({ email: 'pas-un-email' });
    expect(r.status).toBe(400);
    expect(r.body.error.param).toBe('email');
    expect((await request(app).post('/v1/customers').set(auth(PK)).send({ email: 'a@example.com' })).status).toBe(403);
    expect((await request(app).get('/v1/customers/cus_nope').set(auth())).status).toBe(404);
  });
});

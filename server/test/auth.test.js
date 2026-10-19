'use strict';
const request = require('supertest');
const { makeApp, SK, PK, auth } = require('./helpers');

describe('auth', () => {
  let app;
  beforeAll(() => {
    ({ app } = makeApp());
  });

  it('sans clé → 401 authentication_error', async () => {
    const res = await request(app).get('/v1/ledger/check');
    expect(res.status).toBe(401);
    expect(res.body.error.type).toBe('authentication_error');
    expect(res.body.error.code).toBe('missing_api_key');
  });

  it('mauvaise clé → 401', async () => {
    const res = await request(app).get('/v1/ledger/check').set(auth('sk_test_nimportequoi'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_api_key');
  });

  it('en-tête mal formé → 401', async () => {
    const res = await request(app).get('/v1/ledger/check').set('Authorization', SK);
    expect(res.status).toBe(401);
  });

  it('clé publique sur route secrète → 403 permission_error', async () => {
    const res = await request(app).get('/v1/ledger/check').set(auth(PK));
    expect(res.status).toBe(403);
    expect(res.body.error.type).toBe('permission_error');
  });

  it('clé secrète → 200', async () => {
    const res = await request(app).get('/v1/ledger/check').set(auth(SK));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ balanced: true, total: 0 });
  });

  it('la clé en clair n\'est pas stockée en base', () => {
    const { db } = makeApp();
    const dump = JSON.stringify(db.prepare('SELECT * FROM api_keys').all());
    expect(dump).not.toContain(SK);
    expect(dump).not.toContain(PK);
  });
});

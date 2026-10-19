'use strict';
const request = require('supertest');
const { makeApp, auth, SK, PK, tokenize } = require('./helpers');
const { luhnValid, detectBrand } = require('../src/modules/vault/service');
const { TEST_CARDS } = require('../src/modules/network/service');

const PAN = '4242424242424242';
const CVC = '7319';

describe('vault — fonctions pures', () => {
  it('Luhn : toutes les cartes de test PLAN §4.3 sont valides ; un chiffre modifié invalide', () => {
    for (const pan of Object.keys(TEST_CARDS)) expect(luhnValid(pan)).toBe(true);
    expect(luhnValid('4242424242424241')).toBe(false);
    expect(luhnValid('378282246310005')).toBe(true); // amex 15 chiffres
  });

  it('détection de marque', () => {
    expect(detectBrand('4242424242424242')).toBe('visa');
    expect(detectBrand('5555555555554444')).toBe('mastercard');
    expect(detectBrand('2221000000000009')).toBe('mastercard');
    expect(detectBrand('2720990000000007')).toBe('mastercard');
    expect(detectBrand('2721000000000000')).toBe(null);
    expect(detectBrand('378282246310005')).toBe('amex');
    expect(detectBrand('6011111111111117')).toBe(null);
  });
});

describe('vault — API', () => {
  let app;
  let ctx;
  beforeEach(() => {
    ({ app, ctx } = makeApp()); // horloge gelée au 2026-01-01
  });

  it('tokenisation pk → pm_ public, sans PAN ni CVC dans la réponse', async () => {
    const res = await tokenize(app, PAN, { cvc: CVC });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: 'payment_method',
      customer: null,
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, cvc_check: 'pass' },
    });
    expect(res.body.id).toMatch(/^pm_[0-9A-Za-z]{24}$/);
    expect(res.body.card.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(PAN);
    expect(raw).not.toContain(CVC);
  });

  it('même carte → même fingerprint ; numéro avec espaces accepté', async () => {
    const a = await tokenize(app, PAN);
    const b = await tokenize(app, '4242 4242 4242 4242');
    expect(b.status).toBe(200);
    expect(b.body.card.fingerprint).toBe(a.body.card.fingerprint);
    expect(b.body.id).not.toBe(a.body.id);
  });

  it('la ligne en base ne contient ni le PAN ni le CVC en clair (toutes colonnes, toute la base)', async () => {
    const res = await tokenize(app, PAN, { cvc: CVC });
    const row = ctx.db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(res.body.id);
    // aucune colonne destinée au CVC
    expect(Object.keys(row).filter((c) => /cvc|cvv|pan$|number/i.test(c))).toEqual(['cvc_check']);
    for (const [col, value] of Object.entries(row)) {
      expect(String(value), col).not.toContain(PAN);
      expect(String(value), col).not.toBe(CVC);
    }
    expect(row.pan_encrypted).toMatch(/^v1\./);
    // aucune table (événements compris) ne contient le PAN ; aucune valeur n'est exactement le CVC
    const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) {
      for (const r of ctx.db.prepare(`SELECT * FROM ${name}`).all()) {
        for (const v of Object.values(r)) {
          expect(String(v), name).not.toContain(PAN);
          expect(String(v), name).not.toBe(CVC);
          expect(String(v), name).not.toContain(`"cvc":`);
        }
      }
    }
  });

  it('reveal() redonne le PAN ; le chiffré est lié à son pm (AAD)', async () => {
    const a = await tokenize(app, PAN);
    const b = await tokenize(app, '5555555555554444');
    expect(ctx.vault.reveal(a.body.id)).toBe(PAN);
    expect(ctx.vault.reveal(b.body.id)).toBe('5555555555554444');
    // chiffré recopié sur une autre ligne → déchiffrement refusé
    const encA = ctx.db.prepare('SELECT pan_encrypted FROM payment_methods WHERE id = ?').get(a.body.id).pan_encrypted;
    ctx.db.prepare('UPDATE payment_methods SET pan_encrypted = ? WHERE id = ?').run(encA, b.body.id);
    expect(() => ctx.vault.reveal(b.body.id)).toThrow();
  });

  it('Luhn invalide → 400 param card.number, sans écho du numéro', async () => {
    const res = await tokenize(app, '4242424242424241');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ type: 'invalid_request_error', param: 'card.number', code: 'incorrect_number' });
    expect(JSON.stringify(res.body)).not.toContain('4242424242424241');
  });

  it('longueur invalide / marque non supportée → 400 card.number', async () => {
    expect((await tokenize(app, '42424242')).body.error.param).toBe('card.number');
    const r = await tokenize(app, '6011111111111117'); // Luhn OK, marque non supportée
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ param: 'card.number', code: 'card_brand_unsupported' });
  });

  it('carte expirée (selon ctx.clock) → 400 ; valable jusqu\'à la fin du mois d\'expiration', async () => {
    const r1 = await tokenize(app, PAN, { exp_month: 12, exp_year: 2025 });
    expect(r1.status).toBe(400);
    expect(r1.body.error.param).toBe('card.exp_year');
    // horloge = janvier 2026 : 01/2026 encore valable
    expect((await tokenize(app, PAN, { exp_month: 1, exp_year: 2026 })).status).toBe(200);
    // on avance d'un mois : 01/2026 expirée
    ctx.clock.advance(31 * 24 * 3600);
    const r2 = await tokenize(app, PAN, { exp_month: 1, exp_year: 2026 });
    expect(r2.status).toBe(400);
    expect(r2.body.error.param).toBe('card.exp_month');
  });

  it('CVC mal formé → 400 param card.cvc', async () => {
    for (const cvc of ['12', '12345', 'abc', '']) {
      const res = await tokenize(app, PAN, { cvc });
      expect(res.status, cvc).toBe(400);
      expect(res.body.error.param).toBe('card.cvc');
    }
  });

  it('exp_month hors bornes / champ inconnu → 400 avec param', async () => {
    const r = await tokenize(app, PAN, { exp_month: 13 });
    expect(r.body.error.param).toBe('card.exp_month');
    const r2 = await request(app).post('/v1/payment_methods').set(auth(PK)).send({ card: { number: PAN, exp_month: 1, exp_year: 2030, cvc: '123', cvv: '1' } });
    expect(r2.status).toBe(400);
  });

  it('carte 4000000000000127 → cvc_check: fail à la tokenisation', async () => {
    const res = await tokenize(app, '4000000000000127');
    expect(res.status).toBe(200);
    expect(res.body.card.cvc_check).toBe('fail');
  });

  it('pk acceptée sur la tokenisation, refusée (403) sur attach, GET et liste', async () => {
    const pm = (await tokenize(app, PAN, { key: PK })).body.id;
    const cus = (await request(app).post('/v1/customers').set(auth(SK)).send({ email: 'a@example.com' })).body.id;
    const attachPk = await request(app).post(`/v1/payment_methods/${pm}/attach`).set(auth(PK)).send({ customer: cus });
    expect(attachPk.status).toBe(403);
    expect(attachPk.body.error.type).toBe('permission_error');
    expect((await request(app).get(`/v1/payment_methods/${pm}`).set(auth(PK))).status).toBe(403);
    expect((await request(app).get(`/v1/customers/${cus}/payment_methods`).set(auth(PK))).status).toBe(403);
    expect((await tokenize(app, PAN, { key: SK })).status).toBe(200); // sk a aussi le droit
    expect((await request(app).post('/v1/payment_methods').send({})).status).toBe(401);
  });

  it('attach (sk) → GET pm et liste des pm du client', async () => {
    const pm = (await tokenize(app, PAN)).body.id;
    const pm2 = (await tokenize(app, '5555555555554444')).body.id;
    const cus = (await request(app).post('/v1/customers').set(auth()).send({ email: 'a@example.com' })).body.id;
    const att = await request(app).post(`/v1/payment_methods/${pm}/attach`).set(auth()).send({ customer: cus });
    expect(att.status).toBe(200);
    expect(att.body.customer).toBe(cus);
    await request(app).post(`/v1/payment_methods/${pm2}/attach`).set(auth()).send({ customer: cus }).expect(200);

    const get = await request(app).get(`/v1/payment_methods/${pm}`).set(auth());
    expect(get.body).toMatchObject({ id: pm, customer: cus });
    const list = await request(app).get(`/v1/customers/${cus}/payment_methods?limit=1`).set(auth());
    expect(list.body).toMatchObject({ object: 'list', has_more: true });
    expect(list.body.data[0].id).toBe(pm2);
    expect(JSON.stringify(list.body)).not.toContain(PAN);

    // déjà rattaché à un autre client → 400 ; client inconnu → 400 ; pm inconnu → 404
    const cus2 = (await request(app).post('/v1/customers').set(auth()).send({ email: 'b@example.com' })).body.id;
    expect((await request(app).post(`/v1/payment_methods/${pm}/attach`).set(auth()).send({ customer: cus2 })).status).toBe(400);
    const unknownCus = await request(app).post(`/v1/payment_methods/${pm2}/attach`).set(auth()).send({ customer: 'cus_nope' });
    expect(unknownCus.status).toBe(400);
    expect(unknownCus.body.error.param).toBe('customer');
    expect((await request(app).get('/v1/payment_methods/pm_nope').set(auth())).status).toBe(404);
    expect((await request(app).get('/v1/customers/cus_nope/payment_methods').set(auth())).status).toBe(404);
  });
});

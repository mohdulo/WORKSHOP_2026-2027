'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { makeApp, auth, pmFor, memoryStream, config, SK, PK, T0 } = require('./helpers');
const { createApp } = require('../src/app');
const { createClock } = require('../src/lib/clock');
const { createLogger } = require('../src/lib/logger');
const { platformFee } = require('../src/demo/catalog');

const OK_CARD = '4242424242424242';
const THREE_DS_CARD = '4000000000003220';
const DECLINED_CARD = '4000000000000002';

/** Aucune trace de clé secrète (ni la valeur configurée, ni un préfixe sk_) dans une réponse. */
function expectNoSecret(res) {
  const raw = res.text || JSON.stringify(res.body);
  expect(raw).not.toContain(SK);
  expect(raw).not.toMatch(/sk_(test|live)_/);
}

describe('démo marchand (/demo)', () => {
  let app;
  let ctx;
  beforeEach(() => {
    ({ app, ctx } = makeApp());
  });
  afterEach(() => {
    expect(ctx.ledger.check().balanced).toBe(true);
  });

  const getConfig = async () => {
    const r = await request(app).get('/demo/config');
    expect(r.status).toBe(200);
    return r.body;
  };
  const productByName = (cfg, re) => cfg.products.find((p) => re.test(p.name));

  it('GET /demo/config : clé publique, 3 produits, abonnement 9,90 €/mois, sans clé secrète', async () => {
    const r = await request(app).get('/demo/config');
    expect(r.status).toBe(200);
    expectNoSecret(r);
    expect(r.body.publishableKey).toBe(PK);
    expect(r.body.products).toHaveLength(3);
    for (const p of r.body.products) {
      expect(p.id).toMatch(/^prod_/);
      expect(p.price).toMatch(/^price_/);
      expect(Number.isInteger(p.amount) && p.amount > 0).toBe(true);
      expect(p.currency).toBe('eur');
    }
    expect(r.body.subscriptionPrice).toMatchObject({ unit_amount: 990, currency: 'eur', interval: 'month' });
    expect(r.body.subscriptionPrice.id).toMatch(/^price_/);
    // Prix réels côté PaySim (le catalogue n'est pas qu'un JSON statique)
    const price = await request(app).get(`/v1/prices/${r.body.subscriptionPrice.id}`).set(auth());
    expect(price.body).toMatchObject({ type: 'recurring', unit_amount: 990, recurring: { interval: 'month', interval_count: 1 } });
    const market = r.body.products.filter((p) => p.marketplace);
    expect(market).toHaveLength(1);
    expect(market[0].marketplace).toMatchObject({ seller_name: 'Atelier Lyonnais', platform_fee_percent: 15 });
  });

  it('seed idempotent : un second seed (redémarrage) ne crée aucun doublon', async () => {
    const first = await getConfig();
    const count = (t) => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    const before = { products: count('products'), prices: count('prices'), accounts: count('accounts'), events: count('events') };
    ctx.demo.seed();
    ctx.demo.seed();
    expect({ products: count('products'), prices: count('prices'), accounts: count('accounts'), events: count('events') }).toEqual(before);
    expect(before).toMatchObject({ products: 4, prices: 4, accounts: 1 });
    expect(await getConfig()).toEqual(first);
  });

  it('seed idempotent sur une base FICHIER rouverte (vrai redémarrage)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paysim-demo-'));
    const dbPath = path.join(dir, 'demo.db');
    const open = () => createApp({ dbPath, config, clock: createClock(T0), logger: createLogger({ level: 'silent' }), rateLimit: false, seedDemo: true });
    const a = open();
    const cfgA = a.ctx.demo.config();
    a.db.close();
    const b = open();
    const cfgB = b.ctx.demo.config();
    const n = b.db.prepare('SELECT (SELECT COUNT(*) FROM products) AS p, (SELECT COUNT(*) FROM accounts) AS a').get();
    b.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(cfgB).toEqual(cfgA);
    expect(n).toEqual({ p: 4, a: 1 });
  });

  it('régression L18 : un premier appel /demo qui échoue (transaction annulée) ne met pas en cache des ids fantômes', async () => {
    // Premier appel = subscribe en erreur : le seed paresseux se fait dans SA transaction, qui est annulée.
    expect((await request(app).post('/demo/subscribe').send({ email: 'x@example.com', payment_method: 'pm_inexistant' })).status).toBe(400);
    const cfg = await getConfig();
    const exists = (t, id) => Boolean(ctx.db.prepare(`SELECT 1 FROM ${t} WHERE id = ?`).get(id));
    expect(exists('prices', cfg.subscriptionPrice.id)).toBe(true);
    for (const p of cfg.products) expect(exists('products', p.id)).toBe(true);
    const pm = await pmFor(app, OK_CARD);
    expect((await request(app).post('/demo/subscribe').send({ email: 'y@example.com', payment_method: pm })).status).toBe(200);
  });

  it('checkout → PI au montant du catalogue ; parcours navigateur pk + client_secret → succeeded', async () => {
    const cfg = await getConfig();
    const product = productByName(cfg, /Café/);
    const r = await request(app).post('/demo/checkout').send({ productId: product.id });
    expect(r.status).toBe(200);
    expectNoSecret(r);
    expect(Object.keys(r.body).sort()).toEqual(['amount', 'client_secret', 'currency', 'id']);
    expect(r.body.amount).toBe(product.amount);
    expect(r.body.client_secret).toMatch(new RegExp(`^${r.body.id}_secret_`));

    // Navigateur : carte → /v1/payment_methods (pk) puis confirm (pk + client_secret)
    const pm = await pmFor(app, OK_CARD);
    const c = await request(app).post(`/v1/payment_intents/${r.body.id}/confirm`).set(auth(PK)).send({ payment_method: pm, client_secret: r.body.client_secret });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'succeeded', amount_received: product.amount });
  });

  it('checkout : montant NON falsifiable (champ amount refusé, prix toujours celui du serveur)', async () => {
    const cfg = await getConfig();
    const product = productByName(cfg, /Carnet/);
    const forged = await request(app).post('/demo/checkout').send({ productId: product.id, amount: 1 });
    expect(forged.status).toBe(400);
    expect(forged.body.error).toMatchObject({ type: 'invalid_request_error', code: 'parameter_invalid' });
    for (const extra of [{ application_fee_amount: 0 }, { transfer_data: { destination: 'acct_x' } }, { currency: 'usd' }]) {
      expect((await request(app).post('/demo/checkout').send({ productId: product.id, ...extra })).status).toBe(400);
    }
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM payment_intents').get().n).toBe(0);

    const ok = await request(app).post('/demo/checkout').send({ productId: product.id });
    expect(ok.body.amount).toBe(product.amount);
    expect(ctx.db.prepare('SELECT amount FROM payment_intents WHERE id = ?').get(ok.body.id).amount).toBe(product.amount);
  });

  it('checkout : produit inconnu, prix d\'abonnement ou corps invalide → 400', async () => {
    const cfg = await getConfig();
    const unknown = await request(app).post('/demo/checkout').send({ productId: 'prod_inexistant' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: 'resource_missing', param: 'productId' });
    expect((await request(app).post('/demo/checkout').send({ productId: cfg.subscriptionPrice.product })).status).toBe(400);
    expect((await request(app).post('/demo/checkout').send({})).status).toBe(400);
  });

  it('checkout marketplace : split 85 % vendeur / 15 % plateforme', async () => {
    const cfg = await getConfig();
    const product = cfg.products.find((p) => p.marketplace);
    const r = await request(app).post('/demo/checkout').send({ productId: product.id });
    const pi = (await request(app).get(`/v1/payment_intents/${r.body.id}`).set(auth())).body;
    const fee = platformFee(product.amount);
    expect(fee).toBe(Math.round(product.amount * 0.15));
    expect(pi).toMatchObject({ application_fee_amount: fee, transfer_data: { destination: product.marketplace.seller } });

    const pm = await pmFor(app, OK_CARD);
    await request(app).post(`/v1/payment_intents/${r.body.id}/confirm`).set(auth(PK)).send({ payment_method: pm, client_secret: r.body.client_secret }).expect(200);
    const bal = await request(app).get(`/v1/accounts/${product.marketplace.seller}/balance`).set(auth());
    expect(bal.body.available[0].amount).toBe(product.amount - fee); // 85 %
  });

  it('checkout + carte 3-D Secure : requires_action → complete (pk) → succeeded', async () => {
    const cfg = await getConfig();
    const r = await request(app).post('/demo/checkout').send({ productId: cfg.products[0].id });
    const pm = await pmFor(app, THREE_DS_CARD);
    const c = await request(app).post(`/v1/payment_intents/${r.body.id}/confirm`).set(auth(PK)).send({ payment_method: pm, client_secret: r.body.client_secret });
    expect(c.body.status).toBe('requires_action');
    expect(c.body.next_action).toMatchObject({ type: 'three_d_secure' });
    const done = await request(app).post(`/v1/three_ds/${c.body.next_action.challenge_id}/complete`).set(auth(PK)).send({ result: 'approve', client_secret: r.body.client_secret });
    expect(done.body.status).toBe('succeeded');
  });

  it('subscribe OK → client, carte rattachée par défaut, abonnement active, facture payée', async () => {
    const cfg = await getConfig();
    const pm = await pmFor(app, OK_CARD);
    const r = await request(app).post('/demo/subscribe').send({ email: 'abonne@example.com', payment_method: pm });
    expect(r.status).toBe(200);
    expectNoSecret(r);
    expect(r.body.subscription.status).toBe('active');
    expect(r.body.invoice).toMatchObject({ status: 'paid', amount_paid: 990, amount_due: 990 });

    const sub = (await request(app).get(`/v1/subscriptions/${r.body.subscription.id}`).set(auth())).body;
    expect(sub).toMatchObject({ customer: r.body.customer, price: cfg.subscriptionPrice.id, status: 'active' });
    const cus = (await request(app).get(`/v1/customers/${r.body.customer}`).set(auth())).body;
    expect(cus).toMatchObject({ email: 'abonne@example.com', invoice_settings: { default_payment_method: pm } });

    // Facturation suivante : +1 mois → nouvelle facture payée
    const adv = await request(app).post('/v1/test_clock/advance').set(auth()).send({ seconds: 31 * 86400 });
    expect(adv.status).toBe(200);
    const inv = (await request(app).get(`/v1/invoices?subscription=${sub.id}`).set(auth())).body.data;
    expect(inv.map((i) => i.status)).toEqual(['paid', 'paid']);
  });

  it('subscribe carte refusée → 402 card_error (decline_code) ; abonnement incomplete committé (L6)', async () => {
    const pm = await pmFor(app, DECLINED_CARD);
    const r = await request(app).post('/demo/subscribe').send({ email: 'refus@example.com', payment_method: pm });
    expect(r.status).toBe(402);
    expectNoSecret(r);
    expect(r.body.error).toMatchObject({ type: 'card_error', code: 'card_declined', decline_code: 'card_declined' });
    expect(r.body.error.subscription.status).toBe('incomplete');
    expect(r.body.error.invoice.status).toBe('open');
    const sub = (await request(app).get(`/v1/subscriptions/${r.body.error.subscription.id}`).set(auth())).body;
    expect(sub.status).toBe('incomplete');
  });

  it('subscribe : erreurs de validation annulent tout (pm inconnu, déjà rattaché, e-mail invalide, montant envoyé)', async () => {
    const count = () => ctx.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
    expect((await request(app).post('/demo/subscribe').send({ email: 'x@example.com', payment_method: 'pm_inexistant' })).status).toBe(400);
    expect(count()).toBe(0); // le client créé avant l'échec du rattachement est annulé (transaction)
    expect((await request(app).post('/demo/subscribe').send({ email: 'pas-un-email', payment_method: 'pm_x' })).status).toBe(400);
    const pm = await pmFor(app, OK_CARD);
    expect((await request(app).post('/demo/subscribe').send({ email: 'x@example.com', payment_method: pm, amount: 1 })).status).toBe(400);
    expect((await request(app).post('/demo/subscribe').send({ email: 'x@example.com', payment_method: pm, priceId: 'price_autre' })).status).toBe(400);
    const okSub = await request(app).post('/demo/subscribe').send({ email: 'a@example.com', payment_method: pm });
    expect(okSub.body).toMatchObject({ subscription: { status: 'active' } });
    const again = await request(app).post('/demo/subscribe').send({ email: 'b@example.com', payment_method: pm });
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('payment_method_already_attached');
    expect(count()).toBe(1);
  });

  it('/demo ne renvoie jamais la clé secrète (toutes routes, succès et erreurs) et n\'exige aucune clé', async () => {
    const cfg = await getConfig();
    const pm = await pmFor(app, OK_CARD);
    const responses = [
      await request(app).get('/demo/config'),
      await request(app).post('/demo/checkout').send({ productId: cfg.products[0].id }),
      await request(app).post('/demo/checkout').send({ productId: 'nope' }),
      await request(app).post('/demo/checkout').set('Content-Type', 'application/json').send('{"x":'),
      await request(app).post('/demo/subscribe').send({ email: 's@example.com', payment_method: pm }),
      await request(app).post('/demo/subscribe').send({ email: 's@example.com', payment_method: 'pm_nope' }),
      await request(app).get('/demo/inconnue'),
    ];
    for (const r of responses) {
      expect(r.status).not.toBe(401);
      expectNoSecret(r);
      expect(JSON.stringify(r.headers)).not.toContain(SK);
    }
  });

  it('logs : ni clé secrète, ni client_secret, ni PAN pendant un parcours /demo', async () => {
    const mem = memoryStream();
    const logger = createLogger({ level: 'debug', stream: mem.stream });
    ({ app, ctx } = makeApp({ logger }));
    const cfg = await getConfig();
    const co = await request(app).post('/demo/checkout').send({ productId: cfg.products[0].id });
    const pm = await pmFor(app, OK_CARD);
    await request(app).post(`/v1/payment_intents/${co.body.id}/confirm`).set(auth(PK)).send({ payment_method: pm, client_secret: co.body.client_secret }).expect(200);
    await request(app).get(`/v1/payment_intents/${co.body.id}?client_secret=${co.body.client_secret}`).set(auth(PK)).expect(200);
    const pm2 = await pmFor(app, OK_CARD);
    await request(app).post('/demo/subscribe').send({ email: 'log@example.com', payment_method: pm2 }).expect(200);
    const out = mem.text();
    expect(out).toContain('démo : checkout créé');
    expect(out).not.toContain(SK);
    expect(out).not.toMatch(/sk_test_/);
    expect(out).not.toContain(co.body.client_secret);
    expect(out).not.toContain('_secret_');
    expect(out).not.toContain(OK_CARD);
  });

  it('rate limit appliqué aussi à /demo (routes sans clé)', async () => {
    const limited = createApp({ dbPath: ':memory:', config, clock: createClock(T0), logger: createLogger({ level: 'silent' }), rateLimit: { windowMs: 60000, limit: 2 } });
    await request(limited.app).get('/demo/config').expect(200);
    await request(limited.app).get('/demo/config').expect(200);
    const r = await request(limited.app).get('/demo/config');
    expect(r.status).toBe(429);
    expect(r.body.error.type).toBe('rate_limit_error');
  });
});

describe('front statique (web/dist) + fallback SPA', () => {
  let dir;
  let app;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paysim-dist-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>');
    fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
    ({ app } = createApp({ dbPath: ':memory:', config, clock: createClock(T0), logger: createLogger({ level: 'silent' }), rateLimit: false, staticDir: dir }));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('sert index.html sur / et les routes du front (/checkout, /dashboard), assets avec cache long', async () => {
    for (const p of ['/', '/checkout', '/subscribe', '/dashboard']) {
      const r = await request(app).get(p).set('Accept', 'text/html');
      expect(r.status).toBe(200);
      expect(r.text).toContain('<div id="root">');
    }
    const a = await request(app).get('/assets/app.js');
    expect(a.status).toBe(200);
    expect(a.headers['cache-control']).toContain('immutable');
  });

  it('les routes API inconnues gardent leur 404 JSON (pas de fallback SPA)', async () => {
    for (const p of ['/v1/inconnue', '/demo/inconnue', '/health/x']) {
      const r = await request(app).get(p).set('Accept', 'text/html');
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('route_not_found');
    }
    expect((await request(app).get('/health')).body).toEqual({ ok: true });
  });

  it('CSP : scripts et styles en self, pas d\'upgrade-insecure-requests hors production', async () => {
    const r = await request(app).get('/').set('Accept', 'text/html');
    const csp = r.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    const { cspDirectives } = require('../src/app');
    expect(cspDirectives({ nodeEnv: 'production' }).upgradeInsecureRequests).toEqual([]);
  });

  it('sans staticDir (tests/API seule) : / reste une 404 JSON', async () => {
    const { app: bare } = makeApp();
    const r = await request(bare).get('/').set('Accept', 'text/html');
    expect(r.status).toBe(404);
  });
});

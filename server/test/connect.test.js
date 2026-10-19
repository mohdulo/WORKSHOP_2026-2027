'use strict';
const request = require('supertest');
const { makeApp, auth, PK, countRows, createSeller, paidPi, refund } = require('./helpers');
const { computePspFee } = require('../src/lib/money');

describe('connect (marketplace)', () => {
  let app;
  let ctx;
  beforeEach(() => {
    ({ app, ctx } = makeApp());
  });
  afterEach(() => {
    expect(ctx.ledger.check().balanced).toBe(true);
  });

  const bal = (code) => ctx.ledger.balanceOf(code);
  const apiBalance = async (seller) => (await request(app).get(seller ? `/v1/accounts/${seller}/balance` : '/v1/balance').set(auth())).body;
  const transfer = (body) => request(app).post('/v1/transfers').set(auth()).send(body);
  const payout = (body) => request(app).post('/v1/payouts').set(auth()).send(body);
  const eventsOf = (type) => ctx.db.prepare('SELECT data FROM events WHERE type = ? ORDER BY seq').all(type).map((e) => JSON.parse(e.data).object);

  describe('accounts', () => {
    it('create / get / list / balance (même format que /v1/balance) + account.created', async () => {
      const r = await request(app).post('/v1/accounts').set(auth()).send({ email: 'shop@example.com', business_name: 'Boutique' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ object: 'account', email: 'shop@example.com', business_name: 'Boutique', status: 'enabled' });
      expect(r.body.id).toMatch(/^acct_[0-9A-Za-z]{24}$/);
      expect((await request(app).get(`/v1/accounts/${r.body.id}`).set(auth())).body).toEqual(r.body);
      const second = await createSeller(app);
      const list = (await request(app).get('/v1/accounts?limit=1').set(auth())).body;
      expect(list).toMatchObject({ object: 'list', has_more: true });
      expect(list.data[0].id).toBe(second);

      const b = await apiBalance(r.body.id);
      const platform = await apiBalance();
      expect(Object.keys(b).sort()).toEqual(Object.keys(platform).sort());
      expect(b).toEqual({ object: 'balance', available: [{ amount: 0, currency: 'eur' }] });
      expect(eventsOf('account.created').map((a) => a.id)).toEqual([r.body.id, second]);
      // compte ledger créé d'office
      expect(ctx.db.prepare('SELECT type FROM ledger_accounts WHERE code = ?').get(`merchant:${r.body.id}`)).toEqual({ type: 'liability' });
    });

    it('validation et erreurs', async () => {
      expect((await request(app).post('/v1/accounts').set(auth()).send({ email: 'pas-un-email' })).body.error.param).toBe('email');
      expect((await request(app).post('/v1/accounts').set(auth()).send({ email: 'a@b.fr', status: 'disabled' })).status).toBe(400);
      expect((await request(app).post('/v1/accounts').set(auth(PK)).send({ email: 'a@b.fr' })).status).toBe(403);
      expect((await request(app).get('/v1/accounts/acct_nope').set(auth())).status).toBe(404);
      expect((await request(app).get('/v1/accounts/acct_nope/balance').set(auth())).status).toBe(404);
    });

    it('le vendeur créé via l\'API est une destination valide pour un paiement split', async () => {
      const seller = await createSeller(app);
      const pi = await paidPi(app, 5000, { destination: seller, fee: 500 });
      expect(pi.transfer_data).toEqual({ destination: seller });
      expect((await apiBalance(seller)).available[0].amount).toBe(4500);
    });
  });

  describe('transfers', () => {
    it('plateforme → vendeur : écritures, soldes, transfer.created', async () => {
      const seller = await createSeller(app);
      await paidPi(app, 10000); // plateforme : 10000 − 165 = 9835
      const r = await transfer({ amount: 3000, destination: seller, description: 'bonus' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ object: 'transfer', amount: 3000, currency: 'eur', destination: seller, description: 'bonus' });
      expect(r.body.id).toMatch(/^tr_/);
      expect(bal('platform_balance')).toBe(6835);
      expect(bal(`merchant:${seller}`)).toBe(3000);
      expect(ctx.ledger.listTransactions({ refId: r.body.id }).data[0].entries).toEqual([
        { account: 'platform_balance', amount: 3000 },
        { account: `merchant:${seller}`, amount: -3000 },
      ]);
      expect(eventsOf('transfer.created')[0].id).toBe(r.body.id);
      expect((await request(app).get(`/v1/transfers/${r.body.id}`).set(auth())).body).toEqual(r.body);
      expect((await request(app).get(`/v1/transfers?destination=${seller}`).set(auth())).body.data).toHaveLength(1);
    });

    it('solde plateforme insuffisant → 402 insufficient_balance, aucune écriture ; borne exacte acceptée', async () => {
      const seller = await createSeller(app);
      const empty = await transfer({ amount: 1, destination: seller });
      expect(empty.status).toBe(402);
      expect(empty.body.error).toMatchObject({ code: 'insufficient_balance', param: 'amount' });
      await paidPi(app, 10000); // 9835
      const before = countRows(ctx, 'ledger_entries');
      expect((await transfer({ amount: 9836, destination: seller })).status).toBe(402);
      expect(countRows(ctx, 'ledger_entries')).toBe(before);
      expect(countRows(ctx, 'transfers')).toBe(0);
      expect(countRows(ctx, 'events', "type = 'transfer.created'")).toBe(0);
      expect((await transfer({ amount: 9835, destination: seller })).status).toBe(200);
      expect(bal('platform_balance')).toBe(0);
    });

    it('destination inconnue / désactivée → 400', async () => {
      await paidPi(app, 10000);
      const r = await transfer({ amount: 100, destination: 'acct_nope' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatchObject({ code: 'resource_missing', param: 'destination' });
      const seller = await createSeller(app);
      ctx.db.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").run(seller);
      expect((await transfer({ amount: 100, destination: seller })).body.error.code).toBe('account_disabled');
      expect((await transfer({ amount: -5, destination: seller })).body.error.param).toBe('amount');
    });
  });

  describe('payouts', () => {
    it('payout ≤ solde : status paid, bank_payouts, payout.paid ; au-delà → 402 sans écriture', async () => {
      const seller = await createSeller(app);
      await paidPi(app, 10000, { destination: seller, fee: 1000 }); // vendeur 9000
      const over = await payout({ account: seller, amount: 9001 });
      expect(over.status).toBe(402);
      expect(over.body.error).toMatchObject({ type: 'invalid_request_error', code: 'insufficient_balance', param: 'amount' });
      expect(countRows(ctx, 'payouts')).toBe(0);
      expect(bal('bank_payouts')).toBe(0);

      const r = await payout({ account: seller, amount: 9000 });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ object: 'payout', account: seller, amount: 9000, currency: 'eur', status: 'paid' });
      expect(r.body.id).toMatch(/^po_/);
      expect(bal(`merchant:${seller}`)).toBe(0);
      expect(bal('bank_payouts')).toBe(9000);
      expect(eventsOf('payout.paid')[0]).toMatchObject({ id: r.body.id, status: 'paid' });
      expect((await request(app).get(`/v1/payouts/${r.body.id}`).set(auth())).body).toEqual(r.body);
      expect((await request(app).get(`/v1/payouts?account=${seller}`).set(auth())).body.data).toHaveLength(1);
    });

    it('compte inconnu → 400 ; compte sans fonds → 402', async () => {
      expect((await payout({ account: 'acct_nope', amount: 1 })).body.error).toMatchObject({ code: 'resource_missing', param: 'account' });
      const seller = await createSeller(app);
      expect((await payout({ account: seller, amount: 1 })).status).toBe(402);
    });

    it('idempotence : un payout rejoué n\'est payé qu\'une fois', async () => {
      const seller = await createSeller(app);
      await paidPi(app, 10000, { destination: seller, fee: 1000 });
      const send = () => request(app).post('/v1/payouts').set(auth()).set('Idempotency-Key', 'po-1').send({ account: seller, amount: 5000 });
      const a = await send();
      const b = await send();
      expect(b.body).toEqual(a.body);
      expect(countRows(ctx, 'payouts')).toBe(1);
      expect(bal(`merchant:${seller}`)).toBe(4000);
    });
  });

  it('scénario marketplace complet', async () => {
    // 1. création vendeur
    const seller = await createSeller(app, { business_name: 'Atelier Céramique' });
    const M = `merchant:${seller}`;

    // 2. paiement split 100 € avec 10 € de commission
    const pi = await paidPi(app, 10000, { destination: seller, fee: 1000 });
    const pspFee = computePspFee(10000);
    expect(pspFee).toBe(165);
    expect((await apiBalance(seller)).available[0].amount).toBe(9000);
    expect((await apiBalance()).available[0].amount).toBe(1000 - pspFee); // 835
    expect(bal('psp_revenue')).toBe(pspFee);
    expect(bal('network_receivable')).toBe(10000);

    // 3. payout 50 € → vendeur 40 €, bank_payouts 50 €
    expect((await payout({ account: seller, amount: 5000 })).status).toBe(200);
    expect((await apiBalance(seller)).available[0].amount).toBe(4000);
    expect(bal('bank_payouts')).toBe(5000);

    // 4. payout 41 € refusé
    const refused = await payout({ account: seller, amount: 4100 });
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('insufficient_balance');
    expect((await apiBalance(seller)).available[0].amount).toBe(4000);

    // 5. remboursement 20 € → vendeur 20 €
    const r = await refund(app, { payment_intent: pi.id, amount: 2000 });
    expect(r.status).toBe(200);
    expect((await apiBalance(seller)).available[0].amount).toBe(2000);
    expect((await apiBalance()).available[0].amount).toBe(835); // plateforme inchangée (commission non rendue)
    expect(bal('network_receivable')).toBe(8000);
    expect(bal('psp_revenue')).toBe(165);
    expect(bal('bank_payouts')).toBe(5000);

    // Somme des soldes : actif = passif + produits
    expect(bal('network_receivable')).toBe(bal(M) + bal('platform_balance') + bal('bank_payouts') + bal('psp_revenue'));
    expect((await request(app).get('/v1/ledger/check').set(auth())).body).toMatchObject({ balanced: true, total: 0 });
  });
});

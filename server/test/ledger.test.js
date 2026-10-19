'use strict';
const request = require('supertest');
const { makeApp, auth } = require('./helpers');
const { computePspFee } = require('../src/lib/money');
const { newId } = require('../src/lib/ids');

describe('ledger', () => {
  let app;
  let ctx;
  beforeEach(() => {
    ({ app, ctx } = makeApp());
  });

  const count = (t) => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

  it('post équilibré (capture sans destination) → soldes conformes PLAN §4.1', () => {
    const A = 10000;
    const fee = computePspFee(A);
    const txn = ctx.ledger.post('capture', 'pi_test', [
      { account: 'network_receivable', amount: A },
      { account: 'platform_balance', amount: -A },
      { account: 'platform_balance', amount: fee },
      { account: 'psp_revenue', amount: -fee },
    ]);
    expect(txn.id).toMatch(/^txn_[0-9A-Za-z]{24}$/);
    expect(ctx.ledger.balanceOf('network_receivable')).toBe(A);
    expect(ctx.ledger.balanceOf('platform_balance')).toBe(A - fee);
    expect(ctx.ledger.balanceOf('psp_revenue')).toBe(fee);
    expect(ctx.ledger.check()).toMatchObject({ balanced: true, total: 0 });
  });

  it('capture avec destination marchand + payout', () => {
    const M = `merchant:${newId('acct')}`;
    const A = 5000;
    const F = 500;
    const fee = computePspFee(A);
    ctx.ledger.post('capture', 'pi_x', [
      { account: 'network_receivable', amount: A },
      { account: M, amount: -(A - F) },
      { account: 'platform_balance', amount: -F },
      { account: 'platform_balance', amount: fee },
      { account: 'psp_revenue', amount: -fee },
    ]);
    expect(ctx.ledger.balanceOf(M)).toBe(4500);
    expect(ctx.ledger.balanceOf('platform_balance')).toBe(F - fee);
    ctx.ledger.post('payout', 'po_x', [
      { account: M, amount: 1000 },
      { account: 'bank_payouts', amount: -1000 },
    ]);
    expect(ctx.ledger.balanceOf(M)).toBe(3500);
    expect(ctx.ledger.balanceOf('bank_payouts')).toBe(1000);
    expect(ctx.ledger.check().balanced).toBe(true);
  });

  it('déséquilibré → refusé, rien n\'est écrit', () => {
    expect(() =>
      ctx.ledger.post('capture', 'pi_bad', [
        { account: 'network_receivable', amount: 100 },
        { account: 'platform_balance', amount: -99 },
      ]),
    ).toThrow(/déséquilibrée/);
    expect(count('ledger_transactions')).toBe(0);
    expect(count('ledger_entries')).toBe(0);
  });

  it('refuse montants nuls / non entiers / moins de 2 lignes / compte inconnu, sans rien écrire', () => {
    const bad = [
      [{ account: 'network_receivable', amount: 0 }, { account: 'platform_balance', amount: 0 }],
      [{ account: 'network_receivable', amount: 1.5 }, { account: 'platform_balance', amount: -1.5 }],
      [{ account: 'network_receivable', amount: 0 }],
      [],
      [{ account: 'network_receivable', amount: 10 }, { account: 'compte_bidon', amount: -10 }],
    ];
    for (const lines of bad) expect(() => ctx.ledger.post('x', null, lines)).toThrow();
    expect(count('ledger_transactions')).toBe(0);
    expect(count('ledger_entries')).toBe(0);
  });

  it('rollback complet si la transaction englobante échoue', () => {
    expect(() =>
      ctx.db.transaction(() => {
        ctx.ledger.post('capture', 'pi_r', [
          { account: 'network_receivable', amount: 100 },
          { account: 'platform_balance', amount: -100 },
        ]);
        throw new Error('échec métier après l\'écriture');
      })(),
    ).toThrow();
    expect(count('ledger_entries')).toBe(0);
  });

  it('check() détecte une écriture corrompue (insérée hors service)', () => {
    ctx.ledger.post('t', null, [
      { account: 'network_receivable', amount: 100 },
      { account: 'platform_balance', amount: -100 },
    ]);
    const txnId = ctx.db.prepare('SELECT id FROM ledger_transactions').get().id;
    ctx.db.prepare('INSERT INTO ledger_entries (txn_id, account_code, amount) VALUES (?, ?, ?)').run(txnId, 'psp_revenue', 1);
    const c = ctx.ledger.check();
    expect(c.balanced).toBe(false);
    expect(c.total).toBe(1);
    expect(c.unbalanced_transactions).toEqual([txnId]);
  });

  it('GET /v1/balance, /v1/ledger/check, /v1/ledger/transactions', async () => {
    ctx.ledger.post('capture', 'pi_1', [
      { account: 'network_receivable', amount: 2000 },
      { account: 'platform_balance', amount: -2000 },
    ]);
    ctx.ledger.post('capture', 'pi_2', [
      { account: 'network_receivable', amount: 300 },
      { account: 'platform_balance', amount: -300 },
    ]);
    const bal = await request(app).get('/v1/balance').set(auth());
    expect(bal.status).toBe(200);
    expect(bal.body).toEqual({ object: 'balance', available: [{ amount: 2300, currency: 'eur' }] });

    const chk = await request(app).get('/v1/ledger/check').set(auth());
    expect(chk.body).toMatchObject({ balanced: true, total: 0 });

    const list = await request(app).get('/v1/ledger/transactions?limit=1').set(auth());
    expect(list.body.object).toBe('list');
    expect(list.body.has_more).toBe(true);
    expect(list.body.data[0]).toMatchObject({ kind: 'capture', ref_id: 'pi_2' });
    expect(list.body.data[0].entries).toHaveLength(2);

    const byRef = await request(app).get('/v1/ledger/transactions?ref_id=pi_1').set(auth());
    expect(byRef.body.data).toHaveLength(1);
  });

  it('GET /v1/ledger/accounts (phase 6) : soldes de tous les comptes, Σ net = 0, solde nul = 0 (pas -0)', async () => {
    const A = 10000;
    const fee = computePspFee(A);
    ctx.ledger.post('capture', 'pi_t', [
      { account: 'network_receivable', amount: A },
      { account: 'platform_balance', amount: -A },
      { account: 'platform_balance', amount: fee },
      { account: 'psp_revenue', amount: -fee },
    ]);
    const r = await request(app).get('/v1/ledger/accounts').set(auth());
    expect(r.status).toBe(200);
    const byCode = Object.fromEntries(r.body.data.map((a) => [a.code, a]));
    expect(byCode.network_receivable).toMatchObject({ type: 'asset', balance: A, net: A, entries: 1 });
    expect(byCode.platform_balance).toMatchObject({ type: 'liability', balance: A - fee, entries: 2 });
    expect(byCode.psp_revenue).toMatchObject({ type: 'revenue', balance: fee });
    expect(Object.is(ctx.ledger.listAccounts().data.find((a) => a.code === 'bank_payouts').balance, 0)).toBe(true);
    expect(r.body.data.reduce((s, a) => s + a.net, 0)).toBe(0);
    for (const a of r.body.data) expect(a.balance).toBe(ctx.ledger.balanceOf(a.code));
    expect((await request(app).get('/v1/ledger/accounts').set(auth(require('./helpers').PK))).status).toBe(403);
  });
});

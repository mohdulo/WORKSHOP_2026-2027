'use strict';
const request = require('supertest');
const { makeApp, auth, PK, pmFor, createPi, countRows, createSeller, paidPi, refund } = require('./helpers');
const { computePspFee } = require('../src/lib/money');
const { computeFeeShare } = require('../src/modules/refunds/service');

const VISA = '4242424242424242';

describe('computeFeeShare (L3 : entier, arrondi au demi supérieur)', () => {
  it('identique à Math.round(F*R/A) sur une grille de valeurs', () => {
    for (const A of [1, 2, 3, 7, 999, 1000, 3333, 10000, 99999]) {
      for (const F of [0, 1, 2, 5, 333, 1000, Math.max(0, A - 1)]) {
        for (const R of [1, 2, Math.ceil(A / 3), Math.floor(A / 2) || 1, A]) {
          if (R > A) continue;
          expect(computeFeeShare(F, R, A)).toBe(Math.round((F * R) / A));
        }
      }
    }
    expect(computeFeeShare(1, 1, 2)).toBe(1); // 0,5 → 1
    expect(computeFeeShare(1000, 4000, 10000)).toBe(400);
    expect(() => computeFeeShare(1.5, 1, 2)).toThrow(RangeError);
  });
});

describe('refunds', () => {
  let app;
  let ctx;
  beforeEach(() => {
    ({ app, ctx } = makeApp());
  });
  afterEach(() => {
    // Invariant global : le grand livre reste équilibré à la fin de chaque test.
    expect(ctx.ledger.check().balanced).toBe(true);
  });

  const bal = (code) => ctx.ledger.balanceOf(code);
  const charge = (pi) => ctx.db.prepare('SELECT * FROM charges WHERE id = ?').get(pi.latest_charge);
  const snapshot = () => ({
    entries: countRows(ctx, 'ledger_entries'),
    txns: countRows(ctx, 'ledger_transactions'),
    refunds: countRows(ctx, 'refunds'),
    events: countRows(ctx, 'events'),
    charges: ctx.db.prepare('SELECT id, amount_refunded, refunded FROM charges ORDER BY seq').all(),
  });

  it('remboursement total par défaut (montant = reste remboursable) : refund, charge, ledger, événements', async () => {
    const A = 10000;
    const pi = await paidPi(app, A);
    const r = await refund(app, { payment_intent: pi.id, reason: 'requested_by_customer' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      object: 'refund', amount: A, currency: 'eur', payment_intent: pi.id, charge: pi.latest_charge, status: 'succeeded',
      reason: 'requested_by_customer', refund_application_fee: false, application_fee_refunded: 0,
    });
    expect(r.body.id).toMatch(/^re_[0-9A-Za-z]{24}$/);

    const ch = (await request(app).get(`/v1/charges/${pi.latest_charge}`).set(auth())).body;
    expect(ch).toMatchObject({ amount_captured: A, amount_refunded: A, refunded: true });

    // Dr platform_balance A ; Cr network_receivable A. Frais PSP non remboursés.
    const fee = computePspFee(A);
    expect(bal('network_receivable')).toBe(0);
    expect(bal('platform_balance')).toBe(-fee);
    expect(bal('psp_revenue')).toBe(fee);
    const txn = ctx.ledger.listTransactions({ refId: r.body.id }).data;
    expect(txn).toHaveLength(1);
    expect(txn[0].kind).toBe('refund');
    expect(txn[0].entries).toEqual([
      { account: 'platform_balance', amount: A },
      { account: 'network_receivable', amount: -A },
    ]);

    const types = ctx.db.prepare('SELECT type, data FROM events ORDER BY seq').all();
    const created = types.find((e) => e.type === 'refund.created');
    const refunded = types.find((e) => e.type === 'charge.refunded');
    expect(JSON.parse(created.data).object.id).toBe(r.body.id);
    expect(JSON.parse(refunded.data).object).toMatchObject({ id: pi.latest_charge, amount_refunded: A, refunded: true });

    // GET unitaire et liste filtrée
    expect((await request(app).get(`/v1/refunds/${r.body.id}`).set(auth())).body).toEqual(r.body);
    const list = (await request(app).get(`/v1/refunds?payment_intent=${pi.id}`).set(auth())).body;
    expect(list).toMatchObject({ object: 'list', has_more: false });
    expect(list.data.map((x) => x.id)).toEqual([r.body.id]);
  });

  it('remboursement partiel : refunded reste false, montant exact', async () => {
    const pi = await paidPi(app, 10000);
    const r = await refund(app, { payment_intent: pi.id, amount: 2500 });
    expect(r.status).toBe(200);
    expect(r.body.amount).toBe(2500);
    expect(charge(pi)).toMatchObject({ amount_refunded: 2500, refunded: 0 });
    expect(bal('network_receivable')).toBe(7500);
    expect(bal('platform_balance')).toBe(10000 - computePspFee(10000) - 2500);
  });

  it('plusieurs partiels jusqu\'au total, puis plus rien de remboursable', async () => {
    const pi = await paidPi(app, 10000);
    for (const amount of [3000, 3000, 3000]) expect((await refund(app, { payment_intent: pi.id, amount })).status).toBe(200);
    expect(charge(pi)).toMatchObject({ amount_refunded: 9000, refunded: 0 });
    // sans montant : rembourse exactement le reste (1000)
    const last = await refund(app, { payment_intent: pi.id });
    expect(last.body.amount).toBe(1000);
    expect(charge(pi)).toMatchObject({ amount_refunded: 10000, refunded: 1 });
    expect(bal('network_receivable')).toBe(0);
    // déjà intégralement remboursé → 400
    const again = await refund(app, { payment_intent: pi.id });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatchObject({ type: 'invalid_request_error', param: 'amount' });
    const list = (await request(app).get(`/v1/refunds?payment_intent=${pi.id}`).set(auth())).body;
    expect(list.data.map((x) => x.amount)).toEqual([1000, 3000, 3000, 3000]);
  });

  it('dépassement → 400 amount_too_large (param amount), AUCUNE écriture', async () => {
    const pi = await paidPi(app, 10000);
    await refund(app, { payment_intent: pi.id, amount: 6000 });
    const before = snapshot();
    const r = await refund(app, { payment_intent: pi.id, amount: 4001 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatchObject({ type: 'invalid_request_error', code: 'amount_too_large', param: 'amount' });
    expect(snapshot()).toEqual(before);
    // dépassement d'emblée (> capturé)
    const pi2 = await paidPi(app, 500);
    const before2 = snapshot();
    expect((await refund(app, { payment_intent: pi2.id, amount: 501 })).body.error.code).toBe('amount_too_large');
    expect(snapshot()).toEqual(before2);
  });

  it('borne : rembourser exactement le reste est accepté', async () => {
    const pi = await paidPi(app, 10000);
    await refund(app, { payment_intent: pi.id, amount: 6000 });
    expect((await refund(app, { payment_intent: pi.id, amount: 4000 })).status).toBe(200);
  });

  it('capture partielle : la limite est amount_captured, pas amount', async () => {
    const pi = await paidPi(app, 10000, { capture: 6000 });
    const over = await refund(app, { payment_intent: pi.id, amount: 6001 });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('amount_too_large');
    const all = await refund(app, { payment_intent: pi.id });
    expect(all.body.amount).toBe(6000);
    expect(charge(pi)).toMatchObject({ amount_captured: 6000, amount_refunded: 6000, refunded: 1 });
  });

  it('PI non capturé (requires_capture) ou sans paiement → 409 state_error, aucune écriture', async () => {
    const pm = await pmFor(app, VISA);
    const auth1 = (await createPi(app, { amount: 5000, payment_method: pm, capture_method: 'manual', confirm: true })).body;
    expect(auth1.status).toBe('requires_capture');
    const pending = (await createPi(app, { amount: 5000 })).body;
    const before = snapshot();
    for (const id of [auth1.id, pending.id]) {
      const r = await refund(app, { payment_intent: id });
      expect(r.status).toBe(409);
      expect(r.body.error.type).toBe('state_error');
    }
    // annulé → 409 aussi
    await request(app).post(`/v1/payment_intents/${auth1.id}/cancel`).set(auth()).send({});
    expect((await refund(app, { payment_intent: auth1.id })).status).toBe(409);
    expect(countRows(ctx, 'refunds')).toBe(before.refunds);
    expect(countRows(ctx, 'ledger_entries')).toBe(before.entries);
  });

  it('validation : PI inconnu, montant invalide, champ inconnu, clé publique', async () => {
    const pi = await paidPi(app, 1000);
    const unknown = await refund(app, { payment_intent: 'pi_nope' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatchObject({ code: 'resource_missing', param: 'payment_intent' });
    expect((await refund(app, { payment_intent: pi.id, amount: 0 })).body.error.param).toBe('amount');
    expect((await refund(app, { payment_intent: pi.id, amount: 10.5 })).body.error.param).toBe('amount');
    expect((await refund(app, { payment_intent: pi.id, foo: 1 })).status).toBe(400);
    expect((await refund(app, { payment_intent: pi.id, reason: 'parce_que' })).body.error.param).toBe('reason');
    // refund_application_fee sans destination → 400
    expect((await refund(app, { payment_intent: pi.id, refund_application_fee: true })).body.error.param).toBe('refund_application_fee');
    expect((await request(app).post('/v1/refunds').set(auth(PK)).send({ payment_intent: pi.id })).status).toBe(403);
    expect((await request(app).get('/v1/refunds/re_nope').set(auth())).status).toBe(404);
    expect(countRows(ctx, 'refunds')).toBe(0);
  });

  it('idempotence : deux POST avec la même clé → un seul remboursement', async () => {
    const pi = await paidPi(app, 10000);
    const a = await refund(app, { payment_intent: pi.id, amount: 1000 }, { idem: 'refund-1' });
    const b = await refund(app, { payment_intent: pi.id, amount: 1000 }, { idem: 'refund-1' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toEqual(a.body);
    expect(countRows(ctx, 'refunds')).toBe(1);
    expect(countRows(ctx, 'ledger_transactions', "kind = 'refund'")).toBe(1);
    expect(countRows(ctx, 'events', "type = 'refund.created'")).toBe(1);
    expect(charge(pi).amount_refunded).toBe(1000);
    // même clé, corps différent → 409
    expect((await refund(app, { payment_intent: pi.id, amount: 2000 }, { idem: 'refund-1' })).status).toBe(409);
  });

  describe('paiement split (destination)', () => {
    const A = 10000;
    const F = 1000;
    const fee = computePspFee(A); // 165
    let seller;
    let M;
    let pi;
    beforeEach(async () => {
      seller = await createSeller(app);
      M = `merchant:${seller}`;
      pi = await paidPi(app, A, { destination: seller, fee: F });
      expect(bal(M)).toBe(A - F); // 9000
      expect(bal('platform_balance')).toBe(F - fee); // 835
    });

    it('refund_application_fee=false : seul le vendeur est débité', async () => {
      const r = await refund(app, { payment_intent: pi.id, amount: 4000 });
      expect(r.body).toMatchObject({ refund_application_fee: false, application_fee_refunded: 0 });
      expect(bal(M)).toBe(5000);
      expect(bal('platform_balance')).toBe(835);
      expect(bal('psp_revenue')).toBe(fee);
      expect(bal('network_receivable')).toBe(6000);
      expect(ctx.ledger.listTransactions({ refId: r.body.id }).data[0].entries).toEqual([
        { account: M, amount: 4000 },
        { account: 'network_receivable', amount: -4000 },
      ]);
    });

    it('refund_application_fee=true : feeShare = round(F*R/A) rendu au vendeur par la plateforme', async () => {
      const r = await refund(app, { payment_intent: pi.id, amount: 4000, refund_application_fee: true });
      expect(r.body).toMatchObject({ refund_application_fee: true, application_fee_refunded: 400 });
      expect(bal(M)).toBe(9000 - 4000 + 400); // 5400
      expect(bal('platform_balance')).toBe(835 - 400); // 435
      expect(bal('psp_revenue')).toBe(fee); // frais PSP non remboursés
      expect(bal('network_receivable')).toBe(6000);
      expect(ctx.ledger.listTransactions({ refId: r.body.id }).data[0].entries).toEqual([
        { account: M, amount: 4000 },
        { account: 'network_receivable', amount: -4000 },
        { account: 'platform_balance', amount: 400 },
        { account: M, amount: -400 },
      ]);
    });

    it('remboursement total avec commission : vendeur 0, plateforme −fee PSP', async () => {
      await refund(app, { payment_intent: pi.id, refund_application_fee: true });
      expect(bal(M)).toBe(0);
      expect(bal('platform_balance')).toBe(-fee);
      expect(bal('network_receivable')).toBe(0);
    });

    it('solde vendeur insuffisant : remboursement accepté, solde vendeur négatif', async () => {
      await request(app).post('/v1/payouts').set(auth()).send({ account: seller, amount: 9000 });
      expect(bal(M)).toBe(0);
      const r = await refund(app, { payment_intent: pi.id, amount: 3000 });
      expect(r.status).toBe(200);
      expect(bal(M)).toBe(-3000);
      expect((await request(app).get(`/v1/accounts/${seller}/balance`).set(auth())).body.available[0].amount).toBe(-3000);
      // un payout est alors impossible
      expect((await request(app).post('/v1/payouts').set(auth()).send({ account: seller, amount: 1 })).status).toBe(402);
    });
  });

  it('feeShare cumulatif : plusieurs partiels rendent exactement F au total (pas de dérive d\'arrondi)', async () => {
    const seller = await createSeller(app);
    const M = `merchant:${seller}`;
    // A = 3, F = 1 : 3 × round(1/3) donnerait 0 ; l'arrondi cumulatif donne 0, 1, 0 → total 1 = F.
    const pi = await paidPi(app, 3, { destination: seller, fee: 1 });
    const shares = [];
    for (let i = 0; i < 3; i += 1) {
      shares.push((await refund(app, { payment_intent: pi.id, amount: 1, refund_application_fee: true })).body.application_fee_refunded);
    }
    expect(shares).toEqual([0, 1, 0]);
    expect(bal(M)).toBe(0);
    // A = 10000, F = 1000 : partiels 3333 + 3333 + 3334 → 333 + 334 + 333 = 1000
    const pi2 = await paidPi(app, 10000, { destination: seller, fee: 1000 });
    const s2 = [];
    for (const amount of [3333, 3333, 3334]) s2.push((await refund(app, { payment_intent: pi2.id, amount, refund_application_fee: true })).body.application_fee_refunded);
    expect(s2).toEqual([333, 334, 333]);
    expect(s2.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(bal(M)).toBe(0);
  });

  it('mélange avec et sans restitution de commission : seuls les remboursements flaggés comptent', async () => {
    const seller = await createSeller(app);
    const M = `merchant:${seller}`;
    const pi = await paidPi(app, 10000, { destination: seller, fee: 1000 });
    expect((await refund(app, { payment_intent: pi.id, amount: 5000 })).body.application_fee_refunded).toBe(0);
    expect((await refund(app, { payment_intent: pi.id, amount: 5000, refund_application_fee: true })).body.application_fee_refunded).toBe(500);
    expect(bal(M)).toBe(9000 - 10000 + 500);
    expect(bal('platform_balance')).toBe(1000 - computePspFee(10000) - 500);
  });
});

describe('migration : charges.refunded ajoutée à une base de phase 2 existante', () => {
  it('ALTER TABLE additive et idempotente', () => {
    const Database = require('better-sqlite3');
    const { migrate } = require('../src/db');
    const db = new Database(':memory:');
    // table charges telle que créée en phase 2 (sans `refunded`)
    db.exec(`CREATE TABLE charges (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, payment_intent_id TEXT NOT NULL,
      payment_method_id TEXT NOT NULL, customer_id TEXT, amount INTEGER NOT NULL, amount_captured INTEGER NOT NULL DEFAULT 0,
      amount_refunded INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL, status TEXT NOT NULL, captured INTEGER NOT NULL DEFAULT 0,
      failure_code TEXT, decline_code TEXT, failure_message TEXT, outcome TEXT NOT NULL, three_d_secure TEXT, created INTEGER NOT NULL)`);
    const cols = () => db.prepare('PRAGMA table_info(charges)').all().map((c) => c.name);
    expect(cols()).not.toContain('refunded');
    migrate(db);
    expect(cols()).toContain('refunded');
    migrate(db); // relancer ne casse rien
    expect(cols().filter((c) => c === 'refunded')).toHaveLength(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('refunds', 'transfers', 'payouts') ORDER BY name").all().map((r) => r.name)).toEqual(['payouts', 'refunds', 'transfers']);
    db.close();
  });
});

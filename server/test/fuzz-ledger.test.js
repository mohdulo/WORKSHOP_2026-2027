'use strict';
const request = require('supertest');
const { makeApp, auth, pmFor, createSeller } = require('./helpers');
const { computePspFee } = require('../src/lib/money');
const { computeFeeShare } = require('../src/modules/refunds/service');

/** PRNG déterministe (mulberry32) : même graine → même séquence d'opérations. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20261019;
const OPERATIONS = 200;

/**
 * Fuzz déterministe : ~200 opérations aléatoires via l'API (paiements auto/manuels, captures partielles, split,
 * remboursements avec/sans commission, transferts, payouts), y compris des demandes volontairement excessives.
 * Un MODÈLE indépendant (calcul attendu à la main) prédit chaque acceptation/refus et chaque solde.
 */
describe(`fuzz ledger (graine ${SEED}, ${OPERATIONS} opérations)`, () => {
  it('ledger équilibré, jamais de remboursement > capturé, jamais de payout rendant un solde négatif, soldes = modèle', async () => {
    const { app, ctx } = makeApp();
    const rnd = mulberry32(SEED);
    const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

    const pm = await pmFor(app, '4242424242424242');
    const sellers = [];
    for (let i = 0; i < 3; i += 1) sellers.push(await createSeller(app));

    // Modèle
    const model = { platform: 0, psp: 0, receivable: 0, bank: 0, merchant: Object.fromEntries(sellers.map((s) => [s, 0])) };
    const paid = []; // { id, A, F, dest, refunded, flaggedRefunded, feeRefunded }
    const stats = { payments: 0, captures_partielles: 0, refunds: 0, refunds_refuses: 0, transfers: 0, transfers_refuses: 0, payouts: 0, payouts_refuses: 0 };

    const post = (path, body) => request(app).post(path).set(auth()).send(body);

    for (let op = 0; op < OPERATIONS; op += 1) {
      const kind = pick(['payment', 'payment', 'payment', 'refund', 'refund', 'transfer', 'payout', 'payout']);
      const ctxMsg = `op #${op} (${kind})`;

      if (kind === 'payment' || paid.length === 0) {
        const amount = int(50, 50000);
        const split = rnd() < 0.6;
        const manual = rnd() < 0.4;
        const body = { amount, currency: 'eur', payment_method: pm, confirm: true, capture_method: manual ? 'manual' : 'automatic' };
        let F = 0;
        let dest = null;
        if (split) {
          dest = pick(sellers);
          F = int(0, Math.min(amount - 1, Math.floor(amount / 4)));
          body.transfer_data = { destination: dest };
          body.application_fee_amount = F;
        }
        let res = await post('/v1/payment_intents', body);
        expect(res.status, ctxMsg).toBe(200);
        let A = amount;
        if (manual) {
          expect(res.body.status).toBe('requires_capture');
          A = int(F + 1, amount); // capture partielle (> commission, cf. PLAN §4.5)
          if (A < amount) stats.captures_partielles += 1;
          res = await post(`/v1/payment_intents/${res.body.id}/capture`, { amount_to_capture: A });
          expect(res.status, ctxMsg).toBe(200);
        }
        expect(res.body.status).toBe('succeeded');
        const fee = computePspFee(A);
        model.receivable += A;
        model.psp += fee;
        model.platform += (dest ? F : A) - fee;
        if (dest) model.merchant[dest] += A - F;
        paid.push({ id: res.body.id, charge: res.body.latest_charge, A, F, dest, refunded: 0, flaggedRefunded: 0, feeRefunded: 0 });
        stats.payments += 1;
      } else if (kind === 'refund') {
        const p = pick(paid);
        const remaining = p.A - p.refunded;
        // parfois le reste exact, parfois un dépassement volontaire, parfois montant par défaut
        const mode = rnd();
        const amount = mode < 0.2 ? undefined : mode < 0.35 ? remaining + int(1, 500) : int(1, Math.max(1, remaining));
        const flag = p.dest ? rnd() < 0.5 : false;
        const body = { payment_intent: p.id };
        if (amount !== undefined) body.amount = amount;
        if (flag) body.refund_application_fee = true;
        const res = await post('/v1/refunds', body);
        const R = amount === undefined ? remaining : amount;
        if (remaining <= 0 || R > remaining) {
          expect(res.status, ctxMsg).toBe(400);
          expect(res.body.error.param).toBe('amount');
          stats.refunds_refuses += 1;
        } else {
          expect(res.status, `${ctxMsg} ${JSON.stringify(res.body)}`).toBe(200);
          let share = 0;
          if (flag) {
            share = computeFeeShare(p.F, p.flaggedRefunded + R, p.A) - p.feeRefunded;
            p.flaggedRefunded += R;
            p.feeRefunded += share;
          }
          expect(res.body.amount).toBe(R);
          expect(res.body.application_fee_refunded, ctxMsg).toBe(share);
          p.refunded += R;
          model.receivable -= R;
          if (p.dest) {
            model.merchant[p.dest] += share - R;
            model.platform -= share;
          } else {
            model.platform -= R;
          }
          stats.refunds += 1;
        }
      } else if (kind === 'transfer') {
        const dest = pick(sellers);
        const amount = rnd() < 0.3 ? Math.max(1, model.platform + int(1, 1000)) : int(1, Math.max(1, Math.floor(Math.max(model.platform, 1) / 3)));
        const res = await post('/v1/transfers', { amount, destination: dest });
        if (amount > model.platform) {
          expect(res.status, ctxMsg).toBe(402);
          expect(res.body.error.code).toBe('insufficient_balance');
          stats.transfers_refuses += 1;
        } else {
          expect(res.status, ctxMsg).toBe(200);
          model.platform -= amount;
          model.merchant[dest] += amount;
          stats.transfers += 1;
        }
      } else {
        const acct = pick(sellers);
        const available = model.merchant[acct];
        const amount = rnd() < 0.35 ? Math.max(1, available + int(1, 1000)) : int(1, Math.max(1, available));
        const res = await post('/v1/payouts', { account: acct, amount });
        if (amount > available) {
          expect(res.status, ctxMsg).toBe(402);
          expect(res.body.error.code).toBe('insufficient_balance');
          stats.payouts_refuses += 1;
        } else {
          expect(res.status, ctxMsg).toBe(200);
          model.merchant[acct] -= amount;
          model.bank += amount;
          expect(ctx.ledger.balanceOf(`merchant:${acct}`), ctxMsg).toBeGreaterThanOrEqual(0); // un payout ne rend jamais un solde négatif
          stats.payouts += 1;
        }
      }

      // Invariant à chaque pas
      expect(ctx.ledger.check().balanced, ctxMsg).toBe(true);
    }

    // ---- invariants finaux ----
    expect(ctx.ledger.check()).toMatchObject({ balanced: true, total: 0 });

    // Jamais de remboursement au-delà du capturé (en base, pas seulement dans le modèle)
    const overRefunded = ctx.db
      .prepare(`SELECT c.id FROM charges c LEFT JOIN (SELECT charge_id, SUM(amount) AS s FROM refunds GROUP BY charge_id) r ON r.charge_id = c.id
        WHERE c.amount_refunded > c.amount_captured OR COALESCE(r.s, 0) <> c.amount_refunded
           OR c.refunded <> (CASE WHEN c.amount_captured > 0 AND c.amount_refunded = c.amount_captured THEN 1 ELSE 0 END)`)
      .all();
    expect(overRefunded).toEqual([]);
    // Commission rendue ≤ commission perçue, par charge
    const feeOver = ctx.db
      .prepare(`SELECT pi.id FROM payment_intents pi JOIN refunds r ON r.payment_intent_id = pi.id
        GROUP BY pi.id HAVING SUM(r.application_fee_refunded) > COALESCE(MAX(pi.application_fee_amount), 0)`)
      .all();
    expect(feeOver).toEqual([]);

    // Payouts : montants positifs, cumul = bank_payouts
    const payoutsTotal = ctx.db.prepare('SELECT COALESCE(SUM(amount), 0) AS s, COALESCE(MIN(amount), 1) AS m FROM payouts').get();
    expect(payoutsTotal.m).toBeGreaterThan(0);
    expect(ctx.ledger.balanceOf('bank_payouts')).toBe(payoutsTotal.s);
    expect(ctx.ledger.balanceOf('bank_payouts')).toBeGreaterThanOrEqual(0);

    // Soldes = modèle
    expect(ctx.ledger.balanceOf('platform_balance')).toBe(model.platform);
    expect(ctx.ledger.balanceOf('psp_revenue')).toBe(model.psp);
    expect(ctx.ledger.balanceOf('network_receivable')).toBe(model.receivable);
    expect(ctx.ledger.balanceOf('bank_payouts')).toBe(model.bank);
    for (const s of sellers) expect(ctx.ledger.balanceOf(`merchant:${s}`)).toBe(model.merchant[s]);

    // La séquence a bien exercé chaque branche (sinon le fuzz ne prouve rien)
    for (const [k, v] of Object.entries(stats)) expect(v, `branche non exercée : ${k}`).toBeGreaterThan(0);
  }, 60000);
});

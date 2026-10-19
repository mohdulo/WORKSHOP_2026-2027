'use strict';
const { makeApp, auth, pmFor, tokenize, createPi } = require('./helpers');
const { createNetwork, TEST_CARDS } = require('../src/modules/network/service');

describe('network — simulateur (unitaire)', () => {
  const net = createNetwork();

  it('table des cartes de test exactement conforme à PLAN §4.3', () => {
    expect(Object.keys(TEST_CARDS).sort()).toEqual(
      ['4242424242424242', '5555555555554444', '4000000000000002', '4000000000009995', '4000000000000069', '4000000000000127', '4000000000003220', '4000000000000341'].sort(),
    );
  });

  it('autorisations', () => {
    expect(net.authorize({ pan: '4242424242424242', amount: 100 })).toEqual({ approved: true });
    expect(net.authorize({ pan: '4000000000000002', amount: 100 })).toMatchObject({ approved: false, decline_code: 'card_declined' });
    expect(net.authorize({ pan: '4000000000003220', amount: 100 })).toEqual({ approved: false, requires_3ds: true });
    expect(net.authorize({ pan: '4000000000003220', amount: 100, threeDsCompleted: true })).toEqual({ approved: true });
    expect(net.authorize({ pan: '4000000000003220', amount: 100, offSession: true })).toMatchObject({ decline_code: 'authentication_required' });
    expect(net.authorize({ pan: '4242424242424242', amount: 1000000 })).toMatchObject({ decline_code: 'amount_too_large' });
    expect(net.authorize({ pan: '4242424242424242', amount: 999999 })).toEqual({ approved: true });
    expect(net.checkCvc('4000000000000127', '123')).toBe('fail');
    expect(net.checkCvc('4242424242424242', '123')).toBe('pass');
  });
});

/**
 * Chaque carte de test, de bout en bout via l'API (tokenisation pk → PI sk avec confirm:true).
 * decline_code = code de la table PLAN §4.3 ; code = code d'erreur API.
 */
const CASES = [
  { pan: '4242424242424242', status: 'succeeded', brand: 'visa' },
  { pan: '5555555555554444', status: 'succeeded', brand: 'mastercard' },
  { pan: '4000000000000002', decline: 'card_declined', code: 'card_declined' },
  { pan: '4000000000009995', decline: 'insufficient_funds', code: 'card_declined' },
  { pan: '4000000000000069', decline: 'expired_card', code: 'expired_card' },
  { pan: '4000000000000127', decline: 'incorrect_cvc', code: 'incorrect_cvc', cvcCheck: 'fail' },
  { pan: '4000000000003220', status: 'requires_action' },
  { pan: '4000000000003220', offSession: true, decline: 'authentication_required', code: 'card_declined' },
  { pan: '4000000000000341', decline: 'card_declined', code: 'card_declined' },
  { pan: '4111111111111111', status: 'succeeded', brand: 'visa' }, // toute autre carte valide
  { pan: '378282246310005', status: 'succeeded', brand: 'amex', cvc: '1234' },
  { pan: '4242424242424242', amount: 1000000, decline: 'amount_too_large', code: 'amount_too_large' },
];

describe('network — chaque carte de test via l\'API', () => {
  let app;
  let ctx;
  beforeEach(() => {
    ({ app, ctx } = makeApp());
  });

  for (const c of CASES) {
    const label = `${c.pan}${c.offSession ? ' off_session' : ''}${c.amount ? ` amount=${c.amount}` : ''} → ${c.status || `refus ${c.decline}`}`;
    it(label, async () => {
      const tok = await tokenize(app, c.pan, { cvc: c.cvc || '123' });
      expect(tok.status).toBe(200); // tokenisation toujours OK (y compris 0341 et 0127)
      expect(tok.body.card.cvc_check).toBe(c.cvcCheck || 'pass');
      if (c.brand) expect(tok.body.card.brand).toBe(c.brand);

      const res = await createPi(app, { amount: c.amount || 2000, payment_method: tok.body.id, confirm: true, off_session: Boolean(c.offSession) });
      if (c.status) {
        expect(res.status).toBe(200);
        expect(res.body.status).toBe(c.status);
        if (c.status === 'requires_action') expect(res.body.next_action).toMatchObject({ type: 'three_d_secure', challenge_id: expect.stringMatching(/^tds_/) });
      } else {
        expect(res.status).toBe(402);
        expect(res.body.error).toMatchObject({ type: 'card_error', code: c.code, decline_code: c.decline });
        expect(res.body.error.payment_intent).toMatchObject({
          status: 'requires_payment_method',
          payment_method: null,
          last_payment_error: { type: 'card_error', code: c.code, decline_code: c.decline },
        });
        const charge = ctx.db.prepare('SELECT * FROM charges WHERE payment_intent_id = ?').get(res.body.error.payment_intent.id);
        expect(charge).toMatchObject({ status: 'failed', decline_code: c.decline });
        expect(ctx.ledger.check().entries).toBe(0);
      }
    });
  }

  it('0341 : la carte rattachée à un client est refusée aussi en off_session', async () => {
    const pm = await pmFor(app, '4000000000000341');
    const res = await createPi(app, { amount: 990, payment_method: pm, confirm: true, off_session: true });
    expect(res.status).toBe(402);
    expect(res.body.error.decline_code).toBe('card_declined');
  });
});

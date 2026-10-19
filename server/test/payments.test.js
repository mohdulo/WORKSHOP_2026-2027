'use strict';
const request = require('supertest');
const { makeApp, auth, SK, PK, pmFor, createPi, confirmPi, insertAccount, countRows } = require('./helpers');
const { computePspFee } = require('../src/lib/money');
const { TRANSITIONS, ACTIONS, canTransition } = require('../src/modules/payments/service');

const VISA = '4242424242424242';
const THREE_DS = '4000000000003220';
const DECLINE = '4000000000000002';
const DAY = 24 * 3600;

describe('payments — machine à états (table)', () => {
  it('états terminaux sans sortie ; transitions clés', () => {
    expect(TRANSITIONS.succeeded).toEqual([]);
    expect(TRANSITIONS.canceled).toEqual([]);
    expect(canTransition('requires_capture', 'succeeded')).toBe(true);
    expect(canTransition('succeeded', 'canceled')).toBe(false);
    expect(canTransition('requires_payment_method', 'succeeded')).toBe(false);
    expect(ACTIONS.capture).toEqual(['requires_capture']);
    // toute action n'est permise que depuis un statut ayant au moins une transition
    for (const statuses of Object.values(ACTIONS)) for (const s of statuses) expect(TRANSITIONS[s].length).toBeGreaterThan(0);
  });
});

describe('payment intents', () => {
  let app;
  let ctx;
  beforeEach(() => {
    ({ app, ctx } = makeApp());
  });

  const ledgerTxns = (piId) => countRows(ctx, 'ledger_transactions', 'ref_id = ?', piId);
  const eventTypes = () => ctx.db.prepare('SELECT type FROM events ORDER BY seq').all().map((e) => e.type);

  it('création : client_secret au bon format, statut selon payment_method, événement', async () => {
    const r = await createPi(app, { amount: 1500 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ object: 'payment_intent', amount: 1500, currency: 'eur', status: 'requires_payment_method', capture_method: 'automatic' });
    expect(r.body.client_secret).toMatch(new RegExp(`^${r.body.id}_secret_[A-Za-z0-9_-]{20,}$`));
    const pm = await pmFor(app, VISA);
    expect((await createPi(app, { amount: 1500, payment_method: pm })).body.status).toBe('requires_confirmation');
    // l'événement ne transporte pas le client_secret
    const evt = ctx.events.list({ type: 'payment_intent.created' }).data[0];
    expect(evt.data.object.client_secret).toBeUndefined();
  });

  it('validation de la création', async () => {
    expect((await createPi(app, { amount: 10.5 })).body.error.param).toBe('amount');
    expect((await createPi(app, { amount: 0 })).body.error.param).toBe('amount');
    expect((await createPi(app, { amount: 100, currency: 'usd' })).body.error.param).toBe('currency');
    expect((await createPi(app, { amount: 100, customer: 'cus_nope' })).body.error.param).toBe('customer');
    expect((await createPi(app, { amount: 100, payment_method: 'pm_nope' })).body.error.param).toBe('payment_method');
    expect((await createPi(app, { amount: 100 }, { key: PK })).status).toBe(403);
  });

  it('flux automatique : create + confirm → succeeded, charge, ledger équilibré, solde = amount − fee', async () => {
    const A = 10000;
    const pm = await pmFor(app, VISA);
    const pi = (await createPi(app, { amount: A })).body;
    expect(ledgerTxns(pi.id)).toBe(0);
    const r = await confirmPi(app, pi.id, { payment_method: pm });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'succeeded', amount_received: A, amount_capturable: 0, payment_method: pm, last_payment_error: null });
    expect(r.body.latest_charge).toMatch(/^ch_/);

    const ch = await request(app).get(`/v1/charges/${r.body.latest_charge}`).set(auth());
    expect(ch.body).toMatchObject({ status: 'succeeded', captured: true, amount: A, amount_captured: A, amount_refunded: 0, payment_intent: pi.id });
    expect(ch.body.payment_method_details.card).toMatchObject({ brand: 'visa', last4: '4242' });

    const fee = computePspFee(A);
    expect(fee).toBe(165);
    expect((await request(app).get('/v1/balance').set(auth())).body.available[0].amount).toBe(A - fee);
    expect(ctx.ledger.balanceOf('psp_revenue')).toBe(fee);
    expect(ctx.ledger.balanceOf('network_receivable')).toBe(A);
    expect((await request(app).get('/v1/ledger/check').set(auth())).body).toMatchObject({ balanced: true, total: 0 });
    expect(ledgerTxns(pi.id)).toBe(1);
    expect(eventTypes()).toEqual(expect.arrayContaining(['payment_intent.created', 'charge.succeeded', 'charge.captured', 'payment_intent.succeeded']));
  });

  it('flux manuel : requires_capture → capture partielle → succeeded ; ledger seulement à la capture', async () => {
    const pm = await pmFor(app, VISA);
    const r = await createPi(app, { amount: 5000, payment_method: pm, capture_method: 'manual', confirm: true });
    expect(r.body).toMatchObject({ status: 'requires_capture', amount_capturable: 5000, amount_received: 0 });
    expect(countRows(ctx, 'ledger_transactions')).toBe(0);
    expect(countRows(ctx, 'ledger_entries')).toBe(0);
    expect(eventTypes()).toContain('payment_intent.amount_capturable_updated');

    // au-delà du montant autorisé → 400
    const over = await request(app).post(`/v1/payment_intents/${r.body.id}/capture`).set(auth()).send({ amount_to_capture: 5001 });
    expect(over.status).toBe(400);
    expect(over.body.error.param).toBe('amount_to_capture');

    const cap = await request(app).post(`/v1/payment_intents/${r.body.id}/capture`).set(auth()).send({ amount_to_capture: 3000 });
    expect(cap.status).toBe(200);
    expect(cap.body).toMatchObject({ status: 'succeeded', amount_received: 3000, amount_capturable: 0 });
    const charge = ctx.db.prepare('SELECT * FROM charges WHERE id = ?').get(cap.body.latest_charge);
    expect(charge).toMatchObject({ amount: 5000, amount_captured: 3000, captured: 1 });
    expect(ctx.ledger.balanceOf('platform_balance')).toBe(3000 - computePspFee(3000));
    expect(ctx.ledger.balanceOf('network_receivable')).toBe(3000);
    expect(ctx.ledger.check().balanced).toBe(true);
  });

  it('capture totale par défaut (sans amount_to_capture)', async () => {
    const pm = await pmFor(app, VISA);
    const r = await createPi(app, { amount: 4200, payment_method: pm, capture_method: 'manual', confirm: true });
    const cap = await request(app).post(`/v1/payment_intents/${r.body.id}/capture`).set(auth()).send({});
    expect(cap.body).toMatchObject({ status: 'succeeded', amount_received: 4200 });
  });

  it('3DS : requires_action → approve (pk + client_secret) → succeeded', async () => {
    const pm = await pmFor(app, THREE_DS);
    const pi = (await createPi(app, { amount: 2500, payment_method: pm })).body;
    const c = await confirmPi(app, pi.id, { client_secret: pi.client_secret }, { key: PK });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('requires_action');
    const challenge = c.body.next_action.challenge_id;
    expect(countRows(ctx, 'charges')).toBe(0); // pas encore d'autorisation
    expect(countRows(ctx, 'three_ds_challenges', "status = 'pending'")).toBe(1);

    // sans client_secret / mauvais secret → refusé
    expect((await request(app).post(`/v1/three_ds/${challenge}/complete`).set(auth(PK)).send({ result: 'approve' })).status).toBe(400);
    expect((await request(app).post(`/v1/three_ds/${challenge}/complete`).set(auth(PK)).send({ result: 'approve', client_secret: `${pi.id}_secret_faux` })).status).toBe(404);

    const done = await request(app).post(`/v1/three_ds/${challenge}/complete`).set(auth(PK)).send({ result: 'approve', client_secret: pi.client_secret });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'succeeded', next_action: null, amount_received: 2500 });
    expect(ctx.db.prepare('SELECT three_d_secure FROM charges WHERE id = ?').get(done.body.latest_charge).three_d_secure).toBe('authenticated');
    expect(ctx.ledger.check().balanced).toBe(true);

    // challenge déjà complété → 409
    const again = await request(app).post(`/v1/three_ds/${challenge}/complete`).set(auth(PK)).send({ result: 'approve', client_secret: pi.client_secret });
    expect(again.status).toBe(409);
    expect(again.body.error.type).toBe('state_error');
  });

  it('3DS + capture manuelle : approve → requires_capture', async () => {
    const pm = await pmFor(app, THREE_DS);
    const pi = (await createPi(app, { amount: 2500, payment_method: pm, capture_method: 'manual', confirm: true })).body;
    const done = await request(app).post(`/v1/three_ds/${pi.next_action.challenge_id}/complete`).set(auth(PK)).send({ result: 'approve', client_secret: pi.client_secret });
    expect(done.body.status).toBe('requires_capture');
    expect(countRows(ctx, 'ledger_entries')).toBe(0);
  });

  it('3DS : deny → requires_payment_method (402 card_error), puis retry avec la carte 4242 → succeeded', async () => {
    const pm = await pmFor(app, THREE_DS);
    const pi = (await createPi(app, { amount: 2500, payment_method: pm, confirm: true })).body;
    const deny = await request(app).post(`/v1/three_ds/${pi.next_action.challenge_id}/complete`).set(auth(PK)).send({ result: 'deny', client_secret: pi.client_secret });
    expect(deny.status).toBe(402);
    expect(deny.body.error).toMatchObject({ type: 'card_error', code: 'payment_intent_authentication_failure' });
    expect(deny.body.error.payment_intent).toMatchObject({ status: 'requires_payment_method', next_action: null, payment_method: null });
    expect(ctx.db.prepare('SELECT status FROM three_ds_challenges').get().status).toBe('denied');

    const pm2 = await pmFor(app, VISA);
    const retry = await confirmPi(app, pi.id, { payment_method: pm2 });
    expect(retry.body).toMatchObject({ status: 'succeeded', last_payment_error: null });
  });

  it('3DS off_session → refus authentication_required', async () => {
    const pm = await pmFor(app, THREE_DS);
    const r = await createPi(app, { amount: 2500, payment_method: pm, confirm: true, off_session: true });
    expect(r.status).toBe(402);
    expect(r.body.error.decline_code).toBe('authentication_required');
    expect(r.body.error.payment_intent.status).toBe('requires_payment_method');
    expect(countRows(ctx, 'three_ds_challenges')).toBe(0);
  });

  it('retry après refus avec une autre carte → succeeded ; 2 charges (failed puis succeeded)', async () => {
    const bad = await pmFor(app, DECLINE);
    const pi = (await createPi(app, { amount: 3000 })).body;
    const r1 = await confirmPi(app, pi.id, { payment_method: bad });
    expect(r1.status).toBe(402);
    expect(r1.body.error.payment_intent.last_payment_error).toMatchObject({ type: 'card_error', code: 'card_declined', decline_code: 'card_declined', message: expect.any(String) });
    expect((await request(app).get(`/v1/payment_intents/${pi.id}`).set(auth())).body.status).toBe('requires_payment_method');
    // confirm sans moyen de paiement après refus → 400
    expect((await confirmPi(app, pi.id, {})).body.error.param).toBe('payment_method');

    const good = await pmFor(app, VISA);
    const r2 = await confirmPi(app, pi.id, { payment_method: good });
    expect(r2.status).toBe(200);
    expect(r2.body.status).toBe('succeeded');
    const charges = (await request(app).get(`/v1/charges?payment_intent=${pi.id}`).set(auth())).body.data;
    expect(charges.map((c) => c.status)).toEqual(['succeeded', 'failed']);
    expect(eventTypes()).toEqual(expect.arrayContaining(['charge.failed', 'payment_intent.payment_failed']));
  });

  it('transitions invalides → 409 state_error', async () => {
    const pm = await pmFor(app, VISA);
    const done = (await createPi(app, { amount: 1000, payment_method: pm, confirm: true })).body;
    expect(done.status).toBe('succeeded');
    const expect409 = (res) => {
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ type: 'state_error', code: 'payment_intent_unexpected_state' });
    };
    expect409(await request(app).post(`/v1/payment_intents/${done.id}/capture`).set(auth()).send({}));
    expect409(await confirmPi(app, done.id, {}));
    expect409(await request(app).post(`/v1/payment_intents/${done.id}/cancel`).set(auth()).send({}));

    const canceled = (await createPi(app, { amount: 1000 })).body;
    await request(app).post(`/v1/payment_intents/${canceled.id}/cancel`).set(auth()).send({ cancellation_reason: 'abandoned' }).expect(200);
    expect409(await confirmPi(app, canceled.id, { payment_method: pm }));
    expect409(await request(app).post(`/v1/payment_intents/${canceled.id}/cancel`).set(auth()).send({}));

    const fresh = (await createPi(app, { amount: 1000, payment_method: pm })).body;
    expect409(await request(app).post(`/v1/payment_intents/${fresh.id}/capture`).set(auth()).send({}));

    const tds = (await createPi(app, { amount: 1000, payment_method: await pmFor(app, THREE_DS), confirm: true })).body;
    expect409(await confirmPi(app, tds.id, {})); // requires_action : il faut terminer le challenge
    expect(countRows(ctx, 'ledger_transactions')).toBe(1);
  });

  it('cancel depuis requires_capture → canceled, aucune écriture ledger ; challenge 3DS annulé', async () => {
    const pm = await pmFor(app, VISA);
    const pi = (await createPi(app, { amount: 8000, payment_method: pm, capture_method: 'manual', confirm: true })).body;
    const c = await request(app).post(`/v1/payment_intents/${pi.id}/cancel`).set(auth()).send({ cancellation_reason: 'requested_by_customer' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'canceled', amount_capturable: 0, cancellation_reason: 'requested_by_customer', canceled_at: ctx.clock.now() });
    expect(countRows(ctx, 'ledger_entries')).toBe(0);
    expect(eventTypes()).toContain('payment_intent.canceled');

    const tds = (await createPi(app, { amount: 1000, payment_method: await pmFor(app, THREE_DS), confirm: true })).body;
    await request(app).post(`/v1/payment_intents/${tds.id}/cancel`).set(auth()).send({}).expect(200);
    expect(ctx.db.prepare('SELECT status FROM three_ds_challenges').get().status).toBe('canceled');
    const late = await request(app).post(`/v1/three_ds/${tds.next_action.challenge_id}/complete`).set(auth(PK)).send({ result: 'approve', client_secret: tds.client_secret });
    expect(late.status).toBe(409);
  });

  it('expiration : 7 j exactement → rien ; 7 j + 1 s → canceled (expired), sans ledger', async () => {
    const pm = await pmFor(app, VISA);
    const pi = (await createPi(app, { amount: 6000, payment_method: pm, capture_method: 'manual', confirm: true })).body;
    const keep = (await createPi(app, { amount: 6000, payment_method: pm, capture_method: 'manual', confirm: true })).body;
    await request(app).post(`/v1/payment_intents/${keep.id}/capture`).set(auth()).send({}).expect(200);

    ctx.clock.advance(7 * DAY);
    expect(ctx.payments.expireAuthorizations(ctx.clock.now())).toEqual([]);
    ctx.clock.advance(1);
    expect(ctx.payments.expireAuthorizations(ctx.clock.now())).toEqual([pi.id]);

    const got = (await request(app).get(`/v1/payment_intents/${pi.id}`).set(auth())).body;
    expect(got).toMatchObject({ status: 'canceled', cancellation_reason: 'expired', amount_capturable: 0 });
    expect((await request(app).get(`/v1/payment_intents/${keep.id}`).set(auth())).body.status).toBe('succeeded');
    expect(ledgerTxns(pi.id)).toBe(0);
    expect(ctx.ledger.check().balanced).toBe(true);
    // idempotent : un 2e passage n'expire rien ; la capture devient impossible
    expect(ctx.payments.expireAuthorizations(ctx.clock.now())).toEqual([]);
    expect((await request(app).post(`/v1/payment_intents/${pi.id}/capture`).set(auth()).send({})).status).toBe(409);
  });

  it('split : destination + application_fee_amount → écritures §4.1, ledger équilibré', async () => {
    const acct = insertAccount(ctx);
    const pm = await pmFor(app, VISA);
    const A = 10000;
    const F = 1000;
    const r = await createPi(app, { amount: A, payment_method: pm, confirm: true, application_fee_amount: F, transfer_data: { destination: acct } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'succeeded', application_fee_amount: F, transfer_data: { destination: acct } });

    const fee = computePspFee(A);
    const txn = (await request(app).get(`/v1/ledger/transactions?ref_id=${r.body.id}`).set(auth())).body.data[0];
    expect(txn.kind).toBe('capture');
    expect(txn.entries).toEqual([
      { account: 'network_receivable', amount: A },
      { account: `merchant:${acct}`, amount: -(A - F) },
      { account: 'platform_balance', amount: -F },
      { account: 'platform_balance', amount: fee },
      { account: 'psp_revenue', amount: -fee },
    ]);
    expect(ctx.ledger.balanceOf(`merchant:${acct}`)).toBe(A - F);
    expect(ctx.ledger.balanceOf('platform_balance')).toBe(F - fee);
    expect((await request(app).get('/v1/ledger/check').set(auth())).body).toMatchObject({ balanced: true, total: 0 });
  });

  it('split partiel : capture manuelle partielle avec destination', async () => {
    const acct = insertAccount(ctx);
    const pm = await pmFor(app, VISA);
    const pi = (await createPi(app, { amount: 10000, payment_method: pm, capture_method: 'manual', confirm: true, application_fee_amount: 500, transfer_data: { destination: acct } })).body;
    // capture <= fee → 400
    expect((await request(app).post(`/v1/payment_intents/${pi.id}/capture`).set(auth()).send({ amount_to_capture: 500 })).status).toBe(400);
    await request(app).post(`/v1/payment_intents/${pi.id}/capture`).set(auth()).send({ amount_to_capture: 4000 }).expect(200);
    expect(ctx.ledger.balanceOf(`merchant:${acct}`)).toBe(3500);
    expect(ctx.ledger.check().balanced).toBe(true);
  });

  it('split : validations (fee >= amount, destination inconnue/désactivée, fee sans destination)', async () => {
    const acct = insertAccount(ctx);
    const off = insertAccount(ctx, { status: 'disabled' });
    const e = async (body) => (await createPi(app, { amount: 1000, ...body })).body.error;
    expect(await e({ application_fee_amount: 1000, transfer_data: { destination: acct } })).toMatchObject({ param: 'application_fee_amount' });
    expect(await e({ application_fee_amount: 10, transfer_data: { destination: 'acct_inconnu' } })).toMatchObject({ param: 'transfer_data.destination', code: 'resource_missing' });
    expect(await e({ transfer_data: { destination: off } })).toMatchObject({ param: 'transfer_data.destination', code: 'account_disabled' });
    expect(await e({ application_fee_amount: 10 })).toMatchObject({ param: 'application_fee_amount' });
    // destination sans commission : accepté (fee = 0)
    expect((await createPi(app, { amount: 1000, transfer_data: { destination: acct } })).body.application_fee_amount).toBe(0);
  });

  it('idempotence : deux confirm avec la même Idempotency-Key → une seule charge, réponse rejouée', async () => {
    const pm = await pmFor(app, VISA);
    const pi = (await createPi(app, { amount: 2000, payment_method: pm, capture_method: 'manual' })).body;
    const r1 = await confirmPi(app, pi.id, {}, { idem: 'confirm-1' });
    const r2 = await confirmPi(app, pi.id, {}, { idem: 'confirm-1' });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.body).toEqual(r1.body);
    expect(countRows(ctx, 'charges', 'payment_intent_id = ?', pi.id)).toBe(1);
    // sans la clé, un 2e confirm est une transition invalide
    expect((await confirmPi(app, pi.id, {})).status).toBe(409);
  });

  it('idempotence : un refus 402 est rejoué aussi, sans nouvelle charge', async () => {
    const pm = await pmFor(app, DECLINE);
    const r1 = await createPi(app, { amount: 2000, payment_method: pm, confirm: true }, { idem: 'create-decline' });
    const r2 = await createPi(app, { amount: 2000, payment_method: pm, confirm: true }, { idem: 'create-decline' });
    expect(r1.status).toBe(402);
    expect(r2.status).toBe(402);
    expect(r2.body).toEqual(r1.body);
    expect(countRows(ctx, 'payment_intents')).toBe(1);
    expect(countRows(ctx, 'charges')).toBe(1);
  });

  it('confirm avec pk : client_secret absent → 400, faux → 404, d\'un autre PI → 404, bon → 200', async () => {
    const pm = await pmFor(app, VISA);
    const pi = (await createPi(app, { amount: 2000, payment_method: pm })).body;
    const other = (await createPi(app, { amount: 2000 })).body;

    const missing = await confirmPi(app, pi.id, {}, { key: PK });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ param: 'client_secret', code: 'parameter_missing' });

    const wrong = await confirmPi(app, pi.id, { client_secret: `${pi.id}_secret_mauvais` }, { key: PK });
    expect(wrong.status).toBe(404);
    expect(wrong.body.error.type).toBe('not_found');
    expect((await confirmPi(app, pi.id, { client_secret: other.client_secret }, { key: PK })).status).toBe(404);
    // PI inexistant : même réponse que mauvais secret (pas d'oracle d'existence)
    const ghost = await confirmPi(app, 'pi_inexistant', { client_secret: 'x' }, { key: PK });
    expect(ghost.status).toBe(404);
    expect(countRows(ctx, 'charges')).toBe(0);

    const ok = await confirmPi(app, pi.id, { client_secret: pi.client_secret }, { key: PK });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('succeeded');
    // GET avec pk : client_secret exigé en query
    expect((await request(app).get(`/v1/payment_intents/${pi.id}`).set(auth(PK))).status).toBe(400);
    expect((await request(app).get(`/v1/payment_intents/${pi.id}?client_secret=${pi.client_secret}`).set(auth(PK))).body.status).toBe('succeeded');
    // pk ne peut ni créer, ni capturer, ni annuler, ni lister
    expect((await request(app).post(`/v1/payment_intents/${pi.id}/cancel`).set(auth(PK)).send({})).status).toBe(403);
    expect((await request(app).get('/v1/payment_intents').set(auth(PK))).status).toBe(403);
  });

  it('confirm : pm rattaché à un autre client → 400', async () => {
    const cusA = (await request(app).post('/v1/customers').set(auth(SK)).send({ email: 'a@example.com' })).body.id;
    const cusB = (await request(app).post('/v1/customers').set(auth(SK)).send({ email: 'b@example.com' })).body.id;
    const pm = await pmFor(app, VISA);
    await request(app).post(`/v1/payment_methods/${pm}/attach`).set(auth()).send({ customer: cusA }).expect(200);
    const pi = (await createPi(app, { amount: 2000, customer: cusB })).body;
    const r = await confirmPi(app, pi.id, { payment_method: pm });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('payment_method_customer_mismatch');
    const ok = (await createPi(app, { amount: 2000, customer: cusA, payment_method: pm, confirm: true })).body;
    expect(ok).toMatchObject({ status: 'succeeded', customer: cusA });
    const list = await request(app).get(`/v1/payment_intents?customer=${cusA}`).set(auth());
    expect(list.body.data.map((p) => p.id)).toEqual([ok.id]);
  });

  it('atomicité : une erreur pendant la capture annule tout (aucune charge, aucun événement de succès)', async () => {
    const pm = await pmFor(app, VISA);
    const pi = (await createPi(app, { amount: 2000, payment_method: pm })).body;
    const before = countRows(ctx, 'events');
    const spy = vi.spyOn(ctx.ledger, 'post').mockImplementation(() => {
      throw new Error('panne ledger');
    });
    const r = await confirmPi(app, pi.id, {});
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(countRows(ctx, 'charges')).toBe(0);
    expect(countRows(ctx, 'events')).toBe(before);
    expect((await request(app).get(`/v1/payment_intents/${pi.id}`).set(auth())).body.status).toBe('requires_confirmation');
  });
});

'use strict';
const request = require('supertest');
const { makeApp, auth, pmFor, T0 } = require('./helpers');
const { computePspFee } = require('../src/lib/money');
const { addInterval } = require('../src/modules/billing/periods');

const DAY = 86400;
const OK_CARD = '4242424242424242';
const DUNNING_CARD = '4000000000000341';
const THREE_DS_CARD = '4000000000003220';

describe('billing (abonnements)', () => {
  let app;
  let ctx;
  beforeEach(() => {
    ({ app, ctx } = makeApp()); // horloge GELÉE sur T0 = 2026-01-01T00:00:00Z
  });
  afterEach(() => {
    expect(ctx.ledger.check().balanced).toBe(true);
  });

  // ---------- helpers ----------
  const post = (path, body = {}) => request(app).post(path).set(auth()).send(body);
  const get = (path) => request(app).get(path).set(auth());
  const advance = async (seconds) => {
    const r = await post('/v1/test_clock/advance', { seconds });
    expect(r.status).toBe(200);
    return r.body;
  };
  const advanceTo = (ts) => advance(ts - ctx.clock.now());
  const sub = async (id) => (await get(`/v1/subscriptions/${id}`)).body;
  const invoicesOf = async (subId) => (await get(`/v1/invoices?subscription=${subId}&limit=100`)).body.data.reverse(); // plus ancienne d'abord
  const eventTypes = (prefix) =>
    ctx.db.prepare('SELECT type FROM events WHERE type LIKE ? ORDER BY seq').all(`${prefix}%`).map((e) => e.type);
  const eventsFor = (type, id) =>
    ctx.db.prepare('SELECT data FROM events WHERE type = ? ORDER BY seq').all(type).map((e) => JSON.parse(e.data).object).filter((o) => o.id === id);

  async function monthlyPrice(unitAmount = 990, recurring = { interval: 'month' }) {
    const product = await post('/v1/products', { name: 'PaySim Pro' });
    expect(product.status).toBe(200);
    const price = await post('/v1/prices', { product: product.body.id, unit_amount: unitAmount, currency: 'eur', recurring });
    expect(price.status).toBe(200);
    return price.body;
  }

  /** Client avec une carte rattachée et définie comme moyen de paiement par défaut. */
  async function customerWith(card = OK_CARD) {
    const cus = (await post('/v1/customers', { email: 'abonne@example.com' })).body;
    const pm = await pmFor(app, card);
    expect((await post(`/v1/payment_methods/${pm}/attach`, { customer: cus.id })).status).toBe(200);
    expect((await post(`/v1/customers/${cus.id}`, { invoice_settings: { default_payment_method: pm } })).status).toBe(200);
    return { customer: cus.id, pm };
  }

  async function attachCard(customer, card) {
    const pm = await pmFor(app, card);
    expect((await post(`/v1/payment_methods/${pm}/attach`, { customer })).status).toBe(200);
    return pm;
  }

  async function subscribe(body) {
    const r = await post('/v1/subscriptions', body);
    expect(r.status).toBe(200);
    return r.body;
  }

  // ---------- products / prices ----------

  describe('produits et prix', () => {
    it('création, lecture, listes paginées', async () => {
      const price = await monthlyPrice(990, { interval: 'month', interval_count: 3 });
      expect(price).toMatchObject({ object: 'price', unit_amount: 990, currency: 'eur', type: 'recurring', recurring: { interval: 'month', interval_count: 3 } });
      expect(price.id).toMatch(/^price_[0-9A-Za-z]{24}$/);
      expect(price.product).toMatch(/^prod_[0-9A-Za-z]{24}$/);
      expect((await get(`/v1/prices/${price.id}`)).body).toEqual(price);
      expect((await get(`/v1/products/${price.product}`)).body).toMatchObject({ object: 'product', name: 'PaySim Pro', active: true });
      const p2 = await monthlyPrice(500);
      const list = (await get('/v1/prices?limit=1')).body;
      expect(list).toMatchObject({ object: 'list', has_more: true });
      expect(list.data[0].id).toBe(p2.id);
      expect((await get(`/v1/prices?product=${price.product}`)).body.data.map((p) => p.id)).toEqual([price.id]);
      expect((await get('/v1/products?limit=10')).body.data).toHaveLength(2);
      expect(eventTypes('pr')).toEqual(['product.created', 'price.created', 'product.created', 'price.created']);
    });

    it('défaut interval_count = 1 ; validations', async () => {
      const price = await monthlyPrice();
      expect(price.recurring).toEqual({ interval: 'month', interval_count: 1 });
      const prod = price.product;
      const bad = async (body, param) => {
        const r = await post('/v1/prices', { product: prod, unit_amount: 100, currency: 'eur', ...body });
        expect(r.status).toBe(400);
        expect(r.body.error.param).toBe(param);
      };
      await bad({ recurring: { interval: 'month', interval_count: 0 } }, 'recurring.interval_count');
      await bad({ recurring: { interval: 'month', interval_count: 13 } }, 'recurring.interval_count');
      await bad({ recurring: { interval: 'fortnight' } }, 'recurring.interval');
      await bad({ unit_amount: 0 }, 'unit_amount');
      await bad({ currency: 'usd' }, 'currency');
      await bad({ product: 'prod_inexistant' }, 'product');
      expect((await get('/v1/prices/price_nope')).status).toBe(404);
    });
  });

  // ---------- création ----------

  describe('création d’abonnement', () => {
    it('sans essai, carte OK : active, facture paid, PI succeeded, plateforme créditée, événements', async () => {
      const price = await monthlyPrice(990);
      const { customer } = await customerWith();
      const s = await subscribe({ customer, price: price.id });
      expect(s).toMatchObject({ object: 'subscription', status: 'active', customer, price: price.id, billing_cycle_anchor: T0, current_period_start: T0 });
      expect(s.current_period_end).toBe(Date.UTC(2026, 1, 1) / 1000);

      const [inv] = await invoicesOf(s.id);
      expect(s.latest_invoice).toBe(inv.id);
      expect(inv).toMatchObject({ status: 'paid', amount_due: 990, amount_paid: 990, amount_remaining: 0, attempt_count: 1, billing_reason: 'subscription_create', period_start: T0, period_end: s.current_period_end, next_payment_attempt: null });
      const pi = (await get(`/v1/payment_intents/${inv.payment_intent}`)).body;
      expect(pi).toMatchObject({ status: 'succeeded', amount_received: 990, off_session: true, capture_method: 'automatic', customer });
      expect(pi.metadata).toEqual({ invoice: inv.id, subscription: s.id });

      expect(ctx.ledger.balanceOf('platform_balance')).toBe(990 - computePspFee(990));
      expect(ctx.ledger.balanceOf('psp_revenue')).toBe(computePspFee(990));
      expect((await get('/v1/ledger/check')).body.balanced).toBe(true);

      expect(eventTypes('invoice.')).toEqual(['invoice.created', 'invoice.finalized', 'invoice.paid']);
      expect(eventTypes('customer.subscription.')).toEqual(['customer.subscription.created']);
      expect(eventsFor('customer.subscription.created', s.id)[0].status).toBe('active');
    });

    it('default_payment_method de l’abonnement prioritaire sur celui du client', async () => {
      const price = await monthlyPrice();
      const { customer } = await customerWith(DUNNING_CARD); // le défaut client serait refusé
      const okPm = await attachCard(customer, OK_CARD);
      const s = await subscribe({ customer, price: price.id, default_payment_method: okPm });
      expect(s).toMatchObject({ status: 'active', default_payment_method: okPm });
      const [inv] = await invoicesOf(s.id);
      expect((await get(`/v1/payment_intents/${inv.payment_intent}`)).body.payment_method).toBe(okPm);
    });

    it('carte 3DS (3220) off-session : authentication_required → incomplete, facture open', async () => {
      const price = await monthlyPrice();
      const { customer } = await customerWith(THREE_DS_CARD);
      const s = await subscribe({ customer, price: price.id });
      expect(s.status).toBe('incomplete');
      const [inv] = await invoicesOf(s.id);
      expect(inv).toMatchObject({ status: 'open', attempt_count: 1, amount_paid: 0, next_payment_attempt: null });
      expect(inv.last_payment_error).toMatchObject({ type: 'card_error', code: 'card_declined', decline_code: 'authentication_required' });
      expect((await get(`/v1/payment_intents/${inv.payment_intent}`)).body.status).toBe('requires_payment_method');
      expect(ctx.ledger.balanceOf('platform_balance')).toBe(0);
      expect(eventTypes('invoice.')).toEqual(['invoice.created', 'invoice.finalized', 'invoice.payment_failed']);
      // pas de relance automatique d'un abonnement incomplete
      await advance(40 * DAY);
      expect(await invoicesOf(s.id)).toHaveLength(1);
      expect((await sub(s.id)).status).toBe('incomplete');
    });

    it('aucun moyen de paiement : même chemin qu’un refus (incomplete, facture open)', async () => {
      const price = await monthlyPrice();
      const cus = (await post('/v1/customers', { email: 'sans-carte@example.com' })).body;
      const s = await subscribe({ customer: cus.id, price: price.id });
      expect(s.status).toBe('incomplete');
      const [inv] = await invoicesOf(s.id);
      expect(inv).toMatchObject({ status: 'open', attempt_count: 1 });
      expect(inv.last_payment_error.code).toBe('payment_method_missing');
    });

    it('incomplete puis paiement manuel avec une carte valide → active', async () => {
      const price = await monthlyPrice();
      const { customer } = await customerWith(THREE_DS_CARD);
      const s = await subscribe({ customer, price: price.id });
      const [inv] = await invoicesOf(s.id);
      const ok = await attachCard(customer, OK_CARD);
      const r = await post(`/v1/invoices/${inv.id}/pay`, { payment_method: ok });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'paid', attempt_count: 2, amount_paid: inv.amount_due });
      expect((await sub(s.id)).status).toBe('active');
      expect(eventsFor('customer.subscription.updated', s.id).map((x) => x.status)).toEqual(['active']);
    });

    it('validations : client, prix, pm d’un autre client', async () => {
      const price = await monthlyPrice();
      const { customer } = await customerWith();
      const other = await customerWith();
      const bad = async (body, status, param) => {
        const r = await post('/v1/subscriptions', { customer, price: price.id, ...body });
        expect(r.status).toBe(status);
        expect(r.body.error.param).toBe(param);
      };
      await bad({ customer: 'cus_x' }, 400, 'customer');
      await bad({ price: 'price_x' }, 400, 'price');
      await bad({ default_payment_method: other.pm }, 400, 'default_payment_method');
      await bad({ trial_period_days: 0 }, 400, 'trial_period_days');
      const oneTime = await post('/v1/prices', { product: price.product, unit_amount: 100, currency: 'eur' });
      expect(oneTime.body.type).toBe('one_time');
      await bad({ price: oneTime.body.id }, 400, 'price');
      expect(await ctx.db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get().n).toBe(0);
    });
  });

  // ---------- cycle de vie ----------

  describe('cycle de vie', () => {
    it('essai 14 j : trialing sans facture ; +14 j → facture payée, active, période ancrée sur la fin d’essai', async () => {
      const price = await monthlyPrice(990);
      const { customer } = await customerWith();
      const s = await subscribe({ customer, price: price.id, trial_period_days: 14 });
      const trialEnd = T0 + 14 * DAY;
      expect(s).toMatchObject({ status: 'trialing', trial_start: T0, trial_end: trialEnd, current_period_start: T0, current_period_end: trialEnd, billing_cycle_anchor: trialEnd, latest_invoice: null });
      expect(await invoicesOf(s.id)).toHaveLength(0);

      await advance(14 * DAY - 1);
      expect((await sub(s.id)).status).toBe('trialing');
      expect(await invoicesOf(s.id)).toHaveLength(0);

      const res = await advance(1);
      expect(res.results.billing.invoices_created).toHaveLength(1);
      const after = await sub(s.id);
      expect(after).toMatchObject({ status: 'active', current_period_start: trialEnd, current_period_end: addInterval(trialEnd, 'month', 1) });
      const [inv] = await invoicesOf(s.id);
      expect(inv).toMatchObject({ status: 'paid', billing_reason: 'subscription_cycle', period_start: trialEnd });
      expect(ctx.ledger.balanceOf('platform_balance')).toBe(990 - computePspFee(990));
      expect(eventsFor('customer.subscription.updated', s.id).map((x) => x.status)).toEqual(['active']);
    });

    it('renouvellement : +1 mois → 2ᵉ facture paid, période avancée', async () => {
      const price = await monthlyPrice(990);
      const { customer } = await customerWith();
      const s = await subscribe({ customer, price: price.id });
      const feb1 = Date.UTC(2026, 1, 1) / 1000;
      await advanceTo(feb1);
      const invs = await invoicesOf(s.id);
      expect(invs.map((i) => i.status)).toEqual(['paid', 'paid']);
      expect(invs[1]).toMatchObject({ billing_reason: 'subscription_cycle', period_start: feb1, period_end: Date.UTC(2026, 2, 1) / 1000, attempt_count: 1 });
      expect(await sub(s.id)).toMatchObject({ status: 'active', current_period_start: feb1, current_period_end: Date.UTC(2026, 2, 1) / 1000, latest_invoice: invs[1].id });
      expect(ctx.ledger.balanceOf('platform_balance')).toBe(2 * (990 - computePspFee(990)));
    });

    it('ancrage 31 janv. : factures au 28 févr. puis au 31 mars (pas 28 mars)', async () => {
      const jan31 = Date.UTC(2026, 0, 31, 12) / 1000;
      ctx.clock.set(jan31);
      const price = await monthlyPrice();
      const { customer } = await customerWith();
      const s = await subscribe({ customer, price: price.id });
      await advance(60 * DAY); // jusqu'au 1er avril
      const starts = (await invoicesOf(s.id)).map((i) => new Date(i.period_start * 1000).toISOString());
      expect(starts).toEqual(['2026-01-31T12:00:00.000Z', '2026-02-28T12:00:00.000Z', '2026-03-31T12:00:00.000Z']);
    });

    it('rattrapage : +3 mois d’un coup → exactement 3 factures, dans l’ordre ; second run idempotent', async () => {
      const price = await monthlyPrice(990);
      const { customer } = await customerWith();
      const s = await subscribe({ customer, price: price.id });
      const before = ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
      const res = await advanceTo(Date.UTC(2026, 3, 1) / 1000); // 1er avril
      expect(res.results.billing.invoices_created).toHaveLength(3);
      const invs = await invoicesOf(s.id);
      expect(invs).toHaveLength(4);
      expect(invs.slice(1).map((i) => new Date(i.period_start * 1000).toISOString().slice(0, 10))).toEqual(['2026-02-01', '2026-03-01', '2026-04-01']);
      expect(invs.every((i) => i.status === 'paid')).toBe(true);
      expect(res.results.billing.invoices_created).toEqual(invs.slice(1).map((i) => i.id));
      expect(await sub(s.id)).toMatchObject({ status: 'active', current_period_start: Date.UTC(2026, 3, 1) / 1000, current_period_end: Date.UTC(2026, 4, 1) / 1000 });
      expect(ctx.ledger.balanceOf('platform_balance')).toBe(4 * (990 - computePspFee(990)));
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get().n).toBeGreaterThan(before);

      // second run au même instant : rien de nouveau (factures, PI, événements, écritures)
      const snapshot = () => ['invoices', 'payment_intents', 'charges', 'events', 'ledger_entries'].map((t) => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
      const snap = snapshot();
      const again = ctx.billing.run(ctx.clock.now());
      expect(again).toMatchObject({ subscriptions_processed: 0, invoices_created: [], invoices_paid: [], errors: [] });
      expect((await ctx.testclock.tick()).billing.invoices_created).toEqual([]);
      expect(snapshot()).toEqual(snap);
    });

    it('relances (carte 341) : past_due, tentatives à +1/+3/+5 j, puis uncollectible + canceled', async () => {
      const price = await monthlyPrice(990);
      const { customer } = await customerWith(DUNNING_CARD);
      const s = await subscribe({ customer, price: price.id, trial_period_days: 14 });
      const T1 = T0 + 14 * DAY;

      await advanceTo(T1);
      let [inv] = await invoicesOf(s.id);
      expect((await sub(s.id)).status).toBe('past_due');
      expect(inv).toMatchObject({ status: 'open', attempt_count: 1, next_payment_attempt: T1 + 1 * DAY });
      expect(inv.last_payment_error).toMatchObject({ code: 'card_declined', decline_code: 'card_declined' });

      // juste avant l'échéance : rien ne se passe
      await advanceTo(T1 + DAY - 1);
      expect((await get(`/v1/invoices/${inv.id}`)).body.attempt_count).toBe(1);

      await advanceTo(T1 + 1 * DAY);
      inv = (await get(`/v1/invoices/${inv.id}`)).body;
      expect(inv).toMatchObject({ status: 'open', attempt_count: 2, next_payment_attempt: T1 + 3 * DAY });

      await advanceTo(T1 + 3 * DAY);
      inv = (await get(`/v1/invoices/${inv.id}`)).body;
      expect(inv).toMatchObject({ status: 'open', attempt_count: 3, next_payment_attempt: T1 + 5 * DAY });
      expect((await sub(s.id)).status).toBe('past_due');

      await advanceTo(T1 + 5 * DAY);
      inv = (await get(`/v1/invoices/${inv.id}`)).body;
      expect(inv).toMatchObject({ status: 'uncollectible', attempt_count: 4, next_payment_attempt: null, status_transitions: { marked_uncollectible_at: T1 + 5 * DAY } });
      expect(await sub(s.id)).toMatchObject({ status: 'canceled', canceled_at: T1 + 5 * DAY, ended_at: T1 + 5 * DAY });

      // 4 charges échouées sur le même PI interne, aucune écriture ledger
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM charges WHERE payment_intent_id = ? AND status = 'failed'").get(inv.payment_intent).n).toBe(4);
      expect(ctx.ledger.balanceOf('platform_balance')).toBe(0);

      expect(eventTypes('invoice.')).toEqual([
        'invoice.created', 'invoice.finalized',
        'invoice.payment_failed', 'invoice.payment_failed', 'invoice.payment_failed', 'invoice.payment_failed',
        'invoice.marked_uncollectible',
      ]);
      expect(eventTypes('customer.subscription.')).toEqual(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']);
      expect(eventsFor('customer.subscription.updated', s.id)[0].status).toBe('past_due');

      // plus rien ensuite
      await advance(90 * DAY);
      expect(await invoicesOf(s.id)).toHaveLength(1);
    });

    it('relances rattrapées en un seul advance : mêmes instants logiques, 4 tentatives puis canceled', async () => {
      const price = await monthlyPrice();
      const { customer } = await customerWith(DUNNING_CARD);
      const s = await subscribe({ customer, price: price.id, trial_period_days: 14 });
      const res = await advance(60 * DAY);
      expect(res.results.billing.payment_failures).toHaveLength(4);
      expect(res.results.billing.subscriptions_canceled).toEqual([s.id]);
      const invs = await invoicesOf(s.id);
      expect(invs).toHaveLength(1);
      const T1 = T0 + 14 * DAY;
      // horodatages logiques (pas l'instant du rattrapage, T0 + 60 j)
      expect(invs[0]).toMatchObject({ status: 'uncollectible', attempt_count: 4, status_transitions: { finalized_at: T1, marked_uncollectible_at: T1 + 5 * DAY } });
      expect(await sub(s.id)).toMatchObject({ status: 'canceled', canceled_at: T1 + 5 * DAY });
      const failedAt = eventsFor('invoice.payment_failed', invs[0].id).map((i) => i.next_payment_attempt);
      expect(failedAt).toEqual([T1 + DAY, T1 + 3 * DAY, T1 + 5 * DAY, null]);
    });

    it('récupération : past_due → défaut client = 4242 → POST /invoices/:id/pay → paid, active, période normale', async () => {
      const price = await monthlyPrice(990);
      const { customer } = await customerWith(OK_CARD);
      const s = await subscribe({ customer, price: price.id });
      const bad = await attachCard(customer, DUNNING_CARD);
      await post(`/v1/customers/${customer}`, { invoice_settings: { default_payment_method: bad } });

      const feb1 = Date.UTC(2026, 1, 1) / 1000;
      await advanceTo(feb1);
      expect((await sub(s.id)).status).toBe('past_due');
      const inv = (await invoicesOf(s.id))[1];
      expect(inv).toMatchObject({ status: 'open', attempt_count: 1 });

      // tentative manuelle encore refusée : 402, échec committé (attempt_count = 2)
      const refused = await post(`/v1/invoices/${inv.id}/pay`);
      expect(refused.status).toBe(402);
      expect(refused.body.error).toMatchObject({ type: 'card_error', code: 'card_declined' });
      expect(refused.body.error.payment_intent.id).toBe(inv.payment_intent);
      expect((await get(`/v1/invoices/${inv.id}`)).body.attempt_count).toBe(2);

      const ok = await attachCard(customer, OK_CARD);
      expect((await post(`/v1/customers/${customer}`, { invoice_settings: { default_payment_method: ok } })).status).toBe(200);
      const paid = await post(`/v1/invoices/${inv.id}/pay`);
      expect(paid.status).toBe(200);
      expect(paid.body).toMatchObject({ status: 'paid', attempt_count: 3, amount_paid: 990, next_payment_attempt: null, last_payment_error: null });
      const after = await sub(s.id);
      expect(after).toMatchObject({ status: 'active', current_period_start: feb1, current_period_end: Date.UTC(2026, 2, 1) / 1000 });
      expect((await get(`/v1/payment_intents/${inv.payment_intent}`)).body.status).toBe('succeeded');

      // facture payée : plus de relance, et la période suivante se facture normalement au 1er mars
      await advanceTo(Date.UTC(2026, 2, 1) / 1000);
      const invs = await invoicesOf(s.id);
      expect(invs.map((i) => i.status)).toEqual(['paid', 'paid', 'paid']);
      expect(invs[2].period_start).toBe(Date.UTC(2026, 2, 1) / 1000);
      expect(ctx.ledger.balanceOf('platform_balance')).toBe(3 * (990 - computePspFee(990)));
      // facture déjà payée → 409
      expect((await post(`/v1/invoices/${inv.id}/pay`)).status).toBe(409);
    });

    it('cancel immédiat : canceled, plus aucune facture ensuite ; double cancel → 409', async () => {
      const price = await monthlyPrice();
      const { customer } = await customerWith();
      const s = await subscribe({ customer, price: price.id });
      await advance(10 * DAY);
      const r = await post(`/v1/subscriptions/${s.id}/cancel`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'canceled', canceled_at: T0 + 10 * DAY, ended_at: T0 + 10 * DAY });
      await advance(120 * DAY);
      expect(await invoicesOf(s.id)).toHaveLength(1);
      expect((await post(`/v1/subscriptions/${s.id}/cancel`)).status).toBe(409);
      expect(eventsFor('customer.subscription.deleted', s.id)).toHaveLength(1);
    });

    it('cancel immédiat d’un abonnement past_due : facture ouverte void, PI annulé', async () => {
      const price = await monthlyPrice();
      const { customer } = await customerWith(DUNNING_CARD);
      const s = await subscribe({ customer, price: price.id, trial_period_days: 7 });
      await advance(7 * DAY);
      const [inv] = await invoicesOf(s.id);
      expect(inv.status).toBe('open');
      await post(`/v1/subscriptions/${s.id}/cancel`);
      const voided = (await get(`/v1/invoices/${inv.id}`)).body;
      expect(voided).toMatchObject({ status: 'void', next_payment_attempt: null });
      expect((await get(`/v1/payment_intents/${inv.payment_intent}`)).body).toMatchObject({ status: 'canceled', cancellation_reason: 'abandoned' });
      expect((await post(`/v1/invoices/${inv.id}/pay`)).status).toBe(409);
      await advance(30 * DAY);
      expect((await get(`/v1/invoices/${inv.id}`)).body.attempt_count).toBe(1);
    });

    it('cancel at_period_end : reste active, canceled à la fin de période sans nouvelle facture', async () => {
      const price = await monthlyPrice();
      const { customer } = await customerWith();
      const s = await subscribe({ customer, price: price.id });
      const r = await post(`/v1/subscriptions/${s.id}/cancel`, { at_period_end: true });
      expect(r.body).toMatchObject({ status: 'active', cancel_at_period_end: true, canceled_at: null });
      await advanceTo(s.current_period_end - 1);
      expect((await sub(s.id)).status).toBe('active');
      await advanceTo(s.current_period_end);
      expect(await sub(s.id)).toMatchObject({ status: 'canceled', ended_at: s.current_period_end, canceled_at: s.current_period_end });
      expect(await invoicesOf(s.id)).toHaveLength(1);
      await advance(60 * DAY);
      expect(await invoicesOf(s.id)).toHaveLength(1);
      expect(eventTypes('customer.subscription.')).toEqual(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']);
    });

    it('cancel_at_period_end annulé avant l’échéance (POST /subscriptions/:id) → renouvellement normal', async () => {
      const price = await monthlyPrice();
      const { customer } = await customerWith();
      const s = await subscribe({ customer, price: price.id });
      await post(`/v1/subscriptions/${s.id}/cancel`, { at_period_end: true });
      const r = await post(`/v1/subscriptions/${s.id}`, { cancel_at_period_end: false });
      expect(r.body.cancel_at_period_end).toBe(false);
      await advanceTo(s.current_period_end);
      expect((await sub(s.id)).status).toBe('active');
      expect(await invoicesOf(s.id)).toHaveLength(2);
    });

    it('prix hebdomadaire interval_count 2 : rattrapage sur 6 semaines', async () => {
      const price = await monthlyPrice(500, { interval: 'week', interval_count: 2 });
      const { customer } = await customerWith();
      const s = await subscribe({ customer, price: price.id });
      await advance(6 * 7 * DAY);
      const invs = await invoicesOf(s.id);
      expect(invs.map((i) => (i.period_start - T0) / (14 * DAY))).toEqual([0, 1, 2, 3]);
    });

    it('un refus pendant billing.run ne casse pas la boucle : les autres abonnements sont facturés', async () => {
      const price = await monthlyPrice(990);
      const a = await customerWith(DUNNING_CARD);
      const b = await customerWith(OK_CARD);
      const subA = await subscribe({ customer: a.customer, price: price.id, trial_period_days: 3 });
      const subB = await subscribe({ customer: b.customer, price: price.id, trial_period_days: 3 });
      const res = await ctx.testclock.advance(3 * DAY);
      expect(res.results.billing).toMatchObject({ subscriptions_processed: 2, errors: [] });
      expect((await sub(subA.id)).status).toBe('past_due');
      expect((await sub(subB.id)).status).toBe('active');
      // l'état d'échec de A est bien committé (pas annulé par un rollback)
      const [invA] = await invoicesOf(subA.id);
      expect(invA).toMatchObject({ status: 'open', attempt_count: 1 });
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM charges WHERE payment_intent_id = ? AND status = 'failed'").get(invA.payment_intent).n).toBe(1);
    });

    it('une erreur inattendue sur un abonnement est isolée (rollback de CET abonnement seulement)', async () => {
      const price = await monthlyPrice(990);
      const a = await customerWith();
      const b = await customerWith();
      const subA = await subscribe({ customer: a.customer, price: price.id, trial_period_days: 3 });
      const subB = await subscribe({ customer: b.customer, price: price.id, trial_period_days: 3 });
      const original = ctx.payments.confirm;
      ctx.payments.confirm = (id, params) => {
        if (ctx.payments.get(id).customer === a.customer) throw new Error('panne simulée');
        return original(id, params);
      };
      const res = ctx.billing.run(T0 + 3 * DAY);
      ctx.payments.confirm = original;
      expect(res.errors).toEqual([{ subscription: subA.id, message: 'panne simulée' }]);
      expect((await sub(subA.id)).status).toBe('trialing');
      expect(await invoicesOf(subA.id)).toHaveLength(0); // facture annulée avec la transaction
      expect((await sub(subB.id)).status).toBe('active');
      // au run suivant, A est traité normalement
      ctx.clock.set(T0 + 3 * DAY);
      expect(ctx.billing.run(T0 + 3 * DAY).invoices_paid).toHaveLength(1);
      expect((await sub(subA.id)).status).toBe('active');
    });
  });

  // ---------- routes de lecture ----------

  describe('listes et lecture', () => {
    it('subscriptions / invoices : pagination, filtres, 404, clé pk refusée', async () => {
      const price = await monthlyPrice();
      const c1 = await customerWith();
      const c2 = await customerWith(THREE_DS_CARD);
      const s1 = await subscribe({ customer: c1.customer, price: price.id });
      const s2 = await subscribe({ customer: c2.customer, price: price.id });
      const page1 = (await get('/v1/subscriptions?limit=1')).body;
      expect(page1).toMatchObject({ object: 'list', has_more: true });
      expect(page1.data[0].id).toBe(s2.id);
      const page2 = (await get(`/v1/subscriptions?limit=1&starting_after=${s2.id}`)).body;
      expect(page2.data[0].id).toBe(s1.id);
      expect(page2.has_more).toBe(false);
      expect((await get(`/v1/subscriptions?customer=${c1.customer}`)).body.data.map((s) => s.id)).toEqual([s1.id]);
      expect((await get('/v1/subscriptions?status=incomplete')).body.data.map((s) => s.id)).toEqual([s2.id]);
      expect((await get('/v1/subscriptions?status=bogus')).status).toBe(400);
      expect((await get('/v1/invoices?status=open')).body.data.map((i) => i.subscription)).toEqual([s2.id]);
      expect((await get(`/v1/invoices?customer=${c1.customer}`)).body.data).toHaveLength(1);
      expect((await get('/v1/invoices?limit=1')).body.has_more).toBe(true);
      expect((await get('/v1/subscriptions/sub_nope')).status).toBe(404);
      expect((await get('/v1/invoices/in_nope')).status).toBe(404);
      expect((await post('/v1/invoices/in_nope/pay')).status).toBe(404);
      const { PK } = require('./helpers');
      expect((await request(app).get('/v1/subscriptions').set(auth(PK))).status).toBe(403);
      expect((await request(app).post('/v1/products').set(auth(PK)).send({ name: 'x' })).status).toBe(403);
    });

    it('idempotence : création d’abonnement rejouée sans double facturation', async () => {
      const price = await monthlyPrice();
      const { customer } = await customerWith();
      const send = () => request(app).post('/v1/subscriptions').set(auth()).set('Idempotency-Key', 'sub-1').send({ customer, price: price.id });
      const r1 = await send();
      const r2 = await send();
      expect(r2.headers['idempotent-replayed']).toBe('true');
      expect(r2.body).toEqual(r1.body);
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n).toBe(1);
    });
  });
});

describe('migration : base de phase 3 existante → tables billing ajoutées (L10)', () => {
  it('nouvelles tables uniquement, données existantes conservées, migrate idempotent', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const Database = require('better-sqlite3');
    const { migrate, ADDED_COLUMNS } = require('../src/db');
    const full = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
    const cut = full.indexOf('-- Module billing');
    expect(cut).toBeGreaterThan(0);
    const db = new Database(':memory:');
    db.exec(full.slice(0, cut)); // schéma tel qu'en phase 3 (sans billing)
    db.prepare("INSERT INTO customers (id, email, created) VALUES ('cus_old', 'old@example.com', 1)").run();
    const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('products', 'prices', 'subscriptions', 'invoices') ORDER BY name").all().map((r) => r.name);
    expect(tables()).toEqual([]);
    migrate(db);
    expect(tables()).toEqual(['invoices', 'prices', 'products', 'subscriptions']);
    migrate(db);
    expect(db.prepare('SELECT email FROM customers WHERE id = ?').get('cus_old')).toEqual({ email: 'old@example.com' });
    // billing n'ajoute aucune colonne à une table existante : rien de neuf dans ADDED_COLUMNS
    expect(ADDED_COLUMNS.map((c) => `${c.table}.${c.column}`)).toEqual(['charges.refunded']);
    db.close();
  });
});

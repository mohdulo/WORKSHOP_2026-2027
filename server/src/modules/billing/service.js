'use strict';
const { newId } = require('../../lib/ids');
const { invalid, notFound, stateError } = require('../../lib/errors');
const { paginate } = require('../../lib/pagination');
const { CURRENCY } = require('../../lib/money');
const { DAY, periodBoundary } = require('./periods');

/**
 * Billing (PLAN §4.8) : produits, prix, abonnements, factures, relances.
 *
 * PÉRIODES ANCRÉES
 *   Un abonnement a une ancre `billing_cycle_anchor` (création, ou fin d'essai) ; la période k est
 *   [borne(k), borne(k+1)[ avec borne(k) = ancre + k intervalles (periods.js). `period_index` = k de la
 *   période courante (-1 pendant l'essai). Une facture couvre exactement une période (UNIQUE(subscription_id,
 *   period_index)) ; la période de l'abonnement avance quand la facture de la période suivante est émise.
 *
 * PAIEMENT D'UNE FACTURE
 *   Un payment intent interne par facture (off_session, capture automatique), créé et confirmé via le service
 *   payments (aucune logique d'autorisation ni d'écriture ledger dupliquée). Une relance re-confirme le même PI
 *   (revenu à requires_payment_method après un refus). Moyen de paiement : sub.default_payment_method, sinon
 *   customer.invoice_settings.default_payment_method ; aucun → même chemin qu'un refus (code payment_method_missing).
 *   Un refus N'EST PAS levé (taskForLesson L6) : l'état d'échec est committé avec le reste.
 *
 * RELANCES (dunning)
 *   1er échec automatique à l'instant T (logique) → past_due, prochaine tentative T+1 j, puis T+3 j, puis T+5 j.
 *   Après MAX_ATTEMPTS échecs au total (tentatives manuelles comprises) → facture uncollectible, sub canceled.
 *   Un abonnement `incomplete` (échec à la création) n'est pas relancé automatiquement : POST /v1/invoices/:id/pay.
 *
 * MOTEUR run(now)
 *   Pour chaque abonnement à traiter, dans SA propre transaction : boucle d'étapes à l'instant logique de chaque
 *   échéance (relance due, fin d'essai, fin de période, cancel_at_period_end), dans l'ordre, jusqu'à être à jour.
 *   Tant qu'une facture est ouverte, aucune nouvelle facture n'est émise (une seule facture impayée à la fois).
 *   Idempotent : un second run(now) ne trouve plus rien d'échu.
 */
const RETRY_OFFSETS_DAYS = Object.freeze([1, 3, 5]);
const MAX_ATTEMPTS = 4;
const MAX_STEPS_PER_RUN = 5000; // garde-fou contre une boucle infinie (5 ans de facturation journalière ≈ 1830 étapes)

const SUB_STATUSES = ['trialing', 'active', 'incomplete', 'past_due', 'canceled'];
const SUB_TRANSITIONS = Object.freeze({
  trialing: ['active', 'past_due', 'canceled'],
  active: ['past_due', 'canceled'],
  incomplete: ['active', 'canceled'],
  past_due: ['active', 'canceled'],
  canceled: [],
});
const INVOICE_TRANSITIONS = Object.freeze({
  draft: ['open', 'void'],
  open: ['paid', 'uncollectible', 'void'],
  paid: [],
  uncollectible: [],
  void: [],
});

const SUB_MUTABLE = [
  'status', 'default_payment_method', 'period_index', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'canceled_at', 'ended_at', 'latest_invoice',
];
const INVOICE_MUTABLE = [
  'status', 'amount_paid', 'attempt_count', 'next_payment_attempt', 'retry_anchor', 'payment_intent', 'last_payment_error',
  'finalized_at', 'paid_at', 'marked_uncollectible_at', 'voided_at',
];

function createBilling(ctx) {
  const { db, clock } = ctx;
  const stmts = {
    insertProduct: db.prepare('INSERT INTO products (id, name, description, metadata, created) VALUES (?, ?, ?, ?, ?)'),
    getProduct: db.prepare('SELECT * FROM products WHERE id = ?'),
    insertPrice: db.prepare(`
      INSERT INTO prices (id, product_id, unit_amount, currency, type, recurring_interval, recurring_interval_count, nickname, metadata, created)
      VALUES (@id, @product_id, @unit_amount, @currency, @type, @recurring_interval, @recurring_interval_count, @nickname, @metadata, @created)`),
    getPrice: db.prepare('SELECT * FROM prices WHERE id = ?'),
    insertSub: db.prepare(`
      INSERT INTO subscriptions (id, customer_id, price_id, status, default_payment_method, billing_cycle_anchor, period_index,
        current_period_start, current_period_end, trial_start, trial_end, metadata, created)
      VALUES (@id, @customer_id, @price_id, @status, @default_payment_method, @billing_cycle_anchor, @period_index,
        @current_period_start, @current_period_end, @trial_start, @trial_end, @metadata, @created)`),
    getSub: db.prepare('SELECT * FROM subscriptions WHERE id = ?'),
    insertInvoice: db.prepare(`
      INSERT INTO invoices (id, subscription_id, customer_id, status, billing_reason, amount_due, currency, period_index, period_start, period_end, created)
      VALUES (@id, @subscription_id, @customer_id, 'draft', @billing_reason, @amount_due, @currency, @period_index, @period_start, @period_end, @created)`),
    getInvoice: db.prepare('SELECT * FROM invoices WHERE id = ?'),
    openInvoiceOf: db.prepare("SELECT * FROM invoices WHERE subscription_id = ? AND status = 'open' ORDER BY seq LIMIT 1"),
    dueSubs: db.prepare(`
      SELECT s.id FROM subscriptions s
      WHERE s.status IN ('trialing', 'active', 'past_due')
        AND (s.current_period_end <= @now
             OR EXISTS (SELECT 1 FROM invoices i WHERE i.subscription_id = s.id AND i.status = 'open'
                        AND i.next_payment_attempt IS NOT NULL AND i.next_payment_attempt <= @now))
      ORDER BY s.seq`),
  };

  // ---------- sérialisation ----------

  const productToApi = (r) => ({
    id: r.id, object: 'product', name: r.name, description: r.description, active: Boolean(r.active), metadata: JSON.parse(r.metadata), created: r.created,
  });

  const priceToApi = (r) => ({
    id: r.id,
    object: 'price',
    product: r.product_id,
    unit_amount: r.unit_amount,
    currency: r.currency,
    type: r.type,
    recurring: r.type === 'recurring' ? { interval: r.recurring_interval, interval_count: r.recurring_interval_count } : null,
    nickname: r.nickname,
    active: Boolean(r.active),
    metadata: JSON.parse(r.metadata),
    created: r.created,
  });

  const subToApi = (r) => ({
    id: r.id,
    object: 'subscription',
    customer: r.customer_id,
    price: r.price_id,
    status: r.status,
    default_payment_method: r.default_payment_method,
    billing_cycle_anchor: r.billing_cycle_anchor,
    current_period_start: r.current_period_start,
    current_period_end: r.current_period_end,
    trial_start: r.trial_start,
    trial_end: r.trial_end,
    cancel_at_period_end: Boolean(r.cancel_at_period_end),
    canceled_at: r.canceled_at,
    ended_at: r.ended_at,
    latest_invoice: r.latest_invoice,
    metadata: JSON.parse(r.metadata),
    created: r.created,
  });

  const invoiceToApi = (r) => ({
    id: r.id,
    object: 'invoice',
    subscription: r.subscription_id,
    customer: r.customer_id,
    status: r.status,
    billing_reason: r.billing_reason,
    amount_due: r.amount_due,
    amount_paid: r.amount_paid,
    amount_remaining: r.amount_due - r.amount_paid,
    currency: r.currency,
    period_start: r.period_start,
    period_end: r.period_end,
    attempt_count: r.attempt_count,
    attempted: r.attempt_count > 0,
    next_payment_attempt: r.next_payment_attempt,
    payment_intent: r.payment_intent,
    last_payment_error: r.last_payment_error ? JSON.parse(r.last_payment_error) : null,
    status_transitions: {
      finalized_at: r.finalized_at,
      paid_at: r.paid_at,
      marked_uncollectible_at: r.marked_uncollectible_at,
      voided_at: r.voided_at,
    },
    created: r.created,
  });

  // ---------- accès / mises à jour ----------

  function getRowOr404(stmt, resource, id) {
    const row = typeof id === 'string' ? stmt.get(id) : undefined;
    if (!row) throw notFound(resource, id);
    return row;
  }

  function update(table, mutable, transitions, kind, row, fields) {
    const cols = Object.keys(fields);
    for (const c of cols) if (!mutable.includes(c)) throw new Error(`Colonne non modifiable : ${table}.${c}`);
    if (fields.status !== undefined && fields.status !== row.status && !transitions[row.status].includes(fields.status)) {
      throw stateError(`Transition interdite (${kind}) : ${row.status} → ${fields.status}.`, `${kind}_unexpected_state`);
    }
    if (cols.length === 0) return row;
    db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...fields, id: row.id });
    return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id);
  }
  const patchSub = (row, fields) => update('subscriptions', SUB_MUTABLE, SUB_TRANSITIONS, 'subscription', row, fields);
  const patchInvoice = (row, fields) => update('invoices', INVOICE_MUTABLE, INVOICE_TRANSITIONS, 'invoice', row, fields);

  const emitSub = (type, row) => ctx.events.emit(type, subToApi(row));
  const emitInvoice = (type, row) => ctx.events.emit(type, invoiceToApi(row));

  function boundary(sub, price, k) {
    return periodBoundary(sub.billing_cycle_anchor, price.recurring_interval, price.recurring_interval_count, k);
  }

  /** Moyen de paiement de la facture : celui de l'abonnement, sinon celui du client, sinon null. */
  function resolvePaymentMethod(sub) {
    if (sub.default_payment_method) return sub.default_payment_method;
    return ctx.customers.getRow(sub.customer_id).default_payment_method || null;
  }

  /** Le pm doit exister et être rattaché au client (param = champ d'origine pour l'erreur 400). */
  function assertPmOfCustomer(pmId, customerId, param) {
    const pm = ctx.vault.getRow(pmId, param);
    if (pm.customer_id !== customerId) {
      throw invalid("Le moyen de paiement doit d'abord être rattaché à ce client.", param, 'payment_method_customer_mismatch');
    }
    return pm;
  }

  // ---------- products / prices ----------

  const createProduct = db.transaction(({ name, description, metadata }) => {
    const id = newId('prod');
    stmts.insertProduct.run(id, name, description ?? null, JSON.stringify(metadata || {}), clock.now());
    const product = productToApi(stmts.getProduct.get(id));
    ctx.events.emit('product.created', product);
    return product;
  });

  const createPrice = db.transaction(({ product, unit_amount: unitAmount, currency, recurring, nickname, metadata }) => {
    if (!stmts.getProduct.get(product)) throw invalid(`Aucun produit "${product}".`, 'product', 'resource_missing');
    const id = newId('price');
    stmts.insertPrice.run({
      id,
      product_id: product,
      unit_amount: unitAmount,
      currency,
      type: recurring ? 'recurring' : 'one_time',
      recurring_interval: recurring ? recurring.interval : null,
      recurring_interval_count: recurring ? recurring.interval_count ?? 1 : null,
      nickname: nickname ?? null,
      metadata: JSON.stringify(metadata || {}),
      created: clock.now(),
    });
    const price = priceToApi(stmts.getPrice.get(id));
    ctx.events.emit('price.created', price);
    return price;
  });

  // ---------- factures ----------

  /**
   * Émet la facture de la période k (draft → open) et fait avancer la période courante de l'abonnement.
   * Renvoie { sub, invoice } à jour.
   */
  function issueInvoice(sub, price, k, billingReason, at) {
    const id = newId('in');
    const now = clock.now();
    stmts.insertInvoice.run({
      id,
      subscription_id: sub.id,
      customer_id: sub.customer_id,
      billing_reason: billingReason,
      amount_due: price.unit_amount,
      currency: price.currency,
      period_index: k,
      period_start: boundary(sub, price, k),
      period_end: boundary(sub, price, k + 1),
      created: now,
    });
    let invoice = stmts.getInvoice.get(id);
    emitInvoice('invoice.created', invoice);
    invoice = patchInvoice(invoice, { status: 'open', finalized_at: at });
    emitInvoice('invoice.finalized', invoice);
    const next = patchSub(sub, {
      period_index: k,
      current_period_start: invoice.period_start,
      current_period_end: invoice.period_end,
      latest_invoice: id,
    });
    return { sub: next, invoice };
  }

  /**
   * Une tentative de paiement de la facture (appelée DANS une transaction).
   *   mode 'create'    : 1re tentative à la création de l'abonnement (échec → incomplete, pas de relance auto) ;
   *   mode 'automatic' : tentative du moteur à l'instant logique `at` ;
   *   mode 'manual'    : POST /v1/invoices/:id/pay (pmOverride possible).
   * Renvoie { sub, invoice, failure } ; failure = { type, code, decline_code?, message, charge? } ou null.
   */
  function attemptInvoice(sub, invoice, { mode, at, pmOverride } = {}) {
    const pmId = pmOverride || resolvePaymentMethod(sub);
    let piId = invoice.payment_intent;
    if (!piId) {
      const { paymentIntent } = ctx.payments.create({
        amount: invoice.amount_due,
        currency: invoice.currency,
        customer: invoice.customer_id,
        off_session: true,
        capture_method: 'automatic',
        description: `Facture ${invoice.id} (abonnement ${sub.id})`,
        metadata: { invoice: invoice.id, subscription: sub.id },
      });
      piId = paymentIntent.id;
      invoice = patchInvoice(invoice, { payment_intent: piId });
    }

    let failure = null;
    if (!pmId) {
      failure = {
        type: 'invalid_request_error',
        code: 'payment_method_missing',
        message: "Aucun moyen de paiement : ni default_payment_method sur l'abonnement, ni invoice_settings.default_payment_method sur le client.",
      };
    } else {
      // Refus carte : committé par payments (L6), renvoyé dans `failure` (jamais levé).
      const result = ctx.payments.confirm(piId, { payment_method: pmId });
      if (result.failure) {
        const { type, code, decline_code: declineCode, message, charge } = result.failure;
        failure = { type, code, decline_code: declineCode, message, charge: charge || null };
      }
    }

    // Horodatages métier = instant LOGIQUE de l'échéance en mode automatique (exact même en rattrapage) ;
    // `created` et les événements portent l'instant de traitement (clock.now()).
    const now = mode === 'automatic' ? at : clock.now();
    const attemptCount = invoice.attempt_count + 1;
    if (!failure) {
      invoice = patchInvoice(invoice, {
        status: 'paid', amount_paid: invoice.amount_due, attempt_count: attemptCount, paid_at: now, next_payment_attempt: null, last_payment_error: null,
      });
      emitInvoice('invoice.paid', invoice);
      if (sub.status !== 'active') {
        sub = patchSub(sub, { status: 'active' });
        if (mode !== 'create') emitSub('customer.subscription.updated', sub);
      } else if (mode === 'automatic') {
        emitSub('customer.subscription.updated', sub); // nouvelle période
      }
      return { sub, invoice, failure: null };
    }

    const lastError = JSON.stringify(failure);
    if (mode === 'create' || sub.status === 'incomplete') {
      invoice = patchInvoice(invoice, { attempt_count: attemptCount, last_payment_error: lastError, next_payment_attempt: null });
      emitInvoice('invoice.payment_failed', invoice);
      return { sub, invoice, failure };
    }

    if (attemptCount >= MAX_ATTEMPTS) {
      invoice = patchInvoice(invoice, { attempt_count: attemptCount, last_payment_error: lastError, next_payment_attempt: null });
      emitInvoice('invoice.payment_failed', invoice);
      invoice = patchInvoice(invoice, { status: 'uncollectible', marked_uncollectible_at: now });
      emitInvoice('invoice.marked_uncollectible', invoice);
      sub = patchSub(sub, { status: 'canceled', canceled_at: now, ended_at: now });
      emitSub('customer.subscription.deleted', sub);
      return { sub, invoice, failure };
    }

    const retryAnchor = invoice.retry_anchor ?? now;
    invoice = patchInvoice(invoice, {
      attempt_count: attemptCount,
      last_payment_error: lastError,
      retry_anchor: retryAnchor,
      next_payment_attempt: retryAnchor + RETRY_OFFSETS_DAYS[attemptCount - 1] * DAY,
    });
    emitInvoice('invoice.payment_failed', invoice);
    if (sub.status !== 'past_due') {
      sub = patchSub(sub, { status: 'past_due' });
      emitSub('customer.subscription.updated', sub);
    }
    return { sub, invoice, failure };
  }

  // ---------- abonnements ----------

  const createSubscriptionTxn = db.transaction((params) => {
    const { customer, price: priceId, trial_period_days: trialDays, default_payment_method: defaultPm, metadata } = params;
    ctx.customers.assertExists(customer, 'customer');
    const price = stmts.getPrice.get(priceId);
    if (!price) throw invalid(`Aucun prix "${priceId}".`, 'price', 'resource_missing');
    if (price.type !== 'recurring') throw invalid("Le prix d'un abonnement doit être récurrent.", 'price', 'price_not_recurring');
    if (!price.active) throw invalid('Ce prix est désactivé.', 'price', 'price_inactive');
    if (defaultPm) assertPmOfCustomer(defaultPm, customer, 'default_payment_method');

    const now = clock.now();
    const id = newId('sub');
    const trialEnd = trialDays ? now + trialDays * DAY : null;
    const anchor = trialEnd ?? now;
    stmts.insertSub.run({
      id,
      customer_id: customer,
      price_id: priceId,
      status: trialEnd ? 'trialing' : 'incomplete',
      default_payment_method: defaultPm || null,
      billing_cycle_anchor: anchor,
      period_index: trialEnd ? -1 : 0,
      current_period_start: now,
      current_period_end: trialEnd ?? periodBoundary(anchor, price.recurring_interval, price.recurring_interval_count, 1),
      trial_start: trialEnd ? now : null,
      trial_end: trialEnd,
      metadata: JSON.stringify(metadata || {}),
      created: now,
    });
    let sub = stmts.getSub.get(id);
    let failure = null;
    if (!trialEnd) {
      const issued = issueInvoice(sub, price, 0, 'subscription_create', now);
      ({ sub, failure } = attemptInvoice(issued.sub, issued.invoice, { mode: 'create', at: now }));
    }
    emitSub('customer.subscription.created', sub);
    return { sub, failure };
  });

  function createSubscription(params) {
    const { sub, failure } = createSubscriptionTxn(params);
    if (failure) ctx.logger.info({ subscription: sub.id, code: failure.code, decline_code: failure.decline_code }, 'abonnement incomplet : premier paiement refusé');
    return subToApi(sub);
  }

  /** Annulation : immédiate (factures ouvertes annulées → void) ou à la fin de la période courante. */
  const cancelSubscription = db.transaction((id, { at_period_end: atPeriodEnd = false } = {}) => {
    let sub = getRowOr404(stmts.getSub, 'subscription', id);
    if (sub.status === 'canceled') throw stateError(`L'abonnement ${id} est déjà résilié.`, 'subscription_unexpected_state');
    const now = clock.now();
    if (atPeriodEnd) {
      if (sub.status === 'incomplete') {
        throw stateError('Un abonnement incomplete ne peut être résilié qu’immédiatement (at_period_end: false).', 'subscription_unexpected_state');
      }
      if (!sub.cancel_at_period_end) {
        sub = patchSub(sub, { cancel_at_period_end: 1 });
        emitSub('customer.subscription.updated', sub);
      }
      return subToApi(sub);
    }
    let open = stmts.openInvoiceOf.get(sub.id);
    while (open) {
      // Le PI interne de la facture (revenu à requires_payment_method après un refus) est annulé avec elle.
      if (open.payment_intent && ctx.payments.ACTIONS.cancel.includes(ctx.payments.get(open.payment_intent).status)) {
        ctx.payments.cancel(open.payment_intent, { cancellation_reason: 'abandoned' });
      }
      const voided = patchInvoice(open, { status: 'void', voided_at: now, next_payment_attempt: null });
      emitInvoice('invoice.voided', voided);
      open = stmts.openInvoiceOf.get(sub.id);
    }
    sub = patchSub(sub, { status: 'canceled', canceled_at: now, ended_at: now });
    emitSub('customer.subscription.deleted', sub);
    return subToApi(sub);
  });

  // ---------- paiement manuel ----------

  const payInvoiceTxn = db.transaction((id, { payment_method: pmOverride } = {}) => {
    const invoice = getRowOr404(stmts.getInvoice, 'invoice', id);
    if (invoice.status !== 'open') {
      throw stateError(`La facture ${id} est au statut « ${invoice.status} » : seule une facture open peut être payée.`, 'invoice_unexpected_state');
    }
    const sub = stmts.getSub.get(invoice.subscription_id);
    if (sub.status === 'canceled') throw stateError(`L'abonnement ${sub.id} est résilié.`, 'subscription_unexpected_state');
    if (pmOverride) assertPmOfCustomer(pmOverride, invoice.customer_id, 'payment_method');
    if (!pmOverride && !resolvePaymentMethod(sub)) {
      throw invalid(
        "Aucun moyen de paiement : fournissez payment_method ou définissez invoice_settings.default_payment_method du client.",
        'payment_method',
        'payment_method_missing',
      );
    }
    return attemptInvoice(sub, invoice, { mode: 'manual', pmOverride });
  });

  /** → { invoice, failure } ; la route transforme `failure` en 402 APRÈS le commit (L6). */
  function payInvoice(id, params) {
    const { invoice, failure } = payInvoiceTxn(id, params);
    return { invoice: invoiceToApi(invoice), failure };
  }

  // ---------- moteur ----------

  /**
   * Une étape échue pour l'abonnement à l'instant `now`, ou null si l'abonnement est à jour.
   * Ordre : relance d'une facture ouverte (si échue) ; sinon fin de période (résiliation programmée ou nouvelle facture).
   */
  function step(sub, price, now) {
    if (!['trialing', 'active', 'past_due'].includes(sub.status)) return null;
    const open = stmts.openInvoiceOf.get(sub.id);
    if (open) {
      if (open.next_payment_attempt === null || open.next_payment_attempt > now) return null;
      const r = attemptInvoice(sub, open, { mode: 'automatic', at: open.next_payment_attempt });
      return { sub: r.sub, kind: r.failure ? 'payment_failed' : 'paid', invoice: r.invoice };
    }
    if (sub.current_period_end > now) return null;
    if (sub.cancel_at_period_end) {
      const ended = patchSub(sub, { status: 'canceled', canceled_at: sub.current_period_end, ended_at: sub.current_period_end });
      emitSub('customer.subscription.deleted', ended);
      return { sub: ended, kind: 'canceled' };
    }
    const at = sub.current_period_end;
    const issued = issueInvoice(sub, price, sub.period_index + 1, 'subscription_cycle', at);
    const r = attemptInvoice(issued.sub, issued.invoice, { mode: 'automatic', at });
    return { sub: r.sub, kind: r.failure ? 'invoice_created_failed' : 'invoice_created_paid', invoice: r.invoice };
  }

  /** Traite un abonnement jusqu'à ce qu'il soit à jour (une transaction par abonnement). */
  const processSubscription = db.transaction((id, now, summary) => {
    let sub = stmts.getSub.get(id);
    const price = stmts.getPrice.get(sub.price_id);
    let steps = 0;
    for (;;) {
      if (steps >= MAX_STEPS_PER_RUN) throw new Error(`billing.run : plus de ${MAX_STEPS_PER_RUN} étapes pour ${id}`);
      const r = step(sub, price, now);
      if (!r) break;
      steps += 1;
      sub = r.sub;
      if (r.kind.startsWith('invoice_created')) summary.invoices_created.push(r.invoice.id);
      if (r.kind === 'paid' || r.kind === 'invoice_created_paid') summary.invoices_paid.push(r.invoice.id);
      if (r.kind === 'payment_failed' || r.kind === 'invoice_created_failed') summary.payment_failures.push(r.invoice.id);
      if (sub.status === 'canceled') summary.subscriptions_canceled.push(sub.id);
    }
    return steps;
  });

  /**
   * Moteur de facturation (appelé par testclock.advance). Chaque abonnement est traité dans sa propre transaction :
   * une erreur inattendue sur l'un est journalisée et n'empêche pas les autres (son état est annulé, il sera
   * retraité au prochain run). Les refus carte ne sont pas des erreurs (L6).
   */
  function run(now = clock.now()) {
    const summary = { invoices_created: [], invoices_paid: [], payment_failures: [], subscriptions_canceled: [], errors: [] };
    const ids = stmts.dueSubs.all({ now }).map((r) => r.id);
    let processed = 0;
    for (const id of ids) {
      const partial = { invoices_created: [], invoices_paid: [], payment_failures: [], subscriptions_canceled: [] };
      try {
        if (processSubscription(id, now, partial) > 0) processed += 1;
        for (const k of Object.keys(partial)) summary[k].push(...partial[k]);
      } catch (err) {
        ctx.logger.error({ err, subscription: id }, 'billing.run : échec du traitement de l’abonnement');
        summary.errors.push({ subscription: id, message: err.message });
      }
    }
    return { subscriptions_processed: processed, ...summary };
  }

  // ---------- lecture ----------

  /** { colonne: valeur|undefined } → { where, params } pour paginate (colonnes internes, jamais issues de l'utilisateur). */
  function filters(map) {
    const entries = Object.entries(map).filter(([, v]) => v !== undefined);
    return { where: entries.map(([c]) => `${c} = ?`).join(' AND ') || undefined, params: entries.map(([, v]) => v) };
  }

  /** Mise à jour : default_payment_method (null = repli sur celui du client) et cancel_at_period_end (réactivation). */
  const updateSubscription = db.transaction((id, params) => {
    const row = getRowOr404(stmts.getSub, 'subscription', id);
    if (row.status === 'canceled') throw stateError(`L'abonnement ${id} est résilié.`, 'subscription_unexpected_state');
    const fields = {};
    if (params.default_payment_method !== undefined) {
      if (params.default_payment_method !== null) assertPmOfCustomer(params.default_payment_method, row.customer_id, 'default_payment_method');
      fields.default_payment_method = params.default_payment_method;
    }
    if (params.cancel_at_period_end !== undefined) fields.cancel_at_period_end = params.cancel_at_period_end ? 1 : 0;
    const sub = patchSub(row, fields);
    emitSub('customer.subscription.updated', sub);
    return subToApi(sub);
  });

  return {
    createProduct,
    getProduct: (id) => productToApi(getRowOr404(stmts.getProduct, 'product', id)),
    listProducts: ({ limit, startingAfter } = {}) => paginate(db, { table: 'products', limit, startingAfter, map: productToApi }),
    createPrice,
    getPrice: (id) => priceToApi(getRowOr404(stmts.getPrice, 'price', id)),
    listPrices: ({ limit, startingAfter, product } = {}) =>
      paginate(db, { table: 'prices', where: product ? 'product_id = ?' : undefined, params: product ? [product] : [], limit, startingAfter, map: priceToApi }),
    createSubscription,
    cancelSubscription,
    updateSubscription,
    getSubscription: (id) => subToApi(getRowOr404(stmts.getSub, 'subscription', id)),
    listSubscriptions: ({ limit, startingAfter, customer, status } = {}) =>
      paginate(db, { table: 'subscriptions', ...filters({ customer_id: customer, status }), limit, startingAfter, map: subToApi }),
    getInvoice: (id) => invoiceToApi(getRowOr404(stmts.getInvoice, 'invoice', id)),
    listInvoices: ({ limit, startingAfter, subscription, customer, status } = {}) =>
      paginate(db, { table: 'invoices', ...filters({ subscription_id: subscription, customer_id: customer, status }), limit, startingAfter, map: invoiceToApi }),
    payInvoice,
    run,
    SUB_STATUSES,
    SUB_TRANSITIONS,
    INVOICE_TRANSITIONS,
    RETRY_OFFSETS_DAYS,
    MAX_ATTEMPTS,
  };
}

module.exports = { createBilling, RETRY_OFFSETS_DAYS, MAX_ATTEMPTS, SUB_TRANSITIONS, INVOICE_TRANSITIONS };

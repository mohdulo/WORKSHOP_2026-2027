'use strict';
const crypto = require('node:crypto');
const { newId } = require('../../lib/ids');
const { invalid, notFound, stateError, cardError } = require('../../lib/errors');
const { computePspFee } = require('../../lib/money');
const { safeEqual } = require('../../lib/crypto');
const { paginate } = require('../../lib/pagination');

/**
 * Payment intents (PLAN §4.5) — machine à états explicite.
 *
 * TRANSITIONS : seules ces transitions de statut sont autorisées (toute autre → 409 state_error).
 *   requires_payment_method → requires_confirmation (un moyen de paiement est fourni) | canceled
 *   requires_confirmation   → requires_confirmation (changement de moyen de paiement) | requires_action (3DS)
 *                             | requires_capture (autorisé, capture manuelle) | succeeded (autorisé + capturé)
 *                             | requires_payment_method (refus) | canceled
 *   requires_action         → requires_capture | succeeded | requires_payment_method (3DS refusé / refus) | canceled
 *   requires_capture        → succeeded (capture) | canceled (annulation ou expiration 7 j)
 *   succeeded, canceled     → (terminaux)
 *
 * ACTIONS : statuts depuis lesquels chaque opération publique est permise.
 *
 * Refus carte : le retour à requires_payment_method (+ charge failed + événements) est COMMITTÉ ;
 * le service renvoie { paymentIntent, failure } et c'est l'appelant (route) qui répond 402 hors transaction.
 * (Lever l'erreur dans db.transaction() annulerait l'enregistrement du refus.)
 *
 * Ledger : écritures UNIQUEMENT à la capture (PLAN §4.1).
 */
const STATUSES = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture', 'succeeded', 'canceled'];

const TRANSITIONS = Object.freeze({
  requires_payment_method: ['requires_confirmation', 'canceled'],
  requires_confirmation: ['requires_confirmation', 'requires_action', 'requires_capture', 'succeeded', 'requires_payment_method', 'canceled'],
  requires_action: ['requires_capture', 'succeeded', 'requires_payment_method', 'canceled'],
  requires_capture: ['succeeded', 'canceled'],
  succeeded: [],
  canceled: [],
});

const ACTIONS = Object.freeze({
  confirm: ['requires_payment_method', 'requires_confirmation'],
  complete_3ds: ['requires_action'],
  capture: ['requires_capture'],
  cancel: ['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture'],
  expire: ['requires_capture'],
});

const AUTHORIZATION_TTL = 7 * 24 * 3600; // 7 jours
const CANCELLATION_REASONS = ['duplicate', 'fraudulent', 'requested_by_customer', 'abandoned'];

const MUTABLE_COLUMNS = [
  'status', 'amount_capturable', 'amount_received', 'payment_method_id', 'last_payment_error', 'next_action',
  'latest_charge', 'authorized_at', 'canceled_at', 'cancellation_reason',
];

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function createPayments(ctx) {
  const { db, clock } = ctx;
  const stmts = {
    insertPi: db.prepare(`
      INSERT INTO payment_intents (id, amount, currency, status, capture_method, client_secret, customer_id, payment_method_id,
        off_session, application_fee_amount, transfer_destination, description, metadata, created)
      VALUES (@id, @amount, @currency, @status, @capture_method, @client_secret, @customer_id, @payment_method_id,
        @off_session, @application_fee_amount, @transfer_destination, @description, @metadata, @created)`),
    getPi: db.prepare('SELECT * FROM payment_intents WHERE id = ?'),
    insertCharge: db.prepare(`
      INSERT INTO charges (id, payment_intent_id, payment_method_id, customer_id, amount, currency, status, failure_code,
        decline_code, failure_message, outcome, three_d_secure, created)
      VALUES (@id, @payment_intent_id, @payment_method_id, @customer_id, @amount, @currency, @status, @failure_code,
        @decline_code, @failure_message, @outcome, @three_d_secure, @created)`),
    getCharge: db.prepare('SELECT * FROM charges WHERE id = ?'),
    captureCharge: db.prepare('UPDATE charges SET captured = 1, amount_captured = ? WHERE id = ?'),
    getAccount: db.prepare('SELECT id, status FROM accounts WHERE id = ?'),
    insertChallenge: db.prepare("INSERT INTO three_ds_challenges (id, payment_intent_id, status, created) VALUES (?, ?, 'pending', ?)"),
    getChallenge: db.prepare('SELECT * FROM three_ds_challenges WHERE id = ?'),
    completeChallenge: db.prepare('UPDATE three_ds_challenges SET status = ?, completed_at = ? WHERE id = ?'),
    cancelPendingChallenges: db.prepare("UPDATE three_ds_challenges SET status = 'canceled', completed_at = ? WHERE payment_intent_id = ? AND status = 'pending'"),
    expirable: db.prepare("SELECT id FROM payment_intents WHERE status = 'requires_capture' AND authorized_at IS NOT NULL AND authorized_at + ? < ? ORDER BY seq"),
  };

  // ---------- sérialisation ----------

  /** includeSecret=false pour les événements (le client_secret ne voyage pas dans les webhooks). */
  function toApi(row, { includeSecret = true } = {}) {
    const pi = {
      id: row.id,
      object: 'payment_intent',
      amount: row.amount,
      amount_capturable: row.amount_capturable,
      amount_received: row.amount_received,
      currency: row.currency,
      status: row.status,
      capture_method: row.capture_method,
      customer: row.customer_id,
      payment_method: row.payment_method_id,
      off_session: Boolean(row.off_session),
      application_fee_amount: row.application_fee_amount,
      transfer_data: row.transfer_destination ? { destination: row.transfer_destination } : null,
      description: row.description,
      metadata: JSON.parse(row.metadata),
      last_payment_error: row.last_payment_error ? JSON.parse(row.last_payment_error) : null,
      next_action: row.next_action ? JSON.parse(row.next_action) : null,
      latest_charge: row.latest_charge,
      canceled_at: row.canceled_at,
      cancellation_reason: row.cancellation_reason,
      created: row.created,
    };
    if (includeSecret) pi.client_secret = row.client_secret;
    return pi;
  }

  function chargeToApi(row) {
    const pm = ctx.vault.getRow(row.payment_method_id);
    return {
      id: row.id,
      object: 'charge',
      payment_intent: row.payment_intent_id,
      payment_method: row.payment_method_id,
      customer: row.customer_id,
      amount: row.amount,
      amount_captured: row.amount_captured,
      amount_refunded: row.amount_refunded,
      refunded: Boolean(row.refunded),
      currency: row.currency,
      status: row.status,
      captured: Boolean(row.captured),
      failure_code: row.failure_code,
      failure_message: row.failure_message,
      outcome: JSON.parse(row.outcome),
      payment_method_details: { type: 'card', card: { brand: pm.brand, last4: pm.last4, three_d_secure: row.three_d_secure } },
      created: row.created,
    };
  }

  // ---------- accès ----------

  function getRow(id) {
    const row = typeof id === 'string' ? stmts.getPi.get(id) : undefined;
    if (!row) throw notFound('payment_intent', id);
    return row;
  }

  /**
   * Accès avec clé publique : le client_secret exact du PI est exigé.
   * Absent → 400 parameter_missing ; faux → 404 resource_missing (même réponse que pour un PI inexistant :
   * avec une clé publique, on ne révèle pas l'existence d'un PI). Fourni avec la clé secrète, il est aussi vérifié.
   */
  function authorizeAccess(id, apiKey, clientSecret) {
    const isPublishable = apiKey && apiKey.type === 'publishable';
    if (isPublishable && (clientSecret === undefined || clientSecret === null || clientSecret === '')) {
      throw invalid('client_secret est requis avec une clé publique.', 'client_secret', 'parameter_missing');
    }
    const row = typeof id === 'string' ? stmts.getPi.get(id) : undefined;
    if (clientSecret !== undefined && clientSecret !== null) {
      if (!row || !safeEqual(String(clientSecret), row.client_secret)) throw notFound('payment_intent', id);
    }
    if (!row) throw notFound('payment_intent', id);
    return row;
  }

  function assertAction(action, row) {
    if (!ACTIONS[action].includes(row.status)) {
      throw stateError(
        `Action « ${action} » impossible : le payment intent ${row.id} est au statut « ${row.status} » (statuts permis : ${ACTIONS[action].join(', ')}).`,
        'payment_intent_unexpected_state',
      );
    }
  }

  /** Applique une mise à jour ; si `status` change, la transition doit figurer dans TRANSITIONS. */
  function patch(row, fields) {
    if (fields.status !== undefined && fields.status !== row.status && !canTransition(row.status, fields.status)) {
      throw stateError(`Transition interdite : ${row.status} → ${fields.status}.`, 'payment_intent_unexpected_state');
    }
    if (fields.status === row.status && fields.status !== undefined && !canTransition(row.status, row.status)) {
      throw stateError(`Transition interdite : ${row.status} → ${fields.status}.`, 'payment_intent_unexpected_state');
    }
    const cols = Object.keys(fields);
    for (const c of cols) if (!MUTABLE_COLUMNS.includes(c)) throw new Error(`Colonne non modifiable : ${c}`);
    if (cols.length === 0) return row;
    db.prepare(`UPDATE payment_intents SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...fields, id: row.id });
    return stmts.getPi.get(row.id);
  }

  const emitPi = (type, row) => ctx.events.emit(type, toApi(row, { includeSecret: false }));

  // ---------- validations de références ----------

  function checkPaymentMethodFor(pmId, customerId, param = 'payment_method') {
    const pm = ctx.vault.getRow(pmId, param);
    if (pm.customer_id && pm.customer_id !== customerId) {
      throw invalid('Ce moyen de paiement est rattaché à un autre client que celui du payment intent.', param, 'payment_method_customer_mismatch');
    }
    return pm;
  }

  /**
   * Split marketplace. Phase 2 : la table `accounts` est minimale (créée par schema.sql) ; la phase 3 (Connect)
   * fournira POST /v1/accounts. Ici on vérifie seulement que la destination existe et est active.
   */
  function checkSplit({ amount, application_fee_amount: fee, transfer_data: transfer }) {
    if (fee !== undefined && fee !== null) {
      if (!transfer) throw invalid('application_fee_amount exige transfer_data.destination.', 'application_fee_amount');
      if (!Number.isSafeInteger(fee) || fee < 0) throw invalid('application_fee_amount doit être un entier >= 0.', 'application_fee_amount');
      if (fee >= amount) throw invalid('application_fee_amount doit être strictement inférieur à amount.', 'application_fee_amount');
    }
    if (transfer) {
      const acct = stmts.getAccount.get(transfer.destination);
      if (!acct) throw invalid(`Aucun compte vendeur "${transfer.destination}".`, 'transfer_data.destination', 'resource_missing');
      if (acct.status !== 'enabled') throw invalid('Le compte vendeur de destination est désactivé.', 'transfer_data.destination', 'account_disabled');
    }
  }

  // ---------- création ----------

  const createTxn = db.transaction((params) => {
    if (params.customer) ctx.customers.assertExists(params.customer, 'customer');
    if (params.payment_method) checkPaymentMethodFor(params.payment_method, params.customer || null);
    checkSplit(params);
    const id = newId('pi');
    stmts.insertPi.run({
      id,
      amount: params.amount,
      currency: params.currency,
      status: params.payment_method ? 'requires_confirmation' : 'requires_payment_method',
      capture_method: params.capture_method || 'automatic',
      client_secret: `${id}_secret_${crypto.randomBytes(18).toString('base64url')}`,
      customer_id: params.customer || null,
      payment_method_id: params.payment_method || null,
      off_session: params.off_session ? 1 : 0,
      application_fee_amount: params.transfer_data ? params.application_fee_amount ?? 0 : null,
      transfer_destination: params.transfer_data ? params.transfer_data.destination : null,
      description: params.description ?? null,
      metadata: JSON.stringify(params.metadata || {}),
      created: clock.now(),
    });
    const row = stmts.getPi.get(id);
    emitPi('payment_intent.created', row);
    return row;
  });

  /** create(params) → { paymentIntent, failure? } ; avec confirm:true, enchaîne la confirmation. */
  function create(params) {
    const row = createTxn(params);
    if (params.confirm) return confirm(row.id, {});
    return { paymentIntent: toApi(row) };
  }

  // ---------- autorisation / capture (internes, appelées DANS une transaction) ----------

  function failureFrom(row) {
    return { ...JSON.parse(row.last_payment_error), paymentIntent: toApi(row) };
  }

  function insertCharge(row, pm, result, { threeDs } = {}) {
    const id = newId('ch');
    const approved = result.approved;
    stmts.insertCharge.run({
      id,
      payment_intent_id: row.id,
      payment_method_id: pm.id,
      customer_id: row.customer_id,
      amount: row.amount,
      currency: row.currency,
      status: approved ? 'succeeded' : 'failed',
      failure_code: approved ? null : result.code,
      decline_code: approved ? null : result.decline_code,
      failure_message: approved ? null : result.message,
      outcome: JSON.stringify(
        approved
          ? { type: 'authorized', network_status: 'approved_by_network', seller_message: 'Paiement autorisé.' }
          : { type: 'issuer_declined', network_status: 'declined_by_network', reason: result.decline_code, seller_message: result.message },
      ),
      three_d_secure: threeDs ? 'authenticated' : null,
      created: clock.now(),
    });
    return stmts.getCharge.get(id);
  }

  /** Passe les écritures de capture (PLAN §4.1) pour un montant capturé A. */
  function postCaptureLedger(row, A) {
    const fee = computePspFee(A);
    const lines = [{ account: 'network_receivable', amount: A }];
    if (row.transfer_destination) {
      const F = row.application_fee_amount || 0;
      lines.push({ account: `merchant:${row.transfer_destination}`, amount: -(A - F) });
      if (F > 0) lines.push({ account: 'platform_balance', amount: -F });
    } else {
      lines.push({ account: 'platform_balance', amount: -A });
    }
    lines.push({ account: 'platform_balance', amount: fee }, { account: 'psp_revenue', amount: -fee });
    return ctx.ledger.post('capture', row.id, lines);
  }

  function doCapture(row, amount) {
    const charge = stmts.getCharge.get(row.latest_charge);
    if (!charge || charge.status !== 'succeeded' || charge.captured) throw new Error(`Charge capturable introuvable pour ${row.id}`);
    if (row.transfer_destination && (row.application_fee_amount || 0) >= amount) {
      throw invalid('Le montant capturé doit être strictement supérieur à application_fee_amount.', 'amount_to_capture', 'amount_too_small');
    }
    postCaptureLedger(row, amount);
    stmts.captureCharge.run(amount, charge.id);
    const next = patch(row, { status: 'succeeded', amount_capturable: 0, amount_received: amount });
    ctx.events.emit('charge.captured', chargeToApi(stmts.getCharge.get(charge.id)));
    emitPi('payment_intent.succeeded', next);
    return next;
  }

  /** Interroge le réseau et applique le résultat. Renvoie la ligne PI à jour. */
  function authorizeWithNetwork(row, { threeDsCompleted = false } = {}) {
    const pm = ctx.vault.getRow(row.payment_method_id);
    const result = ctx.network.authorize({
      pan: ctx.vault.reveal(pm.id),
      amount: row.amount,
      offSession: Boolean(row.off_session),
      threeDsCompleted,
      cvcCheck: pm.cvc_check,
    });

    if (result.requires_3ds) {
      const challengeId = newId('tds');
      stmts.insertChallenge.run(challengeId, row.id, clock.now());
      const next = patch(row, { status: 'requires_action', next_action: JSON.stringify({ type: 'three_d_secure', challenge_id: challengeId }) });
      emitPi('payment_intent.requires_action', next);
      return next;
    }

    const charge = insertCharge(row, pm, result, { threeDs: threeDsCompleted });
    if (!result.approved) {
      const error = { type: 'card_error', code: result.code, decline_code: result.decline_code, message: result.message, charge: charge.id, payment_method: pm.id };
      const next = patch(row, {
        status: 'requires_payment_method',
        payment_method_id: null,
        last_payment_error: JSON.stringify(error),
        next_action: null,
        latest_charge: charge.id,
      });
      ctx.events.emit('charge.failed', chargeToApi(charge));
      emitPi('payment_intent.payment_failed', next);
      return next;
    }

    ctx.events.emit('charge.succeeded', chargeToApi(charge));
    if (row.capture_method === 'manual') {
      const next = patch(row, { status: 'requires_capture', amount_capturable: row.amount, next_action: null, latest_charge: charge.id, authorized_at: clock.now() });
      emitPi('payment_intent.amount_capturable_updated', next);
      return next;
    }
    // Capture automatique : on passe directement par requires_confirmation/requires_action → succeeded.
    const authorized = patch(row, { latest_charge: charge.id, next_action: null, authorized_at: clock.now() });
    return doCapture(authorized, row.amount);
  }

  const outcome = (row) => (row.status === 'requires_payment_method' && row.last_payment_error ? { paymentIntent: toApi(row), failure: failureFrom(row) } : { paymentIntent: toApi(row) });

  // ---------- opérations publiques ----------

  /** confirm(id, { payment_method? }) → { paymentIntent, failure? } */
  const confirm = (id, params = {}) => {
    const result = db.transaction(() => {
      let row = getRow(id);
      assertAction('confirm', row);
      const pmId = params.payment_method || row.payment_method_id;
      if (!pmId) throw invalid('Un moyen de paiement est requis pour confirmer.', 'payment_method', 'payment_method_required');
      checkPaymentMethodFor(pmId, row.customer_id);
      row = patch(row, { status: 'requires_confirmation', payment_method_id: pmId, last_payment_error: null });
      return authorizeWithNetwork(row);
    })();
    return outcome(result);
  };

  /** Fin du challenge 3-D Secure : approve → reprend l'autorisation ; deny → requires_payment_method. */
  function completeThreeDs(challengeId, { result: decision }, apiKey, clientSecret) {
    const challenge = typeof challengeId === 'string' ? stmts.getChallenge.get(challengeId) : undefined;
    if (!challenge) throw notFound('three_ds_challenge', challengeId);
    authorizeAccess(challenge.payment_intent_id, apiKey, clientSecret);
    const row = db.transaction(() => {
      const ch = stmts.getChallenge.get(challengeId);
      if (ch.status !== 'pending') throw stateError(`Ce challenge 3-D Secure est déjà « ${ch.status} ».`, 'three_ds_already_completed');
      let pi = stmts.getPi.get(ch.payment_intent_id);
      assertAction('complete_3ds', pi);
      stmts.completeChallenge.run(decision === 'approve' ? 'approved' : 'denied', clock.now(), ch.id);
      if (decision === 'approve') return authorizeWithNetwork(pi, { threeDsCompleted: true });
      const error = {
        type: 'card_error',
        code: 'payment_intent_authentication_failure',
        decline_code: 'authentication_failed',
        message: "L'authentification 3-D Secure a échoué ou a été refusée.",
        payment_method: pi.payment_method_id,
      };
      pi = patch(pi, { status: 'requires_payment_method', payment_method_id: null, next_action: null, last_payment_error: JSON.stringify(error) });
      emitPi('payment_intent.payment_failed', pi);
      return pi;
    })();
    return outcome(row);
  }

  const capture = db.transaction((id, { amount_to_capture: amountToCapture } = {}) => {
    const row = getRow(id);
    assertAction('capture', row);
    const amount = amountToCapture === undefined ? row.amount_capturable : amountToCapture;
    if (!Number.isSafeInteger(amount) || amount <= 0) throw invalid('amount_to_capture doit être un entier > 0.', 'amount_to_capture');
    if (amount > row.amount_capturable) {
      throw invalid(`amount_to_capture (${amount}) dépasse le montant autorisé (${row.amount_capturable}).`, 'amount_to_capture', 'amount_too_large');
    }
    return toApi(doCapture(row, amount));
  });

  const cancel = db.transaction((id, { cancellation_reason: reason } = {}) => {
    const row = getRow(id);
    assertAction('cancel', row);
    return toApi(cancelRow(row, reason || null, clock.now()));
  });

  function cancelRow(row, reason, ts) {
    stmts.cancelPendingChallenges.run(ts, row.id);
    const next = patch(row, { status: 'canceled', amount_capturable: 0, next_action: null, canceled_at: ts, cancellation_reason: reason });
    emitPi('payment_intent.canceled', next);
    return next;
  }

  /**
   * Expiration des autorisations : tout PI requires_capture autorisé depuis PLUS de 7 jours (now > authorized_at + 7 j)
   * passe à canceled (cancellation_reason "expired"). Aucune écriture ledger (rien n'a été capturé).
   * Appelé par testclock.advance (phase 4) ou une tâche périodique. Renvoie les ids expirés.
   */
  function expireAuthorizations(now = clock.now()) {
    const ids = stmts.expirable.all(AUTHORIZATION_TTL, now).map((r) => r.id);
    const expireOne = db.transaction((id) => {
      const row = stmts.getPi.get(id);
      if (!ACTIONS.expire.includes(row.status)) return false;
      cancelRow(row, 'expired', now);
      return true;
    });
    return ids.filter((id) => expireOne(id));
  }

  function get(id, apiKey, clientSecret) {
    return toApi(authorizeAccess(id, apiKey, clientSecret));
  }

  function list({ limit, startingAfter, customer } = {}) {
    return paginate(db, {
      table: 'payment_intents',
      where: customer ? 'customer_id = ?' : undefined,
      params: customer ? [customer] : [],
      limit,
      startingAfter,
      map: (r) => toApi(r),
    });
  }

  function getCharge(id) {
    const row = typeof id === 'string' ? stmts.getCharge.get(id) : undefined;
    if (!row) throw notFound('charge', id);
    return chargeToApi(row);
  }

  function listCharges({ limit, startingAfter, paymentIntent } = {}) {
    return paginate(db, {
      table: 'charges',
      where: paymentIntent ? 'payment_intent_id = ?' : undefined,
      params: paymentIntent ? [paymentIntent] : [],
      limit,
      startingAfter,
      map: chargeToApi,
    });
  }

  return {
    create,
    confirm,
    completeThreeDs,
    capture,
    cancel,
    expireAuthorizations,
    authorizeAccess,
    get,
    list,
    getCharge,
    listCharges,
    toApi,
    STATUSES,
    TRANSITIONS,
    ACTIONS,
    CANCELLATION_REASONS,
    AUTHORIZATION_TTL,
  };
}

/** Convertit un résultat { paymentIntent, failure } en réponse : 402 card_error avec error.payment_intent si refus. */
function failureToError(failure) {
  const { paymentIntent, code, decline_code: declineCode, message, charge } = failure;
  return cardError(code, message, { decline_code: declineCode, charge: charge || null, payment_intent: paymentIntent });
}

module.exports = { createPayments, failureToError, TRANSITIONS, ACTIONS, STATUSES, canTransition, AUTHORIZATION_TTL };

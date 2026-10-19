'use strict';
const { newId } = require('../../lib/ids');
const { invalid, notFound, stateError } = require('../../lib/errors');
const { paginate } = require('../../lib/pagination');

const REASONS = ['duplicate', 'fraudulent', 'requested_by_customer'];

/**
 * Part de commission rendue au vendeur : round(F * R / A), en arithmétique ENTIÈRE (taskForLesson L3).
 * Arrondi au demi supérieur : floor((2·F·R + A) / (2·A)). F, R, A ≤ 99 999 999 → produits < 2^53.
 */
function computeFeeShare(F, R, A) {
  if (!Number.isSafeInteger(F) || !Number.isSafeInteger(R) || !Number.isSafeInteger(A) || F < 0 || R <= 0 || A <= 0) {
    throw new RangeError('computeFeeShare : entiers attendus (F >= 0, R > 0, A > 0).');
  }
  return Math.floor((2 * F * R + A) / (2 * A));
}

/**
 * Remboursements (PLAN §4.6). Le simulateur rembourse toujours : statut `succeeded` immédiat.
 *
 * Écritures (PLAN §4.1), remboursement R d'un PI capturé pour A, commission F, destination M optionnelle :
 *   Dr (merchant:M si destination, sinon platform_balance) R ; Cr network_receivable R
 *   si refund_application_fee : Dr platform_balance feeShare ; Cr merchant:M feeShare
 *     avec feeShare = round(F·R/A) pour un premier remboursement. Pour les suivants, l'arrondi est CUMULATIF :
 *     feeShare = round(F·(ΣR' + R)/A) − Σ feeShare' (R' = remboursements précédents avec refund_application_fee).
 *     Ainsi Σ feeShare = round(F·ΣR/A) ≤ F, et = F exactement après un remboursement total (pas de dérive d'arrondi :
 *     3 × round(1·1/3) donnerait 0 au lieu de 1).
 *   Frais PSP non remboursés.
 *
 * Solde négatif : aucun contrôle de solde sur un remboursement. Le compte débité (vendeur ou plateforme)
 * peut devenir négatif, comme chez les vrais PSP ; il se renfloue sur les paiements suivants.
 * Les payouts, eux, exigent un solde suffisant (connect).
 */
function createRefunds(ctx) {
  const { db, clock } = ctx;
  const stmts = {
    insert: db.prepare(`
      INSERT INTO refunds (id, payment_intent_id, charge_id, amount, currency, status, reason, refund_application_fee,
        application_fee_refunded, debited_account, metadata, created)
      VALUES (@id, @payment_intent_id, @charge_id, @amount, @currency, 'succeeded', @reason, @refund_application_fee,
        @application_fee_refunded, @debited_account, @metadata, @created)`),
    get: db.prepare('SELECT * FROM refunds WHERE id = ?'),
    getPi: db.prepare('SELECT * FROM payment_intents WHERE id = ?'),
    getCharge: db.prepare('SELECT * FROM charges WHERE id = ?'),
    // Cumul des remboursements AVEC restitution de commission, et commission déjà rendue.
    feeRefundedSoFar: db.prepare(`SELECT COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(application_fee_refunded), 0) AS fee
      FROM refunds WHERE charge_id = ? AND refund_application_fee = 1`),
    updateCharge: db.prepare('UPDATE charges SET amount_refunded = ?, refunded = ? WHERE id = ?'),
  };

  function toApi(row) {
    return {
      id: row.id,
      object: 'refund',
      amount: row.amount,
      currency: row.currency,
      payment_intent: row.payment_intent_id,
      charge: row.charge_id,
      status: row.status,
      reason: row.reason,
      refund_application_fee: Boolean(row.refund_application_fee),
      application_fee_refunded: row.application_fee_refunded,
      metadata: JSON.parse(row.metadata),
      created: row.created,
    };
  }

  /** Toute la vérification ET l'écriture dans la même transaction : deux remboursements concurrents ne peuvent pas dépasser le capturé. */
  const create = db.transaction((params) => {
    const { payment_intent: piId, reason, metadata } = params;
    const refundFee = Boolean(params.refund_application_fee);

    const pi = typeof piId === 'string' ? stmts.getPi.get(piId) : undefined;
    if (!pi) throw invalid(`Aucun payment intent "${piId}".`, 'payment_intent', 'resource_missing');
    if (pi.status !== 'succeeded') {
      throw stateError(
        `Remboursement impossible : le payment intent ${pi.id} est au statut « ${pi.status} » (seul un paiement capturé, « succeeded », est remboursable).`,
        'payment_intent_unexpected_state',
      );
    }
    const charge = stmts.getCharge.get(pi.latest_charge);
    if (!charge || charge.status !== 'succeeded' || !charge.captured || charge.amount_captured <= 0) {
      throw stateError(`Aucune charge capturée pour ${pi.id}.`, 'charge_not_captured');
    }

    const A = charge.amount_captured;
    const remaining = A - charge.amount_refunded;
    if (remaining <= 0) throw invalid(`La charge ${charge.id} est déjà intégralement remboursée.`, 'amount', 'charge_already_refunded');
    const R = params.amount === undefined ? remaining : params.amount;
    if (!Number.isSafeInteger(R) || R <= 0) throw invalid('amount doit être un entier de centimes > 0.', 'amount', 'amount_invalid');
    if (R > remaining) {
      throw invalid(
        `Le remboursement (${R}) dépasse le montant remboursable (${remaining} = capturé ${A} − déjà remboursé ${charge.amount_refunded}).`,
        'amount',
        'amount_too_large',
      );
    }

    const destination = pi.transfer_destination;
    if (refundFee && !destination) {
      throw invalid("refund_application_fee n'a de sens que pour un paiement avec transfer_data.destination.", 'refund_application_fee');
    }
    const debited = destination ? `merchant:${destination}` : 'platform_balance';

    let feeShare = 0;
    if (refundFee) {
      const F = pi.application_fee_amount || 0;
      const prior = stmts.feeRefundedSoFar.get(charge.id);
      feeShare = computeFeeShare(F, prior.amount + R, A) - prior.fee;
    }

    const id = newId('re');
    const lines = [
      { account: debited, amount: R },
      { account: 'network_receivable', amount: -R },
    ];
    if (feeShare > 0) lines.push({ account: 'platform_balance', amount: feeShare }, { account: debited, amount: -feeShare });
    ctx.ledger.post('refund', id, lines);

    stmts.insert.run({
      id,
      payment_intent_id: pi.id,
      charge_id: charge.id,
      amount: R,
      currency: charge.currency,
      reason: reason ?? null,
      refund_application_fee: refundFee ? 1 : 0,
      application_fee_refunded: feeShare,
      debited_account: debited,
      metadata: JSON.stringify(metadata || {}),
      created: clock.now(),
    });
    const totalRefunded = charge.amount_refunded + R;
    stmts.updateCharge.run(totalRefunded, totalRefunded === A ? 1 : 0, charge.id);

    const refund = toApi(stmts.get.get(id));
    ctx.events.emit('refund.created', refund);
    ctx.events.emit('charge.refunded', ctx.payments.getCharge(charge.id));
    return refund;
  });

  function get(id) {
    const row = typeof id === 'string' ? stmts.get.get(id) : undefined;
    if (!row) throw notFound('refund', id);
    return toApi(row);
  }

  function list({ limit, startingAfter, paymentIntent } = {}) {
    return paginate(db, {
      table: 'refunds',
      where: paymentIntent ? 'payment_intent_id = ?' : undefined,
      params: paymentIntent ? [paymentIntent] : [],
      limit,
      startingAfter,
      map: toApi,
    });
  }

  return { create, get, list, toApi };
}

module.exports = { createRefunds, computeFeeShare, REASONS };

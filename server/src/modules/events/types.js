'use strict';

/**
 * Liste CENTRALISÉE des types d'événements réellement émis par PaySim (phases 1 à 4).
 * Sert à valider `enabled_events` des webhook endpoints et à exposer GET /v1/event_types.
 * Un test (test/webhooks.test.js) vérifie qu'elle correspond EXACTEMENT aux appels `emit*('type', ...)` du code :
 * tout nouveau type émis doit être ajouté ici.
 */
const EVENT_TYPES = Object.freeze([
  // customers
  'customer.created',
  'customer.updated',
  // vault
  'payment_method.created',
  'payment_method.attached',
  // payments
  'payment_intent.created',
  'payment_intent.requires_action',
  'payment_intent.amount_capturable_updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.succeeded',
  'charge.failed',
  'charge.captured',
  // refunds
  'refund.created',
  'charge.refunded',
  // connect
  'account.created',
  'transfer.created',
  'payout.paid',
  // billing
  'product.created',
  'price.created',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.finalized',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.marked_uncollectible',
  'invoice.voided',
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

module.exports = { EVENT_TYPES, EVENT_TYPE_SET };

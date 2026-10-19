'use strict';
const { newId } = require('../../lib/ids');
const { invalid, notFound } = require('../../lib/errors');
const { paginate } = require('../../lib/pagination');

/** Clients (PLAN §4.4). */
function createCustomers(ctx) {
  const { db, clock } = ctx;
  const stmts = {
    insert: db.prepare('INSERT INTO customers (id, email, name, metadata, created) VALUES (?, ?, ?, ?, ?)'),
    get: db.prepare('SELECT * FROM customers WHERE id = ?'),
    update: db.prepare('UPDATE customers SET email = ?, name = ?, metadata = ?, default_payment_method = ? WHERE id = ?'),
  };

  function toApi(row) {
    return {
      id: row.id,
      object: 'customer',
      email: row.email,
      name: row.name,
      metadata: JSON.parse(row.metadata),
      invoice_settings: { default_payment_method: row.default_payment_method },
      created: row.created,
    };
  }

  function getRow(id) {
    const row = stmts.get.get(id);
    if (!row) throw notFound('customer', id);
    return row;
  }

  /** Pour les références depuis d'autres objets : client inconnu → 400 resource_missing sur `param`. */
  function assertExists(id, param = 'customer') {
    if (!stmts.get.get(id)) throw invalid(`Aucun client "${id}".`, param, 'resource_missing');
  }

  const create = db.transaction(({ email, name, metadata }) => {
    const id = newId('cus');
    stmts.insert.run(id, email, name ?? null, JSON.stringify(metadata || {}), clock.now());
    const customer = toApi(stmts.get.get(id));
    ctx.events.emit('customer.created', customer);
    return customer;
  });

  const update = db.transaction((id, params) => {
    const row = getRow(id);
    const next = {
      email: params.email ?? row.email,
      name: params.name !== undefined ? params.name : row.name,
      metadata: params.metadata !== undefined ? JSON.stringify({ ...JSON.parse(row.metadata), ...params.metadata }) : row.metadata,
      default_payment_method: row.default_payment_method,
    };
    if (params.invoice_settings && params.invoice_settings.default_payment_method !== undefined) {
      const pmId = params.invoice_settings.default_payment_method;
      if (pmId !== null) {
        const pm = ctx.vault.getRow(pmId, 'invoice_settings.default_payment_method');
        if (pm.customer_id !== id) {
          throw invalid("Le moyen de paiement doit d'abord être rattaché à ce client.", 'invoice_settings.default_payment_method');
        }
      }
      next.default_payment_method = pmId;
    }
    stmts.update.run(next.email, next.name, next.metadata, next.default_payment_method, id);
    const customer = toApi(stmts.get.get(id));
    ctx.events.emit('customer.updated', customer);
    return customer;
  });

  function get(id) {
    return toApi(getRow(id));
  }

  function list({ limit, startingAfter } = {}) {
    return paginate(db, { table: 'customers', limit, startingAfter, map: toApi });
  }

  return { create, update, get, getRow, list, assertExists, toApi };
}

module.exports = { createCustomers };

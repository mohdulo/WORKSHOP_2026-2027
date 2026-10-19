'use strict';
const { newId } = require('../../lib/ids');
const { invalid, notFound, insufficientBalance } = require('../../lib/errors');
const { paginate } = require('../../lib/pagination');
const { CURRENCY } = require('../../lib/money');

const merchantCode = (accountId) => `merchant:${accountId}`;

/**
 * Connect / marketplace (PLAN §4.7).
 *  - accounts  : comptes vendeurs (table créée en phase 2, cf. schema.sql) ; solde = ledger.balanceOf('merchant:<id>').
 *  - transfers : plateforme → vendeur. Dr platform_balance X ; Cr merchant:M X. Refusé (402) si X > solde plateforme.
 *  - payouts   : vendeur → banque (simulé, `paid` immédiat). Dr merchant:M X ; Cr bank_payouts X. Refusé (402) si X > solde vendeur.
 *
 * Les contrôles de solde sont faits DANS la même db.transaction() que l'écriture : better-sqlite3 est synchrone et
 * la transaction sérialise lecture du solde + écriture (pas de course entre deux payouts simultanés).
 */
function createConnect(ctx) {
  const { db, clock } = ctx;
  const stmts = {
    insertAccount: db.prepare("INSERT INTO accounts (id, email, business_name, status, created) VALUES (?, ?, ?, 'enabled', ?)"),
    getAccount: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    insertTransfer: db.prepare(`
      INSERT INTO transfers (id, amount, currency, destination, description, metadata, created)
      VALUES (@id, @amount, @currency, @destination, @description, @metadata, @created)`),
    getTransfer: db.prepare('SELECT * FROM transfers WHERE id = ?'),
    insertPayout: db.prepare(`
      INSERT INTO payouts (id, account_id, amount, currency, status, arrival_date, description, metadata, created)
      VALUES (@id, @account_id, @amount, @currency, 'paid', @arrival_date, @description, @metadata, @created)`),
    getPayout: db.prepare('SELECT * FROM payouts WHERE id = ?'),
  };

  // ---------- sérialisation ----------

  const accountToApi = (row) => ({
    id: row.id,
    object: 'account',
    email: row.email,
    business_name: row.business_name,
    status: row.status,
    created: row.created,
  });

  const transferToApi = (row) => ({
    id: row.id,
    object: 'transfer',
    amount: row.amount,
    currency: row.currency,
    destination: row.destination,
    description: row.description,
    metadata: JSON.parse(row.metadata),
    created: row.created,
  });

  const payoutToApi = (row) => ({
    id: row.id,
    object: 'payout',
    account: row.account_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    arrival_date: row.arrival_date,
    description: row.description,
    metadata: JSON.parse(row.metadata),
    created: row.created,
  });

  /** Même format que GET /v1/balance. */
  const balanceToApi = (amount) => ({ object: 'balance', available: [{ amount, currency: CURRENCY }] });

  // ---------- accounts ----------

  function getAccountRow(id) {
    const row = typeof id === 'string' ? stmts.getAccount.get(id) : undefined;
    if (!row) throw notFound('account', id);
    return row;
  }

  /** Référence depuis un autre objet (transfer, payout) : inconnu → 400 resource_missing, désactivé → 400 account_disabled. */
  function assertUsableAccount(id, param) {
    const row = typeof id === 'string' ? stmts.getAccount.get(id) : undefined;
    if (!row) throw invalid(`Aucun compte vendeur "${id}".`, param, 'resource_missing');
    if (row.status !== 'enabled') throw invalid(`Le compte vendeur ${id} est désactivé.`, param, 'account_disabled');
    return row;
  }

  const createAccount = db.transaction(({ email, business_name: businessName }) => {
    const id = newId('acct');
    stmts.insertAccount.run(id, email, businessName ?? null, clock.now());
    ctx.ledger.ensureAccount(merchantCode(id), 'liability');
    const account = accountToApi(stmts.getAccount.get(id));
    ctx.events.emit('account.created', account);
    return account;
  });

  function getAccount(id) {
    return accountToApi(getAccountRow(id));
  }

  function listAccounts({ limit, startingAfter } = {}) {
    return paginate(db, { table: 'accounts', limit, startingAfter, map: accountToApi });
  }

  function accountBalance(id) {
    getAccountRow(id);
    return balanceToApi(ctx.ledger.balanceOf(merchantCode(id)));
  }

  // ---------- transfers ----------

  const createTransfer = db.transaction(({ amount, destination, description, metadata }) => {
    assertUsableAccount(destination, 'destination');
    const available = ctx.ledger.balanceOf('platform_balance');
    if (amount > available) {
      throw insufficientBalance(`Solde plateforme insuffisant : ${available} disponible(s), ${amount} demandé(s).`);
    }
    const id = newId('tr');
    ctx.ledger.post('transfer', id, [
      { account: 'platform_balance', amount },
      { account: merchantCode(destination), amount: -amount },
    ]);
    stmts.insertTransfer.run({
      id,
      amount,
      currency: CURRENCY,
      destination,
      description: description ?? null,
      metadata: JSON.stringify(metadata || {}),
      created: clock.now(),
    });
    const transfer = transferToApi(stmts.getTransfer.get(id));
    ctx.events.emit('transfer.created', transfer);
    return transfer;
  });

  function getTransfer(id) {
    const row = typeof id === 'string' ? stmts.getTransfer.get(id) : undefined;
    if (!row) throw notFound('transfer', id);
    return transferToApi(row);
  }

  function listTransfers({ limit, startingAfter, destination } = {}) {
    return paginate(db, {
      table: 'transfers',
      where: destination ? 'destination = ?' : undefined,
      params: destination ? [destination] : [],
      limit,
      startingAfter,
      map: transferToApi,
    });
  }

  // ---------- payouts ----------

  const createPayout = db.transaction(({ account, amount, description, metadata }) => {
    assertUsableAccount(account, 'account');
    const available = ctx.ledger.balanceOf(merchantCode(account));
    if (amount > available) {
      throw insufficientBalance(`Solde vendeur insuffisant : ${available} disponible(s), ${amount} demandé(s).`);
    }
    const id = newId('po');
    const now = clock.now();
    ctx.ledger.post('payout', id, [
      { account: merchantCode(account), amount },
      { account: 'bank_payouts', amount: -amount },
    ]);
    stmts.insertPayout.run({
      id,
      account_id: account,
      amount,
      currency: CURRENCY,
      arrival_date: now,
      description: description ?? null,
      metadata: JSON.stringify(metadata || {}),
      created: now,
    });
    const payout = payoutToApi(stmts.getPayout.get(id));
    ctx.events.emit('payout.paid', payout);
    return payout;
  });

  function getPayout(id) {
    const row = typeof id === 'string' ? stmts.getPayout.get(id) : undefined;
    if (!row) throw notFound('payout', id);
    return payoutToApi(row);
  }

  function listPayouts({ limit, startingAfter, account } = {}) {
    return paginate(db, {
      table: 'payouts',
      where: account ? 'account_id = ?' : undefined,
      params: account ? [account] : [],
      limit,
      startingAfter,
      map: payoutToApi,
    });
  }

  return {
    createAccount,
    getAccount,
    listAccounts,
    accountBalance,
    balanceToApi,
    createTransfer,
    getTransfer,
    listTransfers,
    createPayout,
    getPayout,
    listPayouts,
    merchantCode,
  };
}

module.exports = { createConnect, merchantCode };

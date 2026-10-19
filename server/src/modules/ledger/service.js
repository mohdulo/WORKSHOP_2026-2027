'use strict';
const { newId } = require('../../lib/ids');
const { invalid, notFound } = require('../../lib/errors');
const { paginate } = require('../../lib/pagination');

/**
 * Grand livre en partie double (PLAN §4.1).
 *
 * CONVENTION DE SIGNE
 *   Chaque écriture a un montant signé : + = débit, − = crédit. Chaque transaction somme à 0,
 *   donc la somme de TOUTES les écritures du livre vaut 0 (check()).
 *
 * TYPES DE COMPTES ET SOLDE AFFICHÉ (balanceOf)
 *   - asset (actif, solde « débiteur ») : network_receivable (argent dû par le réseau carte).
 *       solde = + somme des écritures.
 *   - liability (passif, solde « créditeur ») : platform_balance, merchant:<acct_id>, bank_payouts.
 *       solde = − somme des écritures (affiché positif quand on doit de l'argent à ce compte).
 *   - revenue (produit, solde créditeur) : psp_revenue.
 *       solde = − somme des écritures.
 *   Ainsi : capture de A sans destination → network_receivable = A, platform_balance = A − fee, psp_revenue = fee.
 */
const SYSTEM_ACCOUNTS = {
  network_receivable: 'asset',
  platform_balance: 'liability',
  psp_revenue: 'revenue',
  bank_payouts: 'liability',
};
const ACCOUNT_TYPES = ['asset', 'liability', 'revenue'];
const MERCHANT_RE = /^merchant:acct_[0-9A-Za-z]{24}$/;

function defaultTypeFor(code) {
  if (SYSTEM_ACCOUNTS[code]) return SYSTEM_ACCOUNTS[code];
  if (MERCHANT_RE.test(code)) return 'liability';
  return null;
}

function createLedger(ctx) {
  const { db, clock } = ctx;

  const stmts = {
    getAccount: db.prepare('SELECT * FROM ledger_accounts WHERE code = ?'),
    insertAccount: db.prepare('INSERT INTO ledger_accounts (code, type, created) VALUES (?, ?, ?)'),
    insertTxn: db.prepare('INSERT INTO ledger_transactions (id, kind, ref_id, created) VALUES (?, ?, ?, ?)'),
    insertEntry: db.prepare('INSERT INTO ledger_entries (txn_id, account_code, amount) VALUES (?, ?, ?)'),
    sumAccount: db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries WHERE account_code = ?'),
    sumAll: db.prepare('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM ledger_entries'),
    unbalancedTxns: db.prepare('SELECT txn_id, SUM(amount) AS total FROM ledger_entries GROUP BY txn_id HAVING SUM(amount) <> 0'),
    entriesOf: db.prepare('SELECT account_code, amount FROM ledger_entries WHERE txn_id = ? ORDER BY id'),
    allAccounts: db.prepare(`
      SELECT a.code, a.type, COALESCE(SUM(e.amount), 0) AS total, COUNT(e.id) AS entries
      FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_code = a.code
      GROUP BY a.code, a.type ORDER BY a.id`),
  };

  /** Crée le compte s'il n'existe pas ; vérifie que le type est cohérent s'il existe. */
  function ensureAccount(code, type) {
    const resolvedType = type || defaultTypeFor(code);
    if (!resolvedType || !ACCOUNT_TYPES.includes(resolvedType)) throw new Error(`Compte ledger inconnu ou type invalide : ${code}`);
    const existing = stmts.getAccount.get(code);
    if (existing) {
      if (existing.type !== resolvedType) throw new Error(`Compte ${code} déjà créé avec le type ${existing.type}.`);
      return existing;
    }
    stmts.insertAccount.run(code, resolvedType, clock.now());
    return stmts.getAccount.get(code);
  }

  function validateLines(lines) {
    if (!Array.isArray(lines) || lines.length < 2) {
      throw invalid('Une transaction comptable exige au moins 2 lignes.', 'lines', 'ledger_invalid');
    }
    let sum = 0;
    for (const [i, line] of lines.entries()) {
      if (!line || typeof line.account !== 'string') throw invalid(`Ligne ${i} : compte manquant.`, `lines[${i}].account`, 'ledger_invalid');
      if (!Number.isSafeInteger(line.amount) || line.amount === 0) {
        throw invalid(`Ligne ${i} : montant entier non nul exigé.`, `lines[${i}].amount`, 'ledger_invalid');
      }
      sum += line.amount;
    }
    if (sum !== 0) throw invalid(`Transaction déséquilibrée (somme = ${sum}).`, 'lines', 'ledger_unbalanced');
  }

  /**
   * Passe une transaction équilibrée. Tout est fait dans une transaction SQL : rien n'est écrit en cas d'erreur.
   * Appelé depuis un db.transaction() englobant, better-sqlite3 crée un SAVEPOINT (imbrication sûre).
   */
  const postTxn = db.transaction((kind, refId, lines) => {
    validateLines(lines);
    for (const line of lines) ensureAccount(line.account);
    const id = newId('txn');
    const created = clock.now();
    stmts.insertTxn.run(id, kind, refId ?? null, created);
    for (const line of lines) stmts.insertEntry.run(id, line.account, line.amount);
    return { id, object: 'ledger_transaction', kind, ref_id: refId ?? null, created, entries: lines.map((l) => ({ account: l.account, amount: l.amount })) };
  });

  function post(kind, refId, lines) {
    if (typeof kind !== 'string' || kind === '') throw invalid('kind requis.', 'kind', 'ledger_invalid');
    return postTxn(kind, refId, lines);
  }

  /** Solde affiché d'un compte (cf. convention en tête de fichier). Compte inexistant → 0. */
  function balanceOf(code) {
    const account = stmts.getAccount.get(code);
    const type = account ? account.type : defaultTypeFor(code);
    if (!type) throw notFound('ledger account', code);
    const { total } = stmts.sumAccount.get(code);
    // `0 - total` et non `-total` : -0 (compte passif à zéro) fausserait Object.is/toBe et serait invisible en JSON (taskForLesson L8).
    return type === 'asset' ? total : 0 - total;
  }

  /** Contrôle global : somme de toutes les écritures = 0 et chaque transaction équilibrée. */
  function check() {
    const { total, n } = stmts.sumAll.get();
    const unbalanced = stmts.unbalancedTxns.all();
    return { object: 'ledger_check', balanced: total === 0 && unbalanced.length === 0, total, entries: n, unbalanced_transactions: unbalanced.map((u) => u.txn_id) };
  }

  /**
   * Phase 6 (dashboard) : tous les comptes avec leur solde affiché (même convention que balanceOf) et la somme
   * brute signée des écritures (`net`, + débit / − crédit). Σ net = 0 quand le livre est équilibré.
   */
  function listAccounts() {
    return {
      object: 'list',
      data: stmts.allAccounts.all().map((r) => ({
        object: 'ledger_account',
        code: r.code,
        type: r.type,
        balance: r.type === 'asset' ? r.total : 0 - r.total, // L8 : jamais -0
        net: r.total,
        entries: r.entries,
      })),
      has_more: false,
    };
  }

  function txnToApi(row) {
    return { id: row.id, object: 'ledger_transaction', kind: row.kind, ref_id: row.ref_id, created: row.created, entries: stmts.entriesOf.all(row.id).map((e) => ({ account: e.account_code, amount: e.amount })) };
  }

  function listTransactions({ limit, startingAfter, refId } = {}) {
    return paginate(db, {
      table: 'ledger_transactions',
      where: refId ? 'ref_id = ?' : undefined,
      params: refId ? [refId] : [],
      limit,
      startingAfter,
      map: txnToApi,
    });
  }

  // Comptes système créés d'office.
  db.transaction(() => {
    for (const [code, type] of Object.entries(SYSTEM_ACCOUNTS)) ensureAccount(code, type);
  })();

  return { ensureAccount, post, balanceOf, check, listTransactions, listAccounts, SYSTEM_ACCOUNTS };
}

module.exports = { createLedger, SYSTEM_ACCOUNTS };

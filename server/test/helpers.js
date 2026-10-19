'use strict';
const { Writable } = require('node:stream');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createClock } = require('../src/lib/clock');
const { createLogger } = require('../src/lib/logger');

const config = loadConfig({}); // valeurs de dev par défaut, indépendantes de l'env du poste
const SK = config.secretKey;
const PK = config.publishableKey;
const T0 = 1767225600; // 2026-01-01T00:00:00Z

/** Flux mémoire : capture les lignes de log produites par pino. */
function memoryStream() {
  const lines = [];
  const stream = new Writable({
    write(chunk, enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines, text: () => lines.join('') };
}

function makeApp(opts = {}) {
  return createApp({
    dbPath: ':memory:',
    config: opts.config || config,
    clock: opts.clock || createClock(T0),
    logger: opts.logger || createLogger({ level: 'silent' }),
    rateLimit: false,
    modules: opts.modules,
  });
}

const auth = (key = SK) => ({ Authorization: `Bearer ${key}` });

// ---------- helpers phase 2 (paiement unique) ----------
const request = require('supertest');
const { newId } = require('../src/lib/ids');

/** Tokenise une carte via l'API (clé pk par défaut). Renvoie la réponse supertest. */
function tokenize(app, number, { key = PK, exp_month = 12, exp_year = 2030, cvc = '123' } = {}) {
  return request(app).post('/v1/payment_methods').set(auth(key)).send({ card: { number, exp_month, exp_year, cvc } });
}

/** Tokenise et renvoie l'id pm_ (échoue le test si la tokenisation ne renvoie pas 200). */
async function pmFor(app, number, opts) {
  const res = await tokenize(app, number, opts);
  if (res.status !== 200) throw new Error(`tokenisation ${res.status} : ${JSON.stringify(res.body)}`);
  return res.body.id;
}

function createPi(app, body, { key = SK, idem } = {}) {
  const r = request(app).post('/v1/payment_intents').set(auth(key));
  if (idem) r.set('Idempotency-Key', idem);
  return r.send({ currency: 'eur', ...body });
}

function confirmPi(app, id, body = {}, { key = SK, idem } = {}) {
  const r = request(app).post(`/v1/payment_intents/${id}/confirm`).set(auth(key));
  if (idem) r.set('Idempotency-Key', idem);
  return r.send(body);
}

/**
 * Compte vendeur minimal (table `accounts` de phase 2, sans API : POST /v1/accounts arrive en phase 3).
 * Insertion directe en base, réservée aux tests.
 */
function insertAccount(ctx, { status = 'enabled' } = {}) {
  const id = newId('acct');
  ctx.db.prepare('INSERT INTO accounts (id, email, business_name, status, created) VALUES (?, ?, ?, ?, ?)').run(id, 'v@example.com', 'Vendeur', status, ctx.clock.now());
  return id;
}

// ---------- helpers phase 3 (remboursements, marketplace) ----------

/** Crée un vendeur via l'API (POST /v1/accounts) et renvoie son id acct_. */
async function createSeller(app, body = {}) {
  const res = await request(app).post('/v1/accounts').set(auth()).send({ email: 'vendeur@example.com', business_name: 'Vendeur', ...body });
  if (res.status !== 200) throw new Error(`création vendeur ${res.status} : ${JSON.stringify(res.body)}`);
  return res.body.id;
}

/** Paiement capturé (carte 4242). Options : destination, fee, capture (capture partielle manuelle). Renvoie le PI. */
async function paidPi(app, amount, { destination, fee, capture } = {}) {
  const pm = await pmFor(app, '4242424242424242');
  const body = { amount, payment_method: pm, confirm: true };
  if (destination) body.transfer_data = { destination };
  if (fee !== undefined) body.application_fee_amount = fee;
  if (capture !== undefined) body.capture_method = 'manual';
  let res = await createPi(app, body);
  if (capture !== undefined) {
    if (res.status !== 200) throw new Error(`PI ${res.status} : ${JSON.stringify(res.body)}`);
    res = await request(app).post(`/v1/payment_intents/${res.body.id}/capture`).set(auth()).send({ amount_to_capture: capture });
  }
  if (res.status !== 200 || res.body.status !== 'succeeded') throw new Error(`paiement ${res.status} : ${JSON.stringify(res.body)}`);
  return res.body;
}

function refund(app, body, { idem } = {}) {
  const r = request(app).post('/v1/refunds').set(auth());
  if (idem) r.set('Idempotency-Key', idem);
  return r.send(body);
}

const countRows = (ctx, table, where = '1=1', ...params) => ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params).n;

module.exports = {
  config, SK, PK, T0, memoryStream, makeApp, auth, tokenize, pmFor, createPi, confirmPi, insertAccount, countRows,
  createSeller, paidPi, refund,
};

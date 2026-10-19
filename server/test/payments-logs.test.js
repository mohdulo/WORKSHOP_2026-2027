'use strict';
const express = require('express');
const pino = require('pino');
const request = require('supertest');
const { makeApp, memoryStream, auth, PK, SK } = require('./helpers');
const { createLogger } = require('../src/lib/logger');
const { requireKey } = require('../src/middleware/auth');

const PAN = '4000000000003220';
const CVC = '8317';

/**
 * Route de test : un développeur imprudent journalise la carte et le payment intent complet (client_secret inclus),
 * à plusieurs profondeurs. Sert à prouver que REDACT_PATHS couvre ces champs (taskForLesson L2).
 */
const leakyModule = {
  name: 'leaky',
  routes(ctx) {
    const r = express.Router();
    r.post('/_test/leak', requireKey('secret'), (req, res) => {
      const pi = ctx.payments.get(req.body.pi);
      const pmRow = ctx.db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(pi.payment_method);
      req.log.info({ card: req.body.card }, 'carte');
      req.log.info({ body: { card: req.body.card } }, 'corps');
      req.log.info({ client_secret: pi.client_secret }, 'secret');
      req.log.info({ payment_intent: pi }, 'pi');
      req.log.info({ error: { payment_intent: pi } }, 'erreur 402');
      req.log.info({ res: { body: { error: { payment_intent: pi } } } }, 'réponse');
      req.log.info({ row: pmRow }, 'ligne pm');
      req.log.info({ pan: ctx.vault.reveal(pmRow.id) }, 'pan révélé');
      res.json({ ok: true });
    });
    return r;
  },
};

/** Parcours réel : tokenisation (pk) + confirm 3DS + GET pk avec ?client_secret= + erreurs, puis logs imprudents. */
async function scenario(app) {
  const card = { number: PAN, exp_month: 12, exp_year: 2030, cvc: CVC };
  const tok = await request(app).post('/v1/payment_methods').set(auth(PK)).send({ card });
  expect(tok.status).toBe(200);
  // tokenisation refusée (Luhn) : le PAN est dans le corps de la requête en erreur
  await request(app).post('/v1/payment_methods').set(auth(PK)).send({ card: { ...card, number: '4000000000003221' } }).expect(400);
  const pi = (await request(app).post('/v1/payment_intents').set(auth(SK)).send({ amount: 1234, currency: 'eur', payment_method: tok.body.id })).body;
  const c = await request(app).post(`/v1/payment_intents/${pi.id}/confirm`).set(auth(PK)).send({ client_secret: pi.client_secret });
  expect(c.body.status).toBe('requires_action');
  await request(app).get(`/v1/payment_intents/${pi.id}?client_secret=${pi.client_secret}`).set(auth(PK)).expect(200);
  await request(app).post(`/v1/three_ds/${c.body.next_action.challenge_id}/complete`).set(auth(PK)).send({ result: 'approve', client_secret: pi.client_secret }).expect(200);
  await request(app).post('/v1/_test/leak').set(auth(SK)).send({ card, pi: pi.id }).expect(200);
  return pi;
}

describe('sécurité des logs — paiement unique', () => {
  it('ni PAN, ni CVC, ni client_secret, ni PAN chiffré dans la sortie du logger', async () => {
    const mem = memoryStream();
    const { app, ctx } = makeApp({ logger: createLogger({ level: 'debug', stream: mem.stream }), modules: [leakyModule] });
    const pi = await scenario(app);
    const out = mem.text();
    const enc = ctx.db.prepare('SELECT pan_encrypted FROM payment_methods').get().pan_encrypted;

    expect(out).toContain('payment_method créé'); // les logs de la vraie route sont bien capturés
    expect(out).toContain('"last4":"3220"');
    expect(out).toContain('client_secret=[Redacted]'); // URL pino-http masquée
    expect(out.match(/\[Redacted\]/g).length).toBeGreaterThanOrEqual(8);
    expect(out).not.toContain(PAN);
    expect(out).not.toContain(CVC);
    expect(out).not.toContain(pi.client_secret);
    expect(out).not.toContain('_secret_');
    expect(out).not.toContain(enc);
    expect(out).not.toContain(SK);
  });

  it('contrôle positif (mutation) : le même scénario avec un logger SANS redact fait fuiter les secrets', async () => {
    const mem = memoryStream();
    const naked = pino({ level: 'debug' }, mem.stream); // aucun redact
    const { app } = makeApp({ logger: naked, modules: [leakyModule] });
    const pi = await scenario(app);
    const out = mem.text();
    // si ces assertions échouaient, le test précédent ne prouverait rien
    expect(out).toContain(PAN);
    expect(out).toContain(CVC);
    expect(out).toContain(pi.client_secret);
  });
});

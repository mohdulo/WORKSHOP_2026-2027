'use strict';
const express = require('express');
const request = require('supertest');
const { makeApp, memoryStream, auth, SK } = require('./helpers');
const { createLogger } = require('../src/lib/logger');
const { requireKey } = require('../src/middleware/auth');

const PAN = '4242424242424242';
const CVC = '123';

// Route de test qui logue aussi explicitement l'objet carte (cas d'un développeur imprudent).
const testModule = {
  name: 'logsTest',
  routes() {
    const r = express.Router();
    r.post('/_test/echo', requireKey('secret'), (req, res) => {
      req.log.info({ card: req.body.card }, 'carte reçue');
      req.log.info({ payload: { card: req.body.card } }, 'payload reçu');
      res.json({ ok: true });
    });
    return r;
  },
};

describe('sécurité des logs', () => {
  it('ni le PAN, ni le CVC, ni la clé secrète n\'apparaissent dans les logs', async () => {
    const mem = memoryStream();
    const logger = createLogger({ level: 'debug', stream: mem.stream });
    const { app } = makeApp({ logger, modules: [testModule] });

    const body = { card: { number: PAN, cvc: CVC, exp_month: 12, exp_year: 2030 } };
    await request(app).post('/v1/_test/echo').set(auth()).send(body).expect(200);
    // erreur 4xx (route inconnue) avec le même corps
    await request(app).post('/v1/inconnue').set(auth()).send(body).expect(404);
    // JSON mal formé contenant un PAN : body-parser attache le corps brut à l'erreur
    await request(app).post('/v1/_test/echo').set(auth()).set('Content-Type', 'application/json').send(`{"card":{"number":"${PAN}","cvc":"${CVC}"`).expect(400);

    const out = mem.text();
    expect(mem.lines.length).toBeGreaterThanOrEqual(3);
    expect(out).toContain('[Redacted]');
    expect(out).toContain('exp_month'); // les logs explicites de la route ont bien été capturés (hors champs masqués)
    expect(out).toContain('"statusCode":400'); // la ligne pino-http de l'erreur JSON est bien là
    expect(out).not.toContain(PAN);
    expect(out).not.toContain(`"${CVC}"`);
    expect(out).not.toContain(SK);
  });
});

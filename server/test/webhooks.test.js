'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const request = require('supertest');
const { makeApp, auth, PK, T0, config, memoryStream, paidPi, pmFor, countRows } = require('./helpers');
const { createLogger } = require('../src/lib/logger');
const { requireKey } = require('../src/middleware/auth');
const { EVENT_TYPES } = require('../src/modules/events/types');
const { BACKOFF_SECONDS, MAX_ATTEMPTS } = require('../src/modules/webhooks/service');
const { verifySignature, signatureHeader, parseSignatureHeader } = require('../src/modules/webhooks/verify');

const DAY = 86400;

// ---------------------------------------------------------------------------------------------
// Récepteur HTTP RÉEL (port 0) : capture les requêtes (corps brut) ; comportement réglable.
//   mode : nombre (code HTTP), 'hang' (ne répond jamais), ou fonction (req) => code
// ---------------------------------------------------------------------------------------------
async function startReceiver({ mode = 200, delayMs = 0 } = {}) {
  const received = [];
  const state = { mode, delayMs };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const entry = { method: req.method, url: req.url, headers: req.headers, raw, json: JSON.parse(raw.toString('utf8')) };
      received.push(entry);
      const m = typeof state.mode === 'function' ? state.mode(entry, received.length) : state.mode;
      if (m === 'hang') return; // ne répond jamais
      setTimeout(() => {
        res.writeHead(m, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }, state.delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    state,
    types: () => received.map((r) => r.json.type),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Port fermé : on ouvre un serveur puis on le ferme pour récupérer un port libre. */
async function closedPortUrl() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return `http://127.0.0.1:${port}/hook`;
}

describe('webhooks', () => {
  let app;
  let ctx;
  let receivers;

  const post = (p, body = {}) => request(app).post(p).set(auth()).send(body);
  const get = (p, key) => request(app).get(p).set(auth(key));

  async function receiver(opts) {
    const r = await startReceiver(opts);
    receivers.push(r);
    return r;
  }

  async function endpoint(url, enabledEvents = ['*'], extra = {}) {
    const r = await post('/v1/webhook_endpoints', { url, enabled_events: enabledEvents, ...extra });
    expect(r.status).toBe(200);
    return r.body;
  }

  const deliveries = (endpointId) =>
    ctx.db.prepare('SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY event_seq').all(endpointId);

  const newCustomer = async () => {
    const r = await post('/v1/customers', { email: 'client@example.com' });
    expect(r.status).toBe(200);
    return r.body;
  };

  beforeEach(() => {
    ({ app, ctx } = makeApp());
    receivers = [];
  });
  afterEach(async () => {
    expect(ctx.ledger.check().balanced).toBe(true);
    await Promise.all(receivers.map((r) => r.close()));
  });

  // ------------------------------------------------------------------ verify.js
  describe('verifySignature (bibliothèque marchand)', () => {
    const secret = 'whsec_testSecret';
    const body = Buffer.from('{"id":"evt_1","object":"event","type":"invoice.paid"}');
    const now = 1_800_000_000;

    it('accepte une signature valide (Buffer et chaîne)', () => {
      const header = signatureHeader(secret, now, body);
      expect(header).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
      expect(verifySignature(body, header, secret, 300, now)).toBe(true);
      expect(verifySignature(body.toString(), header, secret, 300, now)).toBe(true);
      expect(verifySignature(new Uint8Array(body), header, secret, 300, now)).toBe(true);
    });

    it('rejette un corps altéré (même d’un octet) et un mauvais secret', () => {
      const header = signatureHeader(secret, now, body);
      const altered = Buffer.from(body);
      altered[altered.length - 2] ^= 1;
      expect(verifySignature(altered, header, secret, 300, now)).toBe(false);
      expect(verifySignature(Buffer.concat([body, Buffer.from(' ')]), header, secret, 300, now)).toBe(false);
      expect(verifySignature(body, header, 'whsec_autre', 300, now)).toBe(false);
      expect(verifySignature(body, header, '', 300, now)).toBe(false);
    });

    it('rejette un timestamp hors tolérance (trop vieux ou dans le futur), borne incluse', () => {
      const header = signatureHeader(secret, now, body);
      expect(verifySignature(body, header, secret, 300, now + 300)).toBe(true);
      expect(verifySignature(body, header, secret, 300, now + 301)).toBe(false);
      expect(verifySignature(body, header, secret, 300, now - 301)).toBe(false);
      expect(verifySignature(body, header, secret, 3600, now + 3000)).toBe(true);
      // timestamp modifié dans l'en-tête : la signature ne correspond plus
      const forged = header.replace(`t=${now}`, `t=${now + 10}`);
      expect(verifySignature(body, forged, secret, 300, now + 10)).toBe(false);
    });

    it('rejette les en-têtes malformés', () => {
      const v1 = signatureHeader(secret, now, body).split(',')[1];
      for (const h of [undefined, null, '', 'garbage', `t=${now}`, v1, `t=abc,${v1}`, `t=${now},t=${now},${v1}`, `t=${now},v1`, `t=${now},${v1.slice(0, 20)}`, `t=${now},v1=${'z'.repeat(64)}`, 'x'.repeat(5000)]) {
        expect(verifySignature(body, h, secret, 300, now)).toBe(false);
      }
      expect(parseSignatureHeader(`t=${now},v0=abc,${v1}`)).toEqual({ timestamp: now, signatures: [v1.slice(3)] });
    });

    it('accepte plusieurs v1= (rotation de secret) : valide si l’une correspond', () => {
      const oldSig = signatureHeader('whsec_ancien', now, body).split(',')[1];
      const newSig = signatureHeader(secret, now, body).split(',')[1];
      expect(verifySignature(body, `t=${now},${oldSig},${newSig}`, secret, 300, now)).toBe(true);
      expect(verifySignature(body, `t=${now},${newSig},${oldSig}`, secret, 300, now)).toBe(true);
      expect(verifySignature(body, `t=${now},${oldSig},${newSig}`, 'whsec_ancien', 300, now)).toBe(true);
      expect(verifySignature(body, `t=${now},${oldSig}`, secret, 300, now)).toBe(false);
    });

    it('fichier autonome : aucune dépendance au reste du projet', () => {
      const src = fs.readFileSync(path.join(__dirname, '../src/modules/webhooks/verify.js'), 'utf8');
      const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
      expect(requires).toEqual(['node:crypto']);
    });
  });

  // ------------------------------------------------------------------ types d'événements
  it('EVENT_TYPES = exactement les types émis par le code ; GET /v1/event_types', async () => {
    const files = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (p.endsWith('.js') && !p.endsWith(path.join('events', 'types.js'))) files.push(p);
      }
    };
    walk(path.join(__dirname, '../src'));
    const emitted = new Set();
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/emit[A-Za-z]*\(\s*'([a-z_.]+)'/g)) emitted.add(m[1]);
    }
    expect([...emitted].sort()).toEqual([...EVENT_TYPES].sort());

    const r = await get('/v1/event_types');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ object: 'list', data: [...EVENT_TYPES], has_more: false });
    expect((await get('/v1/event_types', PK)).status).toBe(403);
  });

  // ------------------------------------------------------------------ endpoints CRUD
  describe('webhook endpoints', () => {
    it('création : whsec_ renvoyé une seule fois, jamais par GET / list ; stocké chiffré', async () => {
      const ep = await endpoint('https://marchand.example/hooks', ['invoice.paid', 'invoice.paid', 'charge.refunded'], { description: 'prod' });
      expect(ep).toMatchObject({ object: 'webhook_endpoint', url: 'https://marchand.example/hooks', enabled_events: ['invoice.paid', 'charge.refunded'], description: 'prod', status: 'enabled' });
      expect(ep.id).toMatch(/^we_[0-9A-Za-z]{24}$/);
      expect(ep.secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);

      const one = await get(`/v1/webhook_endpoints/${ep.id}`);
      const list = await get('/v1/webhook_endpoints');
      const updated = await post(`/v1/webhook_endpoints/${ep.id}`, { description: 'x' });
      for (const r of [one, list, updated]) {
        expect(r.status).toBe(200);
        expect(JSON.stringify(r.body)).not.toContain(ep.secret);
        expect(JSON.stringify(r.body)).not.toContain('whsec_');
        expect(JSON.stringify(r.body)).not.toContain('secret');
      }
      const { secret, ...pub } = ep;
      expect(one.body).toEqual(pub);
      expect(list.body).toMatchObject({ object: 'list', has_more: false, data: [pub] });

      // base : pas de secret en clair
      const row = ctx.db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(ep.id);
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(row.secret_encrypted).toMatch(/^v1\./);
    });

    it('validation : URL http(s) seulement, types connus, "*" seul ; pk → 403', async () => {
      for (const url of ['ftp://x.example/h', 'javascript:alert(1)', 'file:///etc/passwd', 'pas une url', '//x.example', 'http://user:pw@x.example/h', '']) {
        const r = await post('/v1/webhook_endpoints', { url, enabled_events: ['*'] });
        expect(r.status).toBe(400);
        expect(r.body.error.param).toBe('url');
      }
      for (const enabled_events of [[], ['*', 'invoice.paid'], ['invoice.inconnu'], ['Invoice.Paid'], 'invoice.paid', [1]]) {
        const r = await post('/v1/webhook_endpoints', { url: 'http://127.0.0.1:1/h', enabled_events });
        expect(r.status).toBe(400);
        expect(r.body.error.param).toMatch(/^enabled_events/);
      }
      expect((await post('/v1/webhook_endpoints', { url: 'http://x.example', enabled_events: ['*'], secret: 'whsec_x' })).status).toBe(400);
      const pk = await request(app).post('/v1/webhook_endpoints').set(auth(PK)).send({ url: 'http://x.example', enabled_events: ['*'] });
      expect(pk.status).toBe(403);
      expect(countRows(ctx, 'webhook_endpoints')).toBe(0);
    });

    it('mise à jour (url, enabled_events, disabled), suppression, 404', async () => {
      const ep = await endpoint('http://127.0.0.1:1/a');
      const r = await post(`/v1/webhook_endpoints/${ep.id}`, { url: 'https://b.example/b', enabled_events: ['payout.paid'], disabled: true });
      expect(r.body).toMatchObject({ url: 'https://b.example/b', enabled_events: ['payout.paid'], status: 'disabled' });
      expect((await post(`/v1/webhook_endpoints/${ep.id}`, { disabled: false })).body.status).toBe('enabled');
      expect((await post(`/v1/webhook_endpoints/${ep.id}`, { url: 'gopher://x' })).status).toBe(400);

      await newCustomer(); // une livraison (cascade à la suppression)
      expect(countRows(ctx, 'webhook_deliveries')).toBe(0); // payout.paid seulement
      await post(`/v1/webhook_endpoints/${ep.id}`, { enabled_events: ['*'] });
      await newCustomer();
      expect(countRows(ctx, 'webhook_deliveries')).toBe(1);

      const del = await request(app).delete(`/v1/webhook_endpoints/${ep.id}`).set(auth());
      expect(del.body).toEqual({ id: ep.id, object: 'webhook_endpoint', deleted: true });
      expect(countRows(ctx, 'webhook_deliveries')).toBe(0);
      expect((await get(`/v1/webhook_endpoints/${ep.id}`)).status).toBe(404);
      expect((await request(app).delete(`/v1/webhook_endpoints/${ep.id}`).set(auth())).status).toBe(404);
      expect((await get(`/v1/webhook_endpoints/${ep.id}/deliveries`)).status).toBe(404);
    });
  });

  // ------------------------------------------------------------------ fan-out
  describe('fan-out', () => {
    it('filtrage enabled_events ; endpoint disabled → aucune livraison ; endpoint créé après → pas les anciens', async () => {
      const rx = await receiver();
      const early = await newCustomer(); // avant tout endpoint
      const onlyCus = await endpoint(rx.url, ['customer.created']);
      const onlyPi = await endpoint(rx.url, ['payment_intent.succeeded']);
      const disabled = await endpoint(rx.url, ['*']);
      await post(`/v1/webhook_endpoints/${disabled.id}`, { disabled: true });

      const cus = await newCustomer();
      await paidPi(app, 1500);

      expect(deliveries(onlyCus.id).map((d) => d.event_type)).toEqual(['customer.created']);
      expect(deliveries(onlyPi.id).map((d) => d.event_type)).toEqual(['payment_intent.succeeded']);
      expect(deliveries(disabled.id)).toEqual([]);

      const res = await ctx.webhooks.deliverPending();
      expect(res.delivered).toHaveLength(2);
      expect(rx.types().sort()).toEqual(['customer.created', 'payment_intent.succeeded']);
      const cusEvent = rx.received.find((r) => r.json.type === 'customer.created').json;
      expect(cusEvent.data.object.id).toBe(cus.id);
      expect(cusEvent.data.object.id).not.toBe(early.id);
    });

    it('un endpoint désactivé APRÈS la création de la livraison n’est pas livré ; réactivé → livré', async () => {
      const rx = await receiver();
      const ep = await endpoint(rx.url, ['customer.created']);
      await newCustomer();
      await post(`/v1/webhook_endpoints/${ep.id}`, { disabled: true });
      expect((await ctx.webhooks.deliverPending()).attempted).toBe(0);
      expect(rx.received).toHaveLength(0);
      await post(`/v1/webhook_endpoints/${ep.id}`, { disabled: false });
      expect((await ctx.webhooks.deliverPending()).delivered).toHaveLength(1);
      expect(rx.received).toHaveLength(1);
    });

    it('même transaction que l’événement : rollback → ni événement ni livraison', async () => {
      await endpoint('http://127.0.0.1:1/h', ['*']);
      const failing = ctx.db.transaction(() => {
        ctx.events.emit('customer.created', { id: 'cus_x' });
        throw new Error('panne après emit');
      });
      expect(() => failing()).toThrow('panne après emit');
      expect(countRows(ctx, 'events')).toBe(0);
      expect(countRows(ctx, 'webhook_deliveries')).toBe(0);
      ctx.events.emit('customer.created', { id: 'cus_y' });
      expect(countRows(ctx, 'webhook_deliveries')).toBe(1);
    });
  });

  // ------------------------------------------------------------------ livraison
  describe('livraison', () => {
    it('paiement réussi → payment_intent.succeeded reçu, signature valide sur le corps brut', async () => {
      const rx = await receiver();
      const ep = await endpoint(rx.url, ['payment_intent.succeeded']);
      const pi = await paidPi(app, 2500);

      const res = await ctx.webhooks.deliverPending();
      expect(res).toMatchObject({ attempted: 1, retry_scheduled: [], failed: [] });
      expect(rx.received).toHaveLength(1);
      const [req] = rx.received;
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.json).toMatchObject({ object: 'event', type: 'payment_intent.succeeded', created: T0, data: { object: { id: pi.id, status: 'succeeded', amount: 2500 } } });
      expect(req.json.id).toMatch(/^evt_/);
      expect(Object.keys(req.json)).toEqual(['id', 'object', 'type', 'created', 'data']);
      expect(req.json).toEqual((await get(`/v1/events/${req.json.id}`)).body); // objet event complet
      expect(req.raw.toString()).not.toContain('_secret_'); // pas de client_secret dans l'event

      const header = req.headers['paysim-signature'];
      expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      expect(verifySignature(req.raw, header, ep.secret)).toBe(true); // tolérance 300 s, horloge réelle
      expect(verifySignature(req.raw, header, 'whsec_faux')).toBe(false);

      const [d] = deliveries(ep.id);
      expect(d).toMatchObject({ status: 'delivered', attempts: 1, last_status_code: 200, last_error: null, next_attempt_at: null, delivered_at: T0 });
      // déjà livré : un second passage n'envoie rien
      expect((await ctx.webhooks.deliverPending()).attempted).toBe(0);
      expect(rx.received).toHaveLength(1);

      const list = await get(`/v1/webhook_endpoints/${ep.id}/deliveries`);
      expect(list.body.data[0]).toMatchObject({ object: 'webhook_delivery', id: d.id, event: req.json.id, event_type: 'payment_intent.succeeded', status: 'delivered', attempts: 1, last_status_code: 200 });
      expect((await get(`/v1/webhook_endpoints/${ep.id}/deliveries?status=pending`)).body.data).toEqual([]);
      expect((await get(`/v1/webhook_endpoints/${ep.id}/deliveries?status=bogus`)).status).toBe(400);
    });

    it('ordre de livraison : par seq d’événement', async () => {
      const rx = await receiver();
      const ep = await endpoint(rx.url, ['*']);
      await paidPi(app, 1000);
      await newCustomer();
      await ctx.webhooks.deliverPending();
      const expected = ctx.db.prepare('SELECT id FROM events ORDER BY seq').all().map((e) => e.id);
      expect(rx.received.map((r) => r.json.id)).toEqual(expected);
      expect(deliveries(ep.id).every((d) => d.status === 'delivered')).toBe(true);
    });

    it('500 → retries 1 min, 5 min, 30 min, 2 h, 8 h puis failed après la 6ᵉ tentative', async () => {
      const rx = await receiver({ mode: 500 });
      const ep = await endpoint(rx.url, ['customer.created']);
      await newCustomer();
      expect(BACKOFF_SECONDS).toEqual([60, 300, 1800, 7200, 28800]);
      expect(MAX_ATTEMPTS).toBe(6);

      let t = T0;
      const expectedNext = [];
      for (let attempt = 1; attempt <= 6; attempt++) {
        const r = await ctx.webhooks.deliverPending();
        expect(r.attempted).toBe(1);
        const [d] = deliveries(ep.id);
        expect(d.attempts).toBe(attempt);
        expect(d.last_status_code).toBe(500);
        expect(d.last_error).toBe('HTTP 500');
        expect(d.last_attempt_at).toBe(t);
        if (attempt < 6) {
          expect(d.status).toBe('pending');
          expect(d.next_attempt_at).toBe(t + BACKOFF_SECONDS[attempt - 1]);
          expectedNext.push(d.next_attempt_at - t);
          // 1 s avant l'échéance : rien
          ctx.clock.advance(BACKOFF_SECONDS[attempt - 1] - 1);
          expect((await ctx.webhooks.deliverPending()).attempted).toBe(0);
          ctx.clock.advance(1);
          t = ctx.clock.now();
        } else {
          expect(d).toMatchObject({ status: 'failed', next_attempt_at: null });
          expect(r.failed).toEqual([d.id]);
        }
      }
      expect(expectedNext).toEqual([60, 300, 1800, 7200, 28800]);
      expect(rx.received).toHaveLength(6);
      // failed est définitif
      ctx.clock.advance(30 * DAY);
      expect((await ctx.webhooks.deliverPending()).attempted).toBe(0);
      expect(rx.received).toHaveLength(6);
      // toutes les tentatives portent le même event, signature valide à chaque fois
      expect(new Set(rx.received.map((r) => r.json.id)).size).toBe(1);
      for (const r of rx.received) expect(verifySignature(r.raw, r.headers['paysim-signature'], ep.secret)).toBe(true);
    });

    it('500 puis 200 au milieu → delivered (3 tentatives)', async () => {
      const rx = await receiver({ mode: (entry, n) => (n < 3 ? 500 : 200) });
      const ep = await endpoint(rx.url, ['customer.created']);
      await newCustomer();
      await ctx.webhooks.deliverPending(); // 1 : 500
      ctx.clock.advance(60);
      await ctx.webhooks.deliverPending(); // 2 : 500
      expect(deliveries(ep.id)[0]).toMatchObject({ status: 'pending', attempts: 2, next_attempt_at: T0 + 60 + 300 });
      ctx.clock.advance(300);
      const r = await ctx.webhooks.deliverPending(); // 3 : 200
      expect(r.delivered).toHaveLength(1);
      expect(deliveries(ep.id)[0]).toMatchObject({ status: 'delivered', attempts: 3, last_status_code: 200, last_error: null, next_attempt_at: null, delivered_at: T0 + 360 });
      ctx.clock.advance(DAY);
      await ctx.webhooks.deliverPending();
      expect(rx.received).toHaveLength(3);
    });

    it('une redirection (3xx) n’est pas un succès et n’est pas suivie', async () => {
      const rx = await receiver({ mode: 302 });
      const ep = await endpoint(rx.url, ['customer.created']);
      await newCustomer();
      await ctx.webhooks.deliverPending();
      expect(deliveries(ep.id)[0]).toMatchObject({ status: 'pending', last_status_code: 302 });
    });

    it('récepteur injoignable (port fermé) → retry, last_error renseigné, pas de code HTTP', async () => {
      const ep = await endpoint(await closedPortUrl(), ['customer.created']);
      await newCustomer();
      const r = await ctx.webhooks.deliverPending();
      expect(r.retry_scheduled).toHaveLength(1);
      const [d] = deliveries(ep.id);
      expect(d).toMatchObject({ status: 'pending', attempts: 1, last_status_code: null, next_attempt_at: T0 + 60 });
      expect(d.last_error).toMatch(/^erreur réseau : ECONNREFUSED/);
    });

    it('timeout : le récepteur ne répond jamais → abandon après webhookTimeoutMs (configurable)', async () => {
      ({ app, ctx } = makeApp({ config: { ...config, webhookTimeoutMs: 300 } }));
      expect(ctx.webhooks.timeoutMs).toBe(300);
      const rx = await receiver({ mode: 'hang' });
      const ep = await endpoint(rx.url, ['customer.created']);
      await newCustomer();
      const start = Date.now();
      const r = await ctx.webhooks.deliverPending();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(290);
      expect(elapsed).toBeLessThan(3000);
      expect(r.retry_scheduled).toHaveLength(1);
      expect(rx.received).toHaveLength(1); // la requête est bien arrivée
      expect(deliveries(ep.id)[0]).toMatchObject({ status: 'pending', attempts: 1, last_status_code: null, last_error: 'timeout après 300 ms', next_attempt_at: T0 + 60 });
      expect(makeApp().ctx.webhooks.timeoutMs).toBe(5000); // défaut
    });

    it('deux deliverPending en parallèle → une seule requête par livraison', async () => {
      const rx = await receiver({ delayMs: 50 }); // réponses lentes : les deux appels se chevauchent
      const a = await endpoint(rx.url, ['*']);
      const b = await endpoint(rx.url, ['customer.created']);
      for (let i = 0; i < 3; i++) await newCustomer();
      const total = countRows(ctx, 'webhook_deliveries');
      expect(total).toBe(6);

      const [r1, r2] = await Promise.all([ctx.webhooks.deliverPending(), ctx.webhooks.deliverPending()]);
      expect(r1.attempted + r2.attempted).toBe(total);
      expect(r1.delivered.length + r2.delivered.length).toBe(total);
      expect(rx.received).toHaveLength(total);
      const keys = rx.received.map((r) => `${r.json.id}`);
      // chaque event est reçu une fois par endpoint qui le suit (2 endpoints suivent customer.created)
      expect(new Set(keys).size).toBe(3);
      expect([...deliveries(a.id), ...deliveries(b.id)].every((d) => d.status === 'delivered' && d.attempts === 1)).toBe(true);
    });

    it('livraisons d’un endpoint supprimé pendant l’envoi : pas de plantage', async () => {
      const rx = await receiver({ delayMs: 50 });
      const ep = await endpoint(rx.url, ['customer.created']);
      await newCustomer();
      await newCustomer();
      const p = ctx.webhooks.deliverPending();
      await request(app).delete(`/v1/webhook_endpoints/${ep.id}`).set(auth());
      const r = await p;
      expect(r.attempted).toBe(2);
      expect(countRows(ctx, 'webhook_deliveries')).toBe(0);
    });
  });

  // ------------------------------------------------------------------ horloge de test
  describe('horloge de test', () => {
    it('POST /v1/test_clock/advance déclenche la livraison : abonnement → invoice.paid reçu', async () => {
      const rx = await receiver();
      const ep = await endpoint(rx.url, ['invoice.paid', 'customer.subscription.updated']);
      const product = (await post('/v1/products', { name: 'Pro' })).body;
      const price = (await post('/v1/prices', { product: product.id, unit_amount: 990, currency: 'eur', recurring: { interval: 'month' } })).body;
      const cus = await newCustomer();
      const pm = await pmFor(app, '4242424242424242');
      await post(`/v1/payment_methods/${pm}/attach`, { customer: cus.id });
      const sub = (await post('/v1/subscriptions', { customer: cus.id, price: price.id, default_payment_method: pm, trial_period_days: 3 })).body;
      expect(sub.status).toBe('trialing');
      expect(deliveries(ep.id)).toEqual([]);

      const adv = await post('/v1/test_clock/advance', { seconds: 3 * DAY });
      expect(adv.status).toBe(200);
      // la route a ATTENDU le hook async : livraisons faites avant la réponse
      expect(adv.body.results.hooks.webhooks).toMatchObject({ attempted: 2, retry_scheduled: [], failed: [] });
      expect(adv.body.results.hooks.webhooks.delivered).toHaveLength(2);
      // ordre = ordre d'émission (seq) ; billing émet invoice.paid avant la mise à jour de l'abonnement
      const order = ctx.db.prepare("SELECT type FROM events WHERE type IN ('invoice.paid','customer.subscription.updated') ORDER BY seq").all().map((e) => e.type);
      expect(rx.types()).toEqual(order);
      expect(rx.types().sort()).toEqual(['customer.subscription.updated', 'invoice.paid']);
      const paid = rx.received.find((r) => r.json.type === 'invoice.paid');
      expect(paid.json.data.object).toMatchObject({ object: 'invoice', subscription: sub.id, status: 'paid', amount_paid: 990 });
      expect(paid.json.created).toBe(T0 + 3 * DAY);
      expect(verifySignature(paid.raw, paid.headers['paysim-signature'], ep.secret)).toBe(true);
    });

    it('les retries suivent l’horloge de test (advance 1 min → 2ᵉ tentative)', async () => {
      const rx = await receiver({ mode: 503 });
      const ep = await endpoint(rx.url, ['customer.created']);
      await newCustomer();
      await post('/v1/test_clock/advance', { seconds: 1 }); // tentative 1 à T0+1
      expect(deliveries(ep.id)[0]).toMatchObject({ attempts: 1, next_attempt_at: T0 + 1 + 60 });
      await post('/v1/test_clock/advance', { seconds: 59 });
      expect(rx.received).toHaveLength(1);
      rx.state.mode = 200;
      const r = await post('/v1/test_clock/advance', { seconds: 1 });
      expect(r.body.results.hooks.webhooks.delivered).toHaveLength(1);
      expect(deliveries(ep.id)[0]).toMatchObject({ status: 'delivered', attempts: 2 });
    });

    it('une erreur de hook async est capturée sans casser advance', async () => {
      ctx.testclock.onAdvance('async_boom', async () => {
        throw new Error('hook async en panne');
      });
      const r = await post('/v1/test_clock/advance', { seconds: 60 });
      expect(r.status).toBe(200);
      expect(r.body.results.hooks.async_boom).toEqual({ error: 'hook async en panne' });
      expect(r.body.results.hooks.webhooks).toMatchObject({ attempted: 0 });
    });
  });

  // ------------------------------------------------------------------ worker
  it('startWorker : livre périodiquement puis stop() attend le passage en cours', async () => {
    const rx = await receiver();
    await endpoint(rx.url, ['customer.created']);
    await newCustomer();
    const worker = ctx.webhooks.startWorker({ intervalMs: 20 });
    for (let i = 0; i < 100 && rx.received.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await worker.stop();
    expect(rx.received).toHaveLength(1);
  });

  // ------------------------------------------------------------------ base fichier
  it('base fichier de phase 4 : tables webhooks créées à l’ouverture ; livraison `sending` orpheline reprise au redémarrage', async () => {
    const os = require('node:os');
    const { openDb } = require('../src/db');
    const { createApp } = require('../src/app');
    const { createClock } = require('../src/lib/clock');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paysim-wh-'));
    const dbPath = path.join(dir, 'p.db');
    try {
      // base « phase 4 » : schéma sans les tables webhooks
      const old = openDb(dbPath);
      old.exec('DROP TABLE webhook_deliveries; DROP TABLE webhook_endpoints;');
      old.close();
      const open = () => createApp({ dbPath, config, clock: createClock(T0), logger: createLogger({ level: 'silent' }), rateLimit: false });
      const first = open();
      const ep = (await request(first.app).post('/v1/webhook_endpoints').set(auth()).send({ url: 'http://127.0.0.1:1/h', enabled_events: ['*'] })).body;
      first.ctx.events.emit('customer.created', { id: 'cus_1' });
      first.db.prepare("UPDATE webhook_deliveries SET status = 'sending'").run(); // arrêt brutal pendant un envoi
      first.db.close();
      const second = open();
      expect(second.db.prepare('SELECT status FROM webhook_deliveries WHERE endpoint_id = ?').all(ep.id)).toEqual([{ status: 'pending' }]);
      second.db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------------ sécurité des logs (L2)
  it('le secret n’apparaît ni dans les réponses GET/list ni dans les logs (y compris un log imprudent)', async () => {
    const mem = memoryStream();
    const logger = createLogger({ level: 'debug', stream: mem.stream });
    const careless = {
      name: 'webhookLogsTest',
      routes(c) {
        const r = express.Router();
        // développeur imprudent : journalise l'objet endpoint COMPLET (avec secret) et la ligne SQL
        r.post('/_test/log_endpoint/:id', requireKey('secret'), (req, res) => {
          const row = c.db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(req.params.id);
          req.log.info({ endpoint: req.body.endpoint }, 'endpoint (imprudent)');
          req.log.info({ secret: req.body.endpoint.secret, row }, 'secret (imprudent)');
          req.log.info({ data: { endpoint: req.body.endpoint } }, 'imbriqué (imprudent)');
          res.json({ ok: true });
        });
        return r;
      },
    };
    ({ app, ctx } = makeApp({ logger, modules: [careless] }));
    const rx = await receiver({ mode: (e, n) => (n === 1 ? 500 : 200) });
    const ep = await endpoint(rx.url, ['*']);
    await newCustomer();
    await ctx.webhooks.deliverPending();
    ctx.clock.advance(60);
    await ctx.webhooks.deliverPending();
    await get(`/v1/webhook_endpoints/${ep.id}`);
    await get('/v1/webhook_endpoints');
    await get(`/v1/webhook_endpoints/${ep.id}/deliveries`);
    await post(`/v1/_test/log_endpoint/${ep.id}`, { endpoint: ep });

    const out = mem.text();
    expect(out).toContain('webhook endpoint créé');
    expect(out).toContain('webhook livré');
    expect(out).toContain('nouvelle tentative programmée');
    expect(out).toContain('endpoint (imprudent)');
    expect(out).toContain('[Redacted]');
    expect(out).not.toContain(ep.secret);
    expect(out).not.toContain('whsec_');
    expect(out).not.toMatch(/"secret_encrypted":"v1\./);
  });
});

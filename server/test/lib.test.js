'use strict';
const { newId, isId } = require('../src/lib/ids');
const { computePspFee, assertAmount } = require('../src/lib/money');
const { createClock } = require('../src/lib/clock');
const { encrypt, decrypt, hmac, safeEqual, stableStringify } = require('../src/lib/crypto');
const { ApiError } = require('../src/lib/errors');
const { config } = require('./helpers');

describe('ids', () => {
  it('préfixe + 24 caractères base62', () => {
    const id = newId('pi');
    expect(id).toMatch(/^pi_[0-9A-Za-z]{24}$/);
    expect(isId(id, 'pi')).toBe(true);
    expect(isId(id, 'ch')).toBe(false);
  });
  it('unicité sur 10 000 tirages', () => {
    const set = new Set(Array.from({ length: 10000 }, () => newId('evt')));
    expect(set.size).toBe(10000);
  });
  it('refuse un préfixe invalide', () => {
    expect(() => newId('PI-')).toThrow();
  });
});

describe('money', () => {
  it('computePspFee = round(amount*0.014)+25', () => {
    expect(computePspFee(10000)).toBe(165); // 140 + 25
    expect(computePspFee(1250)).toBe(43); // 17.5 → 18 (+25)
    expect(computePspFee(1)).toBe(25); // 0.014 → 0
    expect(computePspFee(999999)).toBe(14025); // 13999.986 → 14000
  });
  it('identique au calcul flottant de la spec sur une large plage', () => {
    for (let a = 1; a <= 200000; a += 7) expect(computePspFee(a)).toBe(Math.round(a * 0.014) + 25);
  });
  it('assertAmount refuse float, zéro, négatif, chaîne', () => {
    for (const bad of [10.5, 0, -1, '100', NaN, null]) {
      expect(() => assertAmount(bad)).toThrow(ApiError);
    }
    expect(assertAmount(100)).toBe(100);
  });
});

describe('clock', () => {
  it('horloge gelée : now / advance / set', () => {
    const c = createClock(1000);
    expect(c.now()).toBe(1000);
    expect(c.advance(86400)).toBe(87400);
    expect(c.now()).toBe(87400);
    c.set(5);
    expect(c.now()).toBe(5);
  });
  it('sans valeur initiale : suit le temps réel, avance par décalage', () => {
    const c = createClock();
    const real = Math.floor(Date.now() / 1000);
    expect(Math.abs(c.now() - real)).toBeLessThanOrEqual(1);
    c.advance(3600);
    expect(Math.abs(c.now() - (real + 3600))).toBeLessThanOrEqual(1);
  });
  it('refuse les avances non entières ou négatives', () => {
    const c = createClock(0);
    expect(() => c.advance(-1)).toThrow();
    expect(() => c.advance(1.5)).toThrow();
  });
});

describe('crypto', () => {
  const key = config.vaultKey;
  it('AES-256-GCM aller-retour, IV aléatoire', () => {
    const a = encrypt(key, '4242424242424242');
    const b = encrypt(key, '4242424242424242');
    expect(a).not.toBe(b);
    expect(a).not.toContain('4242424242424242');
    expect(decrypt(key, a)).toBe('4242424242424242');
  });
  it('tag altéré → erreur', () => {
    const parts = encrypt(key, 'secret').split('.');
    const tag = Buffer.from(parts[2], 'base64url');
    tag[0] ^= 0x01;
    parts[2] = tag.toString('base64url');
    expect(() => decrypt(key, parts.join('.'))).toThrow();
  });
  it('texte chiffré altéré ou mauvaise clé → erreur', () => {
    const parts = encrypt(key, 'secret').split('.');
    const ct = Buffer.from(parts[3], 'base64url');
    ct[0] ^= 0x01;
    expect(() => decrypt(key, [parts[0], parts[1], parts[2], ct.toString('base64url')].join('.'))).toThrow();
    expect(() => decrypt('00'.repeat(32), encrypt(key, 'secret'))).toThrow();
  });
  it('hmac déterministe, safeEqual en temps constant', () => {
    expect(hmac('k', 'data')).toBe(hmac('k', 'data'));
    expect(hmac('k', 'data')).toMatch(/^[0-9a-f]{64}$/);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('abc', undefined)).toBe(false);
  });
  it('stableStringify indépendant de l\'ordre des clés', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe(stableStringify({ a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 }));
  });
});

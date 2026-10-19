'use strict';
const { addInterval, periodBoundary, addMonths } = require('../src/modules/billing/periods');

const ts = (y, m, d, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s) / 1000;
const iso = (t) => new Date(t * 1000).toISOString();
/** Bornes k = 0..n d'un cycle ancré, en ISO (lecture des échecs plus simple). */
const bounds = (anchor, interval, count, n) => Array.from({ length: n + 1 }, (_, k) => iso(periodBoundary(anchor, interval, count, k)));

describe('périodes de facturation (UTC, ancrées)', () => {
  it('31 janv. (année non bissextile) → 28 févr. → 31 mars → 30 avr. (pas de dérive)', () => {
    expect(bounds(ts(2026, 1, 31, 10, 30), 'month', 1, 3)).toEqual([
      '2026-01-31T10:30:00.000Z',
      '2026-02-28T10:30:00.000Z',
      '2026-03-31T10:30:00.000Z',
      '2026-04-30T10:30:00.000Z',
    ]);
  });

  it('31 janv. (année bissextile) → 29 févr. → 31 mars', () => {
    expect(bounds(ts(2028, 1, 31), 'month', 1, 2)).toEqual(['2028-01-31T00:00:00.000Z', '2028-02-29T00:00:00.000Z', '2028-03-31T00:00:00.000Z']);
  });

  it('30 janv. → 28 févr. → 30 mars', () => {
    expect(bounds(ts(2026, 1, 30), 'month', 1, 2)).toEqual(['2026-01-30T00:00:00.000Z', '2026-02-28T00:00:00.000Z', '2026-03-30T00:00:00.000Z']);
  });

  it('15 mars → 15 avr. → 15 mai (heure conservée)', () => {
    expect(bounds(ts(2026, 3, 15, 23, 59, 59), 'month', 1, 2)).toEqual([
      '2026-03-15T23:59:59.000Z',
      '2026-04-15T23:59:59.000Z',
      '2026-05-15T23:59:59.000Z',
    ]);
  });

  it('fin décembre → janvier de l’année suivante', () => {
    expect(iso(addInterval(ts(2026, 12, 31), 'month', 1))).toBe('2027-01-31T00:00:00.000Z');
    expect(iso(addInterval(ts(2026, 12, 15), 'month', 1))).toBe('2027-01-15T00:00:00.000Z');
    expect(iso(addInterval(ts(2026, 11, 30), 'month', 3))).toBe('2027-02-28T00:00:00.000Z');
    expect(iso(addMonths(ts(2026, 12, 31), 14))).toBe('2028-02-29T00:00:00.000Z');
  });

  it('année : 29 févr. 2028 → 28 févr. 2029 → … → 29 févr. 2032 (ancrage)', () => {
    expect(bounds(ts(2028, 2, 29), 'year', 1, 4)).toEqual([
      '2028-02-29T00:00:00.000Z',
      '2029-02-28T00:00:00.000Z',
      '2030-02-28T00:00:00.000Z',
      '2031-02-28T00:00:00.000Z',
      '2032-02-29T00:00:00.000Z',
    ]);
  });

  it('jour et semaine : durée fixe', () => {
    const t = ts(2026, 2, 26);
    expect(iso(periodBoundary(t, 'day', 1, 3))).toBe('2026-03-01T00:00:00.000Z');
    expect(iso(periodBoundary(t, 'week', 1, 1))).toBe('2026-03-05T00:00:00.000Z');
    expect(periodBoundary(t, 'week', 2, 3) - t).toBe(6 * 7 * 86400);
  });

  it('interval_count 3 (trimestriel) depuis le 31 janv. : 30 avr. → 31 juil. → 31 oct.', () => {
    expect(bounds(ts(2026, 1, 31), 'month', 3, 3)).toEqual([
      '2026-01-31T00:00:00.000Z',
      '2026-04-30T00:00:00.000Z',
      '2026-07-31T00:00:00.000Z',
      '2026-10-31T00:00:00.000Z',
    ]);
  });

  it('paramètres invalides → RangeError', () => {
    expect(() => addInterval(ts(2026, 1, 1), 'fortnight', 1)).toThrow(RangeError);
    expect(() => addInterval(ts(2026, 1, 1), 'month', -1)).toThrow(RangeError);
    expect(() => periodBoundary(ts(2026, 1, 1), 'month', 0, 1)).toThrow(RangeError);
  });
});

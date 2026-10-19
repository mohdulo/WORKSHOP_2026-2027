'use strict';

/**
 * Arithmétique des périodes de facturation, en UTC, sur des timestamps Unix en secondes.
 *
 * ANCRAGE : la borne k d'un abonnement est TOUJOURS calculée depuis l'ancre (billing_cycle_anchor) :
 *   boundary(anchor, interval, count, k) = addInterval(anchor, interval, count * k)
 * et jamais depuis la borne précédente. Ainsi 31 janv. → 28/29 févr. → 31 mars (et non 28 mars) :
 * l'écrêtage en fin de mois ne se propage pas (pas de dérive).
 *
 * Mois calendaire : même jour du mois et même heure UTC ; si ce jour n'existe pas dans le mois cible,
 * dernier jour du mois cible (31 janv. + 1 mois = 28 févr., ou 29 en année bissextile).
 * Année = 12 mois (29 févr. 2028 + 1 an = 28 févr. 2029).
 */
const DAY = 86400;
const INTERVALS = ['day', 'week', 'month', 'year'];

/** Nombre maximal d'unités par intervalle : une période dure au plus un an (règle de Stripe). */
const MAX_INTERVAL_COUNT = Object.freeze({ day: 365, week: 52, month: 12, year: 1 });

function daysInMonth(year, month0) {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

function addMonths(ts, months) {
  const d = new Date(ts * 1000);
  const total = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month0 = ((total % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month0));
  return Math.floor(Date.UTC(year, month0, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000);
}

/** ts + n intervalles (n entier >= 0). */
function addInterval(ts, interval, n) {
  if (!Number.isSafeInteger(ts) || ts < 0) throw new RangeError('addInterval : timestamp invalide.');
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('addInterval : n doit être un entier >= 0.');
  switch (interval) {
    case 'day':
      return ts + n * DAY;
    case 'week':
      return ts + n * 7 * DAY;
    case 'month':
      return addMonths(ts, n);
    case 'year':
      return addMonths(ts, n * 12);
    default:
      throw new RangeError(`Intervalle inconnu : ${interval}`);
  }
}

/** Borne k (k >= 0) d'un cycle ancré : début de la période k ; la période k est [boundary(k), boundary(k+1)[. */
function periodBoundary(anchor, interval, intervalCount, k) {
  if (!Number.isSafeInteger(intervalCount) || intervalCount < 1) throw new RangeError('interval_count doit être >= 1.');
  return addInterval(anchor, interval, intervalCount * k);
}

module.exports = { DAY, INTERVALS, MAX_INTERVAL_COUNT, addInterval, addMonths, periodBoundary, daysInMonth };

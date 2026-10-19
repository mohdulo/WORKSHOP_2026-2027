'use strict';
const { invalid } = require('../../lib/errors');

const DAY = 86400;
const MAX_ADVANCE_SECONDS = 5 * 366 * DAY; // 5 ans

/**
 * Horloge de test (PLAN §4.10).
 * advance(seconds) : avance ctx.clock puis exécute, dans l'ordre, au nouvel instant `now` :
 *   1. payments.expireAuthorizations(now)
 *   2. billing.run(now)
 *   3. les hooks enregistrés par onAdvance(name, fn), dans l'ordre d'enregistrement
 *      (phase 5 : webhooks.deliverPending, enregistré par le service webhooks lui-même — testclock n'est pas modifié).
 * Un hook qui lève est journalisé et signalé dans le résultat ; il n'interrompt pas les suivants.
 */
function createTestClock(ctx) {
  const { clock } = ctx;
  const hooks = [];

  function onAdvance(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') throw new TypeError('onAdvance(name, fn)');
    hooks.push({ name, fn });
  }

  function status() {
    return { object: 'test_clock', now: clock.now(), frozen: Boolean(clock.frozen) };
  }

  /**
   * Tâches périodiques à l'instant `now` (sans avancer l'horloge). ASYNC depuis la phase 5 : un hook peut renvoyer
   * une promesse (webhooks.deliverPending fait des appels HTTP) ; chaque hook est attendu avant le suivant.
   * Expiration et billing restent synchrones et s'exécutent avant le premier await.
   */
  async function tick(now = clock.now()) {
    const expired = ctx.payments.expireAuthorizations(now);
    const billing = ctx.billing.run(now);
    const hookResults = {};
    for (const { name, fn } of hooks) {
      try {
        hookResults[name] = (await fn(now)) ?? null;
      } catch (err) {
        ctx.logger.error({ err, hook: name }, 'test_clock : échec du hook');
        hookResults[name] = { error: err.message };
      }
    }
    return { expired_authorizations: expired, billing, hooks: hookResults };
  }

  /** Avance l'horloge (synchrone, validée avant tout effet) puis attend les tâches. Renvoie une promesse. */
  async function advance(seconds) {
    if (!Number.isSafeInteger(seconds) || seconds <= 0) throw invalid('seconds doit être un entier strictement positif.', 'seconds');
    if (seconds > MAX_ADVANCE_SECONDS) throw invalid(`seconds ne peut pas dépasser ${MAX_ADVANCE_SECONDS} (5 ans).`, 'seconds');
    const before = clock.now();
    const now = clock.advance(seconds);
    const snapshot = status(); // `now` de la réponse = instant de l'avance, même si un autre advance survient pendant les hooks
    return { ...snapshot, previous: before, advanced_by: seconds, results: await tick(now) };
  }

  return { status, advance, tick, onAdvance, hooks, MAX_ADVANCE_SECONDS };
}

module.exports = { createTestClock, MAX_ADVANCE_SECONDS };

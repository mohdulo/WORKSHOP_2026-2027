'use strict';

/**
 * Horloge de l'application, en secondes Unix (entiers).
 * - createClock()        : suit le temps réel, avec un décalage modifiable par advance()/set().
 * - createClock(initial) : horloge GELÉE sur `initial` (déterministe, pour les tests) ;
 *                          elle ne bouge que via advance()/set().
 * Les services n'appellent JAMAIS Date.now() : uniquement ctx.clock.now().
 */
function createClock(initial) {
  const realNow = () => Math.floor(Date.now() / 1000);
  const frozen = initial !== undefined && initial !== null;
  if (frozen) assertTs(initial);
  let frozenTs = frozen ? initial : 0;
  let offset = 0;

  return {
    frozen,
    now() {
      return frozen ? frozenTs : realNow() + offset;
    },
    advance(seconds) {
      if (!Number.isSafeInteger(seconds) || seconds <= 0) {
        throw new RangeError('advance(seconds) attend un entier strictement positif.');
      }
      if (frozen) frozenTs += seconds;
      else offset += seconds;
      return this.now();
    },
    set(ts) {
      assertTs(ts);
      if (frozen) frozenTs = ts;
      else offset = ts - realNow();
      return this.now();
    },
  };
}

function assertTs(ts) {
  if (!Number.isSafeInteger(ts) || ts < 0) throw new RangeError('Timestamp Unix (secondes, entier >= 0) attendu.');
}

module.exports = { createClock };

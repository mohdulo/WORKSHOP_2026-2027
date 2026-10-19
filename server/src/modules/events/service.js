'use strict';
const { newId } = require('../../lib/ids');
const { notFound } = require('../../lib/errors');
const { paginate } = require('../../lib/pagination');

/**
 * Journal d'événements. emit() est synchrone : appelé à l'intérieur d'un db.transaction() métier,
 * l'événement est écrit (ou annulé) avec le reste (PLAN §3). La livraison webhook est séparée (phase 5).
 */
function createEvents(ctx) {
  const { db, clock } = ctx;
  const insert = db.prepare('INSERT INTO events (id, type, data, created) VALUES (?, ?, ?, ?)');
  const getStmt = db.prepare('SELECT * FROM events WHERE id = ?');
  const listeners = [];

  function toApi(row) {
    return { id: row.id, object: 'event', type: row.type, data: JSON.parse(row.data), created: row.created };
  }

  // Insertion + listeners dans UNE transaction (savepoint si on est déjà dans la transaction métier) :
  // un listener qui échoue (ex : fan-out webhooks) annule aussi l'événement — jamais d'événement sans ses livraisons.
  const record = db.transaction((event) => {
    const { lastInsertRowid } = insert.run(event.id, event.type, JSON.stringify(event.data), event.created);
    for (const fn of listeners) fn(event, Number(lastInsertRowid));
  });

  function emit(type, dataObject) {
    if (typeof type !== 'string' || !/^[a-z_]+(\.[a-z_]+)+$/.test(type)) throw new Error(`Type d'événement invalide : ${type}`);
    if (!dataObject || typeof dataObject !== 'object') throw new Error('emit() attend un objet de données.');
    const event = { id: newId('evt'), object: 'event', type, data: { object: dataObject }, created: clock.now() };
    record(event);
    return event;
  }

  /** Abonnement interne : fn(event, seq) appelé dans la transaction de l'événement (webhooks : création des livraisons). */
  function onEmit(fn) {
    listeners.push(fn);
  }

  function get(id) {
    const row = getStmt.get(id);
    if (!row) throw notFound('event', id);
    return toApi(row);
  }

  function list({ limit, startingAfter, type } = {}) {
    return paginate(db, {
      table: 'events',
      where: type ? 'type = ?' : undefined,
      params: type ? [type] : [],
      limit,
      startingAfter,
      map: toApi,
    });
  }

  return { emit, onEmit, get, list };
}

module.exports = { createEvents };

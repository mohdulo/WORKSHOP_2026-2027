'use strict';
const { invalid } = require('./errors');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

/** Lit et valide ?limit=&starting_after= depuis req.query. */
function parseListParams(query = {}) {
  let limit = DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit)) {
      throw invalid(`limit doit être un entier entre 1 et ${MAX_LIMIT}.`, 'limit');
    }
    limit = Number(query.limit);
    if (limit < 1 || limit > MAX_LIMIT) throw invalid(`limit doit être un entier entre 1 et ${MAX_LIMIT}.`, 'limit');
  }
  let startingAfter;
  if (query.starting_after !== undefined) {
    if (typeof query.starting_after !== 'string' || query.starting_after === '') {
      throw invalid('starting_after doit être un identifiant.', 'starting_after');
    }
    startingAfter = query.starting_after;
  }
  return { limit, startingAfter };
}

/**
 * Pagination par curseur, du plus récent au plus ancien.
 * Convention : toute table listable a `seq INTEGER PRIMARY KEY AUTOINCREMENT` (ordre d'insertion stable)
 * et `id TEXT NOT NULL UNIQUE` (identifiant public).
 *
 * @param db       better-sqlite3
 * @param opts.table   nom de table (interne, jamais issu de l'utilisateur)
 * @param opts.where   clause SQL optionnelle (sans "WHERE"), paramétrée par opts.params
 * @param opts.map     transforme une ligne en objet API
 */
function paginate(db, { table, where, params = [], limit = DEFAULT_LIMIT, startingAfter, map = (r) => r }) {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`Nom de table invalide : ${table}`);
  const clauses = [];
  const args = [...params];
  if (where) clauses.push(`(${where})`);
  if (startingAfter !== undefined) {
    const cursor = db.prepare(`SELECT seq FROM ${table} WHERE id = ?`).get(startingAfter);
    if (!cursor) throw invalid(`Aucun objet "${startingAfter}" pour starting_after.`, 'starting_after', 'resource_missing');
    clauses.push('seq < ?');
    args.push(cursor.seq);
  }
  const sql = `SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
  const rows = db.prepare(sql).all(...args, limit + 1);
  const hasMore = rows.length > limit;
  return { object: 'list', data: rows.slice(0, limit).map(map), has_more: hasMore };
}

module.exports = { parseListParams, paginate, DEFAULT_LIMIT, MAX_LIMIT };

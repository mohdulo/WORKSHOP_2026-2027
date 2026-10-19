'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { sha256 } = require('../lib/crypto');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/** Ouvre la base (":memory:" accepté), active les FK (+ WAL sur fichier), applique le schéma. */
function openDb(dbPath = ':memory:') {
  const inMemory = dbPath === ':memory:';
  if (!inMemory) fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  if (!inMemory) db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/**
 * Colonnes ajoutées APRÈS la création initiale d'une table : `CREATE TABLE IF NOT EXISTS` ne les ajoute pas
 * à une base fichier existante. Migration additive et idempotente (ALTER TABLE ADD COLUMN si absente).
 * La définition doit être identique à celle de schema.sql.
 */
const ADDED_COLUMNS = [
  { table: 'charges', column: 'refunded', ddl: 'refunded INTEGER NOT NULL DEFAULT 0' }, // phase 3
];

function migrate(db) {
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/** Seed des clés API depuis la config (upsert : changer la clé dans l'env remplace l'ancienne). */
function seedApiKeys(db, config, now) {
  const upsert = db.prepare(`
    INSERT INTO api_keys (id, type, key_hash, key_prefix, created)
    VALUES (@id, @type, @key_hash, @key_prefix, @created)
    ON CONFLICT(id) DO UPDATE SET key_hash = excluded.key_hash, key_prefix = excluded.key_prefix, revoked = 0
  `);
  const seed = db.transaction(() => {
    for (const [id, type, key] of [
      ['key_secret_default', 'secret', config.secretKey],
      ['key_publishable_default', 'publishable', config.publishableKey],
    ]) {
      upsert.run({ id, type, key_hash: sha256(key), key_prefix: key.slice(0, 12), created: now });
    }
  });
  seed();
}

module.exports = { openDb, migrate, seedApiKeys, ADDED_COLUMNS };

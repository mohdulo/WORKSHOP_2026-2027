-- PaySim — schéma SQLite. Exécuté à chaque ouverture (idempotent : CREATE ... IF NOT EXISTS).
-- Conventions :
--   * montants : INTEGER en centimes ; dates : INTEGER secondes Unix (ctx.clock.now()) ;
--   * tables listables : seq INTEGER PRIMARY KEY AUTOINCREMENT (ordre stable pour la pagination)
--     + id TEXT NOT NULL UNIQUE (identifiant public préfixé) ;
--   * chaque module ajoute ses tables dans SA section ci-dessous.

-- ============================================================
-- Core : clés API
-- ============================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,                  -- ex : "key_secret_default"
  type        TEXT NOT NULL CHECK (type IN ('secret', 'publishable')),
  key_hash    TEXT NOT NULL UNIQUE,              -- sha256 de la clé (la clé en clair n'est pas stockée)
  key_prefix  TEXT NOT NULL,                     -- "sk_test_abcd" pour affichage
  created     INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- Core : idempotence (PLAN §3)
-- ============================================================
CREATE TABLE IF NOT EXISTS idempotency_keys (
  api_key_id      TEXT NOT NULL,
  idem_key        TEXT NOT NULL,
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  request_hash    TEXT NOT NULL,                 -- sha256 du corps (JSON à clés triées)
  status          TEXT NOT NULL CHECK (status IN ('in_progress', 'done')),
  response_status INTEGER,
  response_body   TEXT,
  created         INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (api_key_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- ============================================================
-- Module events
-- ============================================================
CREATE TABLE IF NOT EXISTS events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  id       TEXT NOT NULL UNIQUE,                 -- evt_
  type     TEXT NOT NULL,
  data     TEXT NOT NULL,                        -- JSON { object: {...} }
  created  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

-- ============================================================
-- Module ledger (partie double, PLAN §4.1)
-- amount signé : + débit, − crédit. Somme de toutes les écritures = 0.
-- ============================================================
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  code     TEXT NOT NULL UNIQUE,                 -- network_receivable, platform_balance, merchant:acct_...
  type     TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'revenue')),
  created  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_transactions (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  id       TEXT NOT NULL UNIQUE,                 -- txn_
  kind     TEXT NOT NULL,                        -- capture, refund, transfer, payout, ...
  ref_id   TEXT,                                 -- objet métier à l'origine (pi_, re_, tr_, po_ ...)
  created  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_txn_ref ON ledger_transactions(ref_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id        TEXT NOT NULL REFERENCES ledger_transactions(id),
  account_code  TEXT NOT NULL REFERENCES ledger_accounts(code),
  amount        INTEGER NOT NULL CHECK (amount <> 0)
);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_txn ON ledger_entries(txn_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_code);

-- ============================================================
-- Module customers      (phase 2, PLAN §4.4)
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  seq                     INTEGER PRIMARY KEY AUTOINCREMENT,
  id                      TEXT NOT NULL UNIQUE,  -- cus_
  email                   TEXT NOT NULL,
  name                    TEXT,
  metadata                TEXT NOT NULL DEFAULT '{}',  -- JSON
  default_payment_method  TEXT,                  -- pm_ (rattaché à ce client, vérifié par le service)
  created                 INTEGER NOT NULL
);

-- ============================================================
-- Module vault          (phase 2, PLAN §4.2)
-- Le PAN n'est stocké que chiffré (AES-256-GCM, AAD = id du pm). Le CVC n'est JAMAIS stocké :
-- il n'y a volontairement aucune colonne pour lui.
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_methods (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,           -- pm_
  customer_id    TEXT REFERENCES customers(id),
  brand          TEXT NOT NULL CHECK (brand IN ('visa', 'mastercard', 'amex')),
  last4          TEXT NOT NULL,
  exp_month      INTEGER NOT NULL,
  exp_year       INTEGER NOT NULL,
  fingerprint    TEXT NOT NULL,                  -- HMAC-SHA256(FINGERPRINT_KEY, PAN), hex
  pan_encrypted  TEXT NOT NULL,                  -- "v1.<iv>.<tag>.<ct>" (lib/crypto.encrypt)
  cvc_check      TEXT NOT NULL CHECK (cvc_check IN ('pass', 'fail')),
  created        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pm_customer ON payment_methods(customer_id);
CREATE INDEX IF NOT EXISTS idx_pm_fingerprint ON payment_methods(fingerprint);

-- ============================================================
-- Module connect (accounts, transfers, payouts) (phase 3)
-- Phase 2 : table `accounts` MINIMALE, uniquement pour valider transfer_data.destination
-- des payment intents. La phase 3 ajoute service, routes, transfers et payouts.
-- ============================================================
CREATE TABLE IF NOT EXISTS accounts (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT NOT NULL UNIQUE,           -- acct_
  email          TEXT NOT NULL,
  business_name  TEXT,
  status         TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled')),
  created        INTEGER NOT NULL
);

-- Phase 3 : virements plateforme → vendeur (PLAN §4.7).
CREATE TABLE IF NOT EXISTS transfers (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,            -- tr_
  amount          INTEGER NOT NULL CHECK (amount > 0),
  currency        TEXT NOT NULL,
  destination     TEXT NOT NULL REFERENCES accounts(id),
  description     TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_destination ON transfers(destination);

-- Phase 3 : virements bancaires simulés vendeur → banque (status 'paid' immédiat).
CREATE TABLE IF NOT EXISTS payouts (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,            -- po_
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  amount          INTEGER NOT NULL CHECK (amount > 0),
  currency        TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('paid')),
  arrival_date    INTEGER NOT NULL,
  description     TEXT,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payouts_account ON payouts(account_id);

-- ============================================================
-- Module payments (payment_intents, charges, three_ds) (phase 2, PLAN §4.5)
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_intents (
  seq                     INTEGER PRIMARY KEY AUTOINCREMENT,
  id                      TEXT NOT NULL UNIQUE,  -- pi_
  amount                  INTEGER NOT NULL CHECK (amount > 0),
  amount_capturable       INTEGER NOT NULL DEFAULT 0,
  amount_received         INTEGER NOT NULL DEFAULT 0,
  currency                TEXT NOT NULL CHECK (currency = 'eur'),
  status                  TEXT NOT NULL CHECK (status IN ('requires_payment_method', 'requires_confirmation', 'requires_action',
                                                         'requires_capture', 'succeeded', 'canceled')),
  capture_method          TEXT NOT NULL CHECK (capture_method IN ('automatic', 'manual')),
  client_secret           TEXT NOT NULL,         -- <pi_id>_secret_<random> ; masqué dans les logs
  customer_id             TEXT REFERENCES customers(id),
  payment_method_id       TEXT REFERENCES payment_methods(id),
  off_session             INTEGER NOT NULL DEFAULT 0,
  application_fee_amount  INTEGER,
  transfer_destination    TEXT REFERENCES accounts(id),
  description             TEXT,
  metadata                TEXT NOT NULL DEFAULT '{}',
  last_payment_error      TEXT,                  -- JSON { type, code, decline_code, message }
  next_action             TEXT,                  -- JSON { type: 'three_d_secure', challenge_id }
  latest_charge           TEXT,
  authorized_at           INTEGER,               -- début du délai d'expiration (7 j) en requires_capture
  canceled_at             INTEGER,
  cancellation_reason     TEXT,
  created                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pi_customer ON payment_intents(customer_id);
CREATE INDEX IF NOT EXISTS idx_pi_status ON payment_intents(status, authorized_at);

-- Une ligne par tentative d'autorisation (PLAN §4.5).
CREATE TABLE IF NOT EXISTS charges (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,       -- ch_
  payment_intent_id  TEXT NOT NULL REFERENCES payment_intents(id),
  payment_method_id  TEXT NOT NULL REFERENCES payment_methods(id),
  customer_id        TEXT REFERENCES customers(id),
  amount             INTEGER NOT NULL CHECK (amount > 0),
  amount_captured    INTEGER NOT NULL DEFAULT 0,
  amount_refunded    INTEGER NOT NULL DEFAULT 0,
  refunded           INTEGER NOT NULL DEFAULT 0,  -- phase 3 : 1 quand amount_refunded = amount_captured (> 0)
  currency           TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  captured           INTEGER NOT NULL DEFAULT 0,
  failure_code       TEXT,
  decline_code       TEXT,
  failure_message    TEXT,
  outcome            TEXT NOT NULL,              -- JSON
  three_d_secure     TEXT,                       -- 'authenticated' si 3DS passé
  created            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_charges_pi ON charges(payment_intent_id);

CREATE TABLE IF NOT EXISTS three_ds_challenges (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,       -- tds_
  payment_intent_id  TEXT NOT NULL REFERENCES payment_intents(id),
  status             TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'canceled')),
  created            INTEGER NOT NULL,
  completed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tds_pi ON three_ds_challenges(payment_intent_id);

-- ============================================================
-- Module refunds        (phase 3, PLAN §4.6)
-- Statut toujours 'succeeded' (le simulateur rembourse immédiatement).
-- ============================================================
CREATE TABLE IF NOT EXISTS refunds (
  seq                       INTEGER PRIMARY KEY AUTOINCREMENT,
  id                        TEXT NOT NULL UNIQUE,  -- re_
  payment_intent_id         TEXT NOT NULL REFERENCES payment_intents(id),
  charge_id                 TEXT NOT NULL REFERENCES charges(id),
  amount                    INTEGER NOT NULL CHECK (amount > 0),
  currency                  TEXT NOT NULL,
  status                    TEXT NOT NULL CHECK (status IN ('succeeded')),
  reason                    TEXT,
  refund_application_fee    INTEGER NOT NULL DEFAULT 0,
  application_fee_refunded  INTEGER NOT NULL DEFAULT 0 CHECK (application_fee_refunded >= 0),  -- feeShare
  debited_account           TEXT NOT NULL,         -- platform_balance ou merchant:acct_...
  metadata                  TEXT NOT NULL DEFAULT '{}',
  created                   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refunds_pi ON refunds(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_refunds_charge ON refunds(charge_id);

-- ============================================================
-- Module billing (products, prices, subscriptions, invoices) (phase 4, PLAN §4.8)
-- Nouvelles tables uniquement : aucune colonne ajoutée à une table existante (rien dans ADDED_COLUMNS).
-- ============================================================
CREATE TABLE IF NOT EXISTS products (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,               -- prod_
  name         TEXT NOT NULL,
  description  TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  metadata     TEXT NOT NULL DEFAULT '{}',
  created      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS prices (
  seq                       INTEGER PRIMARY KEY AUTOINCREMENT,
  id                        TEXT NOT NULL UNIQUE,  -- price_
  product_id                TEXT NOT NULL REFERENCES products(id),
  unit_amount               INTEGER NOT NULL CHECK (unit_amount > 0),
  currency                  TEXT NOT NULL CHECK (currency = 'eur'),
  type                      TEXT NOT NULL CHECK (type IN ('one_time', 'recurring')),
  recurring_interval        TEXT CHECK (recurring_interval IS NULL OR recurring_interval IN ('day', 'week', 'month', 'year')),
  recurring_interval_count  INTEGER CHECK (recurring_interval_count IS NULL OR recurring_interval_count >= 1),
  nickname                  TEXT,
  active                    INTEGER NOT NULL DEFAULT 1,
  metadata                  TEXT NOT NULL DEFAULT '{}',
  created                   INTEGER NOT NULL,
  CHECK ((type = 'recurring') = (recurring_interval IS NOT NULL AND recurring_interval_count IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_prices_product ON prices(product_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  seq                     INTEGER PRIMARY KEY AUTOINCREMENT,
  id                      TEXT NOT NULL UNIQUE,    -- sub_
  customer_id             TEXT NOT NULL REFERENCES customers(id),
  price_id                TEXT NOT NULL REFERENCES prices(id),
  status                  TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'incomplete', 'past_due', 'canceled')),
  default_payment_method  TEXT REFERENCES payment_methods(id),
  billing_cycle_anchor    INTEGER NOT NULL,        -- borne k = anchor + k intervalles (pas de dérive en fin de mois)
  period_index            INTEGER NOT NULL,        -- -1 pendant l'essai, puis k de la période payée courante
  current_period_start    INTEGER NOT NULL,
  current_period_end      INTEGER NOT NULL,
  trial_start             INTEGER,
  trial_end               INTEGER,
  cancel_at_period_end    INTEGER NOT NULL DEFAULT 0,
  canceled_at             INTEGER,
  ended_at                INTEGER,
  latest_invoice          TEXT,
  metadata                TEXT NOT NULL DEFAULT '{}',
  created                 INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subs_customer ON subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status);

CREATE TABLE IF NOT EXISTS invoices (
  seq                      INTEGER PRIMARY KEY AUTOINCREMENT,
  id                       TEXT NOT NULL UNIQUE,   -- in_
  subscription_id          TEXT NOT NULL REFERENCES subscriptions(id),
  customer_id              TEXT NOT NULL REFERENCES customers(id),
  status                   TEXT NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'uncollectible', 'void')),
  billing_reason           TEXT NOT NULL CHECK (billing_reason IN ('subscription_create', 'subscription_cycle')),
  amount_due               INTEGER NOT NULL CHECK (amount_due > 0),
  amount_paid              INTEGER NOT NULL DEFAULT 0,
  currency                 TEXT NOT NULL,
  period_index             INTEGER NOT NULL,
  period_start             INTEGER NOT NULL,
  period_end               INTEGER NOT NULL,
  attempt_count            INTEGER NOT NULL DEFAULT 0,
  next_payment_attempt     INTEGER,
  retry_anchor             INTEGER,                -- instant du 1er échec : relances à +1 j, +3 j, +5 j
  payment_intent           TEXT REFERENCES payment_intents(id),
  last_payment_error       TEXT,                   -- JSON { type, code, decline_code?, message }
  finalized_at             INTEGER,
  paid_at                  INTEGER,
  marked_uncollectible_at  INTEGER,
  voided_at                INTEGER,
  created                  INTEGER NOT NULL,
  UNIQUE (subscription_id, period_index)           -- une seule facture par période : filet d'idempotence de billing.run
);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, next_payment_attempt);

-- ============================================================
-- Module webhooks (webhook_endpoints, webhook_deliveries) (phase 5)
-- ============================================================
-- Nouvelles tables uniquement (aucune colonne ajoutée à une table existante → rien dans ADDED_COLUMNS, L10).
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,         -- we_
  url               TEXT NOT NULL,
  enabled_events    TEXT NOT NULL,                -- JSON : ["*"] ou liste de types connus
  description       TEXT,
  status            TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  secret_encrypted  TEXT NOT NULL,                -- whsec_ chiffré AES-256-GCM (VAULT_KEY, AAD = id) ; jamais renvoyé hors création
  created           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,         -- whd_
  endpoint_id       TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id          TEXT NOT NULL REFERENCES events(id),
  event_seq         INTEGER NOT NULL,             -- ordre d'envoi
  event_type        TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER,                      -- NULL une fois delivered/failed
  last_attempt_at   INTEGER,
  last_status_code  INTEGER,                      -- NULL si erreur réseau / timeout
  last_error        TEXT,
  delivered_at      INTEGER,
  created           INTEGER NOT NULL,
  UNIQUE (endpoint_id, event_id)                  -- une seule livraison par (endpoint, event)
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id);

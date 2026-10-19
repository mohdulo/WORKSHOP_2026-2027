# PaySim — Plateforme de paiement maison (projet EPSI)

> Source de vérité du projet. Tout agent qui travaille dessus lit ce fichier ET `taskForLesson.md` avant de coder.

## 0. Périmètre et avertissement

PaySim est un **prestataire de paiement (PSP) construit de zéro**, sans Stripe/PayPal/Mollie.
Les banques et réseaux carte sont remplacés par un **simulateur de réseau** (module `network`) :
aucun argent réel ne circule. Passer en réel exigerait : agrément ACPR (établissement de paiement),
contrat avec une banque acquéreuse, certification PCI DSS, 3-D Secure réel (DSP2/SCA).

Fonctionnalités : paiement unique (autorisation/capture, 3-D Secure simulé), remboursements
(total/partiel), abonnements (essai, facturation récurrente, relances, résiliation), marketplace
(comptes vendeurs, split avec commission, virements/payouts), webhooks signés, grand livre
en partie double, idempotence, horloge de test.

## 1. Stack

- **server/** : Node 22, Express 4, better-sqlite3 (synchrone), zod (validation), pino + pino-http (logs JSON),
  helmet, express-rate-limit, CommonJS. Tests : vitest + supertest.
- **web/** : React 18 + Vite. Démo checkout + dashboard.
- `createApp({ dbPath, logger, clock })` : factory d'app ; les tests utilisent `dbPath: ':memory:'`.

## 2. Arborescence

```
paysim/
  PLAN.md  taskForLesson.md  README.md
  server/
    package.json  vitest.config.js
    src/
      app.js            # createApp(options) -> { app, db, ctx }
      server.js         # démarre l'HTTP (PORT, défaut 4000)
      config.js         # env : VAULT_KEY, FINGERPRINT_KEY, clés API seed
      db/schema.sql  db/index.js (open + migrate + seed)
      lib/ ids.js money.js clock.js errors.js crypto.js logger.js
      middleware/ auth.js idempotency.js validate.js errorHandler.js
      modules/
        ledger/ vault/ network/ customers/ payments/ refunds/
        connect/ billing/ webhooks/ events/ testclock/
      demo/             # "backend marchand" de démo (utilise la clé secrète côté serveur)
    test/
  web/
```
Chaque module : `service.js` (logique pure, reçoit `ctx`) + `routes.js` (Express Router). Les routes ne contiennent pas de logique métier.
`ctx = { db, clock, logger, config, events }`.

## 3. Conventions transverses

- **Montants** : entiers en centimes, devise `eur` uniquement (champ `currency` présent quand même). Jamais de float.
- **IDs** : préfixe + 24 caractères base62 aléatoires (`crypto.randomBytes`).
  `pi_` payment intent, `ch_` charge, `re_` refund, `cus_` customer, `tok_` token, `pm_` payment method,
  `acct_` compte vendeur, `tr_` transfer, `po_` payout, `prod_`, `price_`, `sub_`, `in_` invoice,
  `evt_` event, `we_` webhook endpoint, `whd_` livraison webhook, `txn_` transaction ledger, `tds_` challenge 3-D Secure.
- **Dates** : timestamps Unix en secondes, toujours via `ctx.clock.now()` (horloge de test avançable). Jamais `Date.now()` dans les services. *Seule exception (phase 5)* : le `t=` de `PaySim-Signature` est en temps réel (cf. §4.9, taskForLesson L14).
- **Auth** : `Authorization: Bearer <clé>`. `sk_test_...` = secrète (tout), `pk_test_...` = publique : `POST /v1/payment_methods`, et avec le `client_secret` du PI : `POST /v1/payment_intents/:id/confirm`, `POST /v1/three_ds/:id/complete`, `GET /v1/payment_intents/:id?client_secret=`. Clés seedées depuis `config` et affichées au démarrage.
- **Erreurs** : HTTP 4xx/5xx, corps `{ "error": { "type", "code", "message", "param"? } }`.
  types : `invalid_request_error` (400), `authentication_error` (401), `permission_error` (403), `not_found` (404),
  `idempotency_error` (409), `card_error` (402), `state_error` (409 transition invalide), `rate_limit_error` (429), `api_error` (500).
- **Idempotence** : header `Idempotency-Key` sur tout POST. Stocké (clé API + clé + méthode + chemin + hash du corps) → réponse rejouée à l'identique. Même clé + corps différent → 409 `idempotency_error`. Expiration 24 h.
- **Transactions SQL** : toute opération qui modifie plusieurs tables passe par `db.transaction()`.
- **Événements** : `ctx.events.emit(type, object)` insère dans `events` (dans la même transaction SQL). La livraison webhook est séparée (phase 5). Liste des types émis centralisée dans `modules/events/types.js` (`EVENT_TYPES`) ; un test vérifie qu'elle correspond exactement aux `emit*('type', …)` du code.
- **Sécurité des logs** : un PAN (numéro de carte), un CVC ou un `client_secret` ne doit JAMAIS apparaître dans un log, une réponse API (sauf le client_secret au propriétaire du PI) ou la base en clair. pino `redact` (`REDACT_PATHS`) + URL masquée dans pino-http (`maskUrl`, taskForLesson L5). Les événements ne transportent pas le `client_secret`. Des tests le vérifient. Phase 5 : le secret webhook (`secret`, `secret_encrypted`) est dans `REDACT_PATHS`.
- **Listes** : `GET /v1/<ressource>?limit=10&starting_after=<id>` → `{ object: "list", data: [...], has_more }`.

## 4. Modules et contrats d'API

### 4.1 Ledger (grand livre en partie double)
Tables `ledger_accounts(id, code UNIQUE, type)`, `ledger_transactions(id, kind, ref_id, created)`, `ledger_entries(id, txn_id, account_code, amount)` (amount signé : + débit, − crédit).
`ledger.post(kind, refId, lines[])` : refuse si `sum(lines.amount) !== 0` ou ligne nulle/non entière.
Comptes : `network_receivable`, `platform_balance`, `psp_revenue`, `bank_payouts`, `merchant:<acct_id>`.
Solde d'un compte "passif" (marchand, plateforme) = −somme des écritures (affiché positif).
`GET /v1/balance` (plateforme), `GET /v1/accounts/:id/balance`, `GET /v1/ledger/check` → `{ balanced: true, total: 0 }`.

Frais PSP : `fee = round(amount * 0.014) + 25` centimes, à la charge de la plateforme.

Écritures à la **capture** d'un montant A (commission F, destination M optionnelle) :
- sans destination : Dr network_receivable A ; Cr platform_balance A ; Dr platform_balance fee ; Cr psp_revenue fee
- avec destination : Dr network_receivable A ; Cr merchant:M (A−F) ; Cr platform_balance F ; Dr platform_balance fee ; Cr psp_revenue fee

**Remboursement** R : Dr (platform_balance ou merchant:M) R ; Cr network_receivable R.
Si `refund_application_fee=true` et destination : feeShare = round(F*R/A) ; Dr platform_balance feeShare ; Cr merchant:M feeShare. Frais PSP non remboursés.
**Payout** X : Dr merchant:M X ; Cr bank_payouts X (X ≤ solde disponible, sinon 402 `insufficient_balance`).
**Transfer** X : Dr platform_balance X ; Cr merchant:M X (X ≤ solde plateforme, sinon 402 `insufficient_balance`).
- *Précisions phase 3 (implémenté)* :
  - `balanceOf` renvoie `0 - total` (jamais `-0`, cf. taskForLesson L8).
  - **feeShare cumulatif** : pour plusieurs remboursements partiels avec `refund_application_fee`, feeShare = round(F·(ΣR'+R)/A) − Σ feeShare' (R' = remboursements précédents AVEC restitution de commission). Pour un premier remboursement, c'est exactement round(F·R/A) ; ensuite Σ feeShare = round(F·ΣR/A) ≤ F et = F après remboursement total (évite la dérive : 3 × round(1/3) = 0). Calcul entier `floor((2FR + A) / 2A)` (L3), `refunds.computeFeeShare`.
  - **Solde marchand négatif autorisé** : un remboursement sur paiement split débite `merchant:M` SANS contrôle de solde (le client est toujours remboursé, comme chez les vrais PSP ; le vendeur se renfloue sur ses ventes suivantes). Seuls les payouts et transfers exigent un solde suffisant ; un vendeur à solde négatif ne peut donc pas faire de payout. Idem pour `platform_balance` (remboursement d'un paiement direct, ou frais PSP non remboursés : la plateforme peut passer sous 0).
  - Erreur `insufficient_balance` : HTTP 402, `type: invalid_request_error` (pas `card_error` : aucune carte en jeu), `param: amount`.

### 4.2 Vault (coffre-fort carte, tokenisation)
- `POST /v1/payment_methods` (clé pk) `{ card: { number, exp_month, exp_year, cvc } }` → `pm_`.
- Validation : Luhn, 13–19 chiffres, date non expirée (selon clock), CVC 3–4 chiffres, marque détectée (visa 4, mastercard 51–55/2221–2720, amex 34/37).
- PAN chiffré AES-256-GCM (`VAULT_KEY`, IV aléatoire, tag stockés). `fingerprint = HMAC-SHA256(FINGERPRINT_KEY, PAN)`.
- CVC vérifié par le simulateur à la création (`cvc_check: pass|fail`) puis **jamais stocké**.
- Réponse publique : `{ id, object:"payment_method", card:{ brand, last4, exp_month, exp_year, fingerprint, cvc_check }, customer:null }`.
- `POST /v1/payment_methods/:id/attach` (sk) `{ customer }`, `GET /v1/payment_methods/:id`, `GET /v1/customers/:id/payment_methods`.
- Fonction interne `vault.reveal(pmId)` (utilisée uniquement par `network`) déchiffre le PAN.

### 4.3 Network (simulateur banque/réseau)
`network.authorize({ pan, amount, offSession, threeDsCompleted, cvcCheck })` → `{ approved, decline_code?, code?, message?, requires_3ds? }`.
`decline_code` = code de la table ci-dessous ; `code` (code d'erreur API) = `expired_card`, `incorrect_cvc`, `amount_too_large` pour ces cas, `card_declined` sinon (y compris `insufficient_funds` et `authentication_required`).
Cartes de test (toutes valides Luhn) :
| Numéro | Comportement |
|---|---|
| 4242424242424242 | approuvée |
| 5555555555554444 | approuvée (mastercard) |
| 4000000000000002 | refusée `card_declined` |
| 4000000000009995 | refusée `insufficient_funds` |
| 4000000000000069 | refusée `expired_card` |
| 4000000000000127 | `cvc_check: fail` à la tokenisation → paiement refusé `incorrect_cvc` |
| 4000000000003220 | exige 3-D Secure (on-session) ; off-session → refusée `authentication_required` |
| 4000000000000341 | tokenisation OK, tout paiement refusé `card_declined` (tests de relances abonnement) |
Toute autre carte valide : approuvée. Montant > 999999 centimes : refusé `amount_too_large`.

### 4.4 Customers
`POST /v1/customers {email, name?, metadata?}`, `GET /v1/customers/:id`, `GET /v1/customers`, `POST /v1/customers/:id {invoice_settings:{default_payment_method}}`.

### 4.5 Payment Intents (machine à états)
États : `requires_payment_method` → `requires_confirmation` → (`requires_action`) → `requires_capture` | `succeeded` ; `canceled` ; retour à `requires_payment_method` sur refus (avec `last_payment_error`).
- `POST /v1/payment_intents { amount, currency, customer?, payment_method?, capture_method: automatic|manual, confirm?, off_session?, application_fee_amount?, transfer_data?:{destination}, description?, metadata? }`
- `POST /v1/payment_intents/:id/confirm { payment_method? }` (sk ; et clé pk autorisée avec `client_secret` du PI dans le corps)
- `POST /v1/payment_intents/:id/capture { amount_to_capture? }` (≤ montant autorisé ; le reste est libéré)
- `POST /v1/payment_intents/:id/cancel`
- 3-D Secure : `next_action: { type: "three_d_secure", challenge_id }` ; `POST /v1/three_ds/:challenge_id/complete { result: "approve"|"deny" }` (clé pk + client_secret) → reprend la confirmation.
- Expiration d'autorisation : `requires_capture` non capturé après 7 jours → `canceled` (`cancellation_reason: "expired"`), traité par `testclock.advance` / tâche périodique.
- Chaque autorisation crée une ligne `charges` (`ch_`, status `succeeded|failed`, `amount_captured`, `amount_refunded`, `outcome`).
- Écritures ledger **uniquement à la capture**.
- Transitions invalides → 409 `state_error`. Événements : `payment_intent.created|requires_action|amount_capturable_updated|succeeded|payment_failed|canceled`, `charge.succeeded|failed|captured`.
- *Précisions phase 2 (implémenté)* :
  - Refus → 402 `card_error` `{ code, decline_code, charge, payment_intent }` (PI déjà revenu à `requires_payment_method`, état committé avant la réponse, cf. taskForLesson L6). 3DS refusé (`deny`) → 402 `code: payment_intent_authentication_failure`, `decline_code: authentication_failed`.
  - Clé pk : `client_secret` absent → 400 `parameter_missing` ; faux ou d'un autre PI → **404** `not_found` (même réponse qu'un PI inexistant, pas d'oracle d'existence).
  - Expiration : `now > authorized_at + 7 j` (strict) ; `payments.expireAuthorizations(now)` exporté, renvoie les ids expirés.
  - Capture avec destination : le montant capturé doit être > `application_fee_amount`. `transfer_data` sans `application_fee_amount` → commission 0.
  - Routes annexes : `GET /v1/payment_intents?customer=`, `GET /v1/charges?payment_intent=`, `GET /v1/charges/:id` (sk).

### 4.6 Refunds
`POST /v1/refunds { payment_intent, amount?, reason?, refund_application_fee? }`. Montant par défaut = restant remboursable. Somme des remboursements ≤ `amount_captured` (sinon 400 `amount_too_large`). PI non capturé → 409. Événements `charge.refunded`, `refund.created`. `GET /v1/refunds?payment_intent=`.
- *Précisions phase 3 (implémenté)* :
  - Table `refunds` (`re_`, `charge_id`, `amount`, `status` = `succeeded` uniquement, `reason`, `refund_application_fee`, `application_fee_refunded` = feeShare, `debited_account`, `metadata`). Routes : `POST /v1/refunds`, `GET /v1/refunds/:id`, `GET /v1/refunds?payment_intent=` (sk).
  - `reason` ∈ `duplicate | fraudulent | requested_by_customer` ; `metadata` accepté.
  - Objet `refund` : `{ id, object, amount, currency, payment_intent, charge, status, reason, refund_application_fee, application_fee_refunded, metadata, created }`.
  - Colonne `charges.refunded` (0/1, vraie quand `amount_refunded = amount_captured`) ajoutée à `schema.sql` ET par migration additive (`ADDED_COLUMNS` dans `db/index.js` : `ALTER TABLE ADD COLUMN` si absente) pour les bases fichier de phase 2. L'objet `charge` expose `refunded: boolean`.
  - PI inexistant → 400 `resource_missing` (`param: payment_intent`) ; PI non `succeeded` (requires_capture, canceled, …) → 409 `state_error` `payment_intent_unexpected_state` ; charge déjà intégralement remboursée → 400 `charge_already_refunded` (`param: amount`) ; `refund_application_fee: true` sans destination → 400 (`param: refund_application_fee`).
  - Vérification du cumul, écritures ledger, mise à jour de la charge et événements dans UNE `db.transaction()`.

### 4.7 Connect (marketplace)
- `POST /v1/accounts { email, business_name }` → `acct_` (status `enabled`).
- *Phase 2* : la table `accounts` existe déjà (schéma minimal `id, email, business_name, status, created`) pour valider `transfer_data.destination` (inexistant → 400 `resource_missing`, `disabled` → 400 `account_disabled`). La phase 3 ajoute service et routes sans recréer la table.
- Paiement split : PI avec `transfer_data.destination` + `application_fee_amount` (< amount).
- `POST /v1/transfers { amount, destination }` : Dr platform_balance ; Cr merchant (≤ solde plateforme).
- `POST /v1/payouts { account, amount }` : virement bancaire simulé, status `paid` immédiat.
- `GET /v1/accounts`, `GET /v1/accounts/:id`, `GET /v1/accounts/:id/balance`.
- Événements `account.created`, `transfer.created`, `payout.paid`.
- *Précisions phase 3 (implémenté)* :
  - Tables `transfers` (`tr_`, `amount`, `currency`, `destination`, `description`, `metadata`) et `payouts` (`po_`, `account_id`, `amount`, `status` = `paid`, `arrival_date` = création, `description`, `metadata`). La table `accounts` de phase 2 est réutilisée telle quelle.
  - `POST /v1/accounts` crée aussi le compte ledger `merchant:<id>` (type liability). Pas encore de route de désactivation (statut `disabled` posé en base pour les tests).
  - Routes supplémentaires : `GET /v1/transfers[?destination=]`, `GET /v1/transfers/:id`, `GET /v1/payouts[?account=]`, `GET /v1/payouts/:id`. `currency: "eur"` optionnel sur transfers/payouts.
  - `GET /v1/accounts/:id/balance` → `{ object: "balance", available: [{ amount, currency: "eur" }] }` (même format que `/v1/balance`) ; peut être négatif (cf. §4.1).
  - Destination/compte inconnu → 400 `resource_missing` (`param: destination` / `account`), désactivé → 400 `account_disabled`.
  - Vérification de solde ET écriture dans la même `db.transaction()` (better-sqlite3 synchrone : pas de course entre deux payouts).

### 4.8 Billing (abonnements)
- `POST /v1/products {name}`, `POST /v1/prices { product, unit_amount, currency, recurring:{interval: day|week|month|year, interval_count:1} }`.
- `POST /v1/subscriptions { customer, price, trial_period_days?, default_payment_method? }`.
  - Avec essai : `trialing`, période = essai, aucune facture payée.
  - Sinon : facture créée et payée immédiatement off-session (PI interne avec capture auto). Succès → `active` ; échec → `incomplete` (facture `open`).
- Période : `current_period_start/end` (mois calendaire réel : ajout de mois en UTC, 31 jan + 1 mois = 28/29 fév).
- Moteur `billing.run(now)` (appelé par l'horloge de test) :
  - fin de période atteinte → nouvelle facture `in_` (draft→open), tentative de paiement ; succès → `paid`, période suivante, `active`.
  - échec → sub `past_due`, `attempt_count++`, prochaines tentatives à +1 j, +3 j, +5 j après la première ; après 4 échecs → facture `uncollectible`, sub `canceled`.
  - `cancel_at_period_end` → `canceled` à la fin de période sans facturer.
  - fin d'essai → première facture.
- `POST /v1/subscriptions/:id/cancel { at_period_end?: boolean }`, `GET /v1/subscriptions/:id`, `GET /v1/invoices?subscription=`, `POST /v1/invoices/:id/pay` (nouvelle tentative manuelle).
- Événements : `customer.subscription.created|updated|deleted`, `invoice.created|paid|payment_failed|marked_uncollectible`.
- *Précisions phase 4 (implémenté)* :
  - Fichiers : `modules/billing/{periods,service,routes}.js`. Tables `products`, `prices`, `subscriptions`, `invoices` (nouvelles tables seulement, rien dans `ADDED_COLUMNS`).
  - **Ancrage** : `billing_cycle_anchor` = création (ou fin d'essai) ; borne k = ancre + k·interval_count intervalles, toujours calculée depuis l'ancre (`periodBoundary`) → 31 janv. → 28/29 févr. → 31 mars. Mois = même jour/heure UTC, écrêté au dernier jour du mois ; année = 12 mois. `interval_count` ≥ 1 et période ≤ 1 an (day ≤ 365, week ≤ 52, month ≤ 12, year = 1). `period_index` (−1 pendant l'essai) ; `UNIQUE(subscription_id, period_index)` sur `invoices` = filet d'idempotence.
  - **Prix** : `recurring` optionnel → `type: one_time|recurring` ; un abonnement exige un prix récurrent (400 `price_not_recurring`).
  - **Paiement** : un PI interne par facture (`off_session`, capture auto, `metadata: {invoice, subscription}`) créé/confirmé via `ctx.payments` ; une relance re-confirme le même PI. pm = `sub.default_payment_method` ?? `customer.invoice_settings.default_payment_method` ; aucun → échec `payment_method_missing` (même chemin qu'un refus). Le refus est committé (L6) ; `POST /v1/invoices/:id/pay` répond 402 `card_error` APRÈS commit (`error.payment_intent` à jour).
  - **Création** : sans essai, facture `subscription_create` émise et tentée ; échec → `incomplete`, facture `open`, **pas de relance automatique** (seul `POST /v1/invoices/:id/pay` la règle → `active`). Pas d'état `incomplete_expired` (écart Stripe).
  - **Relances** : 1er échec automatique à T (instant logique de l'échéance) → `past_due`, `next_payment_attempt` = T+1 j, T+3 j, T+5 j ; 4ᵉ échec (tentatives manuelles comprises) → `invoice.payment_failed` puis `uncollectible` + `invoice.marked_uncollectible`, sub `canceled` + `customer.subscription.deleted`. Paiement réussi en `past_due` → `active` ; la période (déjà avancée à l'émission de la facture) continue normalement.
  - **Moteur `run(now)`** : sélectionne les subs `trialing|active|past_due` dont la période est échue ou dont la facture ouverte a une relance échue ; chaque sub dans SA transaction, boucle d'étapes (relance due → fin de période : résiliation programmée ou nouvelle facture) jusqu'à être à jour. Tant qu'une facture est `open`, aucune nouvelle facture. Horodatages métier (`finalized_at`, `paid_at`, `marked_uncollectible_at`, `canceled_at`, ancre de relance) = instant LOGIQUE de l'échéance (L11) ; `created` = instant de traitement. Une erreur inattendue sur une sub est journalisée, annule CETTE sub seulement (`errors[]`), les autres continuent. Résumé renvoyé : `{ subscriptions_processed, invoices_created, invoices_paid, payment_failures, subscriptions_canceled, errors }`.
  - **Cancel** : immédiat → factures `open` passées `void` (+ `invoice.voided`, PI interne annulé `abandoned`), sub `canceled` ; `at_period_end` → `cancel_at_period_end`, `canceled` à `current_period_end` sans facture. Déjà résilié → 409 ; `incomplete` + `at_period_end` → 409.
  - **Routes** (sk) : `POST/GET /v1/products[/:id]`, `POST/GET /v1/prices[/:id][?product=]`, `POST /v1/subscriptions`, `GET /v1/subscriptions[?customer=&status=]`, `GET /v1/subscriptions/:id`, `POST /v1/subscriptions/:id {default_payment_method?, cancel_at_period_end?}`, `POST /v1/subscriptions/:id/cancel`, `GET /v1/invoices[?subscription=&customer=&status=]`, `GET /v1/invoices/:id`, `POST /v1/invoices/:id/pay {payment_method?}` (facture non `open` ou sub résiliée → 409).
  - **Événements supplémentaires** : `product.created`, `price.created`, `invoice.finalized`, `invoice.voided`.

### 4.9 Webhooks
- `POST /v1/webhook_endpoints { url, enabled_events: ["*"] | [...] }` → `{ id, secret: "whsec_..." }` (secret renvoyé uniquement à la création).
- Livraison : pour chaque event qui matche, ligne `webhook_deliveries` ; worker `webhooks.deliverPending()` envoie POST JSON (fetch, timeout 5 s) avec header
  `PaySim-Signature: t=<ts>,v1=<hex HMAC-SHA256(secret, "<ts>.<rawBody>")>`.
  2xx → `delivered` ; sinon retry backoff 1 min, 5 min, 30 min, 2 h, 8 h (horloge de test) puis `failed`.
- Utilitaire exporté `verifySignature(rawBody, header, secret, toleranceSec=300)` (comparaison en temps constant).
- `GET /v1/events`, `GET /v1/events/:id`, `GET /v1/webhook_endpoints/:id/deliveries`.
- *Précisions phase 5 (implémenté)* : `modules/webhooks/{service,routes,verify}.js`, `modules/events/types.js`. Nouvelles tables `webhook_endpoints`, `webhook_deliveries` (rien dans `ADDED_COLUMNS`, L10 ; vérifié sur une copie de `data/paysim.db`).
  - **Routes** (sk) : `GET /v1/event_types` ; `POST /v1/webhook_endpoints { url, enabled_events, description? }` ; `GET /v1/webhook_endpoints[/:id]` ; `POST /v1/webhook_endpoints/:id { url?, enabled_events?, description?, disabled? }` ; `DELETE /v1/webhook_endpoints/:id` (→ `{ id, object, deleted: true }`, livraisons supprimées en cascade) ; `GET /v1/webhook_endpoints/:id/deliveries[?status=]`.
  - **Objet** `webhook_endpoint` : `{ id, object, url, enabled_events, description, status: enabled|disabled, created }` (+ `secret` à la création SEULEMENT). `webhook_delivery` : `{ id, object, endpoint, event, event_type, status: pending|sending|delivered|failed, attempts, next_attempt_at, last_attempt_at, last_status_code, last_error, delivered_at, created }`.
  - **Validation** : URL `http:`/`https:` uniquement (400 `url_invalid` sinon), sans `user:pass@`, ≤ 2048 car. `enabled_events` = `["*"]` seul, ou liste de types de `EVENT_TYPES` (doublons retirés ; inconnu → 400 `event_type_unknown`).
  - **Secret** : `whsec_` + 24 octets aléatoires. Stocké **chiffré** AES-256-GCM avec une sous-clé HKDF de `VAULT_KEY` (label `webhook_endpoint_secret`, AAD = id de l'endpoint) : le clair est nécessaire pour signer (un hash ne suffit pas), mais une fuite de la base seule ne le révèle pas. Pas de rotation par API (écart : `verifySignature` accepte déjà plusieurs `v1=`).
  - **Fan-out** : `events.onEmit(fn(event, seq))` ; `emit` exécute insertion + listeners dans une `db.transaction()` (savepoint si imbriquée) → une livraison `pending` par endpoint `enabled` qui matche, atomique avec l'événement. Un endpoint créé après un événement ne le reçoit pas. Un endpoint désactivé ensuite garde ses livraisons `pending` mais elles ne partent pas tant qu'il est désactivé.
  - **Livraison** `deliverPending({ now = clock.now(), limit = 100 })` (async) : (1) transaction synchrone qui sélectionne les `pending` échues (endpoint actif) par `event_seq` et les passe en `sending` (`UPDATE … WHERE status='pending'`, `changes === 1`) ; (2) fetch HORS transaction. Deux appels concurrents ne réservent jamais la même ligne. Endpoints en parallèle, séquentiel par endpoint (ordre des events). Corps = `JSON.stringify({id, object:'event', type, created, data})` sérialisé une fois, signé sur ces octets exacts. Timeout `config.webhookTimeoutMs` (défaut 5000, env `WEBHOOK_TIMEOUT_MS`) par AbortController. `redirect: 'manual'` (3xx = échec). Réponse du marchand non lue.
  - **Retries** : 2xx → `delivered` ; sinon `attempts++`, `next_attempt_at = now + [60, 300, 1800, 7200, 28800][attempts-1]`, `failed` après la 6ᵉ tentative. **Écart assumé à L11** : le délai part de la tentative RÉELLE (pas d'échéance logique) car chaque tentative est un vrai appel HTTP ; un saut d'horloge de 1 j ne fait qu'UNE tentative par `deliverPending`, pas 6 en rafale. `last_error` : `HTTP <code>`, `timeout après N ms` ou `erreur réseau : <code>`.
  - **Signature** : `t=` = **temps réel** (`Date.now()`), pas `ctx.clock` : c'est un anti-rejeu comparé à l'horloge du marchand (tolérance 300 s) ; avec l'horloge de test décalée, toutes les signatures seraient rejetées (L14). Les dates métier (`created` de l'event, `next_attempt_at`, …) restent sur `ctx.clock`.
  - **Branchements** : `ctx.testclock.onAdvance('webhooks', now => deliverPending({ now }))` (module déclaré après testclock). Worker `startWorker({ intervalMs })` lancé par `server.js` uniquement (env `WEBHOOK_WORKER_INTERVAL_MS`, défaut 2000, 0 = désactivé), `unref`, sans chevauchement ; à l'arrêt, `stop()` attend le passage en cours avant `db.close()`. Au démarrage, les lignes `sending` orphelines (arrêt pendant un envoi) repassent `pending` (livraison « au moins une fois » : le marchand déduplique par `event.id`).
  - **`verify.js`** autonome (seul `require('node:crypto')`, testé) : `verifySignature(rawBody, header, secret, toleranceSec=300, now)` → booléen ; en-tête malformé, timestamp hors tolérance (passé ou futur, borne incluse acceptée), signature fausse → `false` ; plusieurs `v1=` acceptés ; `timingSafeEqual` sur 32 octets pour chaque candidat. Exporte aussi `signatureHeader`, `computeSignature`, `parseSignatureHeader`.
  - **Limite SSRF (non traitée)** : PaySim envoie des requêtes vers une URL choisie par le titulaire de la clé sk. `localhost`, les IP privées (10/8, 172.16/12, 192.168/16, 169.254.169.254 métadonnées cloud) et les noms DNS qui y résolvent sont **autorisés en dev/test pour la démo** (récepteur local). En production il faudrait : résoudre le nom, refuser les plages privées/loopback/link-local (y compris après redirection et contre le DNS rebinding en connectant sur l'IP résolue), imposer `https`, et limiter la taille/durée de la réponse.

### 4.10 Test clock
`GET /v1/test_clock`, `POST /v1/test_clock/advance { seconds }` → avance l'horloge puis exécute dans l'ordre : expiration des autorisations, `billing.run`, `webhooks.deliverPending`. Désactivé si `NODE_ENV=production`.
- *Précisions phase 4 (implémenté)* : `modules/testclock/{service,routes}.js`. sk uniquement (pk → 403). `seconds` entier, > 0 et ≤ 5 ans (5·366 j), sinon 400 `param: seconds`. En production : 404 `route_not_found` (identique à une route inconnue). Réponse : `{ object: "test_clock", now, frozen, previous, advanced_by, results: { expired_authorizations, billing, hooks } }`.
  - **Hooks extensibles** : `ctx.testclock.onAdvance(name, fn(now))` ; appelés après `billing.run`, dans l'ordre d'enregistrement ; une erreur de hook est journalisée et renvoyée (`hooks[name] = { error }`) sans interrompre les suivants.
  - *Phase 5* : `tick()` et `advance()` sont **async** (un hook peut renvoyer une promesse, chacun est attendu avant le suivant ; un rejet est traité comme une erreur de hook). La route `POST /v1/test_clock/advance` attend le résultat (handler async + `next(err)`, Express 4 n'attrape pas les rejets) : les webhooks sont livrés AVANT la réponse. L'avance de l'horloge et la validation restent synchrones (avant le premier `await`). Phase 5 : le service webhooks appelle `ctx.testclock.onAdvance('webhooks', deliverPending)` (il doit donc être déclaré APRÈS testclock dans `MODULES`) — testclock n'est pas modifié.
  - `ctx.testclock.tick(now)` exécute les mêmes tâches sans avancer l'horloge (tâche périodique éventuelle).
  - Serveur réel : horloge temps réel + décalage ; le décalage n'est **pas persisté** (redémarrage = retour au temps réel ; les échéances déjà dépassées dans l'horloge décalée ne sont pas rejouées à l'envers, celles dans le futur attendront). Tests : horloge gelée `createClock(T0)`.

### 4.11 Démo marchand (`/demo/*`, sans clé : le serveur utilise la clé secrète en interne)
`GET /demo/config` → `{ publishableKey }` ; `POST /demo/checkout { productId }` → crée un PI et renvoie `{ id, client_secret, amount }` ; `POST /demo/subscribe { email, payment_method, priceId }`. Catalogue démo seedé (3 produits ponctuels, 1 abonnement mensuel 9,90 €, 1 vendeur marketplace).
- *Précisions phase 6 (implémenté)* : `src/demo/{catalog,service,routes}.js`, montés par `app.js` (pas dans `MODULES` : pas de route /v1).
  - **Droits sk sans la clé** : le marchand appelle directement les services (`ctx.payments.create`, `ctx.billing.createSubscription`, …), ceux qu'exécutent les routes /v1 protégées par sk. Aucun appel HTTP interne, la clé secrète ne transite nulle part. Rate limit appliqué aussi à `/demo` (mêmes réglages que /v1).
  - **Catalogue** « Comptoir des Pentes » : café 12,50 €, carnet 18,90 €, planche en noyer 48,00 € (marketplace, vendeur « Atelier Lyonnais », commission plateforme 15 % = `floor((A·15+50)/100)`, 7,20 €), abonnement « Café du mois » 9,90 €/mois. Vrais objets `prod_`/`price_`/`acct_` créés via les services ; retrouvés par `metadata.demo_key` (produits, prix) et par e-mail (vendeur) → **seed idempotent** (testé en mémoire ET sur base fichier rouverte ; vérifié au redémarrage réel : 4 produits, 4 prix, 1 vendeur). Seed au démarrage (`createApp({ seedDemo: true })`, server.js) ; sinon paresseux au premier appel (tests des autres modules non impactés). Cache mémoire rempli seulement après commit (L18).
  - `GET /demo/config` → `{ shop, publishableKey, products: [{ id, price, name, description, amount, currency, marketplace: null | { seller, seller_name, platform_fee_percent, application_fee_amount } }], subscriptionPrice: { id, product, name, description, unit_amount, currency, interval } }`.
  - `POST /demo/checkout { productId, capture_method? }` → `{ id, client_secret, amount, currency }`. Schéma **strict** : tout autre champ (`amount`, `application_fee_amount`, `transfer_data`, `currency`) → 400 (refusé, pas ignoré). Produit inconnu → 400 `resource_missing` (`param: productId`).
  - `POST /demo/subscribe { email, payment_method, priceId? }` → `{ customer, subscription: { id, status, current_period_start, current_period_end }, invoice: { id, status, amount_due, amount_paid, currency } }`. Client + attach + `invoice_settings.default_payment_method` + abonnement dans UNE transaction (pm inconnu → 400 `resource_missing` sans client orphelin ; pm déjà rattaché → 400 `payment_method_already_attached`). Carte refusée → abonnement `incomplete` committé (L6) puis **402 `card_error`** `{ code, decline_code, subscription, invoice }`. `priceId` facultatif ; s'il est fourni il doit être celui du catalogue.
  - **Écart** : `GET /demo/config` renvoie aussi `products` et `subscriptionPrice` (nécessaires au front) ; `priceId` facultatif.

## 5. Front (web/)
- **/checkout** : boutique (3 produits), formulaire carte → `POST /v1/payment_methods` avec pk directement (la carte ne passe jamais par le backend marchand), confirmation, fenêtre 3-D Secure simulée (Approuver/Refuser), écran résultat. Liste des cartes de test visible.
- **/subscribe** : souscription à l'abonnement mensuel.
- **/dashboard** (saisie de la clé sk, gardée en mémoire) : paiements (détail, capture, remboursement), clients, abonnements + factures, vendeurs + soldes + payout, grand livre + contrôle d'équilibre, événements + livraisons webhook, bouton « avancer l'horloge » (+1 j, +1 mois).
- Vite proxy `/v1` et `/demo` → `http://localhost:4000`.
- *Précisions phase 6 (implémenté)* : React 18.3.1 + Vite 6.4.4 + react-router-dom 6.30.6, JavaScript, police Schibsted Grotesk (fontsource, auto-hébergée : aucune requête externe, compatible CSP). Fichiers : `web/src/{App,main}.jsx`, `lib/` (api, format fr-FR, messages FR par `decline_code`, contexte clé sk, `useResource`), `components/` (CardForm, ThreeDsModal, TestCards, ui), `pages/` (Checkout, Subscribe, Dashboard + 7 onglets).
  - **Carte** : `POST /v1/payment_methods` (pk) directement depuis le navigateur ; état local du composant uniquement (aucun stockage persistant), champs vidés dès la tokenisation ; le parent ne reçoit que le `pm_`. Numéro groupé par 4, marque détectée en direct (mêmes règles que le vault), contrôles locaux (Luhn, date, CVC) de confort — le serveur revérifie tout. Chaque POST /v1 porte une `Idempotency-Key` neuve.
  - **Checkout** : le PI est créé au moment de payer (pas à la sélection : pas de PI orphelin) et réutilisé après un refus (revenu à `requires_payment_method`). `requires_action` → modale 3-D Secure (focus piégé, Échap = refuser) → `POST /v1/three_ds/:id/complete` (pk + client_secret).
  - **Dashboard** : clé sk saisie, vérifiée par `GET /v1/ledger/check`, gardée en mémoire (contexte React) — jamais localStorage/sessionStorage/cookie/URL (vérifié par l'E2E). Après une action, l'onglet recharge ses données (pas de remontage, L19). Horloge : +1 j, +7 j, +1 mois calendaire (même jour du mois suivant, écrêté).
  - **Nouvelle route API** : `GET /v1/ledger/accounts` (sk) → `{ object: 'list', data: [{ object: 'ledger_account', code, type, balance, net, entries }] }` (solde affiché selon la convention §4.1, `net` = somme signée ; Σ net = 0). Écart : non prévue au plan, nécessaire à l'onglet Grand livre (testée dans `test/ledger.test.js`).
  - **Production** : `createApp({ staticDir })` sert `web/dist` (assets hashés `immutable`, `index.html` `no-cache`) avec fallback SPA pour les GET/HEAD acceptant du HTML hors `/v1`, `/demo`, `/health` (une route API inconnue garde sa 404 JSON). `server.js` passe `web/dist` (surcharge : `WEB_DIST_DIR`). Absent → simple avertissement.
  - **CSP** (helmet) : `default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`, `img-src 'self' data:`, `connect-src 'self'`, `frame-ancestors 'none'` ; `upgrade-insecure-requests` **seulement en production** (en http local il forcerait les assets en https). Vérifié en Chromium : 0 erreur CSP.
  - **Logs** : la clé secrète n'est plus imprimée au démarrage (L17) — écart par rapport au §3 « clés affichées au démarrage » : seule la pk et un indice `sk_…0000` le sont.
- **Lancement** (racine `paysim/`) : `npm run setup` (installe racine + server + web), `npm run dev` (concurrently : API :4000 + Vite :5173 avec proxy), `npm test`, `npm run build`, `npm start` (API + front buildé sur :4000).

## 6. Phases

| # | Phase | Livrable | Preuve exigée |
|---|---|---|---|
| 1 | Fondations | app factory, DB/schema, libs, auth, idempotence, erreurs, logs, ledger, events | tests verts, `ledger/check` OK |
| 2 | Vault + network + customers + payment intents (auth/capture/3DS/annulation/expiration) | API paiement unique | tests de chaque carte de test, aucun PAN dans les logs |
| 3 | Refunds + Connect (split, transfers, payouts) | marketplace | tests soldes ledger équilibrés — **fait** (131 tests, fuzz 200 op., 5 mutations L7, smoke port 4103) |
| 4 | Billing (produits, prix, abonnements, factures, relances) + test clock | abonnements | scénario essai→actif→relances→annulé — **fait** (173 tests, 6 mutations L7, smoke port 4104, migration vérifiée) |
| 5 | Webhooks (livraison signée, retries) | webhooks | test avec serveur HTTP local réel — **fait** (201 tests, 10 mutations L7, smoke port 4105 + récepteur 4199) |
| 6 | Démo marchand + front React | UI | `npm run build` OK + parcours e2e via navigateur/HTTP — **fait** (221 tests, 3 mutations démo, E2E Playwright/Chromium 7/7 sur port 4106, 0 erreur console, logs propres) |
| 7 | Vérification finale + README | doc | suite complète verte, serveur démarré, logs relus |

## 7. Règles de travail
1. Plan avant code ; si ça dérape : stop, mettre à jour ce plan.
2. Travail complexe délégué à des sous-agents ; ce fichier sert de contrat.
3. Chaque erreur rencontrée → nouvelle règle dans `taskForLesson.md`.
4. Aucune phase « terminée » sans `npm test` vert + vérification des logs.

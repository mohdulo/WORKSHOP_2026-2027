# PaySim — un prestataire de paiement codé de A à Z

Projet EPSI. PaySim est un **PSP (prestataire de services de paiement) construit sans Stripe, PayPal ni Mollie** : coffre-fort carte, autorisation/capture, 3-D Secure, remboursements, marketplace, abonnements, webhooks signés et grand livre en partie double.

> ⚠️ Les banques et réseaux carte sont **simulés** (module `network`). Aucun argent réel ne circule. Traiter de vrais paiements exigerait un agrément ACPR d'établissement de paiement, un contrat avec une banque acquéreuse, la certification PCI DSS et un 3-D Secure réel (DSP2).

## Démarrage

Prérequis : Node.js ≥ 22.

```bash
npm run setup     # installe racine + server + web
npm run dev       # API http://localhost:4000 + front http://localhost:5173
npm test          # 221 tests (vitest + supertest)
```

Production (un seul process qui sert aussi le front) :

```bash
npm run build && npm start   # http://localhost:4000
```

### Docker

Prérequis : Docker avec Compose v2. Une seule image : l'API sert aussi le front buildé, comme `npm run build && npm start`.

```bash
docker compose up --build -d   # http://localhost:4000
docker compose logs -f         # clés de test affichées au démarrage
docker compose down            # ajouter -v pour effacer aussi la base
```

La base SQLite vit dans le volume `paysim-data` (`/data/paysim.db` dans le conteneur) : elle survit aux redémarrages et aux rebuilds. Pour changer le port exposé ou les clés, copier `.env.example` en `.env` (jamais commité). Sans `.env`, le conteneur utilise les clés de test ci-dessous, en mode développement.

`NODE_ENV=production` dans `.env` exige une `VAULT_KEY` personnalisée (`openssl rand -hex 32`), désactive l'horloge de test et suppose un accès en HTTPS (reverse proxy TLS devant le conteneur).

Sans Compose :

```bash
docker build -t paysim .
docker run -d --name paysim -p 4000:4000 -v paysim-data:/data paysim
```

Clés de test par défaut (surchargées par variables d'environnement) :

| Variable | Défaut |
|---|---|
| `SECRET_KEY` | `sk_test_paysimDevSecretKey000000000000` (dashboard, appels serveur) |
| `PUBLISHABLE_KEY` | `pk_test_paysimDevPublishableKey00000000` (tokenisation côté navigateur) |
| `VAULT_KEY` | clé AES-256 de dev — **à changer** hors démo |
| `PORT` / `DB_PATH` | `4000` / `./data/paysim.db` |

## Pages

- **/checkout** — boutique de démo : la carte part directement du navigateur vers PaySim (`pk_`), jamais vers le site marchand. Modale 3-D Secure simulée.
- **/subscribe** — abonnement mensuel 9,90 €.
- **/dashboard** — saisir la clé `sk_` (gardée en mémoire seulement) : paiements, capture, remboursement, clients, abonnements et factures, vendeurs et payouts, grand livre, événements et webhooks, horloge de test.

## Cartes de test

| Numéro | Résultat |
|---|---|
| 4242 4242 4242 4242 | accepté |
| 5555 5555 5555 4444 | accepté (Mastercard) |
| 4000 0000 0000 3220 | 3-D Secure demandé |
| 4000 0000 0000 0002 | refusé `card_declined` |
| 4000 0000 0000 9995 | refusé `insufficient_funds` |
| 4000 0000 0000 0069 | refusé `expired_card` |
| 4000 0000 0000 0127 | refusé `incorrect_cvc` |
| 4000 0000 0000 0341 | enregistrable mais tout paiement échoue (tests de relance) |

N'importe quelle date future et n'importe quel CVC conviennent.

## Architecture

```
server/src/
  app.js              factory createApp() + registre MODULES
  lib/                ids, montants, horloge, erreurs, crypto, logger, pagination
  middleware/         auth (sk/pk), idempotence, validation zod, erreurs
  modules/
    vault/            tokenisation : Luhn, AES-256-GCM, empreinte HMAC, CVC jamais stocké
    network/          simulateur banque / réseau carte
    payments/         payment intents (machine à états), charges, 3-D Secure, expiration 7 j
    refunds/          remboursements total / partiel
    connect/          vendeurs, paiements partagés, transferts, payouts
    billing/          produits, prix, abonnements, factures, relances
    ledger/           grand livre en partie double
    events/           journal d'événements
    webhooks/         livraison signée HMAC, retries, verify.js
    testclock/        horloge de test (avance du temps simulé)
  demo/               backend marchand de démonstration
web/                  React 18 + Vite
```

### Principes clés

- **Montants en centimes entiers**, jamais de flottants.
- **Grand livre en partie double** : chaque opération (capture, remboursement, transfert, payout) est une transaction dont la somme vaut 0. `GET /v1/ledger/check` le vérifie ; un test aléatoire de 200 opérations le garantit.
- **Machine à états** des paiements : `requires_payment_method → requires_action → requires_capture → succeeded`, transitions invalides refusées (409).
- **Idempotence** : header `Idempotency-Key` sur tout POST ; même clé + autre corps → 409.
- **Sécurité** : numéro de carte chiffré, CVC jamais stocké, clé secrète jamais exposée au navigateur, secrets masqués dans les logs (testé par mutation), helmet + CSP, limite de débit.
- **Webhooks** : header `PaySim-Signature: t=…,v1=HMAC-SHA256`, retries 1 min → 8 h. Côté marchand, copier `server/src/modules/webhooks/verify.js`.

## Exemple d'appel API

```bash
SK=sk_test_paysimDevSecretKey000000000000
PK=pk_test_paysimDevPublishableKey00000000

# 1. Tokeniser la carte (navigateur, clé publique)
curl -X POST localhost:4000/v1/payment_methods -H "Authorization: Bearer $PK" \
  -H 'Content-Type: application/json' \
  -d '{"card":{"number":"4242424242424242","exp_month":12,"exp_year":2030,"cvc":"123"}}'

# 2. Payer (serveur marchand, clé secrète)
curl -X POST localhost:4000/v1/payment_intents -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: commande-42' \
  -d '{"amount":2500,"currency":"eur","payment_method":"pm_…","confirm":true}'
```

## Documentation du projet

- `PLAN.md` — spécification complète et contrats d'API, avec les écarts décidés en cours de route.
- `taskForLesson.md` — 21 leçons tirées des erreurs rencontrées, transformées en règles.

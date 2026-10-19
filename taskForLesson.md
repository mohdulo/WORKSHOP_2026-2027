# taskForLesson.md — Leçons apprises

Chaque erreur rencontrée pendant le projet devient une règle ici. À relire avant toute nouvelle tâche.

Format : `## L<n> — <titre>` puis **Erreur** (ce qui s'est passé), **Règle** (ce qu'on fait désormais), **Vérification** (comment on s'en assure).

---

## L1 — Vitest 5 ne peut pas être `require()` depuis un fichier CommonJS
**Erreur** : en phase 1, `const { describe, it, expect } = require('vitest')` dans les tests CJS → « Vitest cannot be imported in a CommonJS module using require() » ; 7 fichiers de test en échec, 0 test exécuté.
**Règle** : `globals: true` dans `server/vitest.config.js` ; dans les tests, ne jamais importer `vitest` : utiliser `describe/it/expect/beforeEach/vi` globaux. Le reste (supertest, src/) reste en `require`.
**Vérification** : `grep -r "require('vitest')" server/test` ne renvoie rien ; `npm test` exécute bien N tests (pas « no tests »).

## L2 — pino-http sérialise la requête AVANT le parsing du corps
**Erreur** : un serializer `req` incluant `req.raw.body` semblait journaliser le corps, mais la ligne `request completed` n'en contenait jamais : pino-http fige `req` dans un logger enfant à l'entrée du middleware, avant `express.json`. Un test « pas de PAN dans les logs » pouvait donc passer sans rien prouver.
**Règle** : ne pas compter sur pino-http pour journaliser le corps (on ne le fait pas). Le test de sécurité des logs doit (1) logger explicitement l'objet carte via `req.log`, (2) vérifier la présence de `[Redacted]`, (3) être validé par mutation : désactiver `redact` doit faire échouer le test. Chaque nouveau champ sensible (PAN, CVC, client_secret, secret webhook) est ajouté à `REDACT_PATHS` de `src/lib/logger.js`.
**Vérification** : le test `test/logs.test.js` exige `[Redacted]` dans la sortie ; mutation faite en phase 1 (redact retiré → test rouge).

## L3 — Arrondi des frais : pas de float dans le calcul
**Erreur** (évitée) : la spec écrit `round(amount * 0.014) + 25` ; `amount * 0.014` est un float (ex : 1250 * 0.014 = 17.5, 107143 * 0.014 = 1500.002).
**Règle** : calcul entier `Math.floor((amount * 14 + 500) / 1000) + 25` (arrondi au demi supérieur), vérifié identique à la formule de la spec pour tout montant de 1 à 2 000 000.
**Vérification** : test « identique au calcul flottant de la spec » dans `test/lib.test.js`.

## L4 — Ne jamais arrêter le serveur avec `pkill -f "node src/server.js"`
**Erreur** : en vérification de phase 1, `pkill -f` a matché la ligne de commande du shell qui l'exécutait → shell tué (exit 144), vérification interrompue. Le même script lisait aussi `config.SECRET_KEY` alors que `config.js` exporte `loadConfig()` → clé vide, faux 401.
**Règle** : lancer le serveur en arrière-plan avec `& PID=$!`, l'arrêter avec `kill $PID; wait $PID`. Lire la config via `require('./src/config').loadConfig().secretKey` (camelCase). Avant d'utiliser un export, vérifier sa forme (`Object.keys`).
**Vérification** : le smoke test renvoie `ledger_check balanced:true` (et pas 401) et le shell termine en exit 0.

## L5 — pino-http journalise `req.url` avec la query string (secrets en GET)
**Erreur** (détectée en phase 2 avant fuite) : `GET /v1/payment_intents/:id?client_secret=...` (clé pk) aurait écrit le `client_secret` en clair dans chaque ligne `request completed` : `redact` ne masque que des chemins d'objet, pas une sous-chaîne de `req.url`. Même risque pour tout secret passé en query.
**Règle** : le serializer `req` de `app.js` passe l'URL par `maskUrl()` (`client_secret=[Redacted]`) ; tout nouveau paramètre de query sensible est ajouté à sa regex. Préférer le corps (POST) pour transmettre un secret ; un GET qui en exige un a un test de logs qui l'exerce.
**Vérification** : `test/payments-logs.test.js` exige `client_secret=[Redacted]` dans la sortie et l'absence de `_secret_` ; mutation faite (maskUrl retiré → test rouge).

## L6 — Un refus carte (402) ne doit pas être levé à l'intérieur de `db.transaction()`
**Erreur** (évitée à la conception) : lever le `card_error` dans la transaction du confirm annulerait aussi ce qu'il faut garder : charge `failed`, `last_payment_error`, retour à `requires_payment_method`, événements `charge.failed` / `payment_intent.payment_failed`.
**Règle** : le service committe l'état de refus et renvoie `{ paymentIntent, failure }` ; la route transforme `failure` en 402 (`failureToError`) APRÈS le commit. Seules les vraies erreurs (validation, état, panne) sont levées dans la transaction, et elles annulent tout.
**Vérification** : tests « chaque carte de test » (charge `failed` présente après un 402), « idempotence : un refus 402 est rejoué » et « atomicité : une erreur pendant la capture annule tout ».

## L7 — Une suite verte du premier coup se vérifie par mutation
**Erreur** (risque) : en phase 2, 55 nouveaux tests sont passés au premier lancement ; un test trop lâche (ex. borne d'expiration `<` vs `<=`, frais PSP oubliés) serait passé inaperçu.
**Règle** : après une suite verte, casser volontairement chaque garde-fou critique (redact, maskUrl, borne d'expiration, écritures de frais, table de transitions), vérifier qu'au moins un test devient rouge, puis restaurer depuis une copie (pas de restauration à la main) et relancer `npm test`.
**Vérification** : les fichiers sont restaurés depuis une copie de sauvegarde (`diff` vide) et la suite complète est relancée ensuite.

## L8 — `-total` sur un solde nul renvoie `-0`
**Erreur** : en phase 3, `ledger.balanceOf()` faisait `return -total` pour les comptes passifs. Pour un solde nul (vendeur après payout total, plateforme vidée par un transfert), le résultat était `-0` : 5 tests `toBe(0)` rouges (`expected -0 to be +0`, vitest compare avec `Object.is`). En JSON `-0` s'écrit `0`, donc l'API masquait le problème ; seul l'appel direct au service le révélait.
**Règle** : pour inverser un signe sur un entier qui peut être nul, écrire `0 - x` (jamais `-x`). Tout test de solde doit inclure au moins un cas à solde exactement nul, vérifié via le service (pas seulement via JSON).
**Vérification** : tests « payout ≤ solde » (vendeur à 0), « borne exacte acceptée » (plateforme à 0) et « remboursement total avec commission » (vendeur à 0) dans `test/connect.test.js` / `test/refunds.test.js`.

## L9 — Arrondi proportionnel répété : arrondir le cumul, pas chaque part
**Erreur** (évitée à la conception) : rendre `round(F·R/A)` à chaque remboursement partiel fait dériver le total (A = 3, F = 1, trois remboursements de 1 : 3 × round(1/3) = 0 au lieu de 1 ; le vendeur ne récupère jamais la commission d'un paiement entièrement remboursé).
**Règle** : quand un montant est réparti proportionnellement en plusieurs fois, calculer `round(F·cumul/A) − déjà_réparti`. La somme des parts reste ≤ F et vaut F quand le cumul atteint A. Calcul entier (L3).
**Vérification** : test « feeShare cumulatif » (parts [0, 1, 0] et [333, 334, 333]) ; mutation M4 (arrondi non cumulatif) → test rouge ; le fuzz recalcule la même formule dans son modèle.

## L10 — Une colonne ajoutée à une table existante n'apparaît pas avec `CREATE TABLE IF NOT EXISTS`
**Erreur** (évitée) : ajouter `refunded` à `charges` dans `schema.sql` ne modifie pas une base fichier créée en phase 2 (`data/paysim.db`) : la table existe déjà, `CREATE TABLE IF NOT EXISTS` ne fait rien, et le premier `UPDATE charges SET refunded` aurait planté (500) en démo.
**Règle** : toute colonne ajoutée à une table existante est déclarée dans `schema.sql` (bases neuves) ET dans `ADDED_COLUMNS` de `src/db/index.js` (migration additive `ALTER TABLE ADD COLUMN` si absente). Une nouvelle colonne doit être `NULL`able ou avoir un `DEFAULT`.
**Vérification** : test « migration : charges.refunded ajoutée à une base de phase 2 existante » (`test/refunds.test.js`).

## L11 — En rattrapage, les dates métier suivent l'échéance logique, pas `clock.now()`
**Erreur** (relevée en relecture, avant le premier test d'horodatage) : dans le premier jet de `billing`, l'ancre des relances était logique, mais `finalized_at`, `marked_uncollectible_at` et `canceled_at` valaient `clock.now()`. Avec une avance de 60 jours d'un coup, une facture d'échéance J+14 était « finalisée » et « déclarée irrécouvrable » à J+60, et la sub « résiliée » à J+60 au lieu de J+19 : l'historique dépendait de la taille du saut d'horloge. Avec `clock.now()` comme ancre de relance, les tentatives seraient en plus parties de J+60 (J+61, J+63…).
**Règle** : tout moteur qui rattrape plusieurs échéances (`run(now)`) traite chaque étape à son **instant logique** (borne de période, `next_payment_attempt`) et le passe explicitement (`at`) ; `clock.now()` n'est utilisé que pour `created` et les événements (instant de traitement). Les relances se calculent depuis l'ancre `retry_anchor` (1er échec), jamais depuis la tentative précédente.
**Vérification** : test « relances rattrapées en un seul advance » (`next_payment_attempt` = T+1/+3/+5 j, `marked_uncollectible_at` = T+5 j) ; mutation M4 (ancre = tentative précédente) → rouge.

## L12 — Idempotence d'un moteur périodique : avancer l'état dans la même transaction + contrainte UNIQUE
**Erreur** (risque relevé par mutation) : si la période de l'abonnement n'est pas avancée dans la transaction qui émet la facture, un second `run(now)` re-facture la même période (mutation M3b : 9 tests rouges). Une boucle limitée à une étape par run (M3a) laisse au contraire des périodes non facturées.
**Règle** : l'émission d'une facture et l'avancée de `current_period_*` / `period_index` sont faites dans la même transaction ; la base porte un filet `UNIQUE(subscription_id, period_index)`. Le moteur boucle jusqu'à ce qu'aucune étape ne soit échue (avec un plafond d'étapes contre la boucle infinie), une transaction par abonnement pour qu'une panne n'annule que lui.
**Vérification** : test « rattrapage : +3 mois → exactement 3 factures ; second run idempotent » (compte factures, PI, charges, événements et écritures avant/après) ; test « erreur inattendue isolée » ; mutations M3a/M3b → rouges.


## L13 — Un hook async appelé par du code synchrone « réussit » sans rien attendre
**Erreur** (détectée à la lecture avant branchement, confirmée par mutation M5) : `testclock.tick()` faisait `hookResults[name] = fn(now) ?? null`. Avec `deliverPending` async, `fn(now)` renvoie une Promise : aucune exception, la route répond 200 avant tout envoi HTTP, `hooks.webhooks` vaut `{}` en JSON, et un rejet devient une « unhandled rejection » au lieu d'un `{ error }`.
**Règle** : dès qu'un point d'extension peut recevoir une fonction async, toute la chaîne devient async (`await fn()` dans `tick`, `advance` async, handler de route async avec `try/catch` + `next(err)` puisque Express 4 n'attrape pas les rejets). Mettre à jour les appelants directs (tests compris : `await ctx.testclock.advance()`).
**Vérification** : tests « advance déclenche la livraison » (les requêtes sont reçues AVANT la réponse) et « erreur de hook async capturée » ; mutation M5 (`await` retiré) → 3 tests rouges.

## L14 — Le timestamp anti-rejeu d'une signature suit le temps réel, pas l'horloge de test
**Erreur** (évitée à la conception, confirmée par mutation M8) : signer avec `t = ctx.clock.now()` paraît conforme à « jamais Date.now() dans les services », mais le marchand compare `t` à SA propre horloge (tolérance 300 s). Dès qu'on avance l'horloge de test (ou dans les tests, horloge gelée en 2026-01-01), toutes les signatures seraient rejetées.
**Règle** : distinguer les dates MÉTIER (événement, `next_attempt_at`, `delivered_at` → `ctx.clock`) des horodatages de TRANSPORT vérifiés par un tiers (`t=` de signature → temps réel). L'exception est documentée à l'endroit du code et dans PLAN §3/§4.9.
**Vérification** : les tests vérifient la signature avec `verifySignature(raw, header, secret)` SANS passer `now` (temps réel) ; mutation M8 (`t = now` de l'horloge de test) → 3 tests rouges.

## L15 — Pas d'`await` dans une transaction better-sqlite3 : réserver d'abord, envoyer ensuite
**Erreur** (risque évité à la conception, confirmé par mutation M2) : better-sqlite3 est synchrone ; une fonction passée à `db.transaction()` qui fait `await fetch()` committe au premier `await` (la transaction ne couvre pas l'envoi). Sélectionner les livraisons `pending` puis appeler fetch sans changer leur statut laisse deux `deliverPending` concurrents envoyer la même livraison.
**Règle** : (1) transaction SYNCHRONE qui sélectionne et passe les lignes en `sending` (`UPDATE … WHERE status = 'pending'`, on garde celles où `changes === 1`) ; (2) appels réseau hors transaction ; (3) mise à jour du résultat avec `WHERE status = 'sending'`. Au démarrage, les `sending` orphelines repassent `pending` (au moins une fois).
**Vérification** : test « deux deliverPending en parallèle → une seule requête par livraison » (récepteur lent pour forcer le chevauchement) ; mutation M2 (réservation retirée) → rouge.

## L16 — Un délai de relance « à effet de bord » part de la tentative réelle (≠ L11)
**Erreur** (évitée en relecture) : appliquer L11 aux webhooks (échéance logique = ancre + backoff cumulé) ferait, après un saut d'horloge d'un jour, partir les 6 tentatives d'un coup dans le même `deliverPending`, toutes datées dans le passé alors qu'elles sont toutes faites maintenant.
**Règle** : L11 vaut pour les moteurs qui RATTRAPENT des échéances métier (facturation). Une relance qui fait un vrai appel externe est datée à l'instant où elle est faite (`now`), et la suivante part de là ; au plus une tentative par livraison et par passage.
**Vérification** : test « 500 → retries » (`next_attempt_at = last_attempt_at + backoff`, rien à backoff − 1 s) ; mutations M3/M3b (index du backoff, nombre max de tentatives) → rouges.

## L17 — Une clé secrète « de test » journalisée au démarrage reste une clé secrète dans les logs
**Erreur** (phase 6, relevée en relisant `server.js` avant l'E2E) : depuis la phase 1, le serveur écrivait `{ secretKey: "sk_test_…" }` en clair dans le log de démarrage « pour faciliter la démo ». Toute collecte de logs (fichier, agrégateur) recevait donc la clé qui donne TOUS les droits, et l'exigence « aucun `sk_test` dans les logs » était violée dès la première ligne. `redact` ne masquait pas ce champ (`secretKey` n'est pas dans `REDACT_PATHS`).
**Règle** : une clé secrète ne s'imprime jamais, même en dev : seulement un indice (`sk_…0000`) et le nom de la variable d'environnement qui la porte. La clé publique peut être affichée. Le marchand de démo agit avec les droits sk via les SERVICES, sans manipuler la clé.
**Vérification** : le log de démarrage contient `secretKeyHint` ; audit des logs de l'E2E (`sk_test` : 0 occurrence) ; test `/demo` « logs : ni clé secrète, ni client_secret, ni PAN ».

## L18 — Ne pas mettre en cache le résultat d'une transaction qui peut encore être annulée
**Erreur** (phase 6, test rouge) : le catalogue de démo était seedé paresseusement au premier appel et mis en cache en mémoire. Quand ce premier appel était un `/demo/subscribe` en erreur (pm inconnu), le seed s'exécutait DANS la transaction de subscribe (better-sqlite3 → SAVEPOINT) ; l'erreur annulait tout, mais le cache gardait les ids `prod_`/`price_` annulés. Tous les appels suivants échouaient (« Aucun prix price_… »).
**Règle** : un cache mémoire n'est rempli qu'après un commit réel (`!db.inTransaction` après la transaction) ; résoudre les données de référence AVANT d'ouvrir la transaction métier ; seeder au démarrage (`seedDemo: true` dans `server.js`).
**Vérification** : test « régression L18 » (`test/demo.test.js`) ; mutations « cache rempli dans la transaction » et « catalogue résolu dans la transaction » → 2 tests rouges, fichier restauré depuis copie (`diff` vide).

## L19 — Remonter un composant React via `key` pour « rafraîchir » efface son état local
**Erreur** (phase 6, E2E navigateur rouge, étapes 5 et 6) : le tableau de bord rechargeait les onglets après chaque action en changeant leur `key` (`key={tab-version}`). Après un remboursement, l'onglet était démonté puis remonté : le détail ouvert et le message « Remboursement effectué » disparaissaient (le remboursement était bien fait côté serveur), et le résultat de l'horloge de test aussi. Les tests HTTP ne pouvaient pas le voir ; seul le parcours navigateur l'a révélé.
**Règle** : après une action, recharger les DONNÉES concernées (`reload()` de la ressource), jamais remonter le composant. Un front se valide par un parcours navigateur réel qui vérifie le message de confirmation, pas seulement l'appel réseau.
**Vérification** : E2E Playwright étapes 5 (message + ligne « Remboursé 10,00 € ») et 6 (« 1 facture émise / 1 facture payée ») au vert.

## L20 — Valider un front à l'œil sur des captures, pas seulement par des assertions
**Erreur** (phase 6) : la première série d'E2E était verte sur le fond, mais les captures montraient (1) « 12 , 50 € » : `font-variant-numeric: tabular-nums` élargit aussi la virgule dans Schibsted Grotesk ; (2) le tableau des factures débordait de 30 px du panneau de détail (grille avec `min-width: auto`) ; (3) un identifiant `merchant:acct_…` coupé sur mobile ; (4) une capture 3DS prise pendant l'animation d'entrée (modale semi-transparente).
**Règle** : relire chaque capture avec l'outil Read ; `tnum` uniquement sur les chiffres (`<Money>` découpe le texte) ; `min-width: 0` sur les enfants de grille et `overflow-wrap: anywhere` sur les identifiants ; attendre `el.getAnimations()` avant une capture. Ajouter un contrôle automatique du débordement (scrollWidth ≤ clientWidth à 375 px, aucun enfant hors du panneau de détail).
**Vérification** : contrôles de débordement dans le script E2E ; captures finales relues.

## L21 — `cd dir && node app &` : `$!` est le PID du sous-shell, pas de node
**Erreur** : vérification finale, `cd server && PORT=4000 node src/server.js & PID=$!` puis `kill $PID` → le sous-shell meurt (exit 143) mais node reste orphelin et continue d'écouter sur le port 4000.
**Règle** : faire le `cd` sur une ligne séparée (ou `node server/src/server.js` avec chemin), puis `node … & PID=$!`. Après l'arrêt, toujours vérifier que le port est libéré (`curl -m 2 /health` doit échouer) ; un code de sortie 143 au `wait` est un signal d'alerte. Pour retrouver un orphelin ici, `ss -p` ne donne pas le PID : parcourir `/proc/*/cmdline`.
**Vérification** : après `kill $PID; wait $PID`, la ligne « Arrêt du serveur » apparaît dans les logs et `curl /health` échoue.

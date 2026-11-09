# Synchronisation hors ligne (PowerSync)

Référence du modèle que suivent tous les modules métier (lot 05, décisions D07 et D30). Ce document grandit avec le lot : la lecture synchronisée (étapes 1 et 2) est décrite ici ; le chemin d'écriture, les refus et la politique de conflits arrivent aux étapes 3 et 4 du lot 05.

## 1. Principe

L'application des organisations lit ses données dans une base SQLite du navigateur, copiée de PostgreSQL et tenue à jour en arrière-plan. Un écran ne fait aucun appel réseau pour s'afficher (`CLAUDE.md` §6).

```
PostgreSQL ──(réplication logique, rôle app_sync)──▶ service PowerSync ──(Sync Streams, jeton ziga-sync)──▶ SQLite du navigateur
     ▲                                                                                                          │
     └──────────────────────────────── API (POST /sync/upload, étape 3) ◀───────────────────────────────────────┘
```

- **Réplication** : le service PowerSync lit la publication `powersync` avec le rôle `app_sync` (D30).
- **Répartition** : les Sync Streams (`infra/powersync/sync-config.yaml`) décident quelles lignes descendent sur chaque appareil.
- **Écriture** : l'appareil écrit d'abord en local ; l'API rejoue chaque opération avec les mêmes validations, permissions, interrupteurs et audit que ses routes (étape 3).

## 2. Sécurité

- **Rôle `app_sync`** (migration `0006_sync`) : réplication, lecture seule, sans `BYPASSRLS`. Il ne lit que les tables publiées, chacune avec un droit `SELECT` et une politique `sync_read` explicites. Les comptes, sessions, jetons, codes, abonnements et le journal ne sont ni lisibles par lui ni publiés.
- **Cloisonnement vers les appareils** : chaque stream part des appartenances de la personne du jeton (`auth.user_id()`), membre `active` d'une organisation non `suspended`. L'appartenance est lue en direct : un membre retiré, ou une organisation suspendue, sort du stream à la synchronisation suivante, et PowerSync efface ces données de l'appareil.
- **Jeton** : `GET /sync/credentials` renvoie l'adresse du service et un jeton EdDSA d'audience `ziga-sync`, valable 5 minutes (`SYNC_TOKEN_TTL_SECONDS`), signé par la clé des jetons d'accès et vérifié par le même JWKS. Il ne porte que la personne (`sub`). L'API le refuse comme jeton d'accès.
- **Colonnes** : un stream choisit ses colonnes, jamais `SELECT *`. Une donnée réservée à un rôle (exemple : la pièce d'identité du représentant légal, réservée au directeur) passe par un stream à part, filtré par ce rôle.

## 3. Ajouter une table synchronisée (lecture)

Dans l'ordre, dans le lot qui crée la table :

1. **Migration** (nouvelle migration, jamais une migration déjà appliquée) :
   ```sql
   GRANT SELECT ON ma_table TO app_sync;
   CREATE POLICY sync_read ON ma_table FOR SELECT TO app_sync USING (true);  -- table à RLS
   ALTER PUBLICATION powersync ADD TABLE ma_table;
   ```
2. **Stream** dans `infra/powersync/sync-config.yaml` : une requête qui filtre par les organisations de la personne (`organization_id IN my_organizations`), avec les seules colonnes utiles.
3. **Schéma local** : ajouter la table, avec les colonnes du stream et leur type SQLite, à `packages/shared/src/sync-schema.ts` (`SYNCED_TABLES` ; `ORGANIZATION_SCOPED_TABLES` si elle porte `organization_id`). Le web en construit son schéma PowerSync (`apps/web/src/lib/sync/schema.ts`).
4. **Tests** :
   - `apps/api/test/sync.int.test.ts` : ajouter la table à `PUBLISHED` (droits, politique, publication) ;
   - `apps/api/test/sync-streams.int.test.ts` : la configuration reste valide pour le moteur de PowerSync, chaque table lue est publiée, et le schéma local est **exactement** celui que PowerSync déduit des streams (rien à aligner à la main) ;
   - test d'accès croisé de la table (`CLAUDE.md` §5, règle 1) ;
   - `apps/web/e2e/sync.spec.ts` : une personne de A ne reçoit aucune ligne de B, flux lu auprès du vrai service.

## 4. Lire dans la base locale (écrans)

- **Ouverture** : la garde de l'espace de gestion ouvre la base (`sync.start()`, `apps/web/src/lib/sync/sync.svelte.ts`) et lance la synchronisation en arrière-plan. Le SDK n'est chargé que dans le navigateur.
- **Requêtes** : dans `apps/web/src/lib/sync/queries.ts`. Toute requête sur une table d'organisation prend l'organisation active en premier paramètre et filtre dessus (`queries.test.ts`) : un écran n'affiche jamais deux organisations.
- **Vues** : `views.ts` transforme les lignes (booléens en 0 ou 1, tableaux en JSON, dates en texte) en vues des écrans, les mêmes que celles de l'API. Fonctions pures, testées.
- **Écran** : `sync.watch(requête, [organisationActive], (lignes) => …)` dans `onMount`, en renvoyant la fonction d'arrêt. La requête est relancée à chaque changement des tables lues. Aucun appel réseau pour afficher l'écran.
- **Fonctionnalités** : calculées sur l'appareil avec la même fonction pure que le serveur (`resolveAll`), sur les tables `features`, `plan_features`, `feature_overrides` et `organization_feature_settings` ; lisibles hors connexion. `GET /me/features` ne sert qu'avant la première synchronisation. Le serveur décide toujours.
- **Indicateur** : « À jour », « Hors ligne », « Synchronisation… », « N modifications en attente » (`status.ts`, règle pure).
- **Déconnexion** : la base est vidée (`disconnectAndClear`), aussi quand l'API refuse la session (401). Un refus de PowerSync ne déconnecte jamais. Si une autre personne se connecte sur le même navigateur, la base est vidée avant d'être remplie.
- **Données non synchronisées** : le téléphone des membres et les invitations en attente (directeur) restent lus en ligne.

## 5. Développement et tests

- `pnpm infra:up` crée la base de stockage `ziga_powersync` et démarre le service (port 8080). Il attend la migration `0006` (`pnpm db:migrate`) et l'API (JWKS), en réessayant seul.
- Sans `AUTH_JWT_KEYS`, l'API prend une clé éphémère dont le `kid` change à chaque démarrage. Après un redémarrage de l'API, la première connexion à PowerSync est refusée, puis il relit le JWKS et les suivantes passent.
- La configuration du service (`infra/powersync/service.yaml`) est la même partout ; ce qui change vient de l'environnement (`PS_SOURCE_URI`, `PS_STORAGE_URI`, `PS_SSLMODE`, `PS_JWKS_URI`, `PS_PORT`).
- Tests de bout en bout : Playwright démarre un service PowerSync branché sur `ziga_e2e` (`apps/api/scripts/e2e-powersync.mjs`), par l'image Docker. Sans Docker : `E2E_POWERSYNC_NODE` (Node 24 au moins) et `E2E_POWERSYNC_ENTRY` (`lib/entry.js` du paquet `@powersync/service-image`, installé hors du dépôt).
- Le flux de synchronisation reste ouvert : un test n'attend jamais `networkidle`, mais `apiIdle` (plus de requête vers l'API) et `synced` (indicateur « À jour »), dans `apps/web/e2e/support.ts`.

## 6. À venir dans le lot 05

- Étape 3 : chemin d'écriture (`POST /sync/upload`), clés d'idempotence, modèle de référence (nom commercial de l'organisation).
- Étape 4 : refus et « Modifications non acceptées », politique de conflits, procédure complète pour une table modifiable.

# Synchronisation hors ligne (PowerSync)

Référence du modèle que suivent tous les modules métier (lot 05, décisions D07 et D30). Il décrit la lecture synchronisée (§3, §4), le chemin d'écriture (§5), les refus et la politique de conflits (§6), et la procédure complète pour une nouvelle table (§7).

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

### Tables synchronisées

| Table | Lot | Ce qui descend | Modifiable depuis l'appareil |
| --- | --- | --- | --- |
| `organizations` | 05 | fiche, formule, moyens de paiement, logo | paramètres (directeur) |
| `organization_representatives` | 05 | représentant légal, directeur seulement | oui (directeur) |
| `organization_members` | 05 | équipe, sans téléphone | non |
| `features`, `plan_features`, `organization_feature_settings`, `feature_overrides` | 05 | fonctionnalités | non |
| `owners` | 06 | fiche propriétaire, **sans** le compte lié (`user_id`) | création et modification (directeur, gestionnaire) |
| `mandates` | 06 | mandat complet, avec sa version | création, modification (nouvelle version), révocation |
| `mandate_versions` | 06 | copie de chaque version, écrite par la base seule | jamais |
| `mandate_scopes` | 06 (remplie au lot 07) | biens et unités couverts, `management_active` calculé | non |

## 4. Lire dans la base locale (écrans)

- **Ouverture** : la garde de l'espace de gestion ouvre la base (`sync.start()`, `apps/web/src/lib/sync/sync.svelte.ts`) et lance la synchronisation en arrière-plan. Le SDK n'est chargé que dans le navigateur.
- **Requêtes** : dans `apps/web/src/lib/sync/queries.ts`. Toute requête sur une table d'organisation prend l'organisation active en premier paramètre et filtre dessus (`queries.test.ts`) : un écran n'affiche jamais deux organisations.
- **Vues** : `views.ts` transforme les lignes (booléens en 0 ou 1, tableaux en JSON, dates en texte) en vues des écrans, les mêmes que celles de l'API. Fonctions pures, testées.
- **Écran** : `sync.watch(requête, [organisationActive], (lignes) => …)` dans `onMount`, en renvoyant la fonction d'arrêt. La requête est relancée à chaque changement des tables lues. Aucun appel réseau pour afficher l'écran.
- **Fonctionnalités** : calculées sur l'appareil avec la même fonction pure que le serveur (`resolveAll`), sur les tables `features`, `plan_features`, `feature_overrides` et `organization_feature_settings` ; lisibles hors connexion. `GET /me/features` ne sert qu'avant la première synchronisation. Le serveur décide toujours.
- **Indicateur** : « À jour », « Hors ligne », « Synchronisation… », « N modifications en attente » (`status.ts`, règle pure).
- **Déconnexion** : la base est vidée (`disconnectAndClear`), aussi quand l'API refuse la session (401). Un refus de PowerSync ne déconnecte jamais. Si une autre personne se connecte sur le même navigateur, la base est vidée avant d'être remplie.
- **Données non synchronisées** : les numéros des membres (directeur et gestionnaire) et les invitations en attente (directeur) restent lus en ligne ; hors connexion, l'écran le dit (« Numéro disponible en ligne »), sans erreur.
- **Accès des tests** : `window.__zigaLocalCounts` (nombre de lignes par table, jamais leur contenu) n'existe que dans une version construite avec `PUBLIC_E2E=1` ; sinon l'assembleur l'élimine (`e2e-hook.build.test.ts`).

## 5. Écrire depuis l'appareil (étape 3)

**Chemin d'une modification**

1. L'écran valide la saisie avec le schéma Zod partagé et écrit la valeur normalisée dans la base locale (`apps/web/src/lib/sync/writes.ts`, une transaction locale). L'écran l'affiche aussitôt ; l'indicateur montre « 1 modification en attente ».
2. PowerSync met l'opération en file : `PATCH` ne porte que les colonnes changées ; une mise à jour qui ne change rien n'en crée pas (`ignoreEmptyUpdates`).
3. Le connecteur (`connector.ts`) envoie la file par lots de 100 au plus à `POST /sync/upload`. Chaque opération a sa clé d'idempotence : identifiant de la base locale et numéro de l'opération.
4. L'API rejoue chaque opération, dans l'ordre de la file (`apps/api/src/modules/sync/sync.service.ts`) :
   - table déclarée au registre, organisation visée, membre actif (sinon refus, rien n'est écrit chez cette organisation) ;
   - clé déjà reçue : le premier résultat est renvoyé, rien n'est rejoué ;
   - les mêmes contrôles que la route HTTP, par les mêmes fonctions : organisation non suspendue, permission du rôle, fonctionnalité (`FEATURE_DISABLED`), création (`SUBSCRIPTION_EXPIRED`) ;
   - dans la transaction de l'organisation : la clé est enregistrée (`sync_operations`), puis le module applique l'opération avec son service et son schéma Zod ; l'audit porte l'origine `sync`.
5. Réponse toujours 200, avec un résultat par opération (`applied` ou `rejected`, code et motif) : un refus ne bloque jamais la file. Une erreur passagère (réseau, 5xx) laisse le lot dans la file ; PowerSync le renvoie, sans doublon grâce aux clés.
6. La synchronisation ramène la valeur du serveur : celle qui a été appliquée, ou l'ancienne si l'opération a été refusée.

**Rendre une table modifiable**

1. Dans le module qui possède la table, un fournisseur déclare ses opérations au registre (`SyncRegistry`), au démarrage : modèle dans `apps/api/src/modules/organizations/organizations.sync.ts`.
   - `operations` (PUT, PATCH, DELETE), `permission` (celle de la route HTTP), `feature` et `creation` si la route les exige ;
   - `organizationOf` : l'organisation visée (identifiant de la ligne, ou sa colonne `organization_id`) ;
   - `apply` : traduit les colonnes en champs de l'API (une colonne non prévue est un refus `FIELD_NOT_WRITABLE`), valide avec **le même schéma Zod** et appelle **le même service** que la route.
2. Côté web, l'écriture locale dans `writes.ts`, avec les valeurs du schéma Zod.
3. Tests : chaque refus (permission, validation, champ, fonctionnalité, création, organisation d'autrui), l'idempotence, l'audit `sync` (modèle : `apps/api/test/sync-upload.int.test.ts`), et un parcours hors ligne dans `apps/web/e2e/sync.spec.ts`.

**Modèle de référence** : les paramètres de l'organisation (nom commercial compris) et le représentant légal. Deux tables locales, donc deux opérations et deux lignes d'audit pour un enregistrement qui touche les deux.

## 6. Refus et conflits (étape 4)

**Refus**

- Une opération refusée par le serveur (permission, interrupteur coupé, validation, champ non modifiable, organisation suspendue ou d'autrui, abonnement échu) reçoit `rejected`, avec son code et son motif. Elle quitte la file : elle ne bloque jamais les suivantes.
- **L'état local est corrigé par la synchronisation suivante** : le serveur n'ayant rien changé, PowerSync remet sur l'appareil la valeur du serveur. Aucun code d'écran n'annule la saisie à la main. Un écran qui affiche une saisie en cours ne réécrit pas le formulaire ; après un enregistrement, il suit de nouveau la base locale (modèle : `apps/web/src/routes/app/organisation/+page.svelte`).
- **Rien n'est perdu en silence** : avant que le lot quitte la file, chaque refus est écrit dans la table locale `sync_rejections` (`apps/web/src/lib/sync/rejections.ts`). Cette table est `localOnly` : jamais envoyée ni reçue ; un refus en sort par « J'ai compris », ou avec le reste de la base à la déconnexion. Elle garde l'opération, les colonnes saisies, le code, le motif et la date. Son identifiant est la clé d'idempotence : un refus rejoué n'y crée pas de doublon.
- **Organisation** : le serveur joint à chaque résultat l'organisation visée (`organizationId`, quand elle se détermine). La liste est lue par organisation, comme toute lecture locale : un refus n'apparaît jamais dans une autre organisation.
- **« J'ai compris »** : chaque refus de l'écran a ce bouton, qui l'efface de la table locale (rien n'est envoyé au serveur). Sur téléphone, on ne se déconnecte presque jamais : sans lui, la liste ne ferait que grandir.
- **Notification** : après un envoi avec des refus, une alerte dans la coque donne le nombre et le motif, avec un lien vers l'écran « Modifications non acceptées » (`/app/modifications-non-acceptees`). Elle se ferme par son bouton ou par Échap. Tant que la liste de l'organisation active n'est pas vide, un lien « N modifications non acceptées » reste affiché.
- **Erreur passagère** (réseau, 5xx) : ce n'est pas un refus. Le lot reste dans la file et PowerSync le renvoie, sans doublon grâce aux clés.

**Politique de conflits**

| Écriture | Règle |
| --- | --- |
| Création | Pas de conflit : identifiant UUIDv7 créé sur l'appareil, unique. |
| Modification d'un champ descriptif | La dernière écriture reçue par le serveur gagne, **champ par champ** : `PATCH` ne porte que les colonnes changées, une modification d'un champ n'écrase pas celle d'un autre champ faite ailleurs (testé dans `sync-upload.int.test.ts`). Toujours validée par le serveur, avec le schéma Zod et la permission de la route. |
| Montant, statut, numéro de reçu | **Jamais** « dernière écriture gagnante ». Décidés par le serveur seul (`CLAUDE.md` §5, règles 3, 6 et 9). |
| Encaissement et toute écriture financière | Ajout seul : jamais modifiée, donc jamais en conflit. Une erreur se corrige par une contre-écriture (lot 09). |

**« La dernière écriture gagne, champ par champ » ne vaut que pour les champs descriptifs** : nom, adresse, téléphone de contact, références administratives, description. Elle ne vaut **jamais** pour un montant, un statut ou un numéro de reçu. Ceux-ci sont toujours décidés par le serveur :

- **Montant** (règle 3) : un paiement validé n'est jamais modifié ; une erreur se corrige par une contre-écriture motivée, par un rôle autorisé.
- **Statut** (règle 6) : un paiement n'est « confirmé » que sur preuve. Mobile Money saisi donne `to_reconcile`, espèces d'un agent de terrain `to_validate`, agrégateur `confirmed` seulement sur notification signée ou vérification. Le statut que l'appareil envoie n'est jamais repris tel quel. De même, les statuts calculés (occupation d'une unité, règle 13) ne s'écrivent pas depuis l'appareil.
- **Numéro de reçu** (règle 9) : attribué par le serveur à la validation, continu et sans trou par organisation. Un reçu créé hors ligne porte un numéro provisoire ; l’appareil n’envoie jamais de numéro définitif.

Concrètement, le gestionnaire du module ne liste que les colonnes modifiables depuis l'appareil ; toute autre colonne est refusée par `FIELD_NOT_WRITABLE` (modèle : `organizations.sync.ts`, où `plan_id`, `verification_status` ou `logo_id` sont refusés). Un statut passe par une machine d'états dans `packages/shared` qui n'accepte que les transitions permises. Une règle métier contraire à la dernière écriture (par exemple deux personnes qui encaissent la même échéance) se règle par une règle du serveur, jamais par l'ordre d'arrivée.

## 7. Procédure complète : rendre une table modifiable depuis l'appareil

Modèle de référence : le nom commercial de l'agence, de bout en bout.

1. **Lecture** (§3) : migration (droits `app_sync`, politique `sync_read`, publication), stream, schéma local, tests d'accès croisé.
2. **Écran** (§4) : lecture par `sync.watch`, organisation active en paramètre, aucun appel réseau.
3. **Écriture locale** (§5) : valeurs du schéma Zod partagé, une transaction dans `writes.ts`.
4. **Serveur** (§5) : gestionnaire au registre, avec la permission de la route, la fonctionnalité et la règle de création si la route les exige, le même schéma Zod et le même service ; les colonnes non modifiables refusées (`FIELD_NOT_WRITABLE`). Montant, statut et numéro de reçu ne sont jamais acceptés tels quels (§6).
5. **Refus** (§6) : libellés de la table et de ses colonnes dans `fr.rejections` (`apps/web/src/lib/i18n/fr.ts`), pour l'écran « Modifications non acceptées ».
6. **Tests** :
   - intégration (`sync-upload.int.test.ts`) : appliquée avec l'audit `sync`, idempotence, chaque refus avec son code ;
   - bout en bout (`apps/web/e2e/sync.spec.ts`) : hors ligne puis reconnexion, et un refus. Exemple : une directrice rétrogradée gestionnaire pendant qu'elle est hors ligne change le nom ; à la reconnexion, `FORBIDDEN_ACTION`, la valeur du serveur revient, et la modification est dans la liste.

## 8. Développement et tests

- `pnpm infra:up` crée la base de stockage `ziga_powersync` et démarre le service (port 8080). Il attend la migration `0006` (`pnpm db:migrate`) et l'API (JWKS), en réessayant seul.
- Sans `AUTH_JWT_KEYS`, l'API prend une clé éphémère dont le `kid` change à chaque démarrage. Après un redémarrage de l'API, la première connexion à PowerSync est refusée, puis il relit le JWKS et les suivantes passent.
- La configuration du service (`infra/powersync/service.yaml`) est la même partout ; ce qui change vient de l'environnement (`PS_SOURCE_URI`, `PS_STORAGE_URI`, `PS_SSLMODE`, `PS_JWKS_URI`, `PS_PORT`).
- Tests de bout en bout : Playwright démarre un service PowerSync branché sur `ziga_e2e` (`apps/api/scripts/e2e-powersync.mjs`), par l'image Docker. Sans Docker : `E2E_POWERSYNC_NODE` (Node 24 au moins) et `E2E_POWERSYNC_ENTRY` (`lib/entry.js` du paquet `@powersync/service-image`, installé hors du dépôt).
- Le flux de synchronisation reste ouvert : un test n'attend jamais `networkidle`, mais `apiIdle` (plus de requête vers l'API) et `synced` (indicateur « À jour »), dans `apps/web/e2e/support.ts`.

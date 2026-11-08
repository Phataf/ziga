# CLAUDE.md — Plateforme de gestion immobilière (Burkina Faso)

Ce fichier est la référence permanente pour Claude Code sur ce dépôt. Lis-le en entier au début de chaque session. En cas de conflit entre ce fichier et un prompt de lot, **ce fichier l'emporte** ; signale le conflit au lieu de le trancher seul.

---

## 1. Le produit en 5 lignes

- Un **registre de gestion locative multi-organisations** (biens, mandats, baux, échéances, cautions, encaissements, reçus, impayés, sorties de locataires, dépenses, relevés propriétaires), utilisé chaque jour par des agences immobilières de Ouagadougou et par des bailleurs particuliers qui gèrent eux-mêmes. Agence ou bailleur particulier : c'est une **organisation**, l'unité de cloisonnement (D12).
- Une **vitrine publique** qui affiche les unités libres des portefeuilles gérés, avec une disponibilité toujours exacte (l'annonce suit le statut de l'unité).
- Une **application local-first** : l'organisation travaille sur les données copiées dans le téléphone, synchronisées en arrière-plan. Elle doit rester utilisable hors connexion.
- Des **espaces personnels** : un propriétaire voit tous ses biens, quelle que soit l'organisation qui les gère ; un locataire voit tout son historique, toutes agences confondues. Ces espaces lisent dans chaque organisation, en lecture seule ; **aucune information ne passe d'une organisation à une autre** (D13, D17).
- Un **back-office plateforme** qui active ou désactive chaque fonctionnalité pour tout le monde, pour une formule, pour une organisation ou pour une personne (voir `docs/FEATURE-FLAGS.md`).
- La plateforme **ne détient jamais les fonds**. Elle enregistre les paiements ; en phase 3, elle initie des paiements Mobile Money **vers le compte marchand de l'agence**. Les abonnements payés par les organisations à la plateforme ne sont pas des loyers : la plateforme les encaisse sur son propre compte.

Documents à connaître : `docs/DECISIONS.md` (décisions prises), `docs/LOTS.md` (ordre de construction), `docs/FEATURE-FLAGS.md` (interrupteurs), `docs/UX.md` (profils, appareils, composants, icônes), `prompts/lot-XX-*.md` (le lot en cours). `docs/AUDIT.md` explique les raisons des décisions D12 à D25 (contexte, pas périmètre).

La maquette (`maquette/`) est la référence visuelle : couleurs, typographie, composants et dispositions par appareil.

`docs/CADRAGE.md` donne le contexte (marché, concurrence, raisons des choix). Consulte-le en cas de doute sur une intention, mais ne l'implémente jamais directement : seuls ce fichier, les décisions et le prompt du lot définissent ce qu'il faut construire.

---

## 2. Pile technique (figée — ne pas changer sans décision écrite dans `docs/DECISIONS.md`)

| Couche | Choix |
| --- | --- |
| Monorepo | pnpm workspaces + Turborepo |
| Langage | TypeScript partout, mode `strict` |
| Interface (vitrine + application) | SvelteKit 2, Svelte 5 (runes), Tailwind CSS, composants shadcn-svelte, icônes Lucide (`@lucide/svelte`), `adapter-node` |
| PWA | Service worker natif de SvelteKit (`src/service-worker.ts`), sans plugin (décision D09) |
| Local-first | PowerSync (édition libre auto-hébergée) : SQLite côté client, PostgreSQL côté serveur |
| API | NestJS (modules par domaine), validation Zod |
| Base de données | PostgreSQL 16, `wal_level=logical`, Row Level Security |
| ORM / migrations | Drizzle ORM + drizzle-kit (migrations SQL versionnées) |
| Files de tâches | BullMQ + Redis |
| Stockage de fichiers | Compatible S3 (MinIO en développement) |
| Images | sharp (redimensionnement WebP) |
| PDF | pdf-lib (reçus, relevés) |
| Contrats | docxtemplater, cœur sous licence MIT (remplissage du modèle Word de l'organisation) ; Gotenberg, image `gotenberg/gotenberg:8-libreoffice`, licence MIT (conversion en PDF) — décision D23 |
| Journalisation | pino (JSON) ; Sentry pour les erreurs |
| Tests | Vitest (unitaires et intégration), Playwright (bout en bout), k6 (charge) |
| CDN | Cloudflare devant la vitrine et les médias |

**Versions** : avant d'installer une bibliothèque, vérifie sa documentation actuelle et sa version stable. N'ajoute **aucune dépendance** hors de cette liste sans la proposer d'abord, avec sa raison.

---

## 3. Structure du dépôt

```
apps/
  web/                 SvelteKit : vitrine (routes publiques SSR) + application (/app, PWA)
    src/routes/(public)/   pages vitrine, rendues serveur, cachables
    src/routes/app/        application de gestion des organisations (client, local-first)
    src/routes/espace/     espaces propriétaire et locataire (compte personnel, lecture seule)
    src/routes/admin/      back-office plateforme
    src/lib/sync/          client PowerSync, schéma local, connecteur d'envoi
  api/                 NestJS
    src/modules/<domaine>/ un dossier par domaine (voir §4)
    src/db/                schéma Drizzle, migrations, politiques RLS
    src/jobs/              processeurs BullMQ
packages/
  shared/              schémas Zod, types, matrice de permissions, catalogue des fonctionnalités,
                       utilitaires (montants FCFA, téléphones +226, dates)
infra/
  docker-compose.dev.yml   postgres, redis, minio, powersync
  powersync/               règles de synchronisation
  k6/                      scénarios de charge
docs/                  décisions, lots, spécifications, journal des lots
prompts/               un prompt par lot
```

---

## 4. Architecture : monolithe modulaire

Domaines de l'API (un module NestJS chacun). Un module n'accède **jamais** directement aux tables d'un autre module : il passe par le service public de ce module.

| Module | Rôle |
| --- | --- |
| `identity` | personnes (comptes), authentification, sessions, vérification du téléphone |
| `organizations` | organisations (agences et bailleurs particuliers), membres, rôles, vérification, liaison des fiches propriétaire et locataire à une personne |
| `features` | catalogue, formules, interrupteurs, résolution (§8) |
| `audit` | journal d'audit en ajout seul |
| `owners` | propriétaires (personne, société ou groupe d'indivisaires), mandats, transferts de gestion |
| `properties` | biens, unités, statut en quatre dimensions, médias |
| `documents` | registre des documents privés, matrice de confidentialité par type, versions et empreintes, URL signées |
| `leases` | locataires, baux et leurs paramètres, échéances, comptes de caution, contrats (modèles, projets, versions, signatures, avenants), préavis, états des lieux, décomptes de sortie |
| `payments` | encaissements, imputations, reçus, adaptateurs de paiement |
| `collections` | impayés, relances, dépenses, relevés propriétaires, reversements |
| `listings` | annonces, visibilité, prospects, vitrine |
| `imports` | import Excel |
| `notifications` | adaptateurs : lien WhatsApp, SMS, (plus tard) API WhatsApp |
| `portals` | espaces propriétaire et locataire : lecture seule, à travers les organisations liées à une personne |

**Le module `portals` est le seul à lire dans plusieurs organisations.** Il parcourt les liens vérifiés d'une personne et lit chaque organisation **l'une après l'autre**, chacune dans son propre contexte `withOrganization`, uniquement ce qui concerne cette personne, en lecture seule, chaque lecture étant journalisée. Aucun écran d'organisation n'affiche une donnée issue d'une autre organisation.

Adaptateurs externes (paiement, SMS, WhatsApp, stockage) : **toujours derrière une interface** dans le module concerné, avec une implémentation `manual` ou `console` pour le développement et les tests.

---

## 5. Règles métier NON NÉGOCIABLES

Une seule violation de ces règles fait échouer le lot, même si tout le reste fonctionne.

1. **Cloisonnement par organisation** (agence ou bailleur particulier, D12).
   - Chaque table métier porte `organization_id NOT NULL`.
   - Les clés étrangères entre tables métier sont **composites** `(organization_id, id)`, pour qu'une ligne ne puisse jamais pointer vers une autre organisation.
   - RLS activée sur chaque table métier. Chaque requête de l'API s'exécute dans une transaction qui fait `SET LOCAL app.organization_id = '<uuid>'`. Le rôle base de données de l'API n'a **pas** `BYPASSRLS`.
   - Seul le back-office utilise un rôle distinct, et chaque accès de ce rôle aux données d'une organisation est journalisé, avec un motif.
   - Les règles PowerSync ne synchronisent que les données de l'organisation (ou des organisations) dont l'utilisateur est membre.
   - Chaque lot qui crée une table ajoute un **test d'accès croisé** (une organisation A tente de lire, modifier, référencer une donnée de B → refus).
2. **Montants en entiers FCFA.** Type `bigint` en base, `number` entier côté TypeScript (validé par Zod `int().nonnegative()`), jamais de flottant, jamais de centimes. Affichage : `75 000 FCFA` (espace fine insécable comme séparateur de milliers) via `packages/shared/money`.
3. **Un paiement n'est jamais supprimé ni modifié après validation.** Une erreur se corrige par une **contre-écriture** (annulation motivée, par un rôle autorisé). Le reçu annulé reste consultable avec la mention « ANNULÉ ». Pas de `DELETE` ni d'`UPDATE` du montant sur `payments`, `payment_allocations`, `receipts` (vérifié par trigger).
4. **Journal d'audit en ajout seul.** Toute création, modification, annulation, publication, changement de configuration ou d'interrupteur écrit une ligne : acteur, organisation, action, objet, valeur avant, valeur après, date, origine (application, API, back-office, synchronisation). Trigger qui interdit `UPDATE` et `DELETE` sur `audit_log`.
5. **La plateforme ne détient jamais les fonds.** Aucun compte marchand de la plateforme ne reçoit de loyers. En paiement direct (lot 14), les identifiants marchands sont **ceux de l'agence**, chiffrés en base. Les abonnements payés à la plateforme par les organisations ne sont pas concernés.
6. **Un paiement n'est « confirmé » que sur preuve.** Mobile Money déclaré à la main → `to_reconcile` (« à rapprocher »). Espèces saisies par un agent de terrain → `to_validate` (« à valider »). Paiement via agrégateur → `confirmed` uniquement après notification signée ou vérification auprès du prestataire, jamais sur la seule redirection du client. La machine d'états complète est dans `packages/shared` (lot 09).
7. **Enregistrer n'est jamais publier.** Créer un bien, une unité ou un propriétaire ne publie rien. Publier exige : mandat actif autorisant la publication (ou bien géré par son propriétaire lui-même, bailleur particulier), au moins 3 photos, loyer renseigné, fonctionnalité `listings.publication` active pour l'organisation, et unité disponible au sens de la règle 13.
8. **Un seul bail actif par unité** (index unique partiel). Une unité louée ne peut pas être publiée, sauf en préavis.
9. **Numérotation des reçus continue et sans trou, par organisation**, attribuée **par le serveur** à la validation (un reçu créé hors ligne porte un numéro provisoire).
10. **Désactiver une fonctionnalité ne supprime aucune donnée** et n'interrompt pas un paiement en cours : les nouvelles actions sont bloquées, les notifications de paiements déjà initiés sont encore traitées.
11. **Les documents privés** (pièces d'identité, mandats, baux, titres) ne sont jamais servis publiquement ni mis en cache CDN. Accès par URL signée de courte durée.
12. **Un seul mandat de gestion actif par unité** (index unique partiel). Une unité n'a jamais deux gestionnaires. Changer de gestionnaire passe par un transfert de gestion guidé : fin du mandat, remise du dossier, changement de détenteur de la caution ; l'ancien gestionnaire garde son historique, le nouveau ne voit jamais ses écritures (D16).
13. **L'occupation d'une unité est calculée, jamais saisie.** Elle découle des baux (libre, réservée, occupée, en préavis). L'état technique (prête, à remettre en état, en travaux, indisponible) est saisi. Une unité n'est **disponible** que si sa fiche est active, qu'elle est libre ou en préavis, et qu'elle est prête. La fin d'un bail la fait passer « à remettre en état », jamais directement « disponible » (D14).
14. **Aucune retenue sur caution sans justification.** Le compte de caution est en ajout seul (versement, retenue, imputation sur loyer, restitution, complément réclamé, changement de détenteur). Une retenue doit pointer vers une ligne d'état des lieux classée « imputable au locataire », avec un montant et un justificatif. Une imputation sur loyer exige un accord écrit et daté. Le total des sorties ne dépasse jamais la caution reçue. Une caution supérieure à deux mois de loyer déclenche un avertissement journalisé (D15).
15. **Aucune information sur un locataire ou un propriétaire ne passe d'une organisation à une autre.** Une personne voit l'ensemble de ses propres données à travers ses organisations, par le module `portals`, après vérification de son téléphone **et** acceptation du lien par chaque organisation. Aucune organisation ne voit les baux, paiements ou fiches d'une autre, ni directement, ni par attestation, ni par une liste partagée (D17).
16. **Une dépense est un seul enregistrement.** Elle dit qui a payé le prestataire, qui la supporte au final et comment elle est récupérée (relevé du propriétaire, caution, réclamée au locataire, aucune). Une retenue sur caution renvoie à la dépense, jamais une copie. La commission de gestion n'est pas une dépense.
17. **Contrats et documents** (D20 à D22, D24, D25).
   - Le contrat est le document du bail : son cycle (brouillon, vérification, prêt à signer, signé) est distinct de celui du bail. Légalisation et enregistrement sont suivis, jamais bloquants. Un bail peut être en vigueur sans contrat signé, avec une alerte.
   - Un contrat « prêt à signer » est **figé** : toute modification crée une nouvelle version ; chaque version est un objet stocké jamais écrasé, avec son empreinte SHA-256.
   - **Un PDF déposé n'est jamais présenté comme une signature électronique** : il est enregistré comme « signature manuscrite, scan déposé », avec qui l'a déposé et quand.
   - Les droits de consultation d'un document viennent de la **matrice par type** (`docs/UX.md` §10) ; une organisation peut les restreindre, jamais les élargir. Aucun document d'une organisation n'est visible par une autre ; chaque téléchargement est journalisé.
   - Le contrat désigne le bailleur (propriétaire représenté par l'organisation, ou organisation en son nom) ; préavis, reconduction, jour d'échéance, pénalité, garantie des factures et délai de restitution sont des paramètres du bail, avec les valeurs légales par défaut. Une organisation sans modèle utilise le modèle par défaut de la plateforme, conforme à la loi n° 103-2015/CNT (D25).

---

## 6. Règles de code

- **Identifiants** : UUIDv7 générés **côté client** (nécessaire au hors ligne). Jamais d'identifiant auto-incrémenté exposé.
- **Code en anglais, interface en français.** Les noms de tables, colonnes, variables et fonctions sont en anglais ; les textes vus par l'utilisateur sont en français, centralisés dans `apps/web/src/lib/i18n/fr.ts`.
- **Glossaire** : Organisation = `organization` (agence ou bailleur particulier), Agence = `agency` (type d'organisation), Personne = `user`, Propriétaire = `owner`, Mandat = `mandate`, Bien = `property`, Unité = `unit`, Locataire = `tenant`, Bail = `lease`, Échéance = `rent_due`, Caution = `deposit`, Encaissement = `payment`, Imputation = `payment_allocation`, Reçu = `receipt`, Dépense = `expense`, Relevé propriétaire = `owner_statement`, Annonce = `listing`, Prospect = `lead`, Formule = `plan`, Fonctionnalité = `feature`, Préavis = `notice`, État des lieux = `inspection`, Compte de caution = `deposit_account`, Mouvement de caution = `deposit_movement`, Décompte de sortie = `deposit_settlement`, Accord = `agreement`, Reversement = `owner_payout`, Transfert de gestion = `management_transfer`, Contrat = `lease_contract`, Version de contrat = `contract_version`, Avenant = `lease_amendment`, Modèle de contrat = `contract_template`, Document = `document`.
- **Validation** : chaque entrée d'API passe par un schéma Zod de `packages/shared`, réutilisé par le formulaire côté client.
- **Permissions et interrupteurs vérifiés côté serveur**, à chaque endpoint (guards NestJS). L'interface les reflète mais ne les remplace jamais.
- **Idempotence** : toute écriture issue de la synchronisation ou d'un paiement porte une clé d'idempotence ; un rejeu ne crée pas de doublon.
- **Dates** : `timestamptz` en UTC pour les instants ; `date` pour les échéances. Affichage `jj/mm/aaaa`.
- **Téléphones** : stockés en E.164 (`+226XXXXXXXX`).
- **Pas de logique métier dans les composants Svelte** : elle vit dans `packages/shared` (règles pures) ou dans l'API.
- **Tâches lourdes** (PDF, images, relances, génération d'échéances en masse) dans BullMQ, jamais dans la requête.
- **Migrations** : jamais modifier une migration déjà appliquée ; en créer une nouvelle. Chaque migration qui crée une table métier crée aussi sa politique RLS.
- **Secrets** : variables d'environnement uniquement ; `.env.example` à jour ; aucun secret dans le code ni dans les tests.
- **Performance** : JavaScript d'une page vitrine < 100 Ko compressés ; aucun appel réseau pour afficher un écran de l'application (lecture locale) ; pagination par curseur côté API.
- **Interface : suivre `docs/UX.md`.** Chaque profil a son espace et sa navigation ; chaque appareil a sa coque : barre d'onglets en bas sur téléphone, rail à gauche sur tablette, menu latéral et barre du haut sur ordinateur. Une liste de cartes sur téléphone devient un tableau sur ordinateur ; une forme différente selon l'appareil s'affiche avec `{#if}` (store `device`), jamais en doublant le composant masqué en CSS.
- **Accessibilité et ergonomie** : cibles tactiles ≥ 44 px, texte de contenu ≥ 16 px (14 px admis pour les libellés secondaires de navigation), pictogramme toujours accompagné d'un mot, clavier numérique pour les montants, focus visible, Échap pour fermer un panneau.
- **Icônes** : uniquement Lucide, même trait et mêmes tailles (16, 20, 24 px). **Aucune émoji**, ni comme icône ni comme décoration (test automatique).

---

## 7. Tests et définition de « terminé »

Un lot est terminé seulement si **tout** ce qui suit est vrai :

- [ ] `pnpm lint`, `pnpm typecheck` et `pnpm test` passent sans erreur ni test désactivé.
- [ ] Les tests listés dans le prompt du lot existent et passent, dont les tests d'accès croisé entre organisations pour chaque nouvelle table.
- [ ] Les règles du §5 concernées par le lot sont couvertes par au moins un test.
- [ ] Les migrations s'appliquent sur une base vide **et** sur la base du lot précédent.
- [ ] Chaque écran créé ou modifié est vérifié par Playwright sur téléphone (360 × 800), tablette (820 × 1180) et ordinateur (1440 × 900), pour chaque profil concerné, sans débordement horizontal sur téléphone (`docs/UX.md` §8).
- [ ] Les critères d'acceptation du prompt sont vérifiés un par un et cochés dans `docs/JOURNAL-LOTS.md`.
- [ ] Aucune fonctionnalité hors périmètre du lot n'a été ajoutée.

Interdits pour « faire passer » un test : le désactiver, l'affaiblir, contourner RLS, utiliser un rôle `BYPASSRLS`, attraper une erreur pour l'ignorer.

---

## 8. Interrupteurs de fonctionnalités (résumé — spécification complète dans `docs/FEATURE-FLAGS.md`)

- Chaque fonctionnalité optionnelle a une clé dans `packages/shared/features.ts` (ex. `payments.direct`, `listings.publication`).
- L'administrateur de la plateforme peut, pour chaque clé : la **couper pour tout le monde**, l'**ouvrir à tout le monde**, ou l'**ouvrir seulement à une liste** d'organisations ou de personnes ; et poser des **exceptions** (forcer à oui ou à non) pour une organisation ou une personne précise, avec motif et date de fin facultative.
- Toute vérification passe par **une seule fonction** : `features.isEnabled(key, { userId, organizationId })`. Personne ne lit les tables d'interrupteurs directement.
- Le résultat combine : interrupteur → formule → réglage de l'organisation → **puis** permission du rôle. Un interrupteur actif n'accorde jamais une permission que le rôle n'a pas.
- Tout nouvel écran ou endpoint d'une fonctionnalité optionnelle est protégé par sa clé **dès sa création**.
- Ce qui fait partie du registre n'est pas un interrupteur : les **moyens de paiement acceptés** (espèces, Mobile Money saisi, virement) sont un réglage de chaque organisation (D18).

---

## 9. Manière de travailler sur ce dépôt

1. Au début d'un lot : lis ce fichier, `docs/DECISIONS.md`, `docs/LOTS.md` et le prompt du lot. Lis `docs/JOURNAL-LOTS.md` pour savoir ce qui existe déjà.
2. **Présente un plan avant de coder** : fichiers créés ou modifiés, tables, endpoints, écrans, tests. Attends la validation si le prompt le demande.
3. Travaille **uniquement** sur le périmètre du lot. Si quelque chose manque d'un lot précédent, signale-le au lieu de l'élargir.
4. Écris les tests en même temps que le code, en commençant par les règles métier.
5. Commits courts au format Conventional Commits (`feat(leases): …`, `fix(payments): …`, `test(organizations): …`).
6. À la fin : mets à jour `docs/JOURNAL-LOTS.md` (fait, écarts, dette technique, questions ouvertes) et `.env.example`.
7. En cas de doute sur une règle métier ou réglementaire (bail, caution, commission, données personnelles) : **pose la question**, n'invente pas.

---

## 10. Commandes

```
pnpm install
pnpm dev            # infra docker + api + web
pnpm db:migrate     # applique les migrations
pnpm db:seed        # démonstration : 2 agences et 1 bailleur particulier ; un propriétaire présent dans les 3, un locataire passé de l'une à l'autre
pnpm lint
pnpm typecheck
pnpm test           # unitaires + intégration
pnpm test:e2e       # Playwright
pnpm k6:vitrine     # charge (lot 13)
```

Ces commandes sont créées au lot 01 ; tiens cette section à jour si elles changent.

# CLAUDE.md — Plateforme de gestion immobilière (Burkina Faso)

Ce fichier est la référence permanente pour Claude Code sur ce dépôt. Lis-le en entier au début de chaque session. En cas de conflit entre ce fichier et un prompt de lot, **ce fichier l'emporte** ; signale le conflit au lieu de le trancher seul.

---

## 1. Le produit en 5 lignes

- Un **registre de gestion locative multi-agences** (biens, mandats, baux, échéances, encaissements, reçus, impayés, relevés propriétaires), utilisé chaque jour par des agences immobilières de Ouagadougou.
- Une **vitrine publique** qui affiche les unités libres des portefeuilles gérés, avec une disponibilité toujours exacte (l'annonce suit le statut de l'unité).
- Une **application local-first** : l'agence travaille sur les données copiées dans le téléphone, synchronisées en arrière-plan. Elle doit rester utilisable hors connexion.
- Un **back-office plateforme** qui active ou désactive chaque fonctionnalité pour tout le monde, pour une formule, pour une agence ou pour une personne (voir `docs/FEATURE-FLAGS.md`).
- La plateforme **ne détient jamais les fonds**. Elle enregistre les paiements ; en phase 3, elle initie des paiements Mobile Money **vers le compte marchand de l'agence**.

Documents à connaître : `docs/DECISIONS.md` (décisions prises), `docs/LOTS.md` (ordre de construction), `docs/FEATURE-FLAGS.md` (interrupteurs), `docs/UX.md` (profils, appareils, composants, icônes), `prompts/lot-XX-*.md` (le lot en cours).

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
    src/routes/app/        application agence (client, local-first)
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
| `identity` | comptes, authentification, sessions |
| `agencies` | agences, membres, rôles, vérification |
| `features` | catalogue, formules, interrupteurs, résolution (§8) |
| `audit` | journal d'audit en ajout seul |
| `owners` | propriétaires (avec ou sans compte), mandats |
| `properties` | biens, unités, médias, documents |
| `leases` | locataires, baux, échéances, cautions |
| `payments` | encaissements, imputations, reçus, adaptateurs de paiement |
| `collections` | impayés, relances, dépenses, relevés propriétaires |
| `listings` | annonces, visibilité, prospects, vitrine |
| `imports` | import Excel |
| `notifications` | adaptateurs : lien WhatsApp, SMS, (plus tard) API WhatsApp |

Adaptateurs externes (paiement, SMS, WhatsApp, stockage) : **toujours derrière une interface** dans le module concerné, avec une implémentation `manual` ou `console` pour le développement et les tests.

---

## 5. Règles métier NON NÉGOCIABLES

Une seule violation de ces règles fait échouer le lot, même si tout le reste fonctionne.

1. **Cloisonnement par agence.**
   - Chaque table métier porte `agency_id NOT NULL`.
   - Les clés étrangères entre tables métier sont **composites** `(agency_id, id)`, pour qu'une ligne ne puisse jamais pointer vers une autre agence.
   - RLS activée sur chaque table métier. Chaque requête de l'API s'exécute dans une transaction qui fait `SET LOCAL app.agency_id = '<uuid>'`. Le rôle base de données de l'API n'a **pas** `BYPASSRLS`.
   - Seul le back-office utilise un rôle distinct, et chaque accès de ce rôle aux données d'une agence est journalisé.
   - Les règles PowerSync ne synchronisent que les données de l'agence (ou des agences) de l'utilisateur.
   - Chaque lot qui crée une table ajoute un **test d'accès croisé** (une agence A tente de lire, modifier, référencer une donnée de B → refus).
2. **Montants en entiers FCFA.** Type `bigint` en base, `number` entier côté TypeScript (validé par Zod `int().nonnegative()`), jamais de flottant, jamais de centimes. Affichage : `75 000 FCFA` (espace fine insécable comme séparateur de milliers) via `packages/shared/money`.
3. **Un paiement n'est jamais supprimé ni modifié après validation.** Une erreur se corrige par une **contre-écriture** (annulation motivée, par un rôle autorisé). Le reçu annulé reste consultable avec la mention « ANNULÉ ». Pas de `DELETE` ni d'`UPDATE` du montant sur `payments`, `payment_allocations`, `receipts` (vérifié par trigger).
4. **Journal d'audit en ajout seul.** Toute création, modification, annulation, publication, changement de configuration ou d'interrupteur écrit une ligne : acteur, agence, action, objet, valeur avant, valeur après, date, origine (application, API, back-office, synchronisation). Trigger qui interdit `UPDATE` et `DELETE` sur `audit_log`.
5. **La plateforme ne détient jamais les fonds.** Aucun compte marchand de la plateforme ne reçoit de loyers. En paiement direct (lot 14), les identifiants marchands sont **ceux de l'agence**, chiffrés en base.
6. **Un paiement n'est « confirmé » que sur preuve.** Mobile Money déclaré à la main → `to_reconcile` (« à rapprocher »). Espèces saisies par un agent de terrain → `to_validate` (« à valider »). Paiement via agrégateur → `confirmed` uniquement après notification signée ou vérification auprès du prestataire, jamais sur la seule redirection du client. La machine d'états complète est dans `packages/shared` (lot 09).
7. **Enregistrer n'est jamais publier.** Créer un bien, une unité ou un propriétaire ne publie rien. Publier exige : mandat actif autorisant la publication, au moins 3 photos, loyer renseigné, fonctionnalité `listings.publication` active pour l'agence.
8. **Un seul bail actif par unité** (index unique partiel). Une unité louée ne peut pas être publiée.
9. **Numérotation des reçus continue et sans trou, par agence**, attribuée **par le serveur** à la validation (un reçu créé hors ligne porte un numéro provisoire).
10. **Désactiver une fonctionnalité ne supprime aucune donnée** et n'interrompt pas un paiement en cours : les nouvelles actions sont bloquées, les notifications de paiements déjà initiés sont encore traitées.
11. **Les documents privés** (pièces d'identité, mandats, baux, titres) ne sont jamais servis publiquement ni mis en cache CDN. Accès par URL signée de courte durée.

---

## 6. Règles de code

- **Identifiants** : UUIDv7 générés **côté client** (nécessaire au hors ligne). Jamais d'identifiant auto-incrémenté exposé.
- **Code en anglais, interface en français.** Les noms de tables, colonnes, variables et fonctions sont en anglais ; les textes vus par l'utilisateur sont en français, centralisés dans `apps/web/src/lib/i18n/fr.ts`.
- **Glossaire** : Agence = `agency`, Propriétaire = `owner`, Mandat = `mandate`, Bien = `property`, Unité = `unit`, Locataire = `tenant`, Bail = `lease`, Échéance = `rent_due`, Caution = `deposit`, Encaissement = `payment`, Imputation = `payment_allocation`, Reçu = `receipt`, Dépense = `expense`, Relevé propriétaire = `owner_statement`, Annonce = `listing`, Prospect = `lead`, Formule = `plan`, Fonctionnalité = `feature`.
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
- [ ] Les tests listés dans le prompt du lot existent et passent, dont les tests d'accès croisé entre agences pour chaque nouvelle table.
- [ ] Les règles du §5 concernées par le lot sont couvertes par au moins un test.
- [ ] Les migrations s'appliquent sur une base vide **et** sur la base du lot précédent.
- [ ] Chaque écran créé ou modifié est vérifié par Playwright sur téléphone (360 × 800), tablette (820 × 1180) et ordinateur (1440 × 900), pour chaque profil concerné, sans débordement horizontal sur téléphone (`docs/UX.md` §8).
- [ ] Les critères d'acceptation du prompt sont vérifiés un par un et cochés dans `docs/JOURNAL-LOTS.md`.
- [ ] Aucune fonctionnalité hors périmètre du lot n'a été ajoutée.

Interdits pour « faire passer » un test : le désactiver, l'affaiblir, contourner RLS, utiliser un rôle `BYPASSRLS`, attraper une erreur pour l'ignorer.

---

## 8. Interrupteurs de fonctionnalités (résumé — spécification complète dans `docs/FEATURE-FLAGS.md`)

- Chaque fonctionnalité optionnelle a une clé dans `packages/shared/features.ts` (ex. `payments.direct`, `listings.publication`).
- L'administrateur de la plateforme peut, pour chaque clé : la **couper pour tout le monde**, l'**ouvrir à tout le monde**, ou l'**ouvrir seulement à une liste** d'agences ou de personnes ; et poser des **exceptions** (forcer à oui ou à non) pour une agence ou une personne précise, avec motif et date de fin facultative.
- Toute vérification passe par **une seule fonction** : `features.isEnabled(key, { userId, agencyId })`. Personne ne lit les tables d'interrupteurs directement.
- Le résultat combine : interrupteur → formule → réglage de l'agence → **puis** permission du rôle. Un interrupteur actif n'accorde jamais une permission que le rôle n'a pas.
- Tout nouvel écran ou endpoint d'une fonctionnalité optionnelle est protégé par sa clé **dès sa création**.

---

## 9. Manière de travailler sur ce dépôt

1. Au début d'un lot : lis ce fichier, `docs/DECISIONS.md`, `docs/LOTS.md` et le prompt du lot. Lis `docs/JOURNAL-LOTS.md` pour savoir ce qui existe déjà.
2. **Présente un plan avant de coder** : fichiers créés ou modifiés, tables, endpoints, écrans, tests. Attends la validation si le prompt le demande.
3. Travaille **uniquement** sur le périmètre du lot. Si quelque chose manque d'un lot précédent, signale-le au lieu de l'élargir.
4. Écris les tests en même temps que le code, en commençant par les règles métier.
5. Commits courts au format Conventional Commits (`feat(leases): …`, `fix(payments): …`, `test(agencies): …`).
6. À la fin : mets à jour `docs/JOURNAL-LOTS.md` (fait, écarts, dette technique, questions ouvertes) et `.env.example`.
7. En cas de doute sur une règle métier ou réglementaire (bail, caution, commission, données personnelles) : **pose la question**, n'invente pas.

---

## 10. Commandes

```
pnpm install
pnpm dev            # infra docker + api + web
pnpm db:migrate     # applique les migrations
pnpm db:seed        # données de démonstration (2 agences, pour tester le cloisonnement)
pnpm lint
pnpm typecheck
pnpm test           # unitaires + intégration
pnpm test:e2e       # Playwright
pnpm k6:vitrine     # charge (lot 13)
```

Ces commandes sont créées au lot 01 ; tiens cette section à jour si elles changent.

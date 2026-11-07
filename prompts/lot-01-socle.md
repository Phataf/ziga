# Lot 01 — Socle technique

## Contexte
Premier lot de la phase 1. Il pose le monorepo, l'infrastructure locale, les outils de qualité et les briques partagées. Aucune fonctionnalité métier.

## Prérequis
Porte 0 franchie. Lis `CLAUDE.md` en entier, `docs/DECISIONS.md`, `docs/LOTS.md`.

## Périmètre
1. **Monorepo** pnpm + Turborepo avec `apps/web`, `apps/api`, `packages/shared`, `infra/`, `docs/`, `prompts/` (structure de `CLAUDE.md` §3). TypeScript `strict` partout, configuration ESLint et Prettier commune.
2. **Infrastructure locale** `infra/docker-compose.dev.yml` : PostgreSQL 16 (`wal_level=logical`), Redis, MinIO. Le service PowerSync est ajouté au lot 05.
3. **API NestJS** minimale : configuration validée par Zod au démarrage (l'API refuse de démarrer si une variable manque), logs pino en JSON avec identifiant de requête, endpoint `GET /health` (base, Redis, stockage), gestion d'erreurs uniforme `{ code, message, details }`, branchement Sentry désactivable.
4. **Base de données** : Drizzle ORM, drizzle-kit, dossier de migrations, commande `pnpm db:migrate`. Création de deux rôles PostgreSQL : `app_api` (sans `BYPASSRLS`) et `app_admin` (back-office). Fonction SQL utilitaire `current_agency_id()` qui lit `current_setting('app.agency_id', true)`.
5. **Helper de transaction** côté API : `withAgency(agencyId, fn)` qui ouvre une transaction et fait `SET LOCAL app.agency_id`. Toute requête métier future passera par lui.
6. **File de tâches** BullMQ branchée sur Redis, avec un processeur d'exemple et un tableau de bord désactivé en production.
7. **`packages/shared`** :
   - `money.ts` : type `Fcfa` (entier), `formatFcfa(75000) → "75 000 FCFA"` avec espace fine insécable, `parseFcfa`, refus des décimales.
   - `phone.ts` : normalisation E.164 `+226`, formatage `+226 70 12 34 56`, validation.
   - `ids.ts` : génération UUIDv7.
   - `dates.ts` : formatage `jj/mm/aaaa`.
8. **Application SvelteKit** : `adapter-node`, Tailwind, shadcn-svelte, icônes Lucide, manifeste PWA et service worker natif (D09), fichier `src/lib/i18n/fr.ts`. **Coque responsive selon `docs/UX.md` §3**, reprise de la maquette : store `device`, barre d'onglets sur téléphone, rail sur tablette, menu latéral et barre du haut sur ordinateur, navigation déclarée par profil (écrans vides). Composants de base : `Sheet` (feuille, boîte de dialogue ou tiroir selon l'appareil), `ActionMenu`, `PageHeader`, conteneurs `page` et `page-narrow`, test anti-émoji.
9. **Tests** : Vitest configuré pour les trois paquets ; base de test PostgreSQL recréée à chaque exécution des tests d'intégration ; Playwright configuré en émulation mobile.
10. **CI** GitHub Actions : installation, lint, typecheck, tests unitaires et d'intégration (avec services PostgreSQL et Redis).
11. **Commandes** de `CLAUDE.md` §10 opérationnelles ; `.env.example` complet ; `README.md` de démarrage.
12. **Sessions Claude Code en ligne** : le porteur travaille sur claude.ai/code. Chaque session démarre sur une machine neuve où Docker, PostgreSQL 16 et Redis sont installés mais arrêtés. Ajoute un hook `SessionStart` dans `.claude/settings.json` qui appelle un script `scripts/session-start.sh` : installation des dépendances (`pnpm install`, sautée si le fichier de verrouillage n'a pas changé), démarrage des services de `infra/docker-compose.dev.yml`, application des migrations. Le script ne fait rien hors d'une session cloud et doit rester sous la minute après le premier lancement.

## Hors périmètre
Modification de `maquette/` (D10), authentification, tables métier, PowerSync, interrupteurs, déploiement en production.

## Tests attendus
- `money.ts` : formatage, arrondi refusé, montants négatifs refusés, très grands montants (10 milliards FCFA).
- `phone.ts` : numéros valides et invalides du Burkina, formats d'entrée variés (`70123456`, `0022670123456`, `+226 70 12 34 56`).
- `withAgency` : la variable `app.agency_id` est visible dans la transaction et absente en dehors.
- `/health` : renvoie l'état de chaque dépendance ; renvoie une erreur si PostgreSQL est arrêté.
- Coque : Playwright sur 360 × 800, 820 × 1180 et 1440 × 900 (bonne navigation affichée, aucune autre ; aucun débordement horizontal) ; test anti-émoji.
- Démarrage de l'API refusé si une variable d'environnement obligatoire manque.
- Le rôle `app_api` n'a pas `BYPASSRLS` (test SQL).

## Critères d'acceptation
- [ ] `pnpm install && pnpm dev` démarre tout depuis un clone neuf, en suivant uniquement le `README.md`.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` passent en local et en CI.
- [ ] La barre d'onglets s'affiche en émulation mobile et l'application est installable.
- [ ] `docs/JOURNAL-LOTS.md` contient l'entrée du lot.

## Instructions de travail
Présente d'abord l'arborescence complète et la liste des dépendances avec leurs versions stables actuelles. Attends la validation avant d'installer.

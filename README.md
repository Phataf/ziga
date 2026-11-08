# Ziga — gestion locative au Burkina Faso

**Ziga** (ziga.com) : registre de gestion locative multi-organisations (agences et bailleurs particuliers), avec vitrine publique, pour Ouagadougou et Saaba.

- `CLAUDE.md` : règles du dépôt (à lire en premier).
- `docs/` : cadrage, décisions, lots, interrupteurs de fonctionnalités, expérience utilisateur, journal des lots.
- `prompts/` : un prompt par lot.
- `maquette/` : maquette cliquable (lots 00 à 00 ter), indépendante du produit. Voir `maquette/README.md`.

## Démarrer depuis un clone neuf

Prérequis : **Node.js 22.17 ou plus**, Git Bash sous Windows, **pnpm 10** (`corepack enable` suffit : la version est fixée dans `package.json`) et **Docker** avec Docker Compose.

```bash
pnpm install
```

```bash
cp .env.example .env
```

```bash
pnpm infra:up
```

```bash
pnpm db:migrate
```

```bash
pnpm dev
```

- `pnpm infra:up` démarre PostgreSQL 16 (`wal_level=logical`, sur le port **55432** de la machine pour ne pas heurter un PostgreSQL déjà installé), Redis et SeaweedFS (stockage S3), attend qu'ils soient sains et crée le compartiment `ziga-dev`.
- `pnpm db:migrate` crée les rôles `app_api` (sans `BYPASSRLS`) et `app_admin`, la fonction `current_organization_id()`, et fixe leurs mots de passe à partir de `.env`.
- `pnpm dev` lance les services, puis l'API (http://localhost:3000), le worker des tâches de fond et l'application web (http://localhost:5173). Sans Docker, avec PostgreSQL et Redis déjà démarrés sur la machine : `pnpm dev:apps`, et `STORAGE_DRIVER=local` dans `.env`.

Vérifier que tout répond :

```bash
curl http://localhost:3000/health/ready
```

## Commandes

| Commande                            | Rôle                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm dev`                          | Services Docker, puis API, worker et web en mode développement                        |
| `pnpm dev:apps`                     | API, worker et web seulement (services déjà démarrés)                                 |
| `pnpm infra:up` / `pnpm infra:down` | Démarre ou arrête les services de `infra/docker-compose.dev.yml`                      |
| `pnpm db:migrate`                   | Applique les migrations SQL versionnées                                               |
| `pnpm db:seed`                      | Données de démonstration (à partir du lot 03)                                         |
| `pnpm lint`                         | ESLint, svelte-check et Prettier                                                      |
| `pnpm typecheck`                    | TypeScript dans les trois paquets                                                     |
| `pnpm test`                         | Tests unitaires et d'intégration ; la base `ziga_test` est recréée à chaque exécution |
| `pnpm test:e2e`                     | Playwright sur la coque de l'application (téléphone, tablette, ordinateur)            |
| `pnpm build`                        | Construit `packages/shared`, l'API et le web                                          |

## Organisation

| Chemin                     | Rôle                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/api`                 | API NestJS. Deux processus : `dist/main.js` (HTTP) et `dist/worker.js` (tâches BullMQ), à multiplier séparément   |
| `apps/web`                 | SvelteKit 3 : vitrine rendue côté serveur, application `/app`, espaces personnels `/espace`, back-office `/admin` |
| `packages/shared`          | Montants FCFA, téléphones +226, identifiants UUIDv7, dates ; schémas Zod partagés                                 |
| `infra/`                   | Services du développement local                                                                                   |
| `scripts/session-start.sh` | Préparation des sessions Claude Code en ligne (dépendances, services, migrations)                                 |

## Exploitation de l'API

- **Sans état** : aucune session ni donnée métier en mémoire ; chaque instance est interchangeable.
- **Santé** : `GET /health/live` (le processus répond) et `GET /health/ready` (base, Redis, stockage ; 503 sinon, et dès le début d'un arrêt).
- **Arrêt propre** : sur SIGTERM ou SIGINT, l'API finit ses requêtes et le worker ses tâches avant de quitter (`SHUTDOWN_TIMEOUT_MS`).
- **Base** : pool par processus (`DATABASE_POOL_MAX`), délai maximal par requête (`DATABASE_STATEMENT_TIMEOUT_MS`) ; tout passe par des transactions avec `SET LOCAL`, compatibles avec PgBouncer en mode transaction.
- **Erreurs** : toujours `{ code, message, details }` ; Sentry s'active avec `SENTRY_DSN`.
- **Tableau de bord des files** : `/admin/queues` en développement (`JOBS_DASHBOARD=true`), jamais en production.

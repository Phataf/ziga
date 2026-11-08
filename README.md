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
| `pnpm test:e2e`                     | Playwright contre la vraie API (base `ziga_e2e` recréée) : coque et authentification  |
| `pnpm build`                        | Construit `packages/shared`, l'API et le web                                          |

## Comptes et authentification (lot 02)

- **Créer un compte** : http://localhost:5173/inscription. En développement, le SMS (code à 6 chiffres) s'affiche dans le terminal de l'API, sur une ligne `[SMS de développement]`, hors des journaux.
- **Clés** : sans `AUTH_JWT_KEYS`, l'API signe avec une clé éphémère (sessions perdues au redémarrage). Pour des clés stables, et pour la production où elles sont obligatoires :

```bash
pnpm --filter @ziga/api auth:keygen
```

Copier les deux lignes affichées (`AUTH_JWT_KEYS`, `AUTH_OTP_SECRET`) dans `.env` ou dans les secrets de l'environnement. Les clés publiques sont publiées sur `/.well-known/jwks.json`.

- **Premier super administrateur** : par la ligne de commande seulement, jamais par l'interface. Le mot de passe est demandé deux fois ; il est masqué dans PowerShell, cmd et les terminaux Linux ou macOS, mais reste visible dans Git Bash sous Windows, où Node ne voit pas de terminal. Pour un script, il peut être lu dans `SUPER_ADMIN_PASSWORD`. Une personne déjà inscrite est promue.

```bash
pnpm --filter @ziga/api admin:create-super-admin --phone "+226 70 12 34 56" --name "Nom Prénom"
```

- **Sessions** : jeton d'accès de 15 minutes, en mémoire du navigateur ; jeton de rafraîchissement de 30 jours dans le cookie `__Host-ziga_rt` (httpOnly, Secure, SameSite=Lax), renouvelé à chaque usage. Hors connexion, la coque reste affichée ; seul un refus du serveur (401) renvoie vers `/connexion`.

## Données de démonstration (lot 03)

`pnpm db:seed` crée, sans jamais rien écraser, l'agence Faso Immobilier (un directeur, un gestionnaire, un agent de terrain, une lecture et comptabilité), l'agence Sahel Habitat (mêmes rôles), un bailleur particulier dirigé par la gestionnaire de Faso Immobilier et une personne sans organisation. Les numéros et les rôles s'affichent à la fin de la commande ; le mot de passe de tous ces comptes est `SEED_DEMO_PASSWORD` (dans `.env`). Refusé en production.

La commande s'applique après `pnpm db:migrate`.

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

#!/usr/bin/env bash
# Hook SessionStart des sessions Claude Code en ligne (lot 01) : dépendances, services, migrations.
# Ne fait rien ailleurs (poste du porteur, CI). Idempotent : relancé à chaque début, reprise ou compactage.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
	exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}"
log() { echo "[session-start] $*" >&2; }

# 1. Configuration locale : .env est ignoré par git, on le crée depuis l'exemple s'il manque.
if [ ! -f .env ]; then
	cp .env.example .env
	log ".env créé depuis .env.example"
fi

# 2. Dépendances : réinstallées seulement si un manifeste ou le fichier de verrouillage a changé.
hashes=node_modules/.session-start.sha256
if ! sha256sum --check --status "$hashes" 2>/dev/null; then
	rm -f "$hashes"
	log "installation des dépendances (pnpm install)"
	pnpm install --prefer-offline
	sha256sum scripts/session-start.sh package.json pnpm-lock.yaml pnpm-workspace.yaml apps/*/package.json packages/*/package.json >"$hashes"
fi

# 3. Services. Docker si ses images sont déjà là ; sinon PostgreSQL 16 et Redis installés sur la machine
#    (les images ne se téléchargent pas toujours depuis l'environnement en ligne), et stockage local.
images=(postgres:16.15 redis:7.4.12-alpine chrislusf/seaweedfs:4.51)
use_docker=false
if docker info >/dev/null 2>&1 && docker image inspect "${images[@]}" >/dev/null 2>&1; then
	use_docker=true
fi

if [ "$use_docker" = true ]; then
	log "services Docker (infra/docker-compose.dev.yml)"
	bash scripts/infra-up.sh
else
	log "services natifs : PostgreSQL 16 et Redis de la machine, stockage local"
	pg_ctlcluster 16 main start >/dev/null 2>&1 || true
	until pg_isready -q -h localhost -p 5432; do sleep 0.5; done
	if [ "$(su postgres -c "psql -tAc 'show wal_level'")" != "logical" ]; then
		su postgres -c "psql -qc \"ALTER SYSTEM SET wal_level = 'logical'\""
		pg_ctlcluster 16 main restart
		until pg_isready -q -h localhost -p 5432; do sleep 0.5; done
	fi
	# Propriétaire du schéma et base de développement, avec les identifiants de .env.example.
	su postgres -c "psql -qc \"DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ziga') THEN CREATE ROLE ziga LOGIN SUPERUSER PASSWORD 'ziga_dev'; END IF; END \\\$\\\$\""
	if [ -z "$(su postgres -c "psql -tAc \"select 1 from pg_database where datname = 'ziga'\"")" ]; then
		su postgres -c "createdb -O ziga ziga"
	fi
	redis-cli ping >/dev/null 2>&1 || redis-server --daemonize yes --save '' --appendonly no >/dev/null
	# Pas de serveur S3 ici : l'API utilise le stockage local de développement.
	sed -i 's/^STORAGE_DRIVER=s3$/STORAGE_DRIVER=local/' .env
fi

# 4. Migrations (l'API se compile d'abord, avec le paquet partagé).
pnpm db:migrate >/dev/null
log "prêt : dépendances installées, services démarrés, migrations appliquées"

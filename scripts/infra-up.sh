#!/usr/bin/env bash
# Démarre les services de infra/docker-compose.dev.yml, attend qu'ils soient sains,
# puis crée le compartiment S3 de développement (sans erreur s'il existe déjà)
# et la base de stockage de PowerSync (lot 05), avant de démarrer PowerSync.
set -euo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose -f infra/docker-compose.dev.yml)
"${compose[@]}" up -d --wait postgres redis seaweedfs
bucket="${S3_BUCKET:-ziga-dev}"
"${compose[@]}" exec -T seaweedfs sh -c "echo 's3.bucket.create -name ${bucket}' | weed shell -master=localhost:9333" >/dev/null 2>&1 || true

# Stockage interne de PowerSync : rôle et base dédiés, créés une seule fois (mot de passe de développement,
# identique à POWERSYNC_STORAGE_URL de .env.example).
"${compose[@]}" exec -T postgres psql -U ziga -d ziga -v ON_ERROR_STOP=1 -q <<'SQL'
SELECT 'CREATE ROLE powersync_storage LOGIN PASSWORD ''powersync_storage_dev'''
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'powersync_storage') \gexec
SELECT 'CREATE DATABASE ziga_powersync OWNER powersync_storage'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ziga_powersync') \gexec
SQL
# Sans attendre : PowerSync a besoin de la migration 0006 (pnpm db:migrate) et de l'API (JWKS), et réessaie seul.
"${compose[@]}" up -d powersync
echo "Services prêts : PostgreSQL :55432, Redis :6379, S3 (SeaweedFS) :8333, compartiment ${bucket}, PowerSync :8080."

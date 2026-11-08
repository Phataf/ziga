#!/usr/bin/env bash
# Démarre les services de infra/docker-compose.dev.yml, attend qu'ils soient sains,
# puis crée le compartiment S3 de développement (sans erreur s'il existe déjà).
set -euo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose -f infra/docker-compose.dev.yml)
"${compose[@]}" up -d --wait
bucket="${S3_BUCKET:-ziga-dev}"
"${compose[@]}" exec -T seaweedfs sh -c "echo 's3.bucket.create -name ${bucket}' | weed shell -master=localhost:9333" >/dev/null 2>&1 || true
echo "Services prêts : PostgreSQL :55432, Redis :6379, S3 (SeaweedFS) :8333, compartiment ${bucket}."

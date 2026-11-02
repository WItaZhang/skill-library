#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Run after verify-release.sh and review, on the authorized target host.
# .env and secret files must already be installed by its operator.
docker compose config --quiet
docker compose build app
docker compose run --rm --no-deps app node src/deployment/validate-config.ts
docker compose up -d --wait db
mkdir -p backups
# Snapshot before a possibly forward-only migration. Existing schema/data are never reset.
docker compose --profile tools run --rm backup
# One app instance: no rolling second replica while OAuth state is in process memory.
docker compose up -d --wait --wait-timeout 120 app prometheus proxy
printf 'Deployment ready. Verify public HTTPS/OAuth and browser flow using docs/deployment/runbook.md.\n'

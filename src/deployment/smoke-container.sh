#!/bin/sh
set -eu
# CI-local smoke only. Fresh isolated DB/container, no real OAuth/API calls.
image=${1:?Pass a built image tag}
name="skill-smoke-$(date +%s)-$$"
network="$name-network"
cleanup() { docker rm -f "$name-app" "$name-db" >/dev/null 2>&1 || true; docker network rm "$network" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
docker network create "$network" >/dev/null
docker run -d --name "$name-db" --network "$network" -e POSTGRES_PASSWORD=ci-only postgres:17-bookworm >/dev/null
for i in $(seq 1 30); do if docker exec "$name-db" pg_isready -U postgres >/dev/null 2>&1; then break; fi; sleep 1; done
docker exec "$name-db" pg_isready -U postgres
start() {
  docker run -d --name "$name-app" --network "$network" --read-only --tmpfs /tmp --cap-drop ALL \
    -e "DATABASE_URL=postgresql://postgres:ci-only@$name-db:5432/postgres" \
    -e PUBLIC_ORIGIN=https://smoke.example.test -e GITHUB_CLIENT_ID=smoke-test \
    -e GITHUB_CLIENT_SECRET=ci-fixture-not-oauth -e METRICS_TOKEN=ci-only-012345678901234567890123456789 \
    -e EXECUTION_ENABLED=false "$image" >/dev/null
  for i in $(seq 1 30); do if docker exec "$name-app" node src/deployment/healthcheck.ts; then return; fi; sleep 1; done
  docker logs "$name-app"; return 1
}
start
test "$(docker exec "$name-app" id -u)" != 0
# Internal migration ledger survives app container replacement; no host DB is accessed.
test "$(docker exec "$name-db" psql -U postgres -Atc 'SELECT count(*) FROM production_migrations')" = 2
docker stop -t 25 "$name-app" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$name-app")" = 0
docker rm "$name-app" >/dev/null
start
test "$(docker exec "$name-db" psql -U postgres -Atc 'SELECT count(*) FROM production_migrations')" = 2
docker exec "$name-app" node -e 'fetch("http://localhost:8080/").then(async r=>{if(!r.ok||!(await r.text()).includes("<html"))process.exit(1)})'
printf 'Non-root read-only image, real PG migration, HTTP artifact, graceful stop and replacement passed. OAuth/provider NOT exercised.\n'

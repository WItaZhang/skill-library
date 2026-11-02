#!/bin/sh
# Disposable real PostgreSQL cluster. No mock or machine-wide service.
set -eu
cd "$(dirname "$0")"
PG_TEST_BIN=${PG_TEST_BIN:-/opt/homebrew/opt/postgresql@17/bin}
PG_TEST_PORT=${PG_TEST_PORT:-55439}
PG_TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/skill-library-pg.XXXXXX")
cleanup() {
 "$PG_TEST_BIN/pg_ctl" -D "$PG_TEST_DIR/data" -m fast stop >/dev/null 2>&1 || true
 rm -rf "$PG_TEST_DIR"
}
trap cleanup EXIT INT TERM
"$PG_TEST_BIN/initdb" -D "$PG_TEST_DIR/data" -A trust -U skill_library --locale=C -E UTF8 > "$PG_TEST_DIR/init.log"
"$PG_TEST_BIN/pg_ctl" -D "$PG_TEST_DIR/data" -l "$PG_TEST_DIR/server.log" -o "-h 127.0.0.1 -p $PG_TEST_PORT -k $PG_TEST_DIR" start
"$PG_TEST_BIN/createdb" -h 127.0.0.1 -p "$PG_TEST_PORT" -U skill_library skill_library_test
DATABASE_URL="postgresql://skill_library@127.0.0.1:$PG_TEST_PORT/skill_library_test" npm test

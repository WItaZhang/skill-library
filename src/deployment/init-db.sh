#!/bin/sh
set -eu
# Runs only on NEW volumes. Application role owns only its database, not the cluster.
APP_DB_PASSWORD=$(cat /run/secrets/app_db_password)
export APP_DB_PASSWORD
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password APP_DB_PASSWORD
CREATE ROLE skill_library LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE DATABASE skill_library OWNER skill_library;
REVOKE ALL ON DATABASE skill_library FROM PUBLIC;
\connect skill_library
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO skill_library;
SQL
unset APP_DB_PASSWORD

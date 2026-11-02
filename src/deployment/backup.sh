#!/bin/sh
set -eu
umask 077
mkdir -p /backups
# Timestamp + random suffix; never overwrite the last good archive.
name="skill-library-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
partial="/backups/$name.dump.partial"
trap 'rm -f "$partial"' EXIT HUP INT TERM
PGPASSWORD=$(cat /run/secrets/app_db_password)
export PGPASSWORD
pg_dump --format=custom --no-owner --no-acl --file="$partial"
pg_restore --list "$partial" >/dev/null
mv "$partial" "/backups/$name.dump"
(cd /backups && sha256sum "$name.dump" > "$name.dump.sha256")
# Retain >=14 days; only prune completed files with this exact owned prefix.
find /backups -maxdepth 1 -type f -name 'skill-library-*.dump' -mtime +14 -delete
find /backups -maxdepth 1 -type f -name 'skill-library-*.dump.sha256' -mtime +14 -delete
printf '{"event":"backup.completed","archive":"%s.dump"}\n' "$name"

#!/usr/bin/env bash
# Restores an encrypted backup into a SEPARATE database and verifies it. It never touches the live database.
#   Usage: ops/restore.sh <backup.tar.age> <age-identity-file> <target-database> [uploads-dir]
#   Env:   PGHOST PGPORT PGUSER PGPASSWORD  (a role allowed to CREATE DATABASE)
set -euo pipefail
FILE="${1:?backup file}"; IDENT="${2:?age identity (private key) file}"; TARGET="${3:?target database name}"; UPLOADS_OUT="${4:-}"
if [ -n "${PGDATABASE:-}" ] && [ "$TARGET" = "$PGDATABASE" ] && [ "${FORCE_OVERWRITE_LIVE:-0}" != 1 ]; then
  echo "refusing to restore over the live database ($TARGET)" >&2; exit 3
fi
if [ -f "$FILE.sha256" ]; then
  ( cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" >/dev/null ) || { echo "CHECKSUM MISMATCH — file corrupted or tampered" >&2; exit 4; }
fi
WORK="$(mktemp -d /var/tmp/erp-restore.XXXXXX)"; chmod 700 "$WORK"
trap 'rm -rf "${WORK:?}"' EXIT
age -d -i "$IDENT" "$FILE" | tar -C "$WORK" -xf - || { echo "DECRYPT/EXTRACT FAILED (wrong key or damaged backup)" >&2; exit 5; }
( cd "$WORK" && sha256sum -c MANIFEST.sha256 >/dev/null ) || { echo "MANIFEST CHECK FAILED" >&2; exit 6; }
psql -X -qAt -d postgres -c "drop database if exists \"$TARGET\" with (force)" -c "create database \"$TARGET\""
pg_restore --no-owner --no-privileges --exit-on-error -d "$TARGET" "$WORK/db.dump"
if [ -n "$UPLOADS_OUT" ]; then mkdir -p "$UPLOADS_OUT"; tar -C "$UPLOADS_OUT" -xf "$WORK/uploads.tar"; fi
echo "--- verification ($(cat "$WORK/INFO")) ---"
OUT="$(psql -X -d "$TARGET" -f "$(dirname "$0")/verify.sql" -P pager=off -t -A -F ' | ')"; echo "$OUT"
if echo "$OUT" | grep -q "| FAIL"; then echo "RESTORE VERIFICATION FAILED" >&2; exit 7; fi
echo "RESTORE OK -> database \"$TARGET\""

#!/usr/bin/env bash
# Encrypted, off-server backup: pg_dump + uploads -> tar -> age (public-key) -> remote. The PRIVATE key never lives on the server.
#   Usage:  ops/backup.sh [daily|weekly|monthly]      (cron runs "daily"; Fridays also keep a weekly, the 1st of the month a monthly)
#   Env:    PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE   owner-role connection (NOT the app role)
#           UPLOAD_DIR                                   attachments directory (optional)
#           AGE_RECIPIENT                                age public key (age1...) — required
#           BACKUP_REMOTE                                rclone remote path (e.g. b2:erp-backups) OR a local directory
#           BACKUP_STAGING                               scratch dir (default /var/tmp/erp-backup)
#           ALERT_WEBHOOK                                optional URL called with a short message on failure
set -Eeuo pipefail
KIND="${1:-daily}"; case "$KIND" in daily|weekly|monthly) ;; *) echo "kind must be daily|weekly|monthly" >&2; exit 2;; esac
: "${AGE_RECIPIENT:?AGE_RECIPIENT is required}"; : "${BACKUP_REMOTE:?BACKUP_REMOTE is required}"; : "${PGDATABASE:?PGDATABASE is required}"
STAGE="${BACKUP_STAGING:-/var/tmp/erp-backup}"; TS="$(date -u +%Y%m%dT%H%M%SZ)"; WORK="$STAGE/$TS"; mkdir -p "$WORK"; chmod 700 "$STAGE" "$WORK"
Q() { psql -X -qAt -v ON_ERROR_STOP=1 "$@"; }
COMPANY="$(Q -c 'select id from companies limit 1')"; STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
JOB="$(Q -c "insert into backup_jobs(company_id,kind,started_at,status) values ('$COMPANY','$(echo "$KIND" | tr a-z A-Z)','$STARTED','RUNNING') returning id")"
is_local() { [ -d "$BACKUP_REMOTE" ] || [[ "$BACKUP_REMOTE" != *:* ]]; }

fail() {
  local msg="$1"
  Q -c "update backup_jobs set status='FAILED', finished_at=now(), error=\$e\$${msg}\$e\$ where id='$JOB'" >/dev/null 2>&1 || true
  if [ -n "${ALERT_WEBHOOK:-}" ]; then curl -fsS -m 10 -X POST -d "ERP backup FAILED ($KIND): $msg" "$ALERT_WEBHOOK" >/dev/null 2>&1 || true; fi
  rm -rf "${WORK:?}"; echo "BACKUP FAILED: $msg" >&2; exit 1
}
trap 'fail "unexpected error at line $LINENO"' ERR

pg_dump --format=custom --no-owner --no-privileges --file="$WORK/db.dump"
if [ -n "${UPLOAD_DIR:-}" ] && [ -d "$UPLOAD_DIR" ]; then tar -C "$UPLOAD_DIR" -cf "$WORK/uploads.tar" .; else tar -cf "$WORK/uploads.tar" --files-from /dev/null; fi
Q -c "select name from schema_migrations order by name" > "$WORK/migrations.txt"
( cd "$WORK" && sha256sum db.dump uploads.tar migrations.txt > MANIFEST.sha256 && echo "created=$STARTED kind=$KIND db=$PGDATABASE git=$(git -C "$(dirname "$0")/.." rev-parse --short HEAD 2>/dev/null || echo unknown)" > INFO )
NAME="erp-$KIND-$TS.tar.age"
tar -C "$WORK" -cf - db.dump uploads.tar migrations.txt MANIFEST.sha256 INFO | age -r "$AGE_RECIPIENT" -o "$STAGE/$NAME"
SIZE="$(stat -c %s "$STAGE/$NAME")"; SHA="$(sha256sum "$STAGE/$NAME" | cut -d' ' -f1)"

put() {   # copy the encrypted file to the remote under a kind prefix, then verify the remote checksum
  local n="erp-$1-$TS.tar.age"
  if is_local; then
    mkdir -p "$BACKUP_REMOTE"; cp "$STAGE/$NAME" "$BACKUP_REMOTE/$n"; echo "$SHA  $n" > "$BACKUP_REMOTE/$n.sha256"
    [ "$(sha256sum "$BACKUP_REMOTE/$n" | cut -d' ' -f1)" = "$SHA" ] || fail "remote checksum mismatch ($n)"
  else
    rclone copyto "$STAGE/$NAME" "$BACKUP_REMOTE/$n"; echo "$SHA  $n" | rclone rcat "$BACKUP_REMOTE/$n.sha256"
    [ "$(rclone hashsum sha256 "$BACKUP_REMOTE/$n" | cut -d' ' -f1)" = "$SHA" ] || fail "rclone checksum mismatch ($n)"
  fi
}
put "$KIND"
if [ "$KIND" = daily ]; then
  if [ "$(date -u +%u)" = 5 ]; then put weekly; fi
  if [ "$(date -u +%d)" = 01 ]; then put monthly; fi
fi

prune() {   # keep the newest N backups of a kind (the paths are guarded: an empty variable aborts instead of deleting)
  local k="$1" keep="$2" f
  if is_local; then
    { ls -1 "$BACKUP_REMOTE" 2>/dev/null || true; } | { grep -E "^erp-$k-.*\.tar\.age$" || true; } | sort | { head -n -"$keep" || true; } | while read -r f; do rm -f "${BACKUP_REMOTE:?}/${f:?}" "${BACKUP_REMOTE:?}/${f:?}.sha256"; done
  else
    rclone lsf "$BACKUP_REMOTE" | { grep -E "^erp-$k-.*\.tar\.age$" || true; } | sort | { head -n -"$keep" || true; } | while read -r f; do rclone deletefile "$BACKUP_REMOTE/$f"; rclone deletefile "$BACKUP_REMOTE/$f.sha256" || true; done
  fi
}
prune daily 14; prune weekly 8; prune monthly 12

Q -c "update backup_jobs set status='OK', finished_at=now(), size_bytes=$SIZE, sha256='$SHA', remote_location=\$r\$$BACKUP_REMOTE/$NAME\$r\$ where id='$JOB'" >/dev/null
rm -rf "${WORK:?}"; rm -f "${STAGE:?}/${NAME:?}"; trap - ERR
echo "BACKUP OK: $NAME ($SIZE bytes, sha256 $SHA)"

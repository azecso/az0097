#!/usr/bin/env bash
# Monthly drill: restore the NEWEST backup into a throw-away database, verify, drop it, record the result.
#   Env: as restore.sh, plus BACKUP_REMOTE (local dir or rclone remote), AGE_IDENTITY (path to the private key, supplied ONLY during the drill),
#        PGDATABASE (the live DB, used for the bookkeeping row; it is never modified except for that row)
set -euo pipefail
: "${BACKUP_REMOTE:?}"; : "${AGE_IDENTITY:?}"; TMPDB="erp_restore_test_$$"; STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMPANY="$(psql -X -qAt -c 'select id from companies limit 1')"
if [ -d "$BACKUP_REMOTE" ] || [[ "$BACKUP_REMOTE" != *:* ]]; then
  LATEST="$(ls -1 "$BACKUP_REMOTE" | grep -E '\.tar\.age$' | sort | tail -n1)"; SRC="$BACKUP_REMOTE/$LATEST"
else
  LATEST="$(rclone lsf "$BACKUP_REMOTE" | grep -E '\.tar\.age$' | sort | tail -n1)"; SRC="/var/tmp/$LATEST"
  rclone copyto "$BACKUP_REMOTE/$LATEST" "$SRC"; rclone copyto "$BACKUP_REMOTE/$LATEST.sha256" "$SRC.sha256" || true
fi
set +e; OUT="$(PGDATABASE='' "$(dirname "$0")/restore.sh" "$SRC" "$AGE_IDENTITY" "$TMPDB" 2>&1)"; RC=$?; set -e
psql -X -qAt -d postgres -c "drop database if exists \"$TMPDB\" with (force)" >/dev/null
if [ "$RC" -eq 0 ]; then STATUS=OK; ERR="NULL"; else STATUS=FAILED; ERR="\$e\$restore drill failed (rc=$RC)\$e\$"; fi
psql -X -qAt -c "insert into backup_jobs(company_id,kind,started_at,finished_at,status,remote_location,error,verification) values ('$COMPANY','RESTORE_TEST','$STARTED',now(),'$STATUS',\$r\$$LATEST\$r\$,$ERR,to_jsonb(\$o\$${OUT: -1500}\$o\$::text))" >/dev/null
echo "$OUT" | tail -n 15
if [ "$RC" -eq 0 ]; then echo "RESTORE DRILL OK ($LATEST)"; else echo "RESTORE DRILL FAILED" >&2; exit 1; fi

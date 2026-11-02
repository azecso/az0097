#!/usr/bin/env bash
# Usage: PGHOST=... PGPORT=... PGUSER=postgres ./run-tests.sh   (needs an empty database in $PGDATABASE)
set -euo pipefail
cd "$(dirname "$0")"
psql -v ON_ERROR_STOP=1 -q -f schema.sql
psql -v ON_ERROR_STOP=1 -q -t -f tests/ledger_invariants.sql | grep -E 'PASS|FAIL|^ +[0-9]+ \|' || true

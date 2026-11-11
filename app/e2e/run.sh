#!/usr/bin/env bash
# Real-browser end-to-end suite. Needs: PostgreSQL (superuser URL in E2E_ADMIN_URL), Node 22, Chromium (CHROMIUM_PATH or `npx playwright install chromium`).
# Each scenario gets a FRESH database + a freshly started app, so scenarios never depend on each other.
#   E2E_ADMIN_URL=postgres://postgres@127.0.0.1:5432 CHROMIUM_PATH=/usr/bin/chromium ./e2e/run.sh [scenario-prefix]
set -uo pipefail
cd "$(dirname "$0")/.."
ADMIN="${E2E_ADMIN_URL:?set E2E_ADMIN_URL, e.g. postgres://postgres:postgres@127.0.0.1:5432}"; PORT="${E2E_PORT:-3100}"; FILTER="${1:-}"; FAIL=0
mkdir -p e2e/out e2e/out/uploads
if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then echo "port $PORT is already in use — stop that server first" >&2; exit 2; fi
[ -d .next ] || npm run build
for SC in e2e/0*.cjs; do
  NAME="$(basename "$SC" .cjs)"; [ -n "$FILTER" ] && [[ "$NAME" != "$FILTER"* ]] && continue
  DB="e2e_$(echo "$NAME" | tr -c 'a-z0-9\n' '_')"
  psql "$ADMIN/postgres" -qAt -c "drop database if exists \"$DB\" with (force)" -c "create database \"$DB\"" >/dev/null 2>&1
  DATABASE_URL="$ADMIN/$DB" APP_DB_USER=erp_app APP_DB_PASSWORD=e2e-app-pw npx tsx scripts/migrate.ts >/dev/null
  DATABASE_URL="$ADMIN/$DB" COMPANY_NAME="شركة التجربة" OWNER_USERNAME=owner OWNER_PASSWORD='Owner-Smoke-Pass-77' npx tsx scripts/bootstrap.ts >/dev/null
  APPURL="$(echo "$ADMIN" | sed -E 's#//[^@]*@#//erp_app:e2e-app-pw@#')/$DB"
  DATABASE_URL="$APPURL" RESET_DATABASE_URL="$ADMIN/$DB" EXPORT_DIR="$PWD/e2e/out/exports" COOKIE_SECURE=false REQUIRE_OWNER_2FA=false UPLOAD_DIR="$PWD/e2e/out/uploads" PORT="$PORT" NEXT_TELEMETRY_DISABLED=1 node node_modules/next/dist/bin/next start -p "$PORT" >"e2e/out/$NAME.server.log" 2>&1 &   # run next directly so $! is the real server (an npx wrapper would survive kill)
  SRV=$!; for i in $(seq 1 40); do curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
  echo "=== $NAME ==="; ( cd e2e/out && E2E_BASE="http://localhost:$PORT" node "../$(basename "$SC")" 2>&1 ) | tee "e2e/out/$NAME.log"
  grep -q "^FAIL\|SMOKE ERROR" "e2e/out/$NAME.log" && FAIL=1
  kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; for i in $(seq 1 20); do curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 || break; sleep 0.3; done
done
[ "$FAIL" -eq 0 ] && echo "E2E: ALL SCENARIOS PASSED" || { echo "E2E: FAILURES (see e2e/out/*.log)" >&2; exit 1; }

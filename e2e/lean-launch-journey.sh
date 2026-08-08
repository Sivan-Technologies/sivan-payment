#!/usr/bin/env bash
#
# Runner for the terms-step browser journey.
#
# WHY THE STATE IS SEEDED INTO THE DATABASE FILE RATHER THAN BUILT OVER HTTP:
# the mock Bridge provider approves everything it is asked, so a customer
# created through /api/customers/kyc-link arrives with terms ALREADY accepted.
# The state under test - KYC approved, terms outstanding, which is exactly
# where a real Bridge user sits while they read the terms page - is therefore
# unreachable over the API. It is written to the JSON file before the server
# boots, because json-database caches the file in memory on first read.
#
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT="${API_PORT:-4750}"
APP_PORT="${APP_PORT:-4175}"
DB=".data/e2e-lean.json"

# KILL ANY STALE STACK FIRST.
#
# A previous run leaving an API on this port is not a harmless annoyance: the
# new server fails with EADDRINUSE, the script carries on, and the journey
# silently tests the OLD build against the OLD database. That produced a run
# where six assertions "failed" against code that was actually correct, and it
# would just as happily produce a PASS against code that was not.
# NOT `fuser` / `lsof` - neither is installed in the CI sandbox, so those
# commands were silent no-ops (`|| true` swallowed the "command not found")
# and the stale server survived. That cost two debugging cycles: the journey
# ran green-then-red against an OLD build and an OLD database while the
# working tree was correct.
pkill -9 -f "tsx src/server.ts" 2>/dev/null || true
pkill -9 -f "e2e/serve-dist.py" 2>/dev/null || true

# Wait for the ports to actually clear. pkill returns before the kernel has
# released the socket, and racing it is how the stale server came back.
for _ in $(seq 1 20); do
  if ! (ss -ltn 2>/dev/null | grep -qE ":$API_PORT|:$APP_PORT"); then break; fi
  sleep 1
done
if ss -ltn 2>/dev/null | grep -qE ":$API_PORT|:$APP_PORT"; then
  echo "ports $API_PORT/$APP_PORT still held after 20s - refusing to run against a stale stack" >&2
  exit 1
fi

mkdir -p .data
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# This journey seeds everything over HTTP, so it starts from an empty database.
rm -f "$DB"

export DATABASE_PROVIDER=json DATABASE_FILE="$DB" \
  WALLET_PROVIDER=mock NGN_PROVIDER=mock KYC_LEVEL_PROVIDER=mock \
  BRIDGE_MOCK_MODE=true EMAIL_PROVIDER=console SUPPORT_UPLOAD_PROVIDER=mock \
  ADMIN_API_KEY=e2e-admin-key USER_JWT_SECRET=e2e-jwt-secret-value-long-enough \
  AUTH_REQUIRE_USER=false RATE_LIMIT_ENABLED=false \
  AUTH_OTP_RESEND_COOLDOWN_SECONDS=0 CORS_ORIGIN='*' \
  APP_ENV=development PORT="$API_PORT"

npx tsx src/server.ts > /tmp/lean-api.log 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true; kill ${WEB_PID:-0} 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done

# The API must be OURS. If the port was held by something else, curl still
# succeeds and the journey runs against a stranger's database.
if ! kill -0 "$API_PID" 2>/dev/null; then
  echo "API process died during startup - refusing to test a stale server:" >&2
  tail -20 /tmp/lean-api.log >&2
  exit 1
fi

(cd frontend && VITE_API_BASE_URL="http://127.0.0.1:$API_PORT" ./node_modules/.bin/vite build --outDir dist >/tmp/lean-build.log 2>&1)

APP_PORT="$APP_PORT" python3 e2e/serve-dist.py > /tmp/lean-web.log 2>&1 &
WEB_PID=$!
sleep 2

API="http://127.0.0.1:$API_PORT" APP="http://127.0.0.1:$APP_PORT" \
  node e2e/lean-launch-journey.mjs

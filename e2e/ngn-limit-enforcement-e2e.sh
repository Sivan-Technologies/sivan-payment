#!/usr/bin/env bash
# NGN LIMIT ENFORCEMENT - END TO END, OVER REAL HTTP.
#
# The unit suite (npm run test:ngn-limit-enforcement) drives the services
# directly. This drives the API a browser would: create a user, verify a bank,
# get quoted, accept an order, race a second one, toggle enforcement, reset in
# bulk. It exists because four of the bugs found while building this were only
# visible through the wire - a readonly $UID in the harness, a signup schema
# needing legalAcceptance.accepted, a payout account landing in pending_review
# rather than verified, and BANK being level 1 rather than 2.
#
# Usage:
#   PORT=4300 DATABASE_PROVIDER=json DATABASE_FILE=.data/limits-e2e.json \
#   WALLET_PROVIDER=mock NGN_PROVIDER=mock ADMIN_API_KEY=e2e-admin-key \
#   AUTH_REQUIRE_USER=false RATE_LIMIT_ENABLED=false npx tsx src/server.ts &
#   bash e2e/ngn-limit-enforcement-e2e.sh
set -u
RUNID=$(date +%s)
API=http://127.0.0.1:4300
ADM='x-admin-api-key: e2e-admin-key'
J='content-type: application/json'
P=0; F=0
ck(){ if [ "$2" = "$3" ]; then echo "  ok   $1"; P=$((P+1)); else echo "  FAIL $1 -> got '$2' want '$3'"; F=$((F+1)); fi; }

echo "--- controls default"
D=$(curl -s -m 20 "$API/api/admin/ngn/controls" -H "$ADM" | python3 -c "import sys,json;d=json.load(sys.stdin)['data']['limitEnforcement'];print(f\"{d['offramp']}/{d['onramp']}/{d['escrow']}\")")
ck "all three flows default ON" "$D" "True/True/True"

curl -s -m 20 -X PUT "$API/api/admin/ngn/controls" -H "$J" -H "$ADM" -d '{"onrampEnabled":true,"offrampEnabled":true,"activeProvider":"mock"}' -o /dev/null

echo "--- create a bank-verified user (Level 1 BANK, NGN 100,000 offramp ceiling)"
curl -s -m 20 -X POST "$API/api/users" -H "$J" -d '{"email":"lim-'$RUNID'@t.test","country":"NG","fullName":"OGUNMEPON SHARAFA","legalAcceptance":{"accepted":true,"termsVersion":"1.0","privacyVersion":"1.0"}}' -o /tmp/u.json
USERID=$(python3 -c "import json;print(json.load(open('/tmp/u.json'))['data']['id'])")
curl -s -m 20 -X POST "$API/api/ngn/payout-accounts" -H "$J" -d "{\"userId\":\"$USERID\",\"bankId\":\"1\",\"accountNumber\":\"1111111111\"}" -o /dev/null
# The bank account lands in pending_review even on a name MATCH - an admin
# approves it. That is a real control, so the E2E goes through it rather than
# writing 'verified' into the database behind the product's back.
ACCT=$(curl -s -m 20 "$API/api/ngn/payout-accounts?userId=$USERID" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d[0]['id'] if d else '')")
curl -s -m 20 -X PUT "$API/api/admin/ngn/payout-accounts/$ACCT/review" -H "$J" -H "$ADM" -d '{"decision":"approve"}' -o /dev/null

LVL=$(curl -s -m 20 "$API/api/users/$USERID/verification-summary" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['level'])")
ck "user reaches Level 1 (BANK) on bank verification" "$LVL" "1"

q(){ curl -s -m 25 "$API/api/ngn/quote?userId=$USERID&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=$1&network=solana"; }

echo "--- under the ceiling"
S=$(q 10 | python3 -c "import sys,json;d=json.load(sys.stdin);print('ok' if 'data' in d else d.get('error',{}).get('code','?'))")
ck "a 10 USDC quote is allowed" "$S" "ok"

echo "--- accept it, putting money IN FLIGHT"
QID=$(q 60 | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
curl -s -m 25 -X POST "$API/api/ngn/offramp/orders" -H "$J" -d "{\"userId\":\"$USERID\",\"quoteId\":\"$QID\"}" -o /tmp/o.json
ST=$(python3 -c "import json;d=json.load(open('/tmp/o.json'));print(d.get('data',{}).get('status','ERR'))")
echo "     in-flight transfer status: $ST"

echo "--- the race: a second large quote must now be refused"
S2=$(q 60 | python3 -c "import sys,json;d=json.load(sys.stdin);print('ALLOWED' if 'data' in d else 'blocked')")
ck "in-flight volume blocks the next quote" "$S2" "blocked"

echo "--- admin sees who is over after tightening"
curl -s -m 20 -X PUT "$API/api/admin/users/$USERID/limits" -H "$J" -H "$ADM" -d '{"flow":"offramp","rail":"ngn","cumulativeNgn":10000,"reason":"tighten","createdBy":"admin"}' -o /dev/null
OV=$(curl -s -m 25 "$API/api/admin/limits/over-ceiling?flow=offramp&rail=ngn" -H "$ADM" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['count'])")
ck "over-ceiling report finds the user" "$OV" "1"

echo "--- per-flow bypass"
curl -s -m 20 -X PUT "$API/api/admin/ngn/controls" -H "$J" -H "$ADM" -d '{"limitEnforcement":{"offramp":false}}' -o /dev/null
OTH=$(curl -s -m 20 "$API/api/admin/ngn/controls" -H "$ADM" | python3 -c "import sys,json;d=json.load(sys.stdin)['data']['limitEnforcement'];print(f\"{d['onramp']}/{d['escrow']}\")")
ck "other flows stay ON when offramp is turned off" "$OTH" "True/True"
S3=$(q 60 | python3 -c "import sys,json;d=json.load(sys.stdin);print('ALLOWED' if 'data' in d else 'blocked')")
ck "with enforcement off the quote passes" "$S3" "ALLOWED"

curl -s -m 20 -X PUT "$API/api/admin/ngn/controls" -H "$J" -H "$ADM" -d '{"limitEnforcement":{"offramp":true}}' -o /dev/null
S4=$(q 60 | python3 -c "import sys,json;d=json.load(sys.stdin);print('ALLOWED' if 'data' in d else 'blocked')")
ck "turning it back on re-blocks" "$S4" "blocked"

echo "--- bulk reset"
BAD=$(curl -s -m 25 -X POST "$API/api/admin/users/limits/reset-all" -H "$J" -H "$ADM" -d '{"flow":"offramp","rail":"ngn","reason":"x","confirm":"onramp"}' -o /dev/null -w '%{http_code}')
ck "mismatched confirm is rejected" "$BAD" "400"
OK=$(curl -s -m 30 -X POST "$API/api/admin/users/limits/reset-all" -H "$J" -H "$ADM" -d '{"flow":"offramp","rail":"ngn","reason":"policy","confirm":"offramp"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['usersReset'])")
ck "bulk reset forgives the user with volume" "$OK" "1"

echo; echo "$([ $F -eq 0 ] && echo ✅ || echo ❌) $P passed, $F failed"

set -u
API=http://127.0.0.1:4700; J='content-type: application/json'; ADM='x-admin-api-key: e2e-admin-key'
P=0; F=0
ck(){ if [ "$2" = "$3" ]; then echo "  ok   $1"; P=$((P+1)); else echo "  FAIL $1 -> got '$2' want '$3'"; F=$((F+1)); fi; }
R=$(date +%s); E="e2e-$R@example.com"

echo "── 1. SIGNUP (the 500 we fixed) ─────────────────────────────"
S=$(curl -s -m 30 -X POST "$API/api/auth/email/start" -H "$J" -d "{\"email\":\"$E\",\"intent\":\"signup\",\"fullName\":\"OGUNMEPON SHARAFA\",\"legalAcceptance\":{\"accepted\":true,\"termsVersion\":\"1.0\",\"privacyVersion\":\"1.0\"}}" -w '|%{http_code}')
ck "signup issues an OTP" "${S##*|}" "200"
C=$(echo "${S%|*}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['devCode'])")
V=$(curl -s -m 30 -X POST "$API/api/auth/email/verify" -H "$J" -d "{\"email\":\"$E\",\"code\":\"$C\"}")
U=$(echo "$V" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['user']['id'])")
TOK=$(echo "$V" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")
ck "OTP creates the account" "$([ -n "$U" ] && echo yes)" "yes"
ck "and returns a session token" "$([ ${#TOK} -gt 50 ] && echo yes)" "yes"

echo "── 2. SIGNIN (returning user) ───────────────────────────────"
S2=$(curl -s -m 30 -X POST "$API/api/auth/email/start" -H "$J" -d "{\"email\":\"$E\",\"intent\":\"signin\"}" -w '|%{http_code}')
ck "signin issues an OTP" "${S2##*|}" "200"
C2=$(echo "${S2%|*}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['devCode'])")
U2=$(curl -s -m 30 -X POST "$API/api/auth/email/verify" -H "$J" -d "{\"email\":\"$E\",\"code\":\"$C2\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['user']['id'])")
ck "and returns the SAME user" "$U2" "$U"

echo "── 3. LEVEL 1: bank verification ────────────────────────────"
curl -s -m 30 -X POST "$API/api/ngn/payout-accounts" -H "$J" -d "{\"userId\":\"$U\",\"bankId\":\"1\",\"accountNumber\":\"1111111111\"}" -o /dev/null
A=$(curl -s -m 30 "$API/api/ngn/payout-accounts?userId=$U" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['id'])")
curl -s -m 30 -X PUT "$API/api/admin/ngn/payout-accounts/$A/review" -H "$J" -H "$ADM" -d '{"decision":"approve"}' -o /dev/null
sum(){ curl -s -m 30 "$API/api/users/$U/verification-summary" | python3 -c "
import sys,json;d=json.load(sys.stdin)['data']
o=[a for a in d['allowances'] if a['flow']=='offramp' and a['rail']=='ngn'][0]
print(f\"{d['level']}|{d['checks']['bvn']}|{o['limitNgn']}|{o['usedNgn']}\")"; }
IFS='|' read L B LIM USED <<< "$(sum)"
ck "bank check reaches Level 1" "$L" "1"
ck "with the NGN 100,000 ceiling" "$LIM" "100000"

echo "── 4. LEVEL 2: BVN (persists, grants, lifts) ────────────────"
BV=$(curl -s -m 30 -X POST "$API/api/users/$U/kyc/ngn-bvn/verify" -H "$J" -d '{"bvn":"22222222222","firstName":"OGUNMEPON","lastName":"SHARAFA","dateOfBirth":"01-01-1990","mobileNo":"08012345678"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['status'])")
ck "BVN check matches" "$BV" "matched"
IFS='|' read L B LIM USED <<< "$(sum)"
ck "user is now Level 2" "$L" "2"
ck "bvn check reads verified" "$B" "verified"
ck "ceiling lifted to NGN 5,000,000" "$LIM" "5000000"
ck "raw BVN is NOT in the database" "$(grep -c '22222222222' .data/final-e2e.json || true)" "0"

echo "── 5. LIMITS: in-flight consumes headroom ───────────────────"
curl -s -m 30 -X PUT "$API/api/admin/ngn/controls" -H "$J" -H "$ADM" -d '{"onrampEnabled":true,"offrampEnabled":true,"activeProvider":"mock"}' -o /dev/null
q(){ curl -s -m 30 "$API/api/ngn/quote?userId=$U&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=$1&network=solana"; }
QID=$(q 1000 | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('data',{}).get('id',''))")
ck "a large quote under the ceiling is allowed" "$([ -n "$QID" ] && echo yes)" "yes"
curl -s -m 30 -X POST "$API/api/ngn/offramp/orders" -H "$J" -d "{\"userId\":\"$U\",\"quoteId\":\"$QID\"}" -o /dev/null
IFS='|' read L B LIM USED <<< "$(sum)"
ck "the in-flight order consumes headroom" "$([ "${USED%.*}" -gt 0 ] && echo yes)" "yes"
BLOCK=$(q 4000 | python3 -c "import sys,json;d=json.load(sys.stdin);print('blocked' if 'error' in d else 'ALLOWED')")
ck "a further order beyond the remaining headroom is refused" "$BLOCK" "blocked"

echo "── 6. ADMIN CONTROLS ────────────────────────────────────────"
curl -s -m 30 "$API/api/admin/ngn/controls" -H "$ADM" -o /tmp/ctl.json
EF=$(python3 -c "import json;d=json.load(open('/tmp/ctl.json'))['data'];print(str(d['externalFundingEnabled'])+'|'+str(d['limitEnforcementOfframp'])+'|'+str(d['limitEnforcementOnramp']))")
ck "external funding OFF, enforcement ON x2" "$EF" "False|True|True"
OV=$(curl -s -m 30 "$API/api/admin/limits/over-ceiling?flow=offramp&rail=ngn" -H "$ADM" -w '|%{http_code}')
ck "over-ceiling report responds" "${OV##*|}" "200"
BAD=$(curl -s -m 30 -X POST "$API/api/admin/limits/reset-all" -H "$J" -H "$ADM" -d '{"flow":"offramp","rail":"ngn","reason":"x","confirm":"onramp"}' -o /dev/null -w '%{http_code}')
ck "bulk reset rejects a mismatched confirm" "$BAD" "400"

echo "── 7. HEALTH ────────────────────────────────────────────────"
ck "/health" "$(curl -s -m 30 -o /dev/null -w '%{http_code}' $API/health)" "200"
ck "/health/db" "$(curl -s -m 30 -o /dev/null -w '%{http_code}' $API/health/db)" "200"

echo; echo "$([ $F -eq 0 ] && echo ✅ || echo ❌) $P passed, $F failed"

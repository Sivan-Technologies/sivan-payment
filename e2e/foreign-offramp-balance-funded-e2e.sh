set -u
# =====================================================================
# USD/GBP/EUR OFF-RAMP, FUNDED FROM THE SIVAN (PRIVY) BALANCE.
#
# The question this answers: a user holding USDC in their Privy wallet
# wants dollars or pounds in their bank. Can Sivan move the crypto to
# the Bridge liquidation address itself, the way it already does for
# the naira rail - or must the user send it by hand?
#
# Before this suite the answer was "by hand", and nothing said so.
# =====================================================================
API=${API:-http://127.0.0.1:4712}; J='content-type: application/json'; ADM='x-admin-api-key: e2e-admin-key'
DBF=${DBF:-.data/offramp-e2e.json}
P=0; F=0
ck(){ if [ "$2" = "$3" ]; then echo "  ok   $1"; P=$((P+1)); else echo "  FAIL $1 -> got '$2' want '$3'"; F=$((F+1)); fi; }
ckc(){ if echo "$2" | grep -qi "$3"; then echo "  ok   $1"; P=$((P+1)); else echo "  FAIL $1 -> '$2' lacks '$3'"; F=$((F+1)); fi; }

R=$(date +%s%N); E="fx-$R@example.com"

echo "── 1. ACCOUNT + KYC ─────────────────────────────────────────"
S=$(curl -s -m 30 -X POST "$API/api/auth/email/start" -H "$J" -d "{\"email\":\"$E\",\"intent\":\"signup\",\"fullName\":\"OGUNMEPON SHARAFA\",\"legalAcceptance\":{\"accepted\":true,\"termsVersion\":\"1.0\",\"privacyVersion\":\"1.0\"}}")
C=$(echo "$S" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['devCode'])")
V=$(curl -s -m 30 -X POST "$API/api/auth/email/verify" -H "$J" -d "{\"email\":\"$E\",\"code\":\"$C\"}")
UID_=$(echo "$V" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['user']['id'])")
ck "account created" "$([ -n "$UID_" ] && echo yes)" "yes"
curl -s -m 30 -X POST "$API/api/customers" -H "$J" -d "{\"userId\":\"$UID_\",\"payload\":{\"type\":\"individual\",\"first_name\":\"Ada\",\"last_name\":\"Obi\"}}" -o /dev/null
KS=$(curl -s -m 30 -X POST "$API/api/customers/$UID_/sandbox/simulate-kyc-approval" -H "$J" -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['kycStatus'])")
ck "KYC approved" "$KS" "kyc_approved"

echo "── 2. WALLET + BALANCE ──────────────────────────────────────"
# A wallet cannot be created until a payout bank is confirmed - the API says
# so explicitly ("Add and confirm your payout bank account to create your
# wallet"), so the suite has to satisfy that rather than work around it.
curl -s -m 30 -X POST "$API/api/ngn/payout-accounts" -H "$J" -d "{\"userId\":\"$UID_\",\"bankId\":\"1\",\"accountNumber\":\"1111111111\"}" -o /dev/null
PA=$(curl -s -m 30 "$API/api/ngn/payout-accounts?userId=$UID_" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d[0]['id'] if d else '')")
curl -s -m 30 -X PUT "$API/api/admin/ngn/payout-accounts/$PA/review" -H "$J" -H "$ADM" -d '{"decision":"approve"}' -o /dev/null
curl -s -m 60 -X POST "$API/api/users/$UID_/wallets" -H "$J" -d '{"chain":"solana"}' -o /dev/null
WA=$(curl -s -m 30 "$API/api/users/$UID_/wallets" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d[0]['address'] if d else '')")
ck "Privy-style wallet exists" "$([ -n "$WA" ] && echo yes)" "yes"
curl -s -m 30 -X POST "$API/api/admin/balance/adjustments" -H "$J" -H "$ADM" -d "{\"userId\":\"$UID_\",\"asset\":\"usdc\",\"amount\":500,\"status\":\"available\",\"reason\":\"foreign offramp e2e funding\"}" -o /dev/null
AV=$(curl -s -m 30 "$API/api/users/$UID_/balance" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['balances'][0]['available'])")
ck "balance is 500 USDC" "$AV" "500"

echo "── 3. USD BANK ACCOUNT ──────────────────────────────────────"
EAID=$(curl -s -m 30 -X POST "$API/api/external-accounts" -H "$J" -d "{\"userId\":\"$UID_\",\"accountType\":\"us\",\"currency\":\"usd\",\"bankName\":\"Chase\",\"accountOwnerName\":\"OGUNMEPON SHARAFA\",\"accountOwnerType\":\"individual\",\"firstName\":\"Ada\",\"lastName\":\"Obi\",\"paymentRail\":\"ach\",\"account\":{\"routing_number\":\"021000021\",\"account_number\":\"123456789\",\"checking_or_savings\":\"checking\"},\"address\":{\"street_line_1\":\"1 Main St\",\"city\":\"New York\",\"state\":\"NY\",\"postal_code\":\"10001\",\"country\":\"USA\"}}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
ck "USD external account created" "$([ -n "$EAID" ] && echo yes)" "yes"

echo "── 4. BALANCE-FUNDED USD WITHDRAWAL (the new path) ──────────"
W=$(curl -s -m 60 -X POST "$API/api/withdrawals" -H "$J" -d "{\"userId\":\"$UID_\",\"externalAccountId\":\"$EAID\",\"sourceCurrency\":\"usdc\",\"sourceChain\":\"solana\",\"destinationCurrency\":\"usd\",\"sourceAmount\":100,\"fundingSource\":\"balance\"}")
WID=$(echo "$W" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['withdrawal']['id'])")
ck "withdrawal created" "$([ -n "$WID" ] && echo yes)" "yes"
ck "server echoes fundingSource=balance" "$(echo "$W" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('fundingSource'))")" "balance"
ck "the AMOUNT is persisted" "$(echo "$W" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['withdrawal'].get('sourceAmount'))")" "100"
LA=$(echo "$W" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['deposit']['address'])")

# The sweep is DETACHED from the response on purpose (Cloudflare 12s cap),
# so the assertion has to wait for it rather than read the POST body.
sleep 4

echo "── 5. SIVAN ATTEMPTS THE SEND ITSELF ────────────────────────"
# WHAT THIS CAN AND CANNOT PROVE OVER HTTP.
#
# The mock wallet provider keeps its on-chain balance IN PROCESS, and there is
# no route to seed it - so over HTTP the transfer always ends at the provider's
# own balance check. That is fine, because the thing this suite is for is the
# WIRING: that a sweep is attempted at all, finds the user's wallet, gets past
# the ledger check, and reaches the provider with the right address and amount.
#
# The completed happy path - a real signed transfer - is proven in
# scripts/test-foreign-offramp-balance-funded.ts, which runs in-process and can
# seed the wallet. Asserting "submitted" here instead would just be asserting
# the mock, and it would fail for a reason that has nothing to do with Sivan.
SW=$(python3 -c "
import json;d=json.load(open('$DBF'))
a=[x for x in d.get('auditLogs',[]) if x.get('resourceId')=='$WID' and x['action'].startswith('withdrawal.sweep_')]
print(json.dumps({'action':a[0]['action'],'meta':a[0].get('metadata')}) if a else '')
")
ck "a sweep was attempted for this withdrawal" "$([ -n "$SW" ] && echo yes)" "yes"
ckc "it reached the wallet provider, not a wiring dead end" "$SW" "sweep_failed"
ckc "aimed at the liquidation address" "$SW" "$LA"
# The negative that matters: it must NOT have bailed out before the provider.
# 'no_wallet_for_network' is the exact silent-skip bug that stranded NGN
# off-ramps, so it is named explicitly rather than left to a generic check.
ck "it did NOT silently skip for want of a wallet" "$(echo "$SW" | grep -c 'no_wallet_for_network')" "0"
ck "and it did NOT skip on a ledger balance the user has" "$(echo "$SW" | grep -c 'insufficient_spendable')" "0"

echo "── 6. THE LIQUIDATION ADDRESS IS SENDABLE ───────────────────"
# A Solana address that cannot be decoded cannot be sent to. The mock used to
# emit 'So'+hex, which contains '0' and is therefore not base58 at all.
ck "deposit address is valid base58/Solana" "$(python3 -c "
import sys
A='$LA'
B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
print('yes' if A and all(c in B58 for c in A) and 32<=len(A)<=44 else 'no')")" "yes"

echo "── 7. GBP WORKS THE SAME WAY ────────────────────────────────"
GB=$(curl -s -m 30 -X POST "$API/api/external-accounts" -H "$J" -d "{\"userId\":\"$UID_\",\"accountType\":\"gb\",\"currency\":\"gbp\",\"bankName\":\"Monzo\",\"accountOwnerName\":\"OGUNMEPON SHARAFA\",\"accountOwnerType\":\"individual\",\"firstName\":\"Ada\",\"lastName\":\"Obi\",\"account\":{\"account_number\":\"12345678\",\"sort_code\":\"040075\"},\"address\":{\"street_line_1\":\"1 High St\",\"city\":\"London\",\"postal_code\":\"E1 6AN\",\"country\":\"GBR\"}}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['id'])")
WG=$(curl -s -m 60 -X POST "$API/api/withdrawals" -H "$J" -d "{\"userId\":\"$UID_\",\"externalAccountId\":\"$GB\",\"sourceCurrency\":\"usdc\",\"sourceChain\":\"solana\",\"destinationCurrency\":\"gbp\",\"sourceAmount\":50,\"fundingSource\":\"balance\"}")
WGID=$(echo "$WG" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['withdrawal']['id'])")
sleep 4
ck "GBP withdrawal also attempts a sweep" "$(python3 -c "
import json;d=json.load(open('$DBF'))
print('yes' if any(x['action'].startswith('withdrawal.sweep_') and x.get('resourceId')=='$WGID' for x in d.get('auditLogs',[])) else 'no')")" "yes"

echo "── 8. MANUAL-SEND STILL WORKS (no regression) ───────────────"
WM=$(curl -s -m 60 -X POST "$API/api/withdrawals" -H "$J" -d "{\"userId\":\"$UID_\",\"externalAccountId\":\"$EAID\",\"sourceCurrency\":\"usdc\",\"sourceChain\":\"solana\",\"destinationCurrency\":\"usd\"}")
WMID=$(echo "$WM" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['withdrawal']['id'])")
ck "amount-less withdrawal still allowed" "$([ -n "$WMID" ] && echo yes)" "yes"
ck "and is marked external" "$(echo "$WM" | python3 -c "import sys,json;print(json.load(sys.stdin)['data'].get('fundingSource'))")" "external"
sleep 3
ck "nothing was swept for it" "$(python3 -c "
import json;d=json.load(open('$DBF'))
print('yes' if any(x['action'].startswith('withdrawal.sweep_') and x.get('resourceId')=='$WMID' for x in d.get('auditLogs',[])) else 'no')")" "no"

echo "── 9. OVERDRAWING IS REFUSED, VISIBLY ───────────────────────"
WB=$(curl -s -m 60 -X POST "$API/api/withdrawals" -H "$J" -d "{\"userId\":\"$UID_\",\"externalAccountId\":\"$EAID\",\"sourceCurrency\":\"usdc\",\"sourceChain\":\"solana\",\"destinationCurrency\":\"usd\",\"sourceAmount\":1000,\"fundingSource\":\"balance\"}")
WBID=$(echo "$WB" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('data',{}).get('withdrawal',{}).get('id',''))" 2>/dev/null)
sleep 3
if [ -n "$WBID" ]; then
  SK=$(python3 -c "
import json;d=json.load(open('$DBF'))
a=[x for x in d.get('auditLogs',[]) if x['action']=='withdrawal.sweep_skipped' and x.get('resourceId')=='$WBID']
print(a[0]['metadata']['reason'] if a else 'NONE')")
  ck "an unaffordable sweep is skipped, with a reason" "$SK" "insufficient_spendable"
  ck "and NOT reported as sent" "$(python3 -c "
import json;d=json.load(open('$DBF'))
print('yes' if any(x['action']=='withdrawal.sweep_submitted' and x.get('resourceId')=='$WBID' for x in d.get('auditLogs',[])) else 'no')")" "no"
else
  # Refused up-front by the limit check is an equally correct answer.
  ckc "an unaffordable withdrawal is refused up-front" "$WB" "error"
  P=$((P+1))
fi

echo "── 10. fundingSource=balance WITHOUT an amount is refused ───"
NA=$(curl -s -m 30 -X POST "$API/api/withdrawals" -H "$J" -d "{\"userId\":\"$UID_\",\"externalAccountId\":\"$EAID\",\"sourceCurrency\":\"usdc\",\"sourceChain\":\"solana\",\"destinationCurrency\":\"usd\",\"fundingSource\":\"balance\"}" -w '|%{http_code}')
ck "contradictory request 400s" "${NA##*|}" "400"
ckc "with an actionable message" "${NA%|*}" "amount"

echo; echo "$([ $F -eq 0 ] && echo ✅ || echo ❌) $P passed, $F failed"

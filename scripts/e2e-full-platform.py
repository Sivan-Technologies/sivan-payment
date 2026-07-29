import json, time, urllib.request, urllib.error

B = "http://localhost:3077"
ADMIN_KEY = "e2ekey"
POOL = "SIVAN_POOL_DO_NOT_USE"

p = f = 0
def t(name, ok, detail=""):
    global p, f
    if ok: p += 1
    else: f += 1
    print(f"  {'✓' if ok else '✗'} {name}" + (f"\n      {detail}" if detail else ""))

def call(method, path, body=None, token=None, admin=False):
    h = {"content-type": "application/json"}
    if token: h["Authorization"] = f"Bearer {token}"
    if admin:
        h["x-admin-api-key"] = ADMIN_KEY
        h["x-sivan-admin-email"] = "ops@sivan.test"
        h["x-sivan-admin-role"] = "ops"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(B + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"{}")
        except Exception: return e.code, {}

def signup(name):
    email = f"{name}+{int(time.time()*1000)}@sivan.test"
    st, r = call("POST", "/api/auth/email/start", {
        "email": email, "fullName": f"{name.title()} Tester", "intent": "signup",
        "legalAcceptance": {"accepted": True, "termsVersion": "2026-07-14",
                            "privacyVersion": "2026-07-14", "riskDisclosureVersion": "2026-07-14"},
    })
    code = (r.get("data") or {}).get("devCode")
    st, r = call("POST", "/api/auth/email/verify", {"email": email, "code": code})
    d = r.get("data") or {}
    return d.get("token"), (d.get("user") or {}).get("id")

def usd_account(user_id):
    return {"userId": user_id, "currency": "usd", "bankName": "Lead Bank",
            "accountName": "Ada Account", "accountOwnerName": "Ada Lovelace",
            "accountOwnerType": "individual", "firstName": "Ada", "lastName": "Lovelace",
            "accountType": "us", "paymentRail": "ach",
            "address": {"street_line_1": "923 Folsom Street", "country": "USA",
                        "state": "CA", "city": "San Francisco", "postal_code": "94107"},
            "account": {"routing_number": "101019644", "account_number": "215268129123",
                        "checking_or_savings": "checking"}}

print("\n" + "=" * 64)
print("  SIVAN FULL END-TO-END  (off-ramp · on-ramp · virtual accounts · wallets)")
print("=" * 64)

# ---------- 1 ----------
print("\n[1] ONBOARDING + KYC")
U = {}
for name in ["alice", "bob"]:
    tok, uid = signup(name)
    U[name] = {"token": tok, "id": uid}
    t(f"{name}: signup + login", bool(tok and uid))
    st, _ = call("POST", "/api/customers/kyc-link", {"userId": uid, "type": "individual"}, tok)
    t(f"{name}: KYC link created", st in (200, 201), f"HTTP {st}")
    st, r = call("GET", f"/api/customers/{uid}", None, tok)
    cust = r.get("data") or {}
    U[name]["kyc"] = cust.get("kycStatus")
    t(f"{name}: KYC approved (mock)", cust.get("kycStatus") == "kyc_approved", str(cust.get("kycStatus")))

# ---------- 2 ----------
print("\n[2] PER-USER WALLETS")
W = {}
for name in ["alice", "bob"]:
    st, r = call("POST", f"/api/users/{U[name]['id']}/wallets", {}, U[name]["token"])
    w = r.get("data") or {}
    W[name] = w
    t(f"{name}: wallet created", st in (200, 201) and bool(w.get("address")),
      f"{w.get('chain')} {str(w.get('address'))[:24]}…")

t("default chain is solana", all(W[n].get("chain") == "solana" for n in W))
t("solana accepts USDC + USDT", all(W[n].get("acceptedAssets") == ["usdc", "usdt"] for n in W))
ids = [W[n].get("providerWalletId") for n in W]
t("alice and bob have DIFFERENT wallets", len(set(ids)) == 2 and all(ids))
t("NO user wallet is the Sivan pool", all(i != POOL for i in ids))

st, r = call("POST", f"/api/users/{U['alice']['id']}/wallets", {"chain": "base"}, U["alice"]["token"])
bw = r.get("data") or {}
t("base wallet is a separate address", bw.get("address") != W["alice"].get("address"))
t("base excludes USDT", bw.get("acceptedAssets") == ["usdc"], str(bw.get("acceptedAssets")))
st, _ = call("POST", f"/api/users/{U['alice']['id']}/wallets", {"chain": "tron"}, U["alice"]["token"])
t("invalid chain rejected", st == 400, f"HTTP {st}")

st, r = call("GET", f"/api/users/{U['alice']['id']}/wallets", None, U["alice"]["token"])
lst = r.get("data") or []
t("wallet list scoped to owner", all(x["userId"] == U["alice"]["id"] for x in lst), f"{len(lst)} wallets")

# idempotency
before = len(lst)
for _ in range(4):
    call("POST", f"/api/users/{U['alice']['id']}/wallets", {}, U["alice"]["token"])
st, r = call("GET", f"/api/users/{U['alice']['id']}/wallets", None, U["alice"]["token"])
t("repeat creates do not duplicate", len(r.get("data") or []) == before, f"{len(r.get('data') or [])} wallets")

# ---------- 3 ----------
print("\n[3] BANK ACCOUNT")
A = {}
for name in ["alice", "bob"]:
    st, r = call("POST", "/api/external-accounts", usd_account(U[name]["id"]), U[name]["token"])
    A[name] = (r.get("data") or {}).get("id")
    t(f"{name}: USD bank account", st in (200, 201) and bool(A[name]), f"HTTP {st}")

# ---------- 4 ----------
print("\n[4] OFF-RAMP  (crypto -> bank)")
st, _ = call("PUT", "/api/admin/offramp/controls",
             {"sourceNetworks": [{"network": "solana", "enabled": True}, {"network": "base", "enabled": True}],
              "sourceAssets": [{"asset": "usdc", "enabled": True}, {"asset": "usdt", "enabled": True}]},
             None, admin=True)
t("admin enabled solana+base, usdc+usdt", st == 200, f"HTTP {st}")

st, r = call("POST", "/api/withdrawals", {
    "userId": U["alice"]["id"], "externalAccountId": A["alice"],
    "sourceCurrency": "usdc", "sourceChain": "solana", "destinationCurrency": "usd",
}, U["alice"]["token"])
d = r.get("data") or {}
la = d.get("liquidationAddress") or d.get("deposit") or {}
wdr = d.get("withdrawal") or d
t("withdrawal created", st in (200, 201), f"HTTP {st}")
t("liquidation address issued", bool(la.get("address")), str(la.get("address"))[:44])
fee = la.get("customDeveloperFeePercent") or wdr.get("feePercent")
t("developer fee applied", bool(fee) and float(fee) > 0, f"fee={fee}%")

st, _ = call("POST", "/api/withdrawals", {
    "userId": U["alice"]["id"], "externalAccountId": A["alice"],
    "sourceCurrency": "usdt", "sourceChain": "base", "destinationCurrency": "usd",
}, U["alice"]["token"])
t("USDT-on-Base withdrawal REJECTED", st == 400, f"HTTP {st}")

st, _ = call("POST", "/api/withdrawals", {
    "userId": U["alice"]["id"], "externalAccountId": A["alice"],
    "sourceCurrency": "usdt", "sourceChain": "solana", "destinationCurrency": "usd",
}, U["alice"]["token"])
t("USDT-on-Solana withdrawal ALLOWED", st in (200, 201), f"HTTP {st}")

# ---------- 5 ----------
print("\n[5] ON-RAMP  (fiat -> crypto)")
st, r = call("POST", "/api/onramp/orders", {
    "userId": U["alice"]["id"], "sourceCurrency": "usd", "destinationCurrency": "usdc",
    "destinationChain": "solana", "destinationAddress": W["alice"]["address"], "amount": 100,
}, U["alice"]["token"])
o = r.get("data") or {}
t("on-ramp order created", st in (200, 201), f"HTTP {st}")
t("destination is the user's OWN wallet", o.get("destinationAddress") == W["alice"]["address"])

st, _ = call("POST", "/api/onramp/orders", {
    "userId": U["alice"]["id"], "sourceCurrency": "usd", "destinationCurrency": "usdt",
    "destinationChain": "base", "destinationAddress": bw.get("address"), "amount": 100,
}, U["alice"]["token"])
t("USDT-on-Base on-ramp REJECTED", st == 400, f"HTTP {st}")

# ---------- 6 ----------
print("\n[6] VIRTUAL ACCOUNTS  (fiat in -> user's own wallet)")
# The VA currency control is separate from the provider settings and is off
# by default. Enable USD so a request can actually be made.
call("PUT", "/api/admin/offramp/controls",
     {"virtualAccounts": [{"currency": "usd", "enabled": True}]}, None, admin=True)

st, r = call("GET", "/api/admin/virtual-account-provider-settings", None, admin=True)
s = r.get("data") or {}
t("settlement network is solana", s.get("defaultSettlementNetwork") == "solana",
  str(s.get("defaultSettlementNetwork")))

st, r = call("POST", f"/api/users/{U['alice']['id']}/virtual-accounts/request",
             {"currency": "usd", "useCase": "e2e"}, U["alice"]["token"])
if st == 403:
    print(f"      (403 body: {r})")
vareq = (r.get("data") or {}).get("id")
t("VA request created", st in (200, 201) and bool(vareq), f"HTTP {st}")

if vareq:
    st, r = call("POST", f"/api/admin/virtual-account-requests/{vareq}/approve",
                 {"reviewedBy": "ops@sivan.test", "reason": "e2e"}, None, admin=True)
    t("VA approved by admin", st == 200, f"HTTP {st}")

st, r = call("GET", "/api/admin/virtual-accounts", None, admin=True)
vas = [v for v in (r.get("data") or []) if v.get("userId") == U["alice"]["id"]]
t("VA provisioned for alice", len(vas) > 0, f"{len(vas)} account(s)")
if vas:
    va = vas[0]
    t("user sees masked BANK details", bool(va.get("accountNumberMasked")),
      f"acct={va.get('accountNumberMasked')}")
    leaked = [k for k in ("address", "bridgeWalletId", "destinationAddress") if va.get(k)]
    t("NO crypto address exposed on the VA record", not leaked, str(leaked))

# ---------- 7 ----------
print("\n[7] CROSS-USER ISOLATION")
st, r = call("GET", f"/api/users/{U['bob']['id']}/wallets", None, U["bob"]["token"])
bob_ids = [x["providerWalletId"] for x in (r.get("data") or [])]
t("bob's list excludes alice's wallet", W["alice"]["providerWalletId"] not in bob_ids)
st, _ = call("GET", f"/api/users/{U['alice']['id']}/wallets", None, U["bob"]["token"])
t("bob CANNOT read alice's wallets", st in (401, 403), f"HTTP {st}")
t("no wallet anywhere equals the Sivan pool", POOL not in bob_ids and POOL not in ids)

print("\n" + "=" * 64)
print(f"  PASS: {p}    FAIL: {f}")
print("=" * 64 + "\n")
raise SystemExit(1 if f else 0)

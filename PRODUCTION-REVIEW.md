# api.sivantech.online — production review

Read-only audit. **No account was created, no user record written, no state
mutated.** Every finding below came from GET/OPTIONS against the live gateway,
the live origin, or from reading the repositories.

Date: 2026-08-02

---

## 1. Launch blockers

### B1 — CRITICAL: `NGN_PROVIDER` is `paj` on production

```
[critical] ngn_provider: NGN_PROVIDER is "paj" on a deployed environment.
           Bank resolution will fail for users — set it to breet.
```

Breet is the default NGN provider and the only one with working credentials.
PajRamp's resolver needs an unprovisioned session token, so **every bank
account resolution on production will 500**. A Nigerian cannot complete
verification, which means they cannot do anything else.

Fix: set `NGN_PROVIDER=breet` on api-live.

### B2 — CRITICAL: delegated signing not configured

```
[critical] delegated_signing_configured: PRIVY_AUTHORIZATION_* is missing.
           The backend cannot sign withdrawals - every one will require the
           user to sign.
```

The production signer EXISTS and is PROVEN — quorum `sivan-production`
(`l7t1bfi2oudgbebdszhkkt65`), verified this session signing `personal_sign` →
HTTP 200. It is simply not installed on api-live.

Fix: set `PRIVY_AUTHORIZATION_KEY_QUORUM_ID` and
`PRIVY_AUTHORIZATION_PRIVATE_KEY` **together** from `.env.production-signer`.

### B3 — WARN, but product-fatal: NGN off-ramp disabled

```
[warn] ngn_offramp_enabled: NGN off-ramp is DISABLED.
```

Confirmed independently from `/api/offramp/controls`, which is public:

| env | enabled payout currencies |
|---|---|
| **LIVE** | `usd`, `gbp`, `eur` — **no `ngn`** |
| test | (none set) |

The Nigerian rail — the core product — is switched off on production.

---

## 2. What is genuinely healthy

- **api-live has been redeployed and is current.** `/api/users/x/FAKE` went
  5.79s → 0.26s, which is the `fda71cb` 28-table-read fix landing. The
  `ngn_provider` health signal is present, so `514652e` and later are on.
- **The production customer bundle is fully current.** `app.sivantech.online`
  serves every fix from today: the verification skeleton, the pending-bank
  card, "Sell crypto to naira", "Waiting for your crypto".
- **Admin endpoints are protected.** `/api/admin/ngn/payout-accounts/reviews`,
  `/api/admin/users`, `/api/admin/ngn/transfers` all 401 without a key.
- **CORS is correct for the real customer domain.** `app.sivantech.online` and
  `sivan-payments-user-live.vercel.app` are allowed; a random origin is
  refused.
- **System mode is `active`**, no open incidents.
- **Both GitHub repos are private** (404 unauthenticated).

### Corrected mid-audit

`/health` returned 503 on the first request and I nearly reported a gateway
fault. It was a **cold start** — three warm requests returned 200 in ~0.13s.

`/health/operational` returning 503 through the gateway is also NOT a bug: the
endpoint returns 503 by design when status is `critical`, and the Cloudflare
worker then masks the body as `UPSTREAM_UNAVAILABLE`. The signal is real; only
the detail is hidden. Worth knowing so nobody debugs the worker.

---

## 3. Non-blocking gaps

- **Render-hosted frontends are still CORS-blocked** at both gateways
  (`sivan-payments-user-live.onrender.com` gets no allow-origin). Patched in
  the three worker files locally; **needs a manual Cloudflare deploy.** Does
  not block launch because `app.sivantech.online` works.
- **`/api/offramp/controls` takes 3.7s** through the gateway. Not fatal, but
  it is on the first-paint path.

---

## 4. Credential rotation

Verified live against each provider rather than assumed.

### Rotate BEFORE launch

| # | Credential | Why | Verified |
|---|---|---|---|
| 1 | **Telegram prod bot `8775192643:AAGys0…`** (`@SivanAi_bot`) | **Committed to git in `telegram-layer/.env.example`** across at least 3 commits, and the token still answers `getMe`. Anyone with repo history can hijack the production bot. | live |
| 2 | **Privy app secret** `privy_app_secret_2Zz…` | Pasted into this chat session; `GET /v1/wallets` → 200. Controls 258 wallets. | live |
| 3 | **Neon `DATABASE_URL`** (`neondb_owner:npg_…`) | Pasted in chat; Neon is internet-reachable, so the password is the only control. | reachable |
| 4 | **GitHub PAT** `github_pat_11AGOC3TI0z…` (Samswitchy) | Pasted in chat; `/user` → 200. | live |
| 5 | **GitHub PAT** `github_pat_11AGOC3TI0y…` (Sivan-Technologies) | Pasted in chat; `/user` → 200. | live |
| 6 | **`ADMIN_API_KEY`** | Used from `.env` this session; grants the payout-review queue. | in use |
| 7 | **Breet `9Fdz…`** + **`BREET_WEBHOOK_SECRET`** | Pasted in chat; `/trades/assets` → 200. Note this is the **sandbox** key — the production key must be separate and must never be the one seen here. | live |
| 8 | **Telegram alert bot `8858372924:…`** (`@SivanEscrowBot`) + channel `-1004465897328` | Pasted in chat; answers `getMe`. Lower blast radius (alerts only). | live |

### Do NOT need rotation

- **Breet `c2qEe5…`** — already revoked, returns 401. It is still sitting in
  your local `.env`, which is why some manual commands failed today. Replace
  the value so it stops wasting time.
- `SiaNotify` committed a real `.env` once (`57bf6b8`) but it contained only
  placeholders (`your_g…`, `choose…`). Not a leak.
- `LAUNCH-RUNBOOK.md` and `test-wallet-health.ts` matched the secret scan but
  both hold placeholders (`privy_app_secret_definitely…`).

### Rotation order that avoids locking yourself out

1. **Privy LAST.** A wallet's signer is fixed at creation. Rotate the app
   secret only after confirming the production quorum is installed and
   working on api-live, or you will be unable to verify the fix.
2. Telegram prod bot first — it is the only credential that is both live and
   publicly committed.
3. Then DB, GitHub PATs, admin key, Breet.
4. After each, re-run `npm run watchdog` and `/health/operational` to confirm
   nothing went dark.

---

## 5. Recommended sequence

```
1. Set on api-live, together, then ONE deploy:
     NGN_PROVIDER=breet
     PRIVY_AUTHORIZATION_KEY_QUORUM_ID=<from .env.production-signer>
     PRIVY_AUTHORIZATION_PRIVATE_KEY=<from .env.production-signer>
2. Enable NGN as a payout currency in Admin Controls.
3. Confirm: /health/operational returns status "ok" (not 503).
4. Deploy the three Cloudflare workers (onrender.com CORS).
5. Rotate credentials in the order above.
6. Re-run the watchdog.
```

Until steps 1–3 are done, a Nigerian on `app.sivantech.online` cannot verify a
bank account and cannot withdraw naira.

# Launch runbook

Written 2026-08-02 for a launch the following night. Everything marked
**VERIFIED** was checked by running it, not by reading code.

---

## 0. The honest position

Readiness: **~78%**, up from 72% once monitoring landed.

What is genuinely proven end to end:

- Onboarding, both verification paths, 68 assertions over real HTTP
- The NGN off-ramp up to and including webhook settlement
- Limits, locks, cross-user isolation, the kill switch
- The production Privy signer — it signs (200), the old test key is refused (401)

What is **not** proven:

- **Breet actually converting USDC to naira and paying a bank.** Breet has no
  testnet; their `development` environment returns the same stub name for
  every account number. Only a mainnet transfer proves settlement.
- **A human completing the frontend flow.** Every frontend claim so far is
  typecheck, unit test and bundle inspection. That is not the same thing.

Those two are the launch risk. Everything else is managed.

---

## 1. Before launch — blocking

### 1.1 Cut over the Privy signer

Full detail in `PRIVY-PRODUCTION-SIGNER.md`. Short version:

```
PRIVY_AUTHORIZATION_KEY_QUORUM_ID=l7t1bfi2oudgbebdszhkkt65
PRIVY_AUTHORIZATION_PRIVATE_KEY=<.env.production-signer>
```

Set **both together**. Setting one without the other leaves the service
issuing wallets it cannot sign for. Signers are fixed at wallet creation and
can never be changed, so every wallet minted before this is permanently bound
to the test key.

Confirm after deploy: `GET /api/admin/wallets/health` →
`delegatedSigningReady: true`.

### 1.2 One mainnet Breet transfer (~$20)

The only thing that proves settlement. Needs:

- a `breet_sk_live_` key (the current key is `breet_sk_test_`)
- `BREET_ENV=production`
- USDC on Base mainnet in the ops wallet
- gas — the wallet holds **0 ETH on mainnet**, and Privy sponsorship is
  configured for Base **Sepolia** only

Send the documented minimum ($15) plus margin. Below the minimum Breet
*flags* the deposit: confirmed on chain, funds held, nothing credited, and a
$1 fee to recover.

Put the live key on **api-live only**. Both services currently read the same
`NGN_PROVIDER`/`BREET_ENV` shape, so a live key on api-test means test users
hit real settlement.

### 1.3 Deploy api-live for the CORS fix

`app.sivantech.online` was missing from the live allow-list. CORS fails in the
browser — the API logs nothing and the app silently does not work.

Verify: `npm run ops:readiness-check` → the CORS check goes green.

### 1.4 Rotate credentials

The Breet secret is in a chat transcript. Rotate it, the admin API key, and
the JWT secret. Leave the **test** Privy quorum alone — 33 wallets still
reference it and the e2e suite signs with it.

---

## 2. Monitoring — wire these before you sleep

### 2.1 The endpoint

```
GET /health/operational
```

Public, unauthenticated, rate-limit exempt. Returns **503** when any signal is
critical and **200** otherwise, so a dumb uptime monitor alerts without
parsing the body.

Signals, each tested by causing the condition (32 assertions):

| Signal | Fires when | Severity |
|---|---|---|
| `transfers_stuck_in_flight` | non-terminal transfer, no update in 2h | **critical** |
| `transfers_requiring_review` | flagged deposit, funds held by Breet | warn |
| `kyc_name_reviews_pending` | oldest review >24h / >48h | warn / **critical** |
| `provider_webhooks_24h` | transfers started but zero webhooks arrived | warn |
| `delegated_signing_configured` | Privy signing credentials missing | **critical** |
| `ngn_offramp_enabled` | off-ramp disabled | warn |
| `breet_environment` | `APP_ENV=production` but `BREET_ENV=development` | **critical** |

The first is the one that matters most: it is the exact shape of both webhook
bugs found this week, and `/health` returned 200 through both.

### 2.2 Uptime monitor

UptimeRobot / Better Stack, 1-minute interval, on **both**:

```
https://<api>/health              → process liveness
https://<api>/health/operational  → product health, 503 = page someone
```

Alert to a phone, not email. A payout stuck at 3am is still stuck at 9am.

### 2.3 Sentry

`SENTRY_DSN` is already wired (`src/monitoring/sentry.ts`) and is `sync: false`
in render.yaml — set it in the dashboard. Two rules:

- any error in `production` in 5 minutes → notify
- webhook 4xx/5xx spike → notify

Confirm with `npm run ops:monitoring-check`, which sends a real smoke event.

---

## 3. Launch night

**Soft-launch to 5–10 people you can phone.** The ₦100,000 Level 1 ceiling is
your blast radius: worst case per user is bounded, and the review queue is
small enough to work by hand.

Order:

1. Confirm `ops:readiness-check` is green except the manual dashboard items
2. Confirm `/health/operational` returns `"status":"ok"`
3. Enable the rails: `PUT /api/admin/ngn/controls` → `offrampEnabled: true`
4. Do the first withdrawal **yourself**, real money, and watch it settle
5. Then invite the others

Watch during: the admin **Name review** tab, `/health/operational`, Sentry.

---

## 4. If something breaks

### The kill switch

```
PUT /api/admin/system/status  { "mode": "paused", "message": "..." }
```

Stops new orders, payout-account creation, KYC links and withdrawals. Does
**not** stop quoting (deliberate — seeing a rate moves no money) and does not
stop webhooks (in-flight money must still settle).

**VERIFIED**: the NGN rails were missing from this list until today. Pausing
stopped Bridge and left naira payouts running. Fixed and mutation-tested.

### A transfer is stuck

1. `/health/operational` → `transfers_stuck_in_flight` gives the count
2. `GET /api/admin/ngn/webhooks` → did the provider deliver?
3. If no delivery: check the webhook URL and secret at Breet
4. If delivered but not applied: that is a bug — capture the payload

### A deposit was flagged

Below the asset minimum. Funds are held by Breet, not lost. Recovery costs the
flag fee (~$1). The transfer shows `requires_review` with the amount and
minimum in metadata.

### Naira did not arrive but the transfer says completed

Sivan believed Breet. Pull the Breet transaction by id and compare — the
webhook handler stores `settledFiatAmount` from Breet's own record for exactly
this comparison.

---

## 5. First week

- Retire one frontend. Two exist on the test tier (Render + Vercel) with
  independent build triggers; they have drifted twice and cost a debugging
  round each time.
- Finish the AWS move. Render free tier cold-starts; the gateway returned
  `UPSTREAM_UNAVAILABLE` twice today purely from that. **Carry the
  `sync: false` env vars manually — they do not migrate.** Make sure the AWS
  pipeline runs `npm run db:migrate` or migration 037 will not exist and
  payout-account writes will throw.
- Integrate a NIN/BVN provider. `identitySource: 'sivan'` is built and tested
  but currently unreachable, so no Nigerian can pass Level 2 without Bridge.
- Decide on the 167 signer-less Privy wallets. The backend cannot move funds
  from them; they need re-provisioning or retiring.

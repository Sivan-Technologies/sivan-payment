# `src/kyc` — KYC verification

Working folder for KYC verification. Empty by design right now: this file exists
so git tracks the structure, and so the next person starts from what is actually
true rather than from assumptions.

## Layout

Matches the house convention used by `src/onramp` and `src/offramp`:

```
src/kyc/
  api/       route handlers
  service/   business logic
  types/     shared types
```

## What already exists (do not rebuild it)

KYC is **not greenfield**. It is currently spread across 35 files. Before adding
anything here, read these:

| File | KYC mentions | Role |
|---|---:|---|
| `src/customers/customers.service.ts` | 66 | the de facto owner today |
| `src/admin/admin-hardening.service.ts` | 37 | admin gating / restricted actions |
| `src/providers/bridge/bridge.provider.ts` | 15 | real Bridge calls |
| `src/providers/bridge/mock-bridge.provider.ts` | 18 | sandbox double |
| `src/metrics/onboarding-costs.service.ts` | 17 | per-verification cost |
| `src/webhooks/webhooks.service.ts` | 10 | inbound status transitions |

Live endpoints:

```
POST /api/customers/kyc-link                          create a hosted KYC link
GET  /api/customers/:userId/kyc-status                read current status
POST /api/customers/:userId/sandbox/simulate-kyc-approval   sandbox only
```

`kyc` is already a first-class restricted action in `src/app.ts`
(`restrictedActionForRequest`), alongside `onramp` and `offramp`.

Status values in use:

```
not_started · pending · incomplete · under_review · awaiting_ubo
active · approved · rejected · paused · offboarded
```

Note there are two "good" terminal states in circulation, `active` and
`approved`. Anything written here should pick one and normalise, not add a
third.

## Why this folder

The logic works but has no single home, so a change to verification means
touching customers, admin, providers, webhooks and metrics together. This folder
is where that gets consolidated.

**Migrate, don't duplicate.** A second KYC implementation living beside the first
is worse than the current spread, because then neither is authoritative.

## Known problems to fix here

1. **Every KYC-approved record carries a `mock_cust_*` provider id.** They came
   from `mock-bridge.provider.ts`, so no end user has a real Bridge customer, and
   `Receive` 404s for all of them. No real user has ever completed KYC.

2. **Two vocabularies for success** (`active` vs `approved`) — see above.

3. **Sandbox approval simulation is a route.** `POST .../sandbox/simulate-kyc-approval`
   must be provably unreachable in production. Worth an explicit test, not just
   an env check, since it can mark a customer verified.

## Verified 2026-07-31

Against `8e4fad8`. Structure only — no logic has been written yet.

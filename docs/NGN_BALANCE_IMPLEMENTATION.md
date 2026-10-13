# NGN balance-funded service agreements

Status: **ledger, opt-in API runtime, service facades and durable workers implemented;
NOT enabled or production-ready. Runtime funding remains deliberately blocked.**
Scope: internal NGN only. No changes to smart contracts, crypto off-ramps,
on-chain activity, existing USDC/USDT funding, or live provider configuration.

## Implemented

- Migration `060_ngn_agreement_ledger.sql`: dedicated NGN accounts, agreements,
  idempotent operations, double-entry postings, cancellation consents and outbox.
- `src/ngn/balance-agreements/ledger.ts`: transactional funding, eligibility-gated
  acceptance, explicit work start, delivery, release, human-authorized dispute
  split, bilateral pre-start cancellation and 48-hour onboarding expiry.
- Principal and the 1% fee are reserved separately. Cancellation before work
  and unaccepted expiry return **both** in one transaction. Successful release
  and delivered-dispute settlement recognize the fee as earned revenue.
- Integer kobo strings only. The fee is rounded up to the next kobo; no binary
  floating point. The recorded fee/policy cannot change after creation.
- No more than three unaccepted, nonterminal agreements per canonical buyer.
  A per-buyer account lock serializes creations, including across channels.
- Operations are payload-bound and persisted. State, postings and outbox commit
  together. Insufficient funds rolls everything back. Agreement row locks
  serialize acceptance/expiry and settlement/refund races.
- Expiry is 48 hours from creation. Acceptance requires seller eligibility AND
  explicit seller consent before that deadline. DVA assignment alone is not
  acceptance. Worker entry point `expireDue()` rechecks eligibility under lock.
- A single cancellation consent moves no funds. Work start invalidates pending
  pre-work consent; cancellation after work starts is rejected.
- The API derives the actor from injected authentication, never a body userId.
  It cannot credit deposits or issue rulings through ordinary user routes.
- Matching clients and HTTP facades in escrow engine, WhatsApp and Telegram have no default
  URL/key, reject non-HTTPS remote destinations, do not follow redirects, and
  never automatically retry a write or claim success after an HTTP failure.

## Important existing-path safeguard

The legacy escrow `/api/escrows/:id/pay-from-balance` route now rejects NGN/NAIRA
with `503 NGN_LEDGER_FUNDING_REQUIRED`. Previously it could record funding without
a payment-ledger debit. This is an intentional safety stop, not a complete
replacement. USDC/USDT behavior is unchanged. Existing payment funding-sync calls
to that legacy endpoint must be replaced for NGN with committed-event processing
before rollout. Do not deploy this as a completed customer feature.

## Runtime wiring still required — do not bypass these gates

1. **Canonical identities and authorization**: runtime now validates user JWTs
   and consumes existing PIN step-up tokens bound to user/amount/agreement/action.
   Complete the secure confirmation UI/delegation flow with attempt limits and
   binding, canonical channel-to-user links and role checks. Never accept a bot
   API key plus a caller-selected userId. Credentials must not enter chat history,
   logs, event payloads, analytics or notification cards. The injected test policy
   is a fixture, NOT a production authorization implementation.
2. **Authoritative NGN balance adoption**: explicitly reconcile existing DVA
   transactions and opening balances before choosing this ledger as spendable
   truth. This migration deliberately imports nothing. Do not display these new
   zero balances as replacements for existing balances before cutover.
3. **DVA provider adapter**: verify raw webhook signatures and/or provider status,
   canonical customer/DVA ownership, reference, currency, gross amount and actual
   inflow-fee policy. Only then call `creditVerifiedDeposit`. Never credit solely
   from caller metadata. Backfills need an approved, audited reconciliation plan.
4. **Seller setup adapter**: derive eligibility from verified identity evidence
   and operational DVA status, not mutable profile names or a browser boolean.
   Seller consent must bind the NGN policy and terms. A DVA is not itself proof
   of complete identity verification or consent to an agreement.
5. **Durable integration workers**: implemented with explicit startup flags,
   persisted leases, retries, signed event transport, escrow inbox dedupe,
   sequence-checked projections and separate WhatsApp/Telegram notification jobs.
   Deploy migrations and configure endpoints/secrets before enabling. Alert on
   outstanding `last_error_code`/attempt counts; no monitoring dashboard is added.
   Delivery is at-least-once, not an exactly-once message guarantee. `delivered_at`
   means the next service acknowledged delivery, not that a human read it.
   Superseded notifications/non-agreement events use `skipped_at`, not a false
   delivered timestamp. A crash after
   sending but before acknowledgment can duplicate a notification, never a debit.
   Do not expose PINs in notifications.
   Current operation retries return their original response; clients should GET
   current status after retries instead of assuming that old response is current.
6. **Bank cashout**: separate internal-NGN payout service, not the existing Breet
   crypto-offramp module. Resolve and match bank ownership against verified KYC,
   quote/disclose provider fees, authorize the exact destination/amount, reserve
   funds atomically and use a stable provider reference. Query uncertain transfers
   before retrying. Do not refund on timeout/unknown status; only on authoritative
   failed/reversed outcome. Handle success/failure/reversal idempotently and
   reconcile merchant float. No cashout implementation is claimed here.
7. **Channel UX**: the HTTP facades now call the real payment endpoints rather
   than independently marking an agreement funded. Still connect native chat
   buttons to secure user confirmation and backend-driven
   cards, pending onboarding, current status, actionable errors and notifications.
   Existing chat buttons do not yet obtain the necessary user JWT and bound
   confirmation for the new NGN flow. No promised
   one-minute KYC, instant bank arrival, zero operational costs or zero risk.
8. **Production registration**: the runtime is registered from `api/routes.ts`
   only with `NGN_BALANCE_AGREEMENTS_ENABLED=true`, using a scoped Fastify plugin
   and PostgreSQL pool. No JSON/memory fallback. The production funding callback
   returns false unconditionally: verified-deposit integration, opening-balance
   reconciliation and velocity/AML accounting must be completed before changing
   that guard. Setting an environment flag alone cannot bypass it.

## Runtime configuration and rollout (no values changed automatically)

Payment service:

```dotenv
NGN_BALANCE_AGREEMENTS_ENABLED=false
NGN_BALANCE_WORKERS_ENABLED=false
# Full HTTPS endpoint on the escrow engine: /api/ngn/balance-agreements/events
NGN_AGREEMENT_EVENT_URL=
# Dedicated shared secret, at least 32 characters; never put it in a client.
NGN_AGREEMENT_EVENT_SECRET=
```

Escrow engine:

```dotenv
NGN_BALANCE_AGREEMENTS_ENABLED=false
# Configured payment API base, without /api/ngn/balance-agreements suffix.
NGN_PAYMENT_API_BASE_URL=
NGN_BALANCE_WORKERS_ENABLED=false
NGN_AGREEMENT_EVENT_SECRET=
# Full HTTPS /api/notify endpoints and the matching configured bot notify secrets.
NGN_WHATSAPP_NOTIFY_URL=
NGN_WHATSAPP_NOTIFY_SECRET=
NGN_TELEGRAM_NOTIFY_URL=
NGN_TELEGRAM_NOTIFY_SECRET=
```

WhatsApp and Telegram facades use `NGN_BALANCE_AGREEMENTS_ENABLED` and
`NGN_PAYMENT_API_BASE_URL`, with the same defaults. All four facades require a
user Bearer token; bot API keys are not accepted as a substitute.

Apply payment migrations 060 through 062 through the existing reviewed migration
workflow and `sivan-escrow-agent/scripts/sql/ngn-agreement-events.sql` to the
escrow PostgreSQL database. Startup checks schema but does not run migrations.
Workers start only on actual server listen, not on module import or test app
construction. Payment events are acknowledged only after the escrow projection
and notification jobs commit. Missing linked recipient contacts keep events
retryable until corrected; no fabricated invitation destination is used.

Creation confirmations bind `destinationRef` to
`ngn:agreement:<id>:create:<termsHash>`, where termsHash is SHA-256 of JSON with
ordered fields `{sellerId,title,principalKobo,policyVersion:'ngn-balance-v1'}`.
Other confirmations bind to `ngn:agreement:<id>:<action>`. Amount is the total
principal-plus-fee in decimal NGN (not kobo), currency `NGN`. Existing single-use
step-up credentials can be consumed on a failed action; read status and obtain
a fresh confirmation instead of blindly retrying. Never collect these through
plain chat or expose them to notification/monitoring payloads.

## API contract (new, not active in deployed applications)

Base: `/api/ngn/balance-agreements`. Available only when the runtime is opted in.

| Operation | Method/path | Body |
|---|---|---|
| List own agreements | GET base | none |
| Own available NGN | GET base/balance | none |
| Read participant agreement | GET base/:id | none |
| Create | POST base | id, sellerId, title, principalKobo, credential |
| Fund/accept/start/deliver/release/dispute/cancel | POST base/:id/:action | credential |

All mutation bodies are strict: buyerId, fee overrides, currency overrides,
provider success flags and extra fields are rejected. All amounts are strings
of integer kobo. HTTP 400 validation, 401 authentication, 403 wrong participant,
409 state/balance conflicts, 503 unexpected service failure. Provider and SQL
error details must not leak. `credential` is opaque pending the production
confirmation adapter; do not pass plaintext chat PINs.

## Verification

Run `npm run test:ngn-agreement-ledger` in `sivan-payment`.

Local evidence (2026-10-13): 16 ledger/API scenarios, 12 escrow guard/client/facade/
signature tests, and the workspace SQL worker integration suite. The matching client contract was exercised for all three
consumers. Application TypeScript checks passed in all four repositories.
The broader payment test-script typecheck remains red outside this change:
`test-paystack-routes-and-webhooks.ts:176` uses an unsupported CustomerStatus;
`test-transfer-pin-guard.ts:107,176` passes an unsupported audit `createdAt` field.
Those files were not modified by this implementation. No claim is made that the
entire repository test suite or CI passed.

The suite creates ephemeral embedded PostgreSQL (PGlite), applies only the new
migration, and exercises SQL transactions and Fastify request injection. Provider
verification and user authorization use explicit test fixtures; no vendor or
production calls occur. This is NOT a public-provider end-to-end test.

`npm run test:ngn-worker-integration` also requires the sibling escrow repository.
It exercises both PostgreSQL schemas, signed delivery, lost acknowledgements,
dedupe, channel retry, stale notification suppression, full expiry refunds and
crashed-worker lease recovery. Provider/channel endpoints are explicit fixtures;
no real notifications are sent. Escrow `ngnAgreementRoutes.test.ts` exercises a
localhost HTTP facade with a fixture upstream, not deployed channel buttons.

Required before rollout: real multi-connection PostgreSQL contention/deadlock
tests; process-crash/unknown-commit recovery; webhook retries/out-of-order events;
channel replay/impersonation; secure PIN UI; provider sandbox cashout and reversal;
merchant reconciliation; failed notification delivery; live-config separation.
Do not run migrations, backfills, provisioning or transfers against the live
payment API as part of automated validation.

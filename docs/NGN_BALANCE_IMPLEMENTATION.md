# NGN balance-funded service agreements

Status: **foundation implemented; NOT enabled or production-ready**.
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
- New matching clients in escrow engine, WhatsApp and Telegram have no default
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

1. **Canonical identities and authorization**: wire user JWT/delegation validation,
   existing PIN/step-up verification with attempt limits, action/amount/agreement
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
5. **Durable integration workers**: schedule expiry and publish outbox entries
   at least once, with consumer dedupe, retries, dead-letter monitoring and
   per-agreement ordering/current-state reads. Outbox currently has durable
   records but no production dispatcher. Do not expose PINs in notifications.
   Current operation retries return their original response; clients should GET
   current status after retries instead of assuming that old response is current.
6. **Bank cashout**: separate internal-NGN payout service, not the existing Breet
   crypto-offramp module. Resolve and match bank ownership against verified KYC,
   quote/disclose provider fees, authorize the exact destination/amount, reserve
   funds atomically and use a stable provider reference. Query uncertain transfers
   before retrying. Do not refund on timeout/unknown status; only on authoritative
   failed/reversed outcome. Handle success/failure/reversal idempotently and
   reconcile merchant float. No cashout implementation is claimed here.
7. **Channel UX**: connect the clients to secure confirmation and backend-driven
   cards, pending onboarding, current status, actionable errors and notifications.
   These clients are not yet called by existing chat buttons. No promised
   one-minute KYC, instant bank arrival, zero operational costs or zero risk.
8. **Production registration**: `routes.ts` is intentionally not registered in
   `app.ts`. Use a scoped Fastify plugin with real policies and a configured
   PostgreSQL pool only after the preceding gates pass. No JSON/memory fallback.

## API contract (new, not active in deployed applications)

Base: `/api/ngn/balance-agreements`.

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

Local evidence (2026-10-13): 15 ledger/API scenarios passed, 7 escrow guard/client
tests passed, and the matching client contract was exercised for all three
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

Required before rollout: real multi-connection PostgreSQL contention/deadlock
tests; process-crash/unknown-commit recovery; webhook retries/out-of-order events;
channel replay/impersonation; secure PIN UI; provider sandbox cashout and reversal;
merchant reconciliation; failed notification delivery; live-config separation.
Do not run migrations, backfills, provisioning or transfers against the live
payment API as part of automated validation.

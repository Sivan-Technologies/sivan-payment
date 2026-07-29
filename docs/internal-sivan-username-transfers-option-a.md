# Sivan Username Transfers — Option A Internal Ledger Transfer

> ## ⚠️ Addendum — 2026-07-29: reassess before building
>
> Two findings materially change this plan. Read this section before Section 1.
>
> ### 1. Bridge already provides wallet-to-wallet transfers
>
> [Bridge Custodial Wallets](https://apidocs.bridge.xyz/platform/wallets/overview)
> lists as a key feature:
>
> > *"Wallet-to-wallet transfers — instantly move funds between Bridge-hosted wallets."*
>
> That is the core primitive this entire document sets out to build. Adopting it
> would move the atomicity, double-spend and reconciliation burden onto Bridge.
>
> | | Option A (this doc) | Bridge wallet-to-wallet |
> |---|---|---|
> | Build effort | Ledger + atomicity + reconciliation from scratch | API call |
> | Double-spend risk | Ours to solve | Bridge's |
> | Source of truth | Our DB | Bridge |
> | Custody position | We hold beneficial ownership | Bridge is custodian |
> | Cost | Free | TBC — ask Bridge |
> | Lock-in | Low | Higher |
>
> **Action:** confirm with Bridge whether user-to-user transfers between two of
> our KYC-approved customers are permitted, and at what price, before
> committing to Option A. See `BRIDGE-COMPLIANCE-EMAIL.md`, question 3.
>
> ### 2. Precision must be 2 decimal places, not 18
>
> Bridge Custodial Wallets *"only process and express amounts in whole U.S.
> cents"* (2 dp). Any ledger we build to mirror Bridge balances must use
> `numeric(20,2)` or integer cents. An 18-decimal ledger will accumulate
> permanent drift against Bridge and produce phantom reconciliation breaks.
>
> ### 3. Prerequisite that has not moved
>
> Section 11 (Ledger Accounting) and Section 13 (Atomicity) assume a durable
> balance ledger. As of this addendum, balances are still derived by replaying
> `auditLogs[]` metadata, with a reproducible double-spend via concurrent
> `requestBalanceTransfer` calls, and are destroyed by audit-log rotation.
>
> **Option A must not ship on the current ledger.** See `LEDGER-VERDICT.md`.

## Status

```txt
Document type: Future production implementation plan
Implementation status: Not implemented yet
Target product area: Transfer & Pay
Recommended first version: UNDER REVIEW — Option A internal ledger vs Bridge wallet-to-wallet
External blockchain movement: No immediate blockchain movement (Option A)
Provider execution: Not required for Option A; required if Bridge wallet-to-wallet is adopted
Blocking prerequisite: durable balance ledger with atomic writes (not yet built)
Open question: Bridge Legal & Compliance approval for user-to-user wallet transfers
Last reviewed: 2026-07-29
```

This document defines how Sivan should implement **Sivan-to-Sivan username transfers** in a production-grade way using the existing settled-USDC balance ledger.

The goal is to let one verified Sivan user send settled USDC value to another verified Sivan user by username, email, phone, or Sivan ID, without creating an on-chain transaction at the moment of transfer.

---

## 1. Executive Summary

Sivan username transfers should be implemented first as an **internal ledger transfer**.

Example:

```txt
User A sends 25 USDC to User B
```

Sivan records internally:

```txt
User A available balance decreases by 25 USDC
User B available balance increases by 25 USDC
```

But on-chain:

```txt
No blockchain transaction happens immediately
No external wallet balance changes immediately
No tx hash is created immediately
```

This is the cleanest first version because the value is moving **inside Sivan’s books**, not out to an external blockchain wallet.

The total Sivan liability remains unchanged.

Before:

```txt
Sivan treasury/provider wallet holds: 1,000 USDC

User A internal balance: 100 USDC
User B internal balance: 20 USDC

Total customer liability: 120 USDC
```

After User A sends 25 USDC to User B:

```txt
Sivan treasury/provider wallet holds: 1,000 USDC

User A internal balance: 75 USDC
User B internal balance: 45 USDC

Total customer liability: 120 USDC
```

The transfer only changes **beneficial ownership inside Sivan’s internal ledger**.

---

## 2. Product Definition

### Product name

```txt
Sivan Username Transfer
```

Customer-facing placement:

```txt
Transfer & Pay → Send to Sivan user
```

### Customer promise

```txt
Instantly send settled USDC balance to another verified Sivan user.
The recipient can use the received Sivan balance inside Sivan or withdraw/send externally later.
```

### Customer-safe wording

Use wording like:

```txt
Send Sivan balance
Internal Sivan transfer
No blockchain transaction is created until funds leave Sivan
Recipient can withdraw or use the balance after it is received
```

Avoid wording like:

```txt
On-chain transfer completed
Sent to blockchain wallet
Tx hash generated
Wallet-to-wallet blockchain payment
```

unless a later provider/on-chain settlement mode is used.

---

## 3. What Option A Is

Option A is an internal balance movement.

```txt
Sender settled USDC balance ↓
Receiver settled USDC balance ↑
Sivan total liability unchanged
No blockchain movement
No provider movement
No gas fee
No tx hash
```

It is similar to an internal book transfer.

The system must maintain a precise ledger trail showing:

```txt
who sent
who received
amount
asset
status
time
risk decision
audit evidence
admin intervention if any
```

---

## 4. What Option A Is Not

Option A is not:

```txt
A blockchain transfer
A Bridge wallet-to-wallet transfer
A bank transfer
A fiat movement
A provider settlement
A treasury movement
```

It does not move funds from one external wallet to another.

It only changes the internal Sivan ledger allocation of already-settled stablecoin balance.

---

## 5. Why Option A Should Be Built First

### Benefits

```txt
Instant customer experience
No network/gas fees
No provider fee dependency
No Bridge wallet required for every user
No blockchain failure state
No tx hash wait time
Works with current Sivan balance ledger
Easier to reverse before external settlement if policy allows
Easier to audit internally
```

### Risks

```txt
Sivan must maintain accurate liability accounting
Ledger must be immutable/auditable
Fraud/risk controls are required
Admin restrictions must be enforced
User messaging must be clear that this is internal balance, not on-chain USDC
```

### Recommendation

```txt
Build Option A first.
Add provider/on-chain settlement later only if there is a strong product or compliance need.
```

---

## 6. High-Level Flow

```txt
User A opens Transfer & Pay
  ↓
Selects Send to Sivan user
  ↓
Enters recipient username/email/phone/Sivan ID
  ↓
Backend resolves recipient
  ↓
Backend checks sender KYC, receiver KYC, restrictions, limits, risk
  ↓
Backend verifies sender has available settled USDC
  ↓
If low risk:
    debit sender ledger
    credit receiver ledger
    mark transfer completed
  ↓
If review required:
    hold sender funds
    mark transfer pending_review
    admin reviews
    approve → debit sender and credit receiver
    reject → release hold
```

---

## 7. Customer UX Flow

### Entry point

```txt
Transfer & Pay → Send to Sivan user
```

### Form fields

```txt
Recipient username, email, phone, or Sivan ID
Amount USDC
Note / memo optional
Review screen
Confirm
```

### Recipient lookup UX

The frontend should not reveal too much private information.

When the sender enters a username/email:

Safe response:

```txt
Recipient found: Michael S. · @michael
```

Do not expose:

```txt
full email unless entered exactly by sender
phone number
KYC provider/customer ID
balance
transaction history
```

### Confirmation copy

```txt
You are sending settled Sivan USDC balance.
No blockchain transaction will be created now.
The recipient can use the balance in Sivan or withdraw/send externally later.
```

### Success copy

Low-risk instant transfer:

```txt
Transfer completed.
25 USDC was sent to @michael inside Sivan.
No blockchain transaction was created.
```

Pending review transfer:

```txt
Transfer held for review.
Your 25 USDC is held while Sivan reviews the transfer.
If rejected, the hold will be released back to your available balance.
```

---

## 8. Data Model — Future Tables

### `payments_internal_transfers`

Recommended table:

```sql
payments_internal_transfers
```

Fields:

```txt
id
sender_user_id
receiver_user_id
recipient_handle
asset
amount
note
status
risk_level
risk_score
review_reason
sender_ledger_entry_id
receiver_ledger_entry_id
hold_ledger_entry_id
release_ledger_entry_id
admin_decision
admin_decision_by
admin_decision_at
completed_at
created_at
updated_at
metadata
```

Recommended status enum:

```txt
created
pending_review
completed
rejected
failed
cancelled
```

Recommended risk level enum:

```txt
low
medium
high
critical
```

Recommended asset enum for v1:

```txt
usdc
```

Future asset support:

```txt
usdt
ngn_balance_if_enabled_later
```

But v1 should start with:

```txt
USDC only
```

### Amount precision — corrected 2026-07-29

Bridge Custodial Wallets express all amounts in **whole U.S. cents (2 decimal
places)**. If Sivan balances are ever reconciled against Bridge wallet
balances, the ledger must match that precision:

```sql
amount numeric(20,2) NOT NULL CHECK (amount > 0)
```

Do **not** use `numeric(38,18)`. Storing 18 decimals against a 2-decimal
provider guarantees rounding drift and permanent phantom reconciliation
breaks. Storing integer cents (`bigint`) is also acceptable and avoids
floating-point issues entirely.

Chain/asset availability is also not uniform — **USDT is not available on
Base**. See `CHAIN_ASSET_SUPPORT` in
`src/controls/payment-controls.service.ts`, which enforces Bridge's supported
matrix at the API boundary.

---

## 9. Username / Handle Model

### Preferred long-term approach

Add username support to Sivan users.

Potential table/field:

```txt
users.username
```

or dedicated table:

```txt
user_handles
```

Recommended username rules:

```txt
3–30 characters
lowercase only
letters, numbers, underscore
must be unique
cannot start with underscore
cannot end with underscore
cannot contain consecutive underscores
reserved words blocked
change history audited
```

Examples:

```txt
@michael
@airspexta
@sivan_vendor_01
```

Reserved handles:

```txt
admin
support
sivan
sivantech
bridge
system
root
owner
null
undefined
api
help
escrow
payment
payments
wallet
bank
official
security
compliance
```

### V1 shortcut

If username is not ready, v1 can allow:

```txt
email
Sivan user ID
verified phone/WhatsApp number
```

But the product should still be designed around:

```txt
Sivan username
```

---

## 10. API Design — Future Endpoints

### Recipient lookup

```http
GET /api/users/:userId/internal-transfer/recipient?handle=@michael
```

Response:

```json
{
  "data": {
    "found": true,
    "recipientUserId": "usr_xxx",
    "displayName": "Michael S.",
    "handle": "@michael",
    "verified": true,
    "canReceive": true
  }
}
```

If not found:

```json
{
  "data": {
    "found": false,
    "canReceive": false
  }
}
```

Do not return sensitive internals.

---

### Create internal transfer

```http
POST /api/users/:userId/internal-transfers
```

Request:

```json
{
  "recipientHandle": "@michael",
  "amount": "25.00",
  "asset": "usdc",
  "note": "Dinner split"
}
```

Response, instant completion:

```json
{
  "data": {
    "id": "itx_xxx",
    "senderUserId": "usr_sender",
    "receiverUserId": "usr_receiver",
    "amount": "25.00",
    "asset": "usdc",
    "status": "completed",
    "riskLevel": "low",
    "reviewReason": "Low-risk transfer completed instantly.",
    "createdAt": "...",
    "completedAt": "..."
  }
}
```

Response, review required:

```json
{
  "data": {
    "id": "itx_xxx",
    "status": "pending_review",
    "riskLevel": "medium",
    "reviewReason": "New user/high-value internal transfer requires review."
  }
}
```

---

### List user internal transfers

```http
GET /api/users/:userId/internal-transfers
```

Returns both sent and received transfers.

Each record should include:

```txt
id
counterparty display name
counterparty handle
direction: sent | received
amount
asset
status
note
createdAt
completedAt
```

---

### Admin list

```http
GET /api/admin/internal-transfers
```

Query filters:

```txt
status
riskLevel
senderUserId
receiverUserId
dateFrom
dateTo
limit
offset
```

---

### Admin review

```http
POST /api/admin/internal-transfers/:id/review
```

Request:

```json
{
  "decision": "approve",
  "reviewedBy": "compliance@sivantech.online",
  "reason": "Verified source and recipient relationship."
}
```

Decision values:

```txt
approve
reject
escalate
```

---

## 11. Ledger Accounting

### Low-risk instant transfer

When the transfer is low-risk, complete it atomically.

Sender ledger entry:

```txt
kind: internal_transfer_debit
asset: usdc
amount: 25
status: completed
sourceType: internal_transfer
sourceId: itx_xxx
```

Receiver ledger entry:

```txt
kind: internal_transfer_credit
asset: usdc
amount: 25
status: available
sourceType: internal_transfer
sourceId: itx_xxx
```

The sender’s available balance decreases.

The receiver’s available balance increases.

No provider transfer ID is created.

No blockchain tx hash exists.

---

### Review-required transfer

Step 1 — Create hold on sender:

```txt
kind: hold
asset: usdc
amount: 25
status: held
sourceType: internal_transfer
sourceId: itx_xxx
```

Sender available balance decreases.

Sender held balance increases.

Transfer status:

```txt
pending_review
```

Step 2A — Admin approves:

Sender ledger:

```txt
kind: debit_transfer
asset: usdc
amount: 25
status: completed
sourceType: internal_transfer
sourceId: itx_xxx
```

Receiver ledger:

```txt
kind: credit_available
asset: usdc
amount: 25
status: available
sourceType: internal_transfer
sourceId: itx_xxx
```

Transfer status:

```txt
completed
```

Step 2B — Admin rejects:

Sender ledger:

```txt
kind: hold_release
asset: usdc
amount: 25
status: available
sourceType: internal_transfer
sourceId: itx_xxx
```

Transfer status:

```txt
rejected
```

Receiver receives nothing.

---

## 12. Required Ledger Engine Upgrade

Current balance ledger kinds should be extended to support internal transfer-specific entries.

Recommended new ledger kinds:

```txt
internal_transfer_debit
internal_transfer_credit
```

Alternative: use existing generic entries:

```txt
debit_transfer
credit_available
hold
hold_release
```

Recommended production approach:

```txt
Use explicit internal_transfer_debit and internal_transfer_credit for audit clarity.
```

Reason:

```txt
Admin, support, reconciliation, and finance can distinguish internal transfers from external wallet sends or supplier payments.
```

---

## 13. Atomicity Requirement

Internal transfers must be atomic.

For instant transfers, the following must succeed or fail together:

```txt
Create internal transfer record
Create sender debit ledger entry
Create receiver credit ledger entry
Create audit log
Update transfer status to completed
```

If any part fails, the transfer should not partially apply.

For Postgres, use a transaction:

```sql
BEGIN;
-- lock sender balance inputs / write transfer record / write ledger entries
COMMIT;
```

Important:

```txt
Never debit sender without crediting receiver.
Never credit receiver without debiting sender.
Never mark completed without ledger entries.
```

---

## 14. Idempotency

The create transfer endpoint should support idempotency.

Recommended header:

```http
Idempotency-Key: uuid
```

or body field:

```json
{
  "clientRequestId": "uuid"
}
```

Purpose:

```txt
Avoid duplicate transfers if user taps twice or network retries.
```

Uniqueness rule:

```txt
sender_user_id + client_request_id must be unique
```

If same idempotency key is replayed, return the same transfer.

---

## 15. Risk Controls

Admin-controlled settings should live in DB/audit-backed controls, not `.env`.

Recommended table:

```txt
payments_internal_transfer_controls
```

Fields:

```txt
id = global
enabled
minimum_amount
manual_review_threshold
new_user_review_window_days
new_user_review_threshold
daily_limit
monthly_limit
receiver_kyc_required
sender_kyc_required
allow_username_lookup
allow_email_lookup
allow_phone_lookup
block_self_transfer
require_note_above_threshold
velocity_review_enabled
updated_by
reason
updated_at
```

Recommended beta defaults:

```txt
enabled: true
minimum_amount: 1 USDC
manual_review_threshold: 500 USDC
new_user_review_window_days: 7
new_user_review_threshold: 50 USDC
daily_limit: 2,500 USDC
monthly_limit: 10,000 USDC
receiver_kyc_required: true
sender_kyc_required: true
allow_username_lookup: true
allow_email_lookup: true
allow_phone_lookup: false initially
block_self_transfer: true
require_note_above_threshold: true
velocity_review_enabled: true
```

---

## 16. Risk Engine

Risk engine should evaluate:

```txt
Sender KYC status
Receiver KYC status
Sender account age
Receiver account age
Sender restrictions/freeze state
Receiver restrictions/freeze state
Amount
Daily velocity
Monthly velocity
Number of unique recipients
First transfer to this recipient
Recipient newly created
Same device/IP signals if available
Repeated failed/rejected attempts
Support/risk flags
Sanctions/AML placeholder or vendor result
Admin controls
```

Risk decisions:

```txt
auto_complete
manual_review
block
```

Risk levels:

```txt
low
medium
high
critical
```

Example low-risk:

```txt
Sender KYC approved
Receiver KYC approved
Amount below threshold
Sender older than 7 days
No velocity flags
No restrictions
```

Example manual review:

```txt
First transfer to a new recipient
Amount above threshold
Sender is a new user
Velocity spike
Receiver recently created
```

Example block:

```txt
Sender KYC rejected
Receiver KYC rejected
Sender restricted
Receiver restricted from receiving
Self-transfer
Insufficient available balance
Sanctions/AML hard hit
```

---

## 17. Compliance Requirements

Even though no blockchain transaction happens immediately, this is still value movement.

Production requirements:

```txt
Sender must be verified
Receiver should be verified before receiving spendable balance
Every transfer must be audit logged
High-risk transfers require admin review
Restricted/frozen users cannot send
Restricted/frozen users cannot receive if restriction says so
Support must be able to trace transfer by ID
Finance must be able to reconcile liabilities
Terms must explain internal Sivan balance clearly
```

User terms should state:

```txt
Sivan balance represents an internal claim to supported stablecoin value.
Internal transfers move that claim between Sivan users.
No blockchain transaction occurs until funds are withdrawn/sent externally.
```

---

## 18. Admin Hub Requirements

Admin Hub should have an Internal Transfers module or section under Risk / Transfer & Pay.

Admin views:

```txt
Internal transfer queue
Open review cases
Completed internal transfers
Rejected transfers
Velocity dashboard
User transfer graph
```

Each transfer detail should show:

```txt
Transfer ID
Sender
Receiver
Recipient handle entered
Amount
Asset
Status
Risk score
Risk reason
Ledger entries
Audit logs
User restrictions
Prior relationship between users
Velocity metrics
Support tickets
Admin notes
```

Admin actions:

```txt
Approve
Reject and release hold
Escalate
Restrict sender
Restrict receiver
Add compliance note
Export evidence
```

Dangerous actions must use action locking:

```txt
Disable button while request in flight
Show success/failure state
Prevent duplicate approval/rejection
Write audit log
```

---

## 19. User Notifications

Sender notification:

```txt
Transfer completed
Transfer held for review
Transfer rejected and funds released
```

Receiver notification:

```txt
You received 25 USDC from @sender
Funds are available in your Sivan balance
```

Channels:

```txt
in-app
email
WhatsApp later if linked
```

Do not notify receiver before review approval if the transfer is pending.

---

## 20. Support and Disputes

Support should be able to search by:

```txt
Transfer ID
Sender email/username
Receiver email/username
Amount
Date
```

Support ticket related item should include:

```txt
internal_transfer:itx_xxx
```

Dispute policy must define:

```txt
When transfers are final
Whether mistaken transfers can be reversed
What happens if recipient account is restricted after receiving
What evidence is required for support action
```

Recommended beta policy:

```txt
Completed internal transfers are final unless Sivan determines fraud, operational error, or legal/compliance obligation.
Pending transfers can be rejected before completion.
```

---

## 21. Reconciliation and Liability Accounting

Finance must reconcile:

```txt
Total settled provider/treasury USDC
minus total user available balances
minus total user pending balances if applicable
minus total user held balances
minus spent/outbound pending amounts
```

For internal transfers:

```txt
Total customer liability must not change.
Only ownership allocation changes.
```

Daily reconciliation check:

```txt
Sum of all internal_transfer_debit entries
must equal
Sum of all internal_transfer_credit entries
```

For pending review transfers:

```txt
Sum of holds for internal transfers
must match pending_review internal transfer amount
```

Exception reports:

```txt
Debit without credit
Credit without debit
Completed transfer without ledger entries
Pending transfer older than SLA
Rejected transfer without hold release
Receiver credited while not KYC approved
```

---

## 22. Security Requirements

### API security

```txt
JWT required
Sender path userId must match JWT subject
Rate limit transfer creation
Rate limit recipient lookup
Prevent recipient enumeration
Idempotency required for create transfer
```

### Recipient lookup abuse prevention

Lookup endpoint should:

```txt
rate limit aggressively
return minimal profile
not reveal if email exists too precisely when privacy risk exists
require exact email for email lookup
prefer username lookup
```

### Fraud prevention

```txt
block self-transfer
block restricted sender
block restricted receiver
block negative/zero amount
block amount above available balance
block unsupported asset
block receiver if KYC required and not approved
```

---

## 23. Privacy Requirements

Sender should see only minimal receiver identity:

```txt
display name
username
verification badge
```

Sender should not see:

```txt
receiver balance
receiver full legal identity
receiver KYC details
receiver provider customer ID
receiver phone/email unless entered exactly
```

Receiver should see:

```txt
sender display name
sender username
amount
note if provided
```

Receiver should not see:

```txt
sender full compliance record
sender balance
sender provider details
```

---

## 24. Failure Handling

### Insufficient balance

Return:

```txt
Insufficient settled USDC balance.
```

No ledger entries should be written.

### Recipient not found

Return safe error:

```txt
Recipient not found or cannot receive transfers.
```

### Receiver not verified

If receiver KYC is required:

```txt
Recipient cannot receive transfers yet.
```

Do not expose exact KYC status.

### Transfer pending too long

Admin queue should flag:

```txt
pending_review older than SLA
```

Recommended SLA:

```txt
24 hours beta
4 hours mature ops
```

### Partial ledger failure

Must not happen if atomic transaction is implemented.

If detected by reconciliation:

```txt
critical incident
freeze affected transfer
manual finance/compliance review
repair ledger through controlled admin adjustment
```

---

## 25. Database Transaction Design

### Instant transfer transaction

Pseudo-flow:

```txt
BEGIN
  lock sender balance calculation inputs or use serializable transaction
  verify sender available >= amount
  create payments_internal_transfers row status=completed
  create sender ledger debit
  create receiver ledger credit
  create audit log
COMMIT
```

### Review transfer creation

```txt
BEGIN
  verify sender available >= amount
  create payments_internal_transfers row status=pending_review
  create sender hold ledger entry
  create audit log
COMMIT
```

### Review approval

```txt
BEGIN
  verify transfer status=pending_review
  create sender debit_transfer ledger entry
  create receiver credit_available ledger entry
  update transfer status=completed
  create audit log
COMMIT
```

### Review rejection

```txt
BEGIN
  verify transfer status=pending_review
  create sender hold_release ledger entry
  update transfer status=rejected
  create audit log
COMMIT
```

---

## 26. Future Option B — Provider / On-Chain Settlement

Option B can be added later if required.

Option B means:

```txt
Provider wallet-to-wallet movement
or blockchain movement
or Bridge wallet-to-wallet movement
```

Potential flow:

```txt
User A internal balance held
Provider transfer created
Provider confirms movement
Sender debited
Receiver credited
Provider transfer ID stored
Webhook confirms status
```

Option B requires:

```txt
Bridge wallet ID per user or provider wallet per user
Provider pricing confirmation
Provider transfer API support
Webhook mapping
Failure/retry handling
More operational complexity
```

Option B should not replace Option A immediately.

Recommended future product control:

```txt
Settlement mode:
  internal_ledger_only
  provider_wallet_settlement
  onchain_settlement
```

Default:

```txt
internal_ledger_only
```

---

## 27. Frontend Implementation Plan

Transfer & Pay already has a route placeholder:

```txt
Send to Sivan user
```

Future implementation should replace the placeholder with:

```txt
Recipient input
Recipient preview card
Amount input
Note input
Review panel
Confirm button
Transfer result panel
History list
```

### Screen states

```txt
Not verified
No balance
Recipient lookup idle
Recipient found
Recipient not found
Review required
Transfer completed
Transfer rejected
```

### History entry

Sent:

```txt
Sent 25 USDC to @michael
Completed inside Sivan
```

Received:

```txt
Received 25 USDC from @airspexta
Available now
```

Pending:

```txt
Transfer held for review
```

---

## 28. Backend Implementation Plan

Recommended files:

```txt
src/internal-transfers/internal-transfer.service.ts
src/internal-transfers/internal-transfer.routes.ts
src/internal-transfers/internal-transfer-risk.service.ts
src/internal-transfers/internal-transfer-controls.service.ts
```

Register routes in:

```txt
src/api/routes.ts
```

Protect paths in:

```txt
src/app.ts
```

Add migrations:

```txt
database/migrations/027_create_internal_transfers.sql
database/migrations/028_create_internal_transfer_controls.sql
```

Add tests:

```txt
scripts/test-internal-transfers.ts
npm run test:internal-transfers
```

Test cases:

```txt
sender cannot send without KYC
receiver cannot receive without KYC if control enabled
sender cannot send more than available
self-transfer blocked
low-risk transfer completes instantly
sender balance decreases
receiver balance increases
high-risk transfer creates hold
admin approval debits sender and credits receiver
admin rejection releases hold
idempotency prevents duplicates
risk cases appear in Admin Hub
```

---

## 29. Admin Hub Implementation Plan

Add controls under:

```txt
Admin Hub → Sivan Payment → Controls → Internal Sivan transfers
```

Controls:

```txt
Internal transfers enabled
Minimum amount
Manual review threshold
Daily limit
Monthly limit
New user window
New user threshold
Sender KYC required
Receiver KYC required
Username lookup enabled
Email lookup enabled
Phone lookup enabled
```

Add queue under:

```txt
Risk queue
```

For internal transfer risk cases, show:

```txt
sender
receiver
amount
risk reason
ledger impact
admin actions
```

---

## 30. Production Readiness Checklist

Before enabling in production:

```txt
[ ] Username/recipient resolution implemented safely
[ ] Internal transfer table migration deployed
[ ] Controls table migration deployed
[ ] Atomic ledger transaction implemented
[ ] Idempotency implemented
[ ] Risk engine implemented
[ ] Admin controls implemented
[ ] Admin review queue implemented
[ ] Support/search implemented
[ ] Ledger reconciliation checks implemented
[ ] Legal terms updated
[ ] Customer copy reviewed
[ ] Rate limits configured
[ ] E2E tests passing
[ ] Live small-value test completed
[ ] Monitoring/alerts configured
```

---

## 31. Recommended Rollout Plan

### Phase 0 — Documentation and design

```txt
This document
Architecture review
Legal/compliance review
```

### Phase 1 — Backend foundation

```txt
Internal transfer records
Controls
Risk engine
Ledger writes
Admin APIs
Tests
```

### Phase 2 — Customer frontend

```txt
Send to Sivan user form
Recipient lookup
Review/confirm
History
```

### Phase 3 — Admin Hub

```txt
Controls
Risk queue
Review actions
Audit/evidence view
```

### Phase 4 — Controlled beta

```txt
Enable for internal staff only
Small limits
Manual review threshold low
Monitor reconciliation daily
```

### Phase 5 — Public beta

```txt
Enable for verified users
Increase limits slowly
Add support playbooks
```

### Phase 6 — Future provider settlement

```txt
Evaluate Bridge wallet-to-wallet or on-chain settlement
Add optional settlement mode if needed
```

---

## 32. Readiness Rating

If implemented according to this design:

```txt
Backend ledger safety: 90%+
Customer UX clarity: 85%+
Compliance readiness: 80–85%
Production beta readiness: 85–90%
Full production readiness: 75–85% until legal/reconciliation/support are fully exercised live
```

Current state before implementation:

```txt
Documented: yes
Implemented: no
Transfer & Pay placeholder: yes
Recommended next step: backend foundation + migrations + tests
```

---

## 33. Final Product Rule

The core rule for Option A is:

```txt
Sivan username transfer changes internal ownership of settled USDC balance.
It does not create an on-chain transaction.
It does not move provider wallet funds immediately.
It must be ledger-atomic, auditable, risk-controlled, and clearly explained to users.
```

This is the recommended production-grade first version for Sivan-to-Sivan transfers.

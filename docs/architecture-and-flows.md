# Sivan Payments Architecture & Flow Documentation

## 1. Product Overview

Sivan Payments is the payments layer for Sivan. The active MVP is an off-ramp engine that lets verified users withdraw stablecoins into their own verified bank accounts.

Current active flow:

```text
USDC
  ↓
Sivan Payments
  ↓
Bridge liquidation address
  ↓
Bridge conversion / payout rail
  ↓
User verified bank account
  ↓
USD / GBP / EUR
```

The repository is structured for a broader payments future, but only the off-ramp module is active today.

Future modules can include:

```text
on-ramp
supplier payouts
B2B payouts
multi-provider routing
wallet-based flows
Sivan username transfers / internal ledger transfers
additional currencies and rails
```

See also:

```text
docs/internal-sivan-username-transfers-option-a.md
```

This document defines the future production design for Option A internal Sivan-to-Sivan settled-USDC transfers, where no blockchain transaction occurs until funds leave Sivan externally.

---

## 2. High-Level System Architecture

```text
                  ┌──────────────────────────────┐
                  │      User Frontend           │
                  │  app.sivantech.online        │
                  └──────────────┬───────────────┘
                                 │
                                 │ HTTPS / JWT
                                 │
                  ┌──────────────▼───────────────┐
                  │      Sivan Payments API      │
                  │      Render backend          │
                  └──────────────┬───────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       │                         │                         │
       ▼                         ▼                         ▼
┌──────────────┐          ┌──────────────┐          ┌──────────────┐
│ Neon DB      │          │ Bridge API   │          │ Resend       │
│ users +      │          │ off-ramp     │          │ email OTP    │
│ payments_*   │          │ provider     │          │              │
└──────────────┘          └──────┬───────┘          └──────────────┘
                                 │
                                 │ Bridge webhooks
                                 │
                  ┌──────────────▼───────────────┐
                  │ /api/webhooks/bridge         │
                  │ signature verification       │
                  └──────────────────────────────┘
```

Admin operations are separate:

```text
                  ┌──────────────────────────────┐
                  │      Admin Frontend          │
                  │  admin.sivantech.online / sivan-admin-hub    │
                  └──────────────┬───────────────┘
                                 │
                                 │ x-admin-api-key
                                 │
                  ┌──────────────▼───────────────┐
                  │      Admin API               │
                  │ /api/admin/*                 │
                  └──────────────────────────────┘
```

---

## 3. Repository Structure

```text
sivan-payments/
├── src/
│   ├── admin/
│   ├── api/
│   ├── audit/
│   ├── auth/
│   ├── config/
│   ├── controls/
│   ├── customers/
│   ├── database/
│   ├── metrics/
│   ├── monitoring/
│   ├── notifications/
│   ├── offramp/
│   ├── onramp/
│   ├── providers/
│   ├── reconciliation/
│   ├── shared/
│   ├── users/
│   └── webhooks/
│
├── frontend/
├── sivan-admin-hub/app/dashboard/modules/sivan-payment/
├── database/migrations/
├── docs/
├── scripts/
├── render.yaml
└── RENDER_DEPLOYMENT.md
```

---

## 4. Backend Module Responsibilities

### `src/offramp/`

The active MVP module.

Responsible for:

```text
external bank accounts
liquidation addresses
withdrawals
fees
withdrawal history
EUR/GBP/USD payout rails
```

Structure:

```text
src/offramp/
├── api/
│   ├── external-accounts.routes.ts
│   ├── fees.routes.ts
│   ├── liquidation-addresses.routes.ts
│   └── withdrawals.routes.ts
├── service/
│   ├── external-accounts.service.ts
│   ├── fees.service.ts
│   ├── liquidation-addresses.service.ts
│   ├── withdrawal-mapping.ts
│   └── withdrawals.service.ts
├── bridge/
└── types/
```

### `src/onramp/`

Reserved for future fiat-to-stablecoin flows.

Current status:

```text
placeholder only
no active logic
```

### `src/providers/`

Provider abstraction layer.

Current implemented provider:

```text
Bridge
```

Core files:

```text
src/providers/offramp-provider.interface.ts
src/providers/provider-routing.ts
src/providers/provider-registry.ts
src/providers/bridge/
```

The off-ramp service talks to:

```ts
OfframpProvider
```

not directly to Bridge.

This allows future providers to be added without rewriting the product logic.

### `src/auth/`

Handles user authentication.

Current auth model:

```text
passwordless email OTP
JWT user sessions
protected user APIs
```

Key endpoints:

```http
POST /api/auth/email/start
POST /api/auth/email/verify
GET  /api/auth/me
```

### `src/admin/`

Admin API surface for the internal operations dashboard.

Admin endpoints are protected by:

```http
x-admin-api-key
```

Current admin capabilities:

```text
overview
analytics
users
withdrawals
webhooks
audit logs
reconciliation runs
rail controls
```

### `src/controls/`

Controls which payout currencies/rails are enabled.

Current controllable rails:

```text
USD
GBP
EUR
```

If a rail is disabled:

```text
it is hidden from the user frontend
external account creation is blocked
withdrawal creation is blocked
```

### `src/webhooks/`

Receives Bridge webhooks.

Endpoint:

```http
POST /api/webhooks/bridge
```

Responsibilities:

```text
verify Bridge signature
store event idempotently
process liquidation address drain events
update withdrawal statuses
process customer / KYC / external account events
```

### `src/reconciliation/`

Compares internal withdrawal records with provider records.

Current reconciliation target:

```text
Bridge liquidation address drains
```

Supports:

```text
dry-run reconciliation
live reconciliation update
persisted reconciliation runs
persisted findings
```

### `src/audit/`

Records important system actions.

Examples:

```text
auth.otp_sent
auth.signup_verified
withdrawal.created
payment_controls.updated
reconciliation.dry_run
reconciliation.live_run
```

### `src/notifications/`

Email delivery layer.

Current provider:

```text
Resend
```

Fallback/test provider:

```text
console
```

### `src/monitoring/`

Sentry-compatible error monitoring.

Captures:

```text
unhandled rejections
uncaught exceptions
server startup errors
unexpected 5xx request errors
frontend runtime errors
```

---

## 5. Data Architecture

Sivan Payments uses the central Sivan identity table.

```text
users
```

Payments does not create a second users table.

The agreed data model:

```text
users
  ↑
  ├── escrows
  ├── payout_accounts
  ├── transactions
  └── payments_customers
        ├── payments_external_accounts
        ├── payments_liquidation_addresses
        ├── payments_withdrawals
        ├── payments_webhook_events
        ├── payments_reconciliation_runs
        ├── payments_reconciliation_findings
        ├── payments_onboarding_costs
        ├── payments_auth_challenges
        ├── payments_audit_logs
        └── payments_control_settings
```

---

## 6. Hybrid Identity Model

Sivan supports both WhatsApp-first and web/email-first users.

Current central `users` identity model supports:

```text
user_id
whatsapp_number
email
first_name
last_name
primary_channel
email_verified_at
whatsapp_verified_at
role_history
created_at
updated_at
```

Rules:

```text
WhatsApp users can exist without email.
Web users should have email.
A user must have at least one identity channel.
Payments references only user_id.
```

Identity channel examples:

```text
primary_channel = whatsapp
primary_channel = email
primary_channel = both
```

---

## 7. User Authentication Flow

### New web user signup

```text
User enters email + full name
  ↓
POST /api/auth/email/start
  ↓
OTP is created and emailed via Resend
  ↓
User enters OTP
  ↓
POST /api/auth/email/verify
  ↓
User is created if needed
  ↓
JWT is issued
  ↓
Frontend stores JWT
  ↓
User continues onboarding
```

### Returning user sign-in

```text
User enters email
  ↓
POST /api/auth/email/start
  ↓
OTP is emailed
  ↓
POST /api/auth/email/verify
  ↓
JWT is issued
  ↓
User dashboard loads
```

### Future WhatsApp sign-in

Planned flow:

```text
User enters WhatsApp number
  ↓
OTP sent through WhatsApp provider
  ↓
User verifies code
  ↓
Existing users.user_id is loaded
  ↓
JWT is issued
```

---

## 8. User Off-Ramp Flow

```text
1. Create account / sign in
2. Complete KYC
3. Add verified bank account
4. Create withdrawal
5. Receive USDC deposit address
6. Send USDC
7. Bridge processes drain
8. Webhook updates withdrawal
9. User sees withdrawal status
```

Detailed flow:

```text
User frontend
  ↓
POST /api/auth/email/start
  ↓
POST /api/auth/email/verify
  ↓
JWT issued
  ↓
POST /api/customers/kyc-link
  ↓
Bridge KYC link / customer
  ↓
POST /api/external-accounts
  ↓
Bridge external account
  ↓
POST /api/withdrawals
  ↓
Bridge liquidation address
  ↓
User sends USDC
  ↓
Bridge webhook: liquidation_address.drain
  ↓
Sivan updates withdrawal status
```

---

## 9. Bridge Webhook Flow

Bridge sends events to:

```text
/api/webhooks/bridge
```

Subscribed event categories:

```text
customer
kyc_link
external_account
liquidation_address.drain
```

Webhook verification:

```text
Bridge signs webhook
  ↓
Sivan reads X-Webhook-Signature
  ↓
Sivan verifies signature using BRIDGE_WEBHOOK_PUBLIC_KEY
  ↓
Sivan rejects invalid signatures
  ↓
Sivan stores event idempotently
  ↓
Sivan processes event
```

Drain state mapping:

```text
funds_received      → deposit_received
payment_submitted   → payout_processing
payment_processed   → completed
in_review           → requires_action
undeliverable       → failed
returned            → failed
error               → failed
canceled            → cancelled
```

---

## 10. Provider Routing Architecture

The system is designed to avoid hardcoding Bridge everywhere.

```text
Off-ramp service
  ↓
Provider routing layer
  ↓
OfframpProvider interface
  ↓
Selected provider implementation
  ↓
Bridge today, more providers later
```

Routing can consider:

```text
currency
country
rail
fee / priority
speed
reliability
compliance model
availability
```

Current provider catalog:

```text
Bridge
```

Future providers can be added under:

```text
src/providers/<provider-name>/
```

---

## 11. Admin Architecture

Admin frontend (moved to sivan-admin-hub):

```text
admin.sivantech.online / sivan-admin-hub
```

Admin backend:

```text
/api/admin/*
```

Current admin protection:

```text
x-admin-api-key
```

Future planned admin auth:

```text
telegram-admin-auth
admin JWT
role_history
RBAC
2FA or equivalent
```

Admin modules:

```text
Command
Analytics
Users
Withdrawals
Reconciliation
Providers
Controls
Webhooks
Audit
Economics
Settings
```

---

## 12. Admin Controls Flow

Admin can toggle payout rails:

```text
USD
GBP
EUR
```

Flow:

```text
Admin opens Controls tab
  ↓
GET /api/admin/offramp/controls
  ↓
Admin toggles a currency
  ↓
PUT /api/admin/offramp/controls
  ↓
payments_control_settings updated
  ↓
payment_controls.updated audit log created
  ↓
User frontend refreshes controls
  ↓
Disabled currency disappears
  ↓
Backend blocks new records for disabled currency
```

Safety rule:

```text
At least one payout currency must remain enabled.
```

---

## 13. Reconciliation Flow

Purpose:

```text
Detect missed webhooks, provider mismatches, stale statuses, and orphaned drains.
```

Flow:

```text
Admin runs reconciliation dry-run
  ↓
Sivan reads local liquidation addresses
  ↓
Sivan fetches Bridge drain history
  ↓
Sivan compares Bridge records with payments_withdrawals
  ↓
Findings are generated
  ↓
Run and findings are persisted
  ↓
Audit log is written
```

Modes:

```text
dryRun = true   → report only
dryRun = false  → apply safe updates
```

Persisted tables:

```text
payments_reconciliation_runs
payments_reconciliation_findings
```

---

## 14. Audit Logging Flow

Audit logs are written for important operations.

Examples:

```text
auth.otp_sent
auth.signup_verified
withdrawal.created
payment_controls.updated
reconciliation.dry_run
reconciliation.live_run
```

Audit log table:

```text
payments_audit_logs
```

Admin view:

```text
Admin → Audit
```

---

## 15. Analytics & Profitability Flow

Admin analytics tracks:

```text
active users
returning users
new users
churning users
dormant users
average lifetime volume per user
KYC cost recovery per user
withdrawal volume per user
repeat withdrawal rate
average withdrawal size
failed withdrawal rate
provider cost
net margin
customer acquisition cost
```

Data sources:

```text
users
payments_customers
payments_external_accounts
payments_withdrawals
payments_webhook_events
payments_audit_logs
```

Admin Analytics refresh policy:

```text
only on Analytics tab
every 60 seconds
on browser focus
manual refresh available
```

---

## 16. Rate Limiting Architecture

Rate limiting is enabled by default.

Policies:

```text
Default API routes:       120 requests/minute
Admin API routes:         300 requests/minute
Bridge webhook route:     300 requests/minute
OTP start:                5 requests / 15 minutes per IP+email
OTP verify:               20 requests / 15 minutes per IP+email
```

Headers returned:

```text
X-RateLimit-Limit
X-RateLimit-Remaining
X-RateLimit-Reset
Retry-After
```

Current implementation:

```text
in-memory
```

Future production scale improvement:

```text
Upstash Redis / Redis-backed distributed limiter
```

---

## 17. Frontend Polling Policy

To avoid exhausting backend limits:

```text
User frontend:
  - loads controls on startup
  - refreshes controls every 60 seconds only while visible
  - refreshes on focus / visibility change
  - rechecks controls before bank account creation
  - rechecks controls before withdrawal creation

Admin frontend (moved to sivan-admin-hub):
  - auto-polls only on Analytics tab
  - interval is 60 seconds
  - refreshes on focus
  - other tabs refresh manually or after explicit actions
```

---

## 18. Error Monitoring

Monitoring provider:

```text
Sentry-compatible SDK
```

Backend captures:

```text
unhandled rejections
uncaught exceptions
server listen failures
unexpected 5xx errors
```

Frontend captures:

```text
React runtime/render errors
ErrorBoundary failures
```

Relevant env vars:

```text
SENTRY_DSN
SENTRY_ENVIRONMENT
SENTRY_TRACES_SAMPLE_RATE
VITE_SENTRY_DSN
VITE_SENTRY_ENVIRONMENT
VITE_SENTRY_TRACES_SAMPLE_RATE
```

---

## 19. Email Delivery Architecture

Provider:

```text
Resend
```

Current official sender:

```text
Sivan <no-reply@sivantech.online>
```

Passwordless OTP email flow:

```text
User requests OTP
  ↓
Auth challenge created
  ↓
Email template generated
  ↓
Resend sends email
  ↓
Audit log written
  ↓
User submits OTP
  ↓
JWT issued
```

---

## 20. Deployment Architecture

### TEST lane

```text
User frontend:   Vercel
Admin frontend (moved to sivan-admin-hub):  Admin Hub (separate repo)
API backend:     Render
Database:        Neon TEST
Bridge:          Sandbox
```

### LIVE lane

```text
User frontend:   app.sivantech.online
Admin frontend (moved to sivan-admin-hub):  admin.sivantech.online / sivan-admin-hub
API backend:     sivan-payments-api-live.onrender.com
Database:        Neon LIVE
Bridge:          Production
```

Deployment runbook:

```text
RENDER_DEPLOYMENT.md
```

---

## 21. Current Production Readiness Summary

Current strengths:

```text
modular architecture
central identity model
payments_* database namespace
passwordless auth
JWT protected user APIs
admin dashboard
rail controls
audit logs
reconciliation persistence
Bridge integration
Resend integration
Sentry integration
rate limiting
TEST/LIVE lanes
```

Remaining major improvements:

```text
Telegram admin JWT/RBAC
Redis-backed distributed rate limiting
paid always-on backend for live
real Bridge production transaction test
real Bridge webhook delivery test
scheduled reconciliation
more detailed operational alerts
WhatsApp sign-in for existing escrow users
```


## 22. Asset and Network Controls

Admin can control three groups independently:

```text
Payout currencies: USD, GBP, EUR
Deposit assets: USDC, USDT
Deposit networks: Base, Polygon, Ethereum, Solana, Arbitrum, Avalanche C-Chain
```

This lets Sivan gradually enable phases:

```text
Phase 1: USDC on Base, Polygon, Ethereum
Phase 2: Solana, Arbitrum, Avalanche C-Chain
Phase 3: USDT if Bridge/provider support is confirmed
```

If a network is down or under maintenance, admin can toggle it off immediately.

Frontend behavior:

```text
User app hides disabled assets and networks.
User app refreshes controls on focus and every 60 seconds while visible.
User app rechecks controls before creating bank accounts and withdrawals.
```

Backend behavior:

```text
Disabled payout currency blocks external account creation and withdrawal creation.
Disabled source asset blocks withdrawal creation.
Disabled source network blocks withdrawal creation.
```

User warning:

```text
Only send the selected asset on the selected network. Sending another token or using another network may cause loss or delays.
```


### Avalanche C-Chain note

Avalanche C-Chain is represented internally and for Bridge as:

```text
avalanche_c_chain
```

The user-facing label is:

```text
Avalanche C-Chain
```

Optimism has been removed from the supported network list and replaced with Avalanche C-Chain.

## 23. Customer Type Controls

Admin can control which onboarding types are available:

```text
Individual
Business
```

Default configuration:

```text
Individual = enabled
Business = disabled
```

Reason:

```text
The current MVP is focused on individual first-party bank withdrawals.
Business/KYB can be enabled later when Sivan is ready to support business compliance flows.
```

Frontend behavior:

```text
Business appears in the account type selector but is disabled when the admin control is off.
```

Backend behavior:

```text
POST /api/customers/kyc-link is blocked for disabled customer types.
POST /api/customers is also blocked for disabled customer types.
```

Safety rule:

```text
At least one customer type must remain enabled.
```


## Admin frontend moved to Admin Hub

The standalone `frontend-admin/` app has been removed from `sivan-payment`.
The official admin UI is now the `sivan-admin-hub` repo, with the Sivan Payment module mounted at:

```text
/dashboard/modules/sivan-payment
```

Do not remove backend admin APIs from this repo. Admin Hub depends on:

```text
/api/admin/*
```

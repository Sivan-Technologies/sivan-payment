# Render Deployment Guide — Sivan Payments Dual Lanes

Sivan Payments uses two isolated lanes:

```text
[ TEST LANE ]                                      [ LIVE LANE ]

sivan-payments-user-test                          sivan-payments-user-live
sivan-payments-admin-test                         sivan-payments-admin-live
        ↓                                                 ↓
sivan-payments-api-test                           sivan-payments-api-live
        ↓                                                 ↓
Neon Database: Sivan Test                         Neon Database: Sivan Live
Bridge Sandbox                                    Bridge Production
```

The Neon database previously configured first is the **TEST** database. The second Neon URL is the **LIVE** database.

## What has been applied

The same migrations have been applied to both Neon databases:

```text
database/migrations/001_create_payments_tables.sql
database/migrations/002_evolve_users_hybrid_identity.sql
```

Both lanes now have:

```text
payments_customers
payments_external_accounts
payments_liquidation_addresses
payments_withdrawals
payments_webhook_events
payments_reconciliation_runs
payments_reconciliation_findings
payments_onboarding_costs
```

The central `users` table now supports hybrid identity:

```text
whatsapp_number optional
email optional
primary_channel = whatsapp | email | both
email_verified_at
whatsapp_verified_at
```

with the constraint that at least one of `email` or `whatsapp_number` must exist.

## Render services

The `render.yaml` blueprint creates six services:

```text
sivan-payments-api-test
sivan-payments-api-live
sivan-payments-user-test
sivan-payments-user-live
sivan-payments-admin-test
sivan-payments-admin-live
```

## Required environment variables

### API TEST

```env
APP_ENV=staging
DATABASE_PROVIDER=postgres
DATABASE_URL=<TEST_NEON_DATABASE_URL>
ADMIN_API_KEY=<strong random admin key>
BRIDGE_MOCK_MODE=false
BRIDGE_BASE_URL=https://api.sandbox.bridge.xyz/v0
BRIDGE_API_KEY=<BRIDGE_SANDBOX_KEY>
BRIDGE_WEBHOOK_PUBLIC_KEY=<BRIDGE_SANDBOX_WEBHOOK_PUBLIC_KEY>
SIVAN_OFFRAMP_FEE_PERCENT=1.25
BRIDGE_OFFRAMP_COST_PERCENT=0.5
BRIDGE_KYC_COST_USD=2
BRIDGE_KYB_COST_USD=10
```

### API LIVE

```env
APP_ENV=production
DATABASE_PROVIDER=postgres
DATABASE_URL=<LIVE_NEON_DATABASE_URL>
ADMIN_API_KEY=<separate strong random production admin key>
BRIDGE_MOCK_MODE=false
BRIDGE_BASE_URL=https://api.bridge.xyz/v0
BRIDGE_API_KEY=<BRIDGE_LIVE_KEY>
BRIDGE_WEBHOOK_PUBLIC_KEY=<BRIDGE_LIVE_WEBHOOK_PUBLIC_KEY>
SIVAN_OFFRAMP_FEE_PERCENT=1.25
BRIDGE_OFFRAMP_COST_PERCENT=0.5
BRIDGE_KYC_COST_USD=2
BRIDGE_KYB_COST_USD=10
```

## Frontend API base URL

Both frontends now read:

```env
VITE_API_BASE_URL
```

Render blueprint sets:

```text
User TEST  → https://sivan-payments-api-test.onrender.com
Admin TEST → https://sivan-payments-api-test.onrender.com
User LIVE  → https://sivan-payments-api-live.onrender.com
Admin LIVE → https://sivan-payments-api-live.onrender.com
```

## Admin API key

Admin endpoints under `/api/admin/*` are protected when `ADMIN_API_KEY` is set.

The admin frontend does **not** bake this key into the static bundle. Enter the key in the admin UI sidebar. It is stored locally in the admin user's browser and sent as:

```http
x-admin-api-key: <key>
```

## Bridge webhooks

Create separate Bridge webhook endpoints per lane.

### TEST

```text
https://sivan-payments-api-test.onrender.com/api/webhooks/bridge
```

Use Bridge sandbox and subscribe to:

```text
customer
kyc_link
external_account
liquidation_address.drain
```

### LIVE

```text
https://sivan-payments-api-live.onrender.com/api/webhooks/bridge
```

Use Bridge production and subscribe to the same categories.

## Deployment order

1. Deploy `sivan-payments-api-test`.
2. Confirm `/health`.
3. Confirm migrations run.
4. Configure Bridge sandbox webhook.
5. Deploy `sivan-payments-user-test` and `sivan-payments-admin-test`.
6. Test complete sandbox flow.
7. Deploy live lane only after test lane works.

## Health checks

```text
https://sivan-payments-api-test.onrender.com/health
https://sivan-payments-api-live.onrender.com/health
```

## Production caution

Do not expose live admin without:

- strong `ADMIN_API_KEY`
- 2FA or proper auth provider as next step
- RBAC
- audit logs
- restricted team access

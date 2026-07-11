# Render + Vercel Deployment Guide — Sivan Payments Dual Lanes

Sivan Payments uses two isolated lanes:

```text
[ TEST LANE ]                                      [ LIVE LANE ]

Vercel: sivan-payments-user-test                  Vercel: sivan-payments-user-live
Vercel: sivan-payments-admin-test                 Vercel: sivan-payments-admin-live
        ↓                                                 ↓
Render Free Web Service: sivan-payments-api-test                   Render Free Web Service: sivan-payments-api-live
        ↓                                                 ↓
Neon Database: Sivan Test                         Neon Database: Sivan Live
Bridge Sandbox                                    Bridge Production
```

The backend API is deployed on **Render**.

The user frontend and admin frontend are deployed on **Vercel**.

## Backend Render Blueprint

The root `render.yaml` now deploys only backend API services:

```text
sivan-payments-api-test
sivan-payments-api-live
```

Frontend services are intentionally not in `render.yaml` because they are deployed separately on Vercel.

## Database migrations

The same migrations have been applied to both Neon databases:

```text
database/migrations/001_create_payments_tables.sql
database/migrations/002_evolve_users_hybrid_identity.sql
```

Both lanes have:

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

The central `users` table supports hybrid identity:

```text
whatsapp_number optional
email optional
primary_channel = whatsapp | email | both
email_verified_at
whatsapp_verified_at
```

## Render API TEST env vars

```env
APP_ENV=staging
DATABASE_PROVIDER=postgres
DATABASE_URL=<TEST_NEON_DATABASE_URL>
CORS_ORIGIN=<VERCEL_USER_TEST_URL>,<VERCEL_ADMIN_TEST_URL>
ADMIN_API_KEY=<strong random test admin key>
USER_JWT_SECRET=<strong random user JWT secret>
USER_JWT_EXPIRES_MINUTES=60
AUTH_OTP_EXPIRES_MINUTES=10
AUTH_DEV_SHOW_OTP=true
AUTH_REQUIRE_USER=true
BRIDGE_MOCK_MODE=false
BRIDGE_BASE_URL=https://api.sandbox.bridge.xyz/v0
BRIDGE_API_KEY=<BRIDGE_SANDBOX_KEY>
BRIDGE_WEBHOOK_PUBLIC_KEY=<BRIDGE_SANDBOX_WEBHOOK_PUBLIC_KEY>
DEFAULT_OFFRAMP_PROVIDER=bridge
SIVAN_OFFRAMP_FEE_PERCENT=1.25
BRIDGE_OFFRAMP_COST_PERCENT=0.5
BRIDGE_KYC_COST_USD=2
BRIDGE_KYB_COST_USD=10
WEBHOOK_MAX_AGE_MS=600000
```

## Render API LIVE env vars

```env
APP_ENV=production
DATABASE_PROVIDER=postgres
DATABASE_URL=<LIVE_NEON_DATABASE_URL>
CORS_ORIGIN=<VERCEL_USER_LIVE_URL>,<VERCEL_ADMIN_LIVE_URL>
ADMIN_API_KEY=<separate strong random live admin key>
USER_JWT_SECRET=<separate strong random live user JWT secret>
USER_JWT_EXPIRES_MINUTES=60
AUTH_OTP_EXPIRES_MINUTES=10
AUTH_DEV_SHOW_OTP=false
AUTH_REQUIRE_USER=true
BRIDGE_MOCK_MODE=false
BRIDGE_BASE_URL=https://api.bridge.xyz/v0
BRIDGE_API_KEY=<BRIDGE_LIVE_KEY>
BRIDGE_WEBHOOK_PUBLIC_KEY=<BRIDGE_LIVE_WEBHOOK_PUBLIC_KEY>
DEFAULT_OFFRAMP_PROVIDER=bridge
SIVAN_OFFRAMP_FEE_PERCENT=1.25
BRIDGE_OFFRAMP_COST_PERCENT=0.5
BRIDGE_KYC_COST_USD=2
BRIDGE_KYB_COST_USD=10
WEBHOOK_MAX_AGE_MS=600000
```

## Vercel user frontend

Create a Vercel project from the same repo.

```text
Root Directory: frontend
Framework: Vite
Build Command: npm run build
Output Directory: dist
```

TEST env:

```env
VITE_API_BASE_URL=https://sivan-payments-api-test.onrender.com
```

LIVE env:

```env
VITE_API_BASE_URL=https://sivan-payments-api-live.onrender.com
```

## Vercel admin frontend

Create another Vercel project from the same repo.

```text
Root Directory: frontend-admin
Framework: Vite
Build Command: npm run build
Output Directory: dist
```

TEST env:

```env
VITE_API_BASE_URL=https://sivan-payments-api-test.onrender.com
```

LIVE env:

```env
VITE_API_BASE_URL=https://sivan-payments-api-live.onrender.com
```

The admin frontend does not bake `ADMIN_API_KEY` into the static build. Enter the admin key in the admin UI sidebar. It is stored locally and sent as:

```http
x-admin-api-key: <key>
```

## Bridge webhooks

Create separate Bridge webhook endpoints per lane.

TEST:

```text
https://sivan-payments-api-test.onrender.com/api/webhooks/bridge
```

LIVE:

```text
https://sivan-payments-api-live.onrender.com/api/webhooks/bridge
```

Subscribe to:

```text
customer
kyc_link
external_account
liquidation_address.drain
```

## Health checks

```text
https://sivan-payments-api-test.onrender.com/health
https://sivan-payments-api-live.onrender.com/health
```

## Deployment order

1. Deploy `sivan-payments-api-test` on Render.
2. Confirm `/health`.
3. Confirm migrations run during the Render build step.
4. Deploy `frontend` and `frontend-admin` to Vercel test projects.
5. Update Render `CORS_ORIGIN` with both Vercel test URLs.
6. Configure Bridge sandbox webhook.
7. Test full TEST lane.
8. Deploy live lane only after TEST works.


## Render free plan note

The Blueprint uses:

```yaml
plan: free
```

for the API services so Render should not require a paid instance type. Render free services do not support `preDeployCommand`, so database migrations are run inside the backend `buildCommand` instead.

For production money movement, upgrade the LIVE API service to a paid Render plan before serving real users. Free services can sleep, cold-start, and are not ideal for payment webhooks.

If Render still asks for payment, deploy only the TEST API first by temporarily removing or commenting out the LIVE service from `render.yaml`, then add LIVE later when ready.


## Frontend environment separation

The two Vercel frontends have separate env files and separate Vercel project settings.

User frontend env files:

```text
frontend/.env.example
frontend/.env.test.example
frontend/.env.live.example
```

Admin frontend env files:

```text
frontend-admin/.env.example
frontend-admin/.env.test.example
frontend-admin/.env.live.example
```

In Vercel, configure each project separately:

### User TEST

```env
VITE_APP_ENV=test
VITE_API_BASE_URL=https://sivan-payments-api-test.onrender.com
```

### User LIVE

```env
VITE_APP_ENV=live
VITE_API_BASE_URL=https://sivan-payments-api-live.onrender.com
```

### Admin TEST

```env
VITE_APP_ENV=test
VITE_API_BASE_URL=https://sivan-payments-api-test.onrender.com
```

### Admin LIVE

```env
VITE_APP_ENV=live
VITE_API_BASE_URL=https://sivan-payments-api-live.onrender.com
```

Never expose `ADMIN_API_KEY` as a `VITE_` variable. `VITE_` variables are public in the browser bundle.


## User authentication

The user frontend now uses passwordless email login.

Backend env vars:

```env
USER_JWT_SECRET=<strong random secret, different per lane>
USER_JWT_EXPIRES_MINUTES=60
AUTH_OTP_EXPIRES_MINUTES=10
AUTH_DEV_SHOW_OTP=true   # test only; set false in live
AUTH_REQUIRE_USER=true
```

In TEST, `AUTH_DEV_SHOW_OTP=true` returns the OTP in the API response so the flow can be tested before email delivery is connected.

In LIVE, set:

```env
AUTH_DEV_SHOW_OTP=false
```

and connect a real email provider before onboarding real users.

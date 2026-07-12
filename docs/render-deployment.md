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

## Email provider for passwordless login

The user frontend uses passwordless email OTP login.

For local/test without real email delivery:

```env
EMAIL_PROVIDER=console
AUTH_DEV_SHOW_OTP=true
```

For production email delivery with Resend:

```env
EMAIL_PROVIDER=resend
RESEND_API_KEY=<resend_api_key>
EMAIL_FROM="Sivan <no-reply@your-domain.com>"
AUTH_DEV_SHOW_OTP=false
```

Important:

- `AUTH_DEV_SHOW_OTP=true` returns the OTP in API responses and should only be used in test/staging.
- `AUTH_DEV_SHOW_OTP=false` must be used in live.
- Verify your sending domain in Resend before using a production `EMAIL_FROM` address.


## Error monitoring

Sivan Payments supports Sentry-compatible error monitoring for the backend and both frontends.

### Backend Render env

```env
SENTRY_DSN=<backend_sentry_dsn>
SENTRY_ENVIRONMENT=staging   # or production
SENTRY_TRACES_SAMPLE_RATE=0  # increase later if you want tracing
```

Backend captures:

- unhandled rejections
- uncaught exceptions
- server listen failures
- unexpected 5xx request errors

### Vercel user/admin frontend env

```env
VITE_SENTRY_DSN=<frontend_sentry_dsn>
VITE_SENTRY_ENVIRONMENT=test  # or live
VITE_SENTRY_TRACES_SAMPLE_RATE=0
```

Frontend captures React render/runtime errors through a Sentry ErrorBoundary.

Recommended Sentry projects:

```text
sivan-payments-api-test
sivan-payments-api-live
sivan-payments-user-test
sivan-payments-user-live
sivan-payments-admin-test
sivan-payments-admin-live
```

You can also use fewer projects and separate by environment if preferred.

## Official Resend sender

The verified production sender is:

```env
EMAIL_FROM="Sivan <no-reply@sivantech.online>"
```

The backend email provider uses the official Resend SDK.

## Admin payment rail controls

The admin dashboard has a **Controls** tab for enabling/disabling payout currencies:

```text
USD
GBP
EUR
```

These controls are persisted in:

```text
payments_control_settings
```

Disabled currencies are:

- hidden from the user frontend,
- blocked when creating new external accounts,
- blocked when creating new withdrawals.

## Admin profitability analytics

The admin Analytics tab tracks unit economics in near real time. To avoid exhausting backend/API limits, automatic polling only runs while the Analytics tab is open, every 60 seconds, and when the browser window regains focus. Other admin tabs refresh on initial load, tab navigation, manual Refresh, and after explicit admin actions.

Metrics include:

```text
Average lifetime volume per user
Average lifetime volume per transacting user
KYC cost recovery per KYC user
Withdrawal volume per user
Withdrawal volume per transacting user
Repeat withdrawal rate
Average withdrawal size
Failed withdrawal rate
Provider cost
Bridge variable cost
Onboarding cost
Sivan fee revenue
Net margin before CAC
Customer acquisition cost
Net margin after CAC
```

`CUSTOMER_ACQUISITION_COST_USD` controls the assumed CAC per signed-up user. Default is `0` until Sivan has reliable acquisition cost data.


## Rate limiting

The backend has in-memory rate limiting enabled by default:

```env
RATE_LIMIT_ENABLED=true
RATE_LIMIT_DEFAULT_MAX_PER_MINUTE=120
RATE_LIMIT_ADMIN_MAX_PER_MINUTE=300
RATE_LIMIT_WEBHOOK_MAX_PER_MINUTE=300
RATE_LIMIT_AUTH_WINDOW_MS=900000
RATE_LIMIT_AUTH_START_MAX=5
RATE_LIMIT_AUTH_VERIFY_MAX=20
```

Current policies:

- `POST /api/auth/email/start`: 5 attempts per 15 minutes per IP/email.
- `POST /api/auth/email/verify`: 20 attempts per 15 minutes per IP/email.
- `/api/admin/*`: 300 requests per minute.
- `/api/webhooks/bridge`: 300 requests per minute.
- Default API routes: 120 requests per minute.

Responses include:

```text
X-RateLimit-Limit
X-RateLimit-Remaining
X-RateLimit-Reset
Retry-After
```

A rate-limited request returns:

```text
429 rate_limited
```

For multi-instance production scale, replace the in-memory limiter with Redis/Upstash-backed rate limiting.


## Frontend polling policy

To avoid unnecessary backend load:

- User frontend loads rail controls on startup.
- User frontend refreshes rail controls only when the page is visible, every 60 seconds, and on window focus/visibility changes.
- User frontend also rechecks controls immediately before creating a bank account or withdrawal.
- Admin frontend auto-polls only on the Analytics tab, every 60 seconds, and on window focus.
- Other admin tabs refresh on initial load, manual Refresh, tab navigation, and after explicit admin actions.

This prevents global polling across all tabs and keeps request volume well below the configured rate limits.

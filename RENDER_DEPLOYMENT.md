# Sivan Payments Deployment Pipeline

This document is the deployment runbook for the `sivan-payment` repository.

The repository deploys into two lanes:

```text
[ TEST LANE ]                                      [ LIVE LANE ]

Vercel: sivan-payments-user-test                  Vercel: sivan-payments-user-live
Admin Hub: sivan-admin-hub-test                 Admin Hub: admin.sivantech.online
        ↓                                                 ↓
Render: sivan-payments-api-test                   Render: sivan-payments-api-live
        ↓                                                 ↓
Neon: Sivan TEST database                         Neon: Sivan LIVE database
Bridge: Sandbox                                   Bridge: Production
Resend: Test/staging email                        Resend: Production email
Sentry: staging                                   Sentry: production
```

---

## 1. Deployment Targets

### Render backend services

| Lane | Render service | URL | Branch | Blueprint |
|---|---|---|---|---|
| TEST | `sivan-payments-api-test` | `https://sivan-payments-api-test.onrender.com` | `main` | `render.yaml` |
| LIVE | `sivan-payments-api-live` | `https://sivan-payments-api-live.onrender.com` | `main` | `render.yaml` |

### Vercel frontend projects

| Lane | Vercel project | Root directory | API target |
|---|---|---|---|
| TEST | `sivan-payments-user-test` | `frontend` | `https://sivan-payments-api-test.onrender.com` |
| TEST | `sivan-admin-hub-test` | `sivan-admin-hub` repo | server-side proxy to `https://sivan-payments-api-test.onrender.com` |
| LIVE | `sivan-payments-user-live` | `frontend` | `https://sivan-payments-api-live.onrender.com` |
| LIVE | `admin.sivantech.online` | `sivan-admin-hub` repo | server-side proxy to `https://sivan-payments-api-live.onrender.com` |

---

## 2. Render Blueprint

Render reads the backend deployment config from:

```text
render.yaml
```

The Blueprint deploys **only backend API services**:

```text
sivan-payments-api-test
sivan-payments-api-live
```

The frontends are deployed separately on Vercel.

### Render service settings

Both backend services use:

```yaml
runtime: node
plan: free
buildCommand: npm install && npm run build && npm run db:migrate
startCommand: npm start
healthCheckPath: /health
```

> Note: Render free services do not support `preDeployCommand`, so migrations run inside `buildCommand`.

---

## 3. Backend Environment Variables

### TEST lane — `sivan-payments-api-test`

Use `.env.test.example` as the source of truth.

Required Render env vars:

```env
APP_ENV=staging
PORT=10000
APP_URL=https://sivan-payments-api-test.onrender.com
CORS_ORIGIN=https://sivan-payments-user-test.vercel.app,https://sivan-admin-hub-test.vercel.app
LOG_LEVEL=info

DATABASE_PROVIDER=postgres
DATABASE_URL=<TEST_NEON_DATABASE_URL>

ADMIN_API_KEY=<TEST_ADMIN_API_KEY>
USER_JWT_SECRET=<TEST_USER_JWT_SECRET>
USER_JWT_EXPIRES_MINUTES=60
AUTH_OTP_EXPIRES_MINUTES=10
AUTH_DEV_SHOW_OTP=true
AUTH_REQUIRE_USER=true

EMAIL_PROVIDER=resend
RESEND_API_KEY=<RESEND_API_KEY>
EMAIL_FROM="Sivan <no-reply@sivantech.online>"

SENTRY_DSN=<SENTRY_BACKEND_TEST_DSN>
SENTRY_ENVIRONMENT=staging
SENTRY_TRACES_SAMPLE_RATE=0

BRIDGE_MOCK_MODE=false
DEFAULT_OFFRAMP_PROVIDER=bridge
BRIDGE_BASE_URL=https://api.sandbox.bridge.xyz/v0
BRIDGE_API_KEY=<BRIDGE_SANDBOX_API_KEY>
BRIDGE_WEBHOOK_PUBLIC_KEY=<BRIDGE_SANDBOX_WEBHOOK_PUBLIC_KEY>
WEBHOOK_MAX_AGE_MS=600000

SIVAN_OFFRAMP_FEE_PERCENT=1.25
BRIDGE_OFFRAMP_COST_PERCENT=0.5
BRIDGE_KYC_COST_USD=2
BRIDGE_KYB_COST_USD=10
```

### LIVE lane — `sivan-payments-api-live`

Use `.env.live.example` as the source of truth.

Required Render env vars:

```env
APP_ENV=production
PORT=10000
APP_URL=https://sivan-payments-api-live.onrender.com
CORS_ORIGIN=https://app.sivantech.online,https://admin.sivantech.online
LOG_LEVEL=info

DATABASE_PROVIDER=postgres
DATABASE_URL=<LIVE_NEON_DATABASE_URL>

ADMIN_API_KEY=<LIVE_ADMIN_API_KEY>
USER_JWT_SECRET=<LIVE_USER_JWT_SECRET>
USER_JWT_EXPIRES_MINUTES=60
AUTH_OTP_EXPIRES_MINUTES=10
AUTH_DEV_SHOW_OTP=false
AUTH_REQUIRE_USER=true

EMAIL_PROVIDER=resend
RESEND_API_KEY=<RESEND_API_KEY>
EMAIL_FROM="Sivan <no-reply@sivantech.online>"

SENTRY_DSN=<SENTRY_BACKEND_LIVE_DSN>
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0

BRIDGE_MOCK_MODE=false
DEFAULT_OFFRAMP_PROVIDER=bridge
BRIDGE_BASE_URL=https://api.bridge.xyz/v0
BRIDGE_API_KEY=<BRIDGE_LIVE_API_KEY>
BRIDGE_WEBHOOK_PUBLIC_KEY=<BRIDGE_LIVE_WEBHOOK_PUBLIC_KEY>
WEBHOOK_MAX_AGE_MS=600000

SIVAN_OFFRAMP_FEE_PERCENT=1.25
BRIDGE_OFFRAMP_COST_PERCENT=0.5
BRIDGE_KYC_COST_USD=2
BRIDGE_KYB_COST_USD=10
```

---

## 4. Vercel Frontend Environment Variables

### User frontend TEST

Project root:

```text
frontend
```

Vercel env:

```env
VITE_APP_ENV=test
VITE_APP_NAME=Sivan Payments Test
VITE_API_BASE_URL=https://sivan-payments-api-test.onrender.com
VITE_SENTRY_DSN=<SENTRY_USER_TEST_DSN>
VITE_SENTRY_ENVIRONMENT=test
VITE_SENTRY_TRACES_SAMPLE_RATE=0
```

### User frontend LIVE

Project root:

```text
frontend
```

Vercel env:

```env
VITE_APP_ENV=live
VITE_APP_NAME=Sivan Payments
VITE_API_BASE_URL=https://sivan-payments-api-live.onrender.com
VITE_SENTRY_DSN=<SENTRY_USER_LIVE_DSN>
VITE_SENTRY_ENVIRONMENT=production
VITE_SENTRY_TRACES_SAMPLE_RATE=0
```

### Admin frontend

The standalone `frontend-admin/` Vite app has been removed from this repository.
The official Sivan Payment admin frontend now lives in the Admin Hub repository:

```text
https://github.com/Samswitchy/sivan-admin-hub
```

Admin Hub module path:

```text
/dashboard/modules/sivan-payment
```

Admin Hub calls this backend through its server-side proxy and must keep the payment admin API key server-side.
Do **not** expose `ADMIN_API_KEY` in any browser `NEXT_PUBLIC_*` or `VITE_*` variable.

Admin Hub TEST env:

```env
SIVAN_PAYMENT_API_URL=https://sivan-payments-api-test.onrender.com
SIVAN_PAYMENT_ADMIN_API_KEY=<TEST_ADMIN_API_KEY>
NEXT_PUBLIC_DATABASE_MODE=test
```

Admin Hub LIVE env:

```env
SIVAN_PAYMENT_API_URL=https://sivan-payments-api-live.onrender.com
SIVAN_PAYMENT_ADMIN_API_KEY=<LIVE_ADMIN_API_KEY>
NEXT_PUBLIC_DATABASE_MODE=live
```

Keep the backend admin APIs in this repo:

```text
/api/admin/*
```

---

## 5. Deployment Flow

### Normal TEST deployment

1. Push to `main`.
2. Render auto-deploys `sivan-payments-api-test`.
3. Vercel auto-deploys:
   - `sivan-payments-user-test`
   - `sivan-admin-hub-test` payment module
4. Verify TEST health and UI.

### Normal LIVE deployment

LIVE Render auto-deploy is disabled.

1. Validate TEST lane first.
2. Manually deploy `sivan-payments-api-live` from Render.
3. Manually promote/deploy the user frontend and Admin Hub LIVE project if needed.
4. Run smoke tests.
5. Verify Bridge live webhook configuration.

---

## 6. Deployment Verification Commands

### TEST backend health

```bash
curl https://sivan-payments-api-test.onrender.com/health
```

Expected:

```json
{ "status": "ok", "service": "sivan-payments" }
```

### LIVE backend health

```bash
curl https://sivan-payments-api-live.onrender.com/health
```

### TEST public controls

```bash
curl https://sivan-payments-api-test.onrender.com/api/offramp/controls
```

### LIVE public controls

```bash
curl https://sivan-payments-api-live.onrender.com/api/offramp/controls
```

### Admin overview

```bash
curl https://sivan-payments-api-test.onrender.com/api/admin/overview \
  -H "x-admin-api-key: $ADMIN_API_KEY"
```

### Protected user endpoint should reject missing JWT

```bash
curl -i https://sivan-payments-api-test.onrender.com/api/users/usr_fake/withdrawals
```

Expected:

```text
401 auth_required
```

### Unsigned webhook should be rejected

```bash
curl -i -X POST https://sivan-payments-api-test.onrender.com/api/webhooks/bridge \
  -H "Content-Type: application/json" \
  -d '{"event_id":"fake","event_category":"liquidation_address.drain"}'
```

Expected:

```text
400 Invalid Bridge webhook signature
```

---

## 7. Bridge Webhooks

### TEST Bridge webhook URL

```text
https://sivan-payments-api-test.onrender.com/api/webhooks/bridge
```

Bridge environment:

```text
Sandbox
```

Categories:

```text
Customer
Kyc link
Liquidation address - Drain
External account
```

### LIVE Bridge webhook URL

```text
https://sivan-payments-api-live.onrender.com/api/webhooks/bridge
```

Bridge environment:

```text
Production
```

Use the same categories.

After creating a Bridge webhook, copy the Bridge `public_key` into:

```env
BRIDGE_WEBHOOK_PUBLIC_KEY=<public key>
```

---

## 8. Database Migration Pipeline

Migrations are in:

```text
database/migrations
```

Render runs migrations during build:

```bash
npm run db:migrate
```

Current migrations:

```text
001_create_payments_tables.sql
002_evolve_users_hybrid_identity.sql
003_create_payments_auth_challenges.sql
004_create_payments_audit_logs.sql
005_create_payments_control_settings.sql
```

Migrations must be safe to run multiple times and should use `if not exists` where possible.

---

## 9. Rollback Procedure

### Backend rollback

1. Open Render service.
2. Go to Deploys.
3. Select previous successful deploy.
4. Click rollback/redeploy previous commit.

### Frontend rollback

1. Open Vercel project.
2. Go to Deployments.
3. Promote previous successful deployment.

### Database rollback

Database migrations are forward-only for now.

If a migration breaks production:

1. Stop new deploys.
2. Roll back backend/frontend code.
3. Apply a corrective migration.
4. Do not manually delete production tables without backup.

---

## 10. Production Readiness Rules

Before real live money movement:

- Upgrade LIVE Render API from free tier to paid/always-on.
- Set `AUTH_DEV_SHOW_OTP=false`.
- Confirm Resend domain is verified.
- Confirm Sentry events are arriving.
- Confirm Bridge live webhook signatures pass.
- Confirm admin CORS is exact.
- Confirm `ADMIN_API_KEY` is strong and private.
- Move admin auth to Telegram JWT/RBAC.
- Run reconciliation dry-run successfully.
- Test with a very small Bridge-approved live amount.

---

## 11. Current Known Operational Notes

- Render free tier can cold start. This is okay for testing but not ideal for live webhooks.
- TEST DB may contain mock liquidation addresses; reconciliation can report Bridge 404 for those mock IDs.
- Admin controls can enable/disable USD, GBP, and EUR rails. Disabled rails are hidden in the user frontend and blocked by backend validation.
- User frontend polls rail controls every 15 seconds and on window focus.

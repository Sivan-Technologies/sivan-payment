# Sivan production validation runbook

Use this before enabling a broader public launch.

## 1) Legal acceptance versioning

Implemented in code:

- Signup now requires explicit acceptance of Terms, Privacy Policy, and Risk Disclosure.
- Backend stores a permanent row in `payments_legal_acceptances` after signup verification.
- Stored evidence:
  - `terms_version`
  - `privacy_version`
  - `risk_disclosure_version`
  - `accepted_at`
  - `ip_address`
  - `user_agent`
  - `source`
- User-level audit endpoint:
  - `GET /api/users/:userId/legal-acceptances`

Required Render envs:

```bash
LEGAL_TERMS_VERSION=2026-07-14
LEGAL_PRIVACY_VERSION=2026-07-14
LEGAL_RISK_DISCLOSURE_VERSION=2026-07-14
```

Migration:

```bash
npm run db:migrate
```

## 2) Real Bridge signed webhook delivery test

Bridge docs require testing via the Bridge webhook endpoint API:

1. Ensure Bridge webhook endpoint exists and is subscribed to:
   - `customer`
   - `kyc_link`
   - `liquidation_address.drain`
   - `external_account`
   - `transfer`
2. Ensure backend env contains the exact public key Bridge generated for that endpoint:
   - `BRIDGE_WEBHOOK_PUBLIC_KEY`
3. Ensure backend webhook URL is:
   - test: `https://sivan-payments-api-test.onrender.com/api/webhooks/bridge`
   - live: `https://sivan-payments-api-live.onrender.com/api/webhooks/bridge`
4. Run:

```bash
BRIDGE_WEBHOOK_ID=<bridge_webhook_id> \
BRIDGE_WEBHOOK_CATEGORY=customer \
SIVAN_API_BASE_URL=https://sivan-payments-api-test.onrender.com \
ADMIN_API_KEY=<admin_api_key> \
npm run bridge:webhook-test
```

To test a specific event:

```bash
BRIDGE_WEBHOOK_ID=<bridge_webhook_id> \
BRIDGE_WEBHOOK_EVENT_ID=<bridge_event_id> \
SIVAN_API_BASE_URL=https://sivan-payments-api-test.onrender.com \
ADMIN_API_KEY=<admin_api_key> \
npm run bridge:webhook-test
```

Repeat for these categories:

```bash
BRIDGE_WEBHOOK_CATEGORY=customer
BRIDGE_WEBHOOK_CATEGORY=kyc_link
BRIDGE_WEBHOOK_CATEGORY=external_account
BRIDGE_WEBHOOK_CATEGORY=liquidation_address.drain
BRIDGE_WEBHOOK_CATEGORY=transfer
```

Pass condition:

- Bridge API returns success for `/webhooks/{id}/send`.
- Sivan `/api/admin/webhooks` shows the same `providerEventId` with `processedAt` set.
- Backend returns HTTP 200 to Bridge.

## 3) Render/Vercel/Sentry readiness check

Automated public smoke check:

```bash
npm run ops:readiness-check
```

This verifies:

- live/test Render backend `/health`
- live/test Render DB health `/health/db`
- on-ramp fees route
- controls route
- Avalanche C-Chain is the only active chain
- CORS allows expected Vercel/user origins
- live/test user frontend routes return HTTP 200
- Admin Hub routes return HTTP 200
- homepage legal pages return HTTP 200

Manual dashboard items that cannot be fully verified from public endpoints:

- Render:
  - health check path is `/health`
  - deploy failure notifications enabled
  - service restart/crash alerts enabled
  - envs are set separately for test and live
- Vercel:
  - user live env points to `https://sivan-payments-api-live.onrender.com`
  - user test env points to `https://sivan-payments-api-test.onrender.com`
  - admin env points to the intended backend
  - deployment failure notifications enabled
- Sentry:
  - backend DSN configured on Render test/live
  - user frontend DSN configured on Vercel test/live
  - Admin Hub monitoring configured if admin monitoring is desired
  - alert: any production backend error > 0 in 5 minutes
  - alert: webhook 400/500 spike
  - alert: payment creation/sync/reconciliation error spike
  - alert destination: ops email/Slack/phone path

## Secret hygiene

Secrets have been used during development. Rotate/revoke before a broad production launch:

- GitHub PATs
- Bridge API keys
- Admin API key
- Neon password/URLs if exposed
- Resend key
- Sentry auth tokens/DSNs if needed
- R2 keys

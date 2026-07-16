# Sivan Payment Admin API Contract

The official admin UI lives in `sivan-admin-hub` and calls this service through the Admin Hub server-side proxy:

```text
sivan-admin-hub /api/admin/payment/* -> sivan-payment /api/admin/*
```

Do not remove these backend routes from `sivan-payment`; Admin Hub depends on them.

## Authentication and identity

Every Admin Hub proxy request to Sivan Payment must include:

```http
x-admin-api-key: <server-side SIVAN_PAYMENT_ADMIN_API_KEY>
x-sivan-admin-module: sivan-payment
x-sivan-admin-hub: true
x-sivan-request-id: <uuid>
```

When available, Admin Hub also forwards actor context:

```http
x-sivan-admin-email: <admin email or username>
x-sivan-admin-role: <superadmin|ops|operator|compliance|finance|support|engineering|auditor|guest>
```

`x-admin-api-key` remains the service authentication control. `x-sivan-admin-role` adds backend RBAC enforcement when present.

## RBAC summary

- `superadmin` / `owner`: all admin actions.
- `guest`: read-only, excluding exports.
- `auditor`: read-only audit/legal/reconciliation/webhook/user/transaction visibility.
- `support`: support mutations and admin notes.
- `compliance`: risk review, support, approvals, notes.
- `finance`: fees, limits, approvals, notes.
- `ops` / `operator`: operational controls, settings, limits, sync/reconciliation, webhook reprocess, approvals, notes.
- `engineering`: sync/reconciliation, webhook reprocess, approvals, notes.
- `escrow`: not allowed to operate Sivan Payment admin APIs.

## Core overview and analytics

```http
GET /api/admin/overview
GET /api/admin/analytics
GET /api/admin/users?limit=&offset=
GET /api/admin/users/:id/details
```

## Withdrawals/off-ramp

```http
GET  /api/admin/withdrawals?limit=&offset=&status=
GET  /api/admin/withdrawals/:id
GET  /api/admin/withdrawals/:id/details
POST /api/admin/withdrawals/:id/sync
```

## On-ramp

```http
GET  /api/admin/onramp/orders?limit=&offset=&status=
GET  /api/admin/onramp/orders/:id
GET  /api/admin/onramp/orders/:id/details
POST /api/admin/onramp/orders/:id/sync
POST /api/admin/onramp/reconciliation/run
```

## Controls, system status, limits, settings

```http
GET /api/admin/offramp/controls
PUT /api/admin/offramp/controls
GET /api/admin/system/status
PUT /api/admin/system/status
GET /api/admin/limits
PUT /api/admin/limits
GET /api/admin/settings/platform
PUT /api/admin/settings/platform
GET /api/admin/settings/team
POST /api/admin/settings/team/invite
GET /api/admin/settings/api-keys
POST /api/admin/settings/api-keys/:key/rotate
```

## Fees, finance, legal evidence

```http
GET /api/admin/fees/settings
PUT /api/admin/fees/settings
GET /api/admin/finance/dashboard
GET /api/admin/legal/evidence
```

Fee settings affect real user-facing APIs and new payment records:

```http
GET  /api/onramp/fees
POST /api/onramp/orders
GET  /api/fees/offramp
POST /api/fees/offramp/estimate
POST /api/withdrawals
POST /api/fees/economics/estimate
```

## Risk, approvals, notes

```http
GET  /api/admin/risk/cases?status=&severity=
POST /api/admin/risk/cases/:id/review
GET  /api/admin/approvals
POST /api/admin/approvals
POST /api/admin/approvals/:id/approve
POST /api/admin/approvals/:id/reject
POST /api/admin/notes
```

## Support operations

```http
GET  /api/admin/support/tickets
GET  /api/admin/support/analytics
GET  /api/admin/support/tickets/:id
PUT  /api/admin/support/tickets/:id
POST /api/admin/support/tickets/:id/messages
```

## Webhooks and reconciliation

```http
GET  /api/admin/webhooks?limit=&offset=
POST /api/admin/webhooks/:id/reprocess
GET  /api/admin/reconciliation/runs
POST /api/admin/reconciliation/run
```

## Exports

```http
GET /api/admin/exports/:type.csv
GET /api/admin/exports/all.json
```

Supported CSV types:

```text
users
legal-acceptances
withdrawals
onramp-orders
support-tickets
audit-logs
reconciliation-findings
```

## Compatibility notes

- List endpoints currently return arrays. Future production-scale pagination should add `{ pagination: { total, limit, offset, hasMore } }` without breaking existing `data` arrays.
- Admin Hub should not call the Sivan Payment backend directly from the browser.
- `SIVAN_PAYMENT_ADMIN_API_KEY` must stay server-side in Admin Hub.

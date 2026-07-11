# Reconciliation Procedure

Reconciliation protects Sivan from missed webhooks, out-of-order events, provider delays, and internal status drift.

## What is reconciled

For the off-ramp MVP, reconciliation compares:

```text
Sivan liquidation addresses / withdrawals
vs
Bridge liquidation address drain history
```

## Admin endpoint

```http
POST /api/admin/reconciliation/run
Content-Type: application/json

{
  "dryRun": true
}
```

Use `dryRun: true` first. This reports what would be updated without mutating records.

When reviewed, run:

```json
{
  "dryRun": false
}
```

## Recommended operational cadence

- Every 15 minutes: dry-run reconciliation for monitoring.
- Hourly: live reconciliation if dry-run findings are low-risk.
- Daily: admin review of unmatched drains and provider errors.
- Monthly: compare Sivan fee revenue and Bridge invoice/settlement data.

## Findings

The reconciliation service returns findings such as:

- `matched_drain`
- `unmatched_drain`
- `would_update_withdrawal`
- `updated_withdrawal`
- `provider_error`

## Production requirements before launch

- Protect admin endpoints with authentication and role-based access.
- Store reconciliation runs in a persistent table.
- Add scheduled jobs.
- Add alerting for unmatched drains and provider errors.
- Reconcile Bridge developer fee settlement against internal fee records.

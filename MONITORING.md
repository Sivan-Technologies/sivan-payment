# Monitoring

## 1. The endpoint

```
GET /health/operational
```

Public, unauthenticated, rate-limit exempt. Returns **503** when any signal is
critical and **200** otherwise, so a plain uptime monitor alerts without
parsing the body.

Public on purpose: it returns counts and states, never user data, and an
alerting endpoint behind auth is one expired credential away from silently not
alerting.

### Signals

Each is tested by *causing* the condition — 32 assertions in
`npm run test:operational-health`.

| Signal | Fires when | Severity |
|---|---|---|
| `transfers_stuck_in_flight` | non-terminal transfer, no update in 2h | **critical** |
| `transfers_requiring_review` | flagged deposit, funds held by Breet | warn |
| `kyc_name_reviews_pending` | oldest review > 24h / > 48h | warn / **critical** |
| `provider_webhooks_24h` | transfers started but zero webhooks arrived | warn |
| `delegated_signing_configured` | Privy signing credentials missing | **critical** |
| `ngn_offramp_enabled` | off-ramp disabled | warn |
| `breet_environment` | `APP_ENV=production` but `BREET_ENV=development` | **critical** |

`transfers_stuck_in_flight` is the one that matters most: it is the exact
shape of both webhook bugs found this week, and `/health` returned 200
through both.

### Why not just /health

`/health` says the process is up. It returned 200 through all three real
incidents:

- `trade.flagged` unhandled → deposits stuck forever
- `trade.completed` discarded → *settled* payouts also stuck
- migration 036 failing → stale code served for six commits

None of those crash. Nothing throws. A liveness check cannot see them.

## 2. Uptime monitoring

### Recommended: the built-in watchdog

`npm run watchdog` polls both APIs every 60s and alerts to Telegram. It reads
the response **body**, so an alert names the failing signal and what to do:

> 🔴 `3 transfers unfinished for over 2h. Check the Breet webhook log.`

Setup: `npm run setup:alerts` (two questions, ~2 minutes).
Details: `WATCHDOG-SETUP.md`.

**A correction to earlier advice:** I previously suggested UptimeRobot at a
1-minute interval. That was wrong. Their free tier is **5-minute** checks, has
**no SMS**, and since October 2024 is restricted to **personal,
non-commercial** use — which a payments company is not. 1-minute plus SMS is
roughly $7–10/month.

### Also add: one external dead-man's switch

The watchdog cannot tell you its own host is down. Add **one** free external
check pointed at the watchdog host (UptimeRobot free, or Better Stack's ten
free monitors). One monitor, well inside any free tier.

If you would rather use a hosted monitor for everything instead, point it at:

```
https://<api>/health              → process liveness
https://<api>/health/operational  → product health, 503 = page someone
```

Alert to a phone, not email. A payout stuck at 3am is still stuck at 9am.

## 3. Sentry

Already wired (`src/monitoring/sentry.ts`). `SENTRY_DSN` is `sync: false`, so
set it in the dashboard. Two rules worth having:

- any error in `production` within 5 minutes → notify
- webhook 4xx/5xx spike → notify

`npm run ops:monitoring-check` sends a real smoke event and reads
`/health/operational` on both services, reporting *which* signal is red.

## 4. Commands

| Command | Does |
|---|---|
| `npm run setup:alerts` | Interactive Telegram setup + writes `.env.watchdog` |
| `npm run watchdog -- --once` | One pass, prints status, exits non-zero if unhealthy |
| `npm run watchdog` | Continuous, alerts on change only |
| `npm run ops:rails -- --api <url> --key <key>` | Show rail state (dry run) |
| `npm run ops:rails -- --api <url> --key <key> --apply` | Enable the NGN rails, then verify |
| `npm run ops:monitoring-check` | Sentry smoke + operational health on both APIs |
| `npm run ops:readiness-check` | Full pre-launch sweep |

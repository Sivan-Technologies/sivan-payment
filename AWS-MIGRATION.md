# Moving api-live to AWS

Scope agreed: **api-live only**, keep Neon, cut over **after launch with live
traffic**. Test stays on Render as a fallback.

Everything below was checked against the actual repo and the running services,
not assumed.

---

## The single most important thing

**Your cutover switch is one line in a Cloudflare Worker, not DNS.**

`cloudflare-worker-live-FIXED.js:45`

```js
const LIVE_PAYMENTS = "https://sivan-payments-api-live-cgqi.onrender.com";
```

Every customer request reaches `api.sivantech.online/api/payment/*` and the
worker forwards it there. To cut over you change that constant to the AWS
hostname and deploy the worker. To roll back you change it back. Propagation is
seconds, there is no DNS TTL to wait out, and `app.sivantech.online` never
knows anything happened.

This is much better than a DNS migration and it changes the shape of the whole
plan: **you never need a maintenance window.**

---

## What actually has to move

| thing | status |
|---|---|
| Database | **Already on AWS.** Neon serverless Postgres, `us-east-1`. Not moving. |
| Compute | Render free plan → AWS |
| TLS / domain | Cloudflare already terminates. Unchanged. |
| Object storage | R2 (`uploads.sivantech.online`). Unchanged. |
| Secrets | **31 env vars marked `sync: false`** — dashboard-only, they do NOT live in `render.yaml` and will NOT migrate themselves |

The app is already cloud-native: binds `0.0.0.0:$PORT`, no local disk writes on
the Postgres path, 12 dependencies, Node >= 20.

---

## Which compute — recommendation

You asked me to choose. **AWS App Runner.**

Reasoning, given you are solo-operating this with live traffic:

- It is the closest thing to Render, so the mental model does not change.
  Health checks, TLS, rolling deploys and autoscaling are handled.
- No cold start on a provisioned instance — which was your original reason for
  leaving Render.
- No ALB, target groups, subnets or security groups to get wrong at 2am.
- It runs a container OR builds from your repo, so you are not forced into
  Docker on day one.

**Not ECS Fargate**, even though it is the "proper" answer: it is roughly four
more moving parts (ECR, task definition, ALB, target group health checks) and
each is a chance to be down while you debug it. Move to ECS later if you
outgrow App Runner; the container image is portable.

**Not the EC2 instance you created**, unless you specifically want it. It works
and it is cheap, but you inherit patching, PM2/systemd supervision, nginx, log
rotation and certificate renewal. That is real ongoing work for one person.

If you want to use the EC2 box anyway, everything below still applies — only
the deploy step differs, and it is noted where relevant.

---

## Two things that will bite you, found by reading the code

### 1. Migrations replay on every boot, with no lock

`scripts/db-migrate.ts` reads every `.sql` and runs it. There is **no
applied-migrations table**:

```js
for (const file of files) {
  await client.query(sql);   // every file, every run
}
```

Today `buildCommand` runs it once per Render deploy, which is survivable
because all 40 migrations are idempotent (verified: `npm run test:migrations`,
13 assertions, PGlite replays them 3x cleanly).

**On AWS this becomes dangerous the moment you run more than one instance.**
Two tasks starting together run 40 concurrent `CREATE TABLE IF NOT EXISTS` /
`ALTER TABLE` statements against the same database. Idempotent does not mean
concurrency-safe — two sessions doing `ALTER TABLE` on the same relation will
deadlock or error.

**Do not put `db:migrate` in the container start command.** Run it as a
separate one-shot step before rolling out new tasks.

### 2. Thirty-one secrets are dashboard-only

`render.yaml` has 81 env keys for api-live; **31 are `sync: false`**, meaning
the value exists only in the Render dashboard. They will not appear in any
file you copy. The full list is in the appendix — miss one and the service
starts and then fails at the first request that needs it.

`PRIVY_AUTHORIZATION_PRIVATE_KEY` and `PRIVY_AUTHORIZATION_KEY_QUORUM_ID` must
move **together**. A wallet's signer is fixed at creation; a mismatched pair
means the backend cannot sign withdrawals.

---

## The plan

### Phase 0 — before you touch AWS

1. Export the 31 secrets from the Render dashboard into a password manager.
   Do not paste them into a terminal, a chat, or a file in the repo.
2. Confirm the current live service is healthy so you have a known-good
   baseline: `GET /health/operational` should be `ok`.
3. Note the current Render URL. That is your rollback target.

### Phase 1 — stand it up in parallel

Nothing customer-facing changes in this phase. The Render service keeps
serving all traffic.

1. Create the App Runner service in **us-east-1** — same region as Neon.
   Cross-region would add ~70ms to every query.
2. Set all 81 env vars. `PORT` is supplied by the platform; the app already
   reads it.
3. Health check path `/health`. It is unauthenticated and returns in ~0.1s.
4. Deploy. Do **not** point anything at it yet.

### Phase 2 — prove it before trusting it

Run these against the new AWS hostname directly, before any traffic moves:

```bash
AWS=https://<your-app-runner-url>

curl -s $AWS/health
curl -s $AWS/health/operational | jq .status          # want "ok"
curl -s $AWS/api/system/status
curl -s -o /dev/null -w "%{time_total}\n" $AWS/api/users/x/FAKE   # want < 0.5s
```

That last one is the tell. On Render before the perf fix it was 5.8s because
every request paid a 28-table read. If it is slow on AWS, the container is
misconfigured — probably a cross-region database.

Then the real check, with your live admin key:

```bash
curl -s $AWS/api/admin/ngn/provider-health -H "x-admin-api-key: $KEY" | jq .data.active
```

Wants `available: true`. This proves the Breet credentials actually
authenticate from the new network, not merely that the env var is set.

### Phase 3 — cut over

1. Run migrations **once**, manually, from your machine or a one-shot task:
   `DATABASE_URL=<neon> npm run db:migrate`
2. Change `LIVE_PAYMENTS` in `cloudflare-worker-live-FIXED.js` to the AWS
   hostname.
3. Deploy the worker.
4. Watch `/health/operational` and the admin hub for 15 minutes.

Because the worker is the switch, this is effectively instant and reversible.

### Phase 4 — after it is stable

- Leave the Render service running for at least a week, stopped but not
  deleted. It is your rollback.
- Point Breet's **production** webhook at the AWS host only after you have
  seen a successful settlement. Breet retries non-2xx for 24h, so a brief
  overlap is safe, but two hosts receiving the same webhook is not — the
  handler is idempotent per `id`, but only within one database, which you
  share, so this is actually fine. Still: change it once, deliberately.

---

## Rollback

One line, one deploy:

```js
const LIVE_PAYMENTS = "https://sivan-payments-api-live-cgqi.onrender.com";
```

Nothing else moves. The database is shared, so no data is stranded on either
side. This is the main reason the parallel-run approach is worth the extra
step.

---

## What I would NOT do

- **Do not migrate the database.** It is already AWS-hosted, managed, backed
  up, and has zero transaction rows today. Moving to RDS buys nothing and
  costs you a cutover window and a rollback plan you do not need.
- **Do not move all services at once.** api-live alone is the smallest change
  that gets you off the cold-start problem.
- **Do not delete the Render service on cutover day.**
- **Do not run migrations from the container start command.**

---

## Appendix — the 31 secrets that will not migrate themselves

```
ADMIN_API_KEY                        PAJ_RAMP_DEFAULT_RECIPIENT_ADDRESS
BREET_APP_ID                         PAJ_RAMP_MERCHANT_TOKEN
BREET_APP_SECRET                     PAJ_RAMP_USDC_MINT
BREET_DEFAULT_ACCOUNT_NUMBER         PAJ_RAMP_USDT_MINT
BREET_DEFAULT_BANK_ID                PRIVY_APP_ID
BREET_DEFAULT_RECIPIENT_ADDRESS      PRIVY_APP_SECRET
BREET_MERCHANT_REFERENCE             PRIVY_AUTHORIZATION_KEY_QUORUM_ID   <- pair
BREET_WEBHOOK_SECRET                 PRIVY_AUTHORIZATION_PRIVATE_KEY     <- pair
BRIDGE_API_KEY                       RESEND_API_KEY
BRIDGE_WEBHOOK_PUBLIC_KEY            SENTRY_DSN
DATABASE_URL                         SIVAN_AI_API_KEY
EMAIL_FROM                           SOLANA_RPC_FALLBACK_URL
NGN_PROVIDER                         SOLANA_RPC_URL
PAJ_RAMP_API_KEY                     USER_JWT_SECRET
PAJ_RAMP_DEFAULT_ACCOUNT_NUMBER      WALLET_PROVIDER
PAJ_RAMP_DEFAULT_BANK_ID
```

`WALLET_PROVIDER` and `NGN_PROVIDER` are `sync: false` deliberately — a
hardcoded `value:` in `render.yaml` is re-applied on every blueprint sync and
silently reverted `WALLET_PROVIDER` once already. Carry the same discipline to
AWS: set them in the service config, never in a committed file.

---

## Timing advice

You are launching with live traffic. **Do not do this on launch night.**

The cold start you are trying to escape is a Render free-plan symptom. api-live
currently answers `/health` in 0.10s and `/api/users/x/FAKE` in 0.27s because
the perf fix landed. It is not currently slow. Ship the launch on Render, watch
it for a few days, then migrate on a quiet morning with the worker rollback
one line away.

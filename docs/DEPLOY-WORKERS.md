# Deploying the Cloudflare Workers

## The two files you need

| Gateway | File | Deploy to route |
|---|---|---|
| **Live** | `/home/user/cloudflare-worker-live-FIXED.js` | `api.sivantech.online/*` |
| **Test** | `/home/user/cloudflare-worker-test-DEPLOY.js` | `test-sivan.sivantech.online/*` |

**Use `-DEPLOY.js` for test, not `-FIXED.js`.**

I could not tell these apart last time and said so. I can now, by their
`/health/deep` output:

```
live test gateway  ->  "escrow":"degraded"      <- only -DEPLOY.js emits "degraded"
-FIXED.js          ->  "down" / "fallback"      <- different vocabulary
```

So `-DEPLOY.js` is the variant currently running on test. `-FIXED.js` is a
newer rewrite (real primary/fallback pairs) that has never been deployed —
shipping it now would be an architecture change on launch week, not a
one-line host swap. I updated the AI host in it too, so it stays correct
whenever you do adopt it, but **do not deploy it today**.

---

## Option A — Cloudflare dashboard (no tooling, ~2 minutes each)

1. <https://dash.cloudflare.com> → **Workers & Pages**
2. Open the existing Worker bound to `api.sivantech.online/*`
   (the route binding is what matters, not the Worker's name)
3. **Edit code** → select all in the editor → paste the whole file
4. **Deploy**
5. Repeat for the Worker bound to `test-sivan.sivantech.online/*`,
   pasting `cloudflare-worker-test-DEPLOY.js`

Paste the entire file including the comment header. Nothing needs editing.

---

## Option B — wrangler CLI

Not installed in this sandbox and there is no `wrangler.toml`, so this needs
setting up once on your machine:

```bash
npm install -g wrangler
wrangler login

mkdir -p sivan-gateway-live && cd sivan-gateway-live
cp /path/to/cloudflare-worker-live-FIXED.js src/index.js

cat > wrangler.toml <<'TOML'
name = "sivan-live-gateway"
main = "src/index.js"
compatibility_date = "2026-08-09"

[[routes]]
pattern = "api.sivantech.online/*"
zone_name = "sivantech.online"
TOML

wrangler deploy
```

⚠️ `name` must match the **existing** Worker, or you will create a second
Worker and the route will not move. Check the current name in the dashboard
first. The dashboard route is authoritative either way.

---

## Verify after deploying

```bash
# 1. AI now resolves to AWS, and fast
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
  https://api.sivantech.online/api/sivan-ai/health
# expect ~0.4s. Before: 22.1s on a cold Render start.

# 2. sivanAi should stop reporting "degraded"
curl -s https://api.sivantech.online/health/deep
# escrow stays "degraded" -- that service is genuinely down, unrelated.

# 3. Nothing else moved
curl -s -o /dev/null -w '%{http_code}\n' https://api.sivantech.online/api/payment/health
```

### Why this is worth deploying

Measured just now, from outside:

```
live /health/deep   ->  "sivanAi":"degraded"
sivan-ai.onrender   ->  200 in 2.12s cold, 0.11s warm
ai.sivantech.online ->  200 in 0.41s, 0.42s, 0.44s (flat)
```

The Worker aborts a health check at 6s. Render answers fine when warm but
spikes when cold, which is why `sivanAi` intermittently reads `degraded`
today and why one call through the gateway took 22.1s. AWS does not sleep.

---

## Rollback

Cloudflare keeps previous versions. Dashboard → the Worker →
**Deployments** → pick the prior version → **Rollback**. Instant, no rebuild.

Or change the one line back:

```js
const LIVE_SIVAN_AI = "https://sivan-ai.onrender.com";
```

## Re-run the routing tests before deploying

```bash
node /home/user/worker-route-test-live.mjs   # 4 assertions
node /home/user/worker-route-test-test.mjs   # 6 assertions
```

They execute the real routing code and assert both the upstream host and the
rewritten path.

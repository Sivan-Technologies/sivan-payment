# Deploying the user frontend

The app has been built and tested but has never been deployed, so there is
currently no URL where a person can use Sivan. This is the gap that closes
that.

## Where it deploys

Render, alongside the API, declared in the repo root `render.yaml`:

| Service | Type | Auto-deploy | API it talks to |
|---|---|---|---|
| `sivan-payments-user-test` | static | yes | `sivan-payments-api-test-x9xq` |
| `sivan-payments-user-live` | static | **no** | `sivan-payments-api-live-cgqi` |

A **static site**, not a web service. Vite emits plain files and there is no
server to run, which also means no cold start — worth having when the API on
the free tier already takes ~40s to wake.

Live is manual to match the live API. A frontend that auto-deploys against a
hand-deployed API drifts the moment the two disagree.

`vercel.json` is kept for anyone who prefers Vercel, but Render means one
platform, one place to read logs, and no second vendor to keep in sync.

## The thing that will break it first: CORS

Measured before deploying, against the test API:

```
Origin: https://sivan-payments-user-test.onrender.com
-> no access-control-allow-origin header
```

Every browser request would be blocked. Worse, it fails in a way that looks
like the API is down rather than misconfigured: the request never arrives, so
there is nothing in the API logs to find, and the browser console shows a
generic network error.

`CORS_ORIGIN` is now set explicitly in `render.yaml` for both API services:

- test: the frontend origin **and** `http://localhost:5173` for development
- live: the frontend origin only — a developer machine must not be able to
  drive the production API from a browser session

Not `*`. The browser sends the user's JWT on these requests.

**If Render assigns a different subdomain than the service name implies, or a
custom domain is added, `CORS_ORIGIN` must be updated or the app goes dark.**

## Client-side routing

The app routes with `history.pushState` across `/dashboard`, `/withdraw`,
`/verification`, `/bank-accounts` and others. Without a rewrite, those paths
404 on a hard refresh or a shared link — the app only works if the user lands
on `/` first and clicks, which is not how anyone uses a link.

Handled by the `routes` rewrite in `render.yaml` and by `vercel.json`.

## Environment

`VITE_*` variables are baked in **at build time**, not read at runtime.
Changing one requires a rebuild, not a restart. Verified: the API URL appears
in the emitted bundle.

| Variable | Test | Live |
|---|---|---|
| `VITE_API_BASE_URL` | test API URL | live API URL |
| `VITE_APP_ENV` | `test` | `live` |
| `VITE_SENTRY_DSN` | dashboard | dashboard |

## After deploying, check these

1. `/` loads
2. **`/dashboard` loads on a hard refresh** — proves the rewrite works
3. Sign-up completes — proves CORS and the API URL are right
4. The network tab shows requests to the API host, not to the frontend host

Step 2 and 3 are the ones that actually fail. A working `/` proves very little.

## Known gaps at the time of writing

- **The NGN off-ramp needs a verified payout bank account.** Wallet creation
  is gated at KYC level 1, so a fresh account cannot reach the wallet screen.
- **Solana off-ramp cannot sponsor gas** until Privy approves the account.
  Base works today.
- The signer configured is still the **e2e test key**. It must be replaced
  before any real user wallet exists, because Privy binds signers at wallet
  creation and they cannot be changed afterwards.

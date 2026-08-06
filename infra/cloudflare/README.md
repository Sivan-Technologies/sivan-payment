# Cloudflare workers

The API gateway that sits in front of the payments backend. Every browser
request goes through one of these before it reaches Render:

```
browser  ->  test-sivan.sivantech.online/api/payment/*   ->  sivan-payments-api-test-x9xq.onrender.com
browser  ->  api.sivantech.online/api/payment/*          ->  sivan-payments-api-live-cgqi.onrender.com
```

## Why these are in the repo

They were not. They lived only in `/home/user` on a sandbox — untracked by any
repo, reviewed by nobody, and gone the moment that machine was wiped. That is a
poor place for the component every request passes through.

Committed here **verbatim**, with no content changes, purely to bring them under
version control. Diffing a committed file against the deployed worker is now
possible; before this there was nothing to diff against.

## ⚠️ These files are NOT proof of what is deployed

Nothing here is generated from Cloudflare. They are local copies that were
*intended* to be deployed, and they have drifted before — an earlier note in
this repo records both worker files carrying a CORS fix that was never live,
verified by curling the gateway and getting no `Access-Control-Allow-Origin`
back for the Render origin.

**Treat a file here as a proposal until a live probe agrees with it.**

## What each one is

| File | Lines | Newest dated comment | Notes |
|---|---:|---|---|
| `cloudflare-worker-live-FIXED.js` | 463 | 2026-07-29 | Production gateway, `api.sivantech.online` |
| `cloudflare-worker-test-DEPLOY.js` | 436 | 2026-07-30 | Test gateway. Newest of the three; its header says "Deploy on: test-sivan.sivantech.online/*" |
| `cloudflare-worker-test-FIXED.js` | 431 | 2026-07-28 | Older test revision, superseded by `-DEPLOY` |

Three files for two workers is itself a smell. `-DEPLOY` and `-FIXED` are two
generations of the same test worker, and the naming does not say which is
authoritative — only the dated comments inside do. Worth collapsing to one file
per environment once someone can confirm what is actually running.

## The 12-second timeout, and why it was left alone

```js
const UPSTREAM_TIMEOUT_MS = 12000;
```

This surfaced on 2026-08-06 as a reported bug:

```
POST /api/ngn/offramp/orders 503 (Service Unavailable)
"The payments-api service did not respond. This was a POST request and it was
 NOT retried, because repeating it could duplicate the action."
```

The order had in fact been created. `acceptNgnQuote` was awaiting an on-chain
sweep inside the HTTP handler, the response exceeded 12s, and the worker hung
up — so the user was shown a failure for something that had succeeded.

**The worker was not changed, and should not have been.** Its behaviour was
correct on both counts:

- 12s is already generous for an HTTP response. Work that needs longer does not
  belong in a request; raising the ceiling would have hidden the fault and made
  the user watch a spinner for 30s instead.
- Refusing to retry a POST is right. A retry could have created a second order,
  and the message it returns — "check whether it took effect before trying
  again" — was the most useful thing on the screen.

The fix went in the backend (`54a4ba3`): the sweep is now scheduled after the
response, which returns in ~5ms.

## Deploying

Manual, through the Cloudflare dashboard — there is no wrangler config here and
no CI step that publishes these. After deploying, verify against the live
gateway rather than trusting the paste:

```bash
# reachable, and fast
curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' \
  https://test-sivan.sivantech.online/api/payment/health

# CORS actually answers for the origin you expect
curl -s -D- -o /dev/null -X OPTIONS \
  -H 'Origin: https://sivan-payments-user-test.vercel.app' \
  -H 'Access-Control-Request-Method: PUT' \
  https://test-sivan.sivantech.online/api/payment/health | grep -i access-control

# a POST is forwarded (401 = reached the API and was refused on auth, which is
# the healthy answer here; 503 would mean the gateway never got through)
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  https://test-sivan.sivantech.online/api/payment/api/ngn/offramp/orders
```

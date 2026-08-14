# Getting `ai.sivantech.online` back on HTTPS

Sivan Assistant is offline. The server is running; TLS is not.

Everything below was measured against the live host, not assumed. Anyone with
SSH access to the box can follow it top to bottom in about ten minutes.

---

## Correcting earlier advice

An earlier note said this needed an **ACM certificate on an ALB listener**.
**That was wrong**, and following it would have wasted an hour in the AWS
console looking for a load balancer that does not exist.

Reverse DNS settles it:

```
13.39.31.121  →  ec2-13-39-31-121.eu-west-3.compute.amazonaws.com
```

That is a **bare EC2 instance**. ACM certificates can only be attached to an
ALB, CloudFront or API Gateway — they **cannot be installed on EC2**. The
private key never leaves AWS, which is the whole point of ACM and the reason it
is useless here.

The fix is a certificate installed *on the box*.

---

## What is actually wrong

```
$ openssl s_client -connect 13.39.31.121:443 -servername ai.sivantech.online
CONNECTED(00000003)
---
no peer certificate available
---
SSL alert number 80   (tlsv1 alert internal error)
```

Identical result **with and without SNI**. Something is listening on :443 and
has **no certificate loaded at all** — not expired, not mismatched, absent. A
web server is configured for TLS and pointed at a certificate file that is not
there.

Supporting evidence, all measured:

| Check | Result | Means |
|---|---|---|
| `http://ai.sivantech.online/health` | `308 → https` | nginx/Caddy is **alive** |
| `https://…` | `000`, alert 80 | no cert on :443 |
| `:8080`, `:3000` | TCP opens, then hangs | **the AI app may also be down** |
| `api.sivantech.online` | valid Google Trust cert | DNS and the domain are fine |

Two separate problems may be stacked here. Fix the app first — a perfect
certificate in front of a dead process still returns 502.

---

## Step 1 — is the AI app even running?

SSH to the box, then:

```bash
sudo ss -ltnp | grep -E ':(8080|3000|443|80)'
sudo systemctl status <your-ai-service>
sudo journalctl -u <your-ai-service> -n 50 --no-pager
```

`:8080` and `:3000` accept a TCP connection and then never speak HTTP. That is
consistent with a process that has crashed and left the socket held, or a
listener bound with nothing behind it. Get a plain `curl localhost:8080/health`
returning JSON before touching TLS.

---

## Step 2 — find the broken certificate path

```bash
sudo nginx -t
```

This is the fastest route to certainty. It names the exact `ssl_certificate`
file it cannot read. If you are on Caddy instead:

```bash
caddy validate --config /etc/caddy/Caddyfile
sudo journalctl -u caddy -n 50 --no-pager
```

---

## Step 3 — issue a real certificate

Let's Encrypt, on the instance. Both prerequisites are already satisfied:
DNS points at the box, and **port 80 is open** — which is how HTTP-01
validation works, so do not close it.

**nginx:**

```bash
sudo apt update && sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ai.sivantech.online
```

**Caddy** does TLS automatically. It only needs the hostname in the site block:

```
ai.sivantech.online {
    reverse_proxy localhost:8080
}
```

Certbot writes the certificate, rewrites the server block, reloads, and
installs a renewal timer.

---

## Step 4 — verify from outside the box

Do not trust a local curl; the failure was always visible only from outside.

```bash
curl -sv https://ai.sivantech.online/health 2>&1 | grep -E "subject|issuer|HTTP/"
curl -s -o /dev/null -w "%{http_code}\n" https://ai.sivantech.online/health
```

Expect a subject of `CN=ai.sivantech.online`, an issuer of Let's Encrypt, and
`200`.

The gateway will **not** go green yet, and that is expected — the test worker
still probes the suspended Render host, not AWS. See the next section; that is
a second, separate edit.

Once both are done:

```bash
curl -s https://test-sivan.sivantech.online/health/deep
```

`sivanAi` should move from `degraded` to `ok`. Read it twice — the probe flaps
(see "Reading the gateway honestly" below).

---

## The test gateway still points at Render — this needs one edit

Checked, rather than assumed, and the two workers disagree:

```
cloudflare-worker-live-FIXED.js:46   LIVE_SIVAN_AI = "https://ai.sivantech.online"   AWS
cloudflare-worker-test-DEPLOY.js:35  TEST_SIVAN_AI = "https://sivan-ai.onrender.com" Render
```

`-DEPLOY.js` is the file actually running on the test gateway (proven by its
`/health/deep` vocabulary — `ok` / `degraded`, which only that file emits). It
points at a Render service that is **suspended**:

```
$ curl -I https://sivan-ai.onrender.com/health
HTTP/2 503
x-render-routing: suspend-by-user
```

So `sivanAi: degraded` on the test gateway has **two independent causes**: the
Render host it probes is switched off, and the AWS host it should probe has no
TLS. Fixing the certificate alone will not turn test green.

**After TLS is working**, change line 35 and redeploy the worker from the
Cloudflare dashboard (there is no `wrangler.toml`; see `docs/DEPLOY-WORKERS.md`):

```js
const TEST_SIVAN_AI = "https://ai.sivantech.online";
```

Live needs no change — `-FIXED.js` already points at AWS. But note `-FIXED.js`
is an **undeployed rewrite** of the live worker; do not deploy it during launch
week to "fix" this. It is unrelated and untested.

---

## Reading the gateway honestly

`/health/deep` **flaps**, and it is not reliable evidence on its own. Three
consecutive reads minutes apart:

```
1st   escrow ✗   payment ok   auth ✗   bot ✗   sivanAi ✗
2nd   escrow ok   payment ✗    auth ok   bot ok   sivanAi ✗
3rd   escrow ok   payment ok   auth ok   bot ok   sivanAi ✗
```

Services do not recover in twenty seconds. Probed directly on the exact paths
the gateway uses, every one answered in under 100 ms:

```
auth    /health       200 in 0.084s
escrow  /api/health   200 in 0.093s
bot     /api/health   200 in 0.078s
```

These are Render free-tier services that sleep when idle. The probe's 8s
timeout catches them mid cold start and calls them degraded; the next probe
passes. **Only `sivanAi` is consistently degraded**, and that is this outage.

Do not chase the others. If the flapping becomes noisy, the fix is a warmer or
a longer probe timeout, not a service migration.

---

## Renewal is now yours

ACM auto-renews. A certificate on an EC2 box does not, unless the timer
survives.

```bash
systemctl list-timers | grep certbot     # confirm the timer exists
sudo certbot renew --dry-run             # prove renewal actually works
```

**If this instance is ever rebuilt from an AMI without that timer, TLS expires
silently in 90 days** and the AI goes down exactly the way it is down now, with
no warning. Worth an uptime check on `https://ai.sivantech.online/health` so
the next occurrence is noticed by a monitor rather than by a user.

---

## Rollback

There is none, by choice — the Render fallback (`sivan-ai.onrender.com`) is
suspended (`x-render-routing: suspend-by-user`) and the decision has been made
to leave Render. So this is the only path, and the money paths are unaffected:
payments, withdrawals and transfers do not touch the AI service. It is one
feature offline, not an outage.

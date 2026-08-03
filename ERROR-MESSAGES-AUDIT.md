# Error messages — end-to-end audit

Triggered by one screenshot. Fixed, tested, deployed, and re-verified live on
`test-sivan.sivantech.online`.

---

## What you saw

```
Bank verification is unavailable right now (provider: breet).
Breet: failed to validate bank account.
```

**Three failures, and only the third is cosmetic.**

1. **It named our provider.** A commercial relationship, an attack surface, and
   none of the user's business. It tells anyone probing which upstream to hit.
2. **It claimed an outage that was not happening.** Breet was up. It had
   answered, and its answer was "no". Blaming an outage tells the user to come
   back later when the thing that would help is re-reading their digits.
3. **It gave them nothing to do.**

---

## The bug underneath the bug

You were on **`app.sivantech.online` — production**. I ran the same call against
Breet directly:

```
BREET_ENV=production + the keys we hold
  -> {"success":false,"message":"wrong app id and secret combination"}
```

**Production is configured as live but holds sandbox keys.** So *every* bank
check on the production app fails, and the old message disguised that as "your
account number is wrong". Now it says "this is on our side", which is true and
makes the real problem visible.

The sandbox is fine — `7061547698` at OPay resolves to *Samuel Udochukwu*, as
does `0000000001`, which is its own known issue.

---

## Three layers, deliberately

A leak here is seen by a customer, so one redundant check costs nothing.

**1 — At the call site.** `bankResolutionMessage()` separates whose fault it is:

| Upstream said | User sees |
|---|---|
| declined / not found / invalid | *"We could not confirm that account. Check the account number and that you picked the right bank, then try again."* |
| bad key / timeout / 5xx / rate limit | *"We could not check that bank account right now. This is on our side, not yours…"* |

That distinction matters: a user **cannot** fix a bad API key by retyping, so
telling them to check their digits sends them round a loop with no exit.

**2 — A sweep in the API error handler.** Every message leaving the API is
checked for provider names and internals before serialisation, so the next one
nobody thought about is caught too. The raw text still reaches the log and
Sentry — asserted explicitly: the log contains `Breet: wrong app id and secret`
while the response does not.

**3 — `userFacingMessage()` in the frontend.** `App.tsx` echoes `error.message`
into a toast in **23 places**. Sanitising the single `notify()` funnel covers
all of them, including ones added later. A test asserts no `setToast` bypasses
it.

Error **codes** are never rewritten, only messages — the frontend switches on
`error.code`.

---

## Verified live, after deploy

```
before: "Bank verification is unavailable right now (provider: breet).
         Breet: wrong bank id selection"
after:  "We could not confirm that account. Check the account number and
         that you picked the right bank, then try again."
```

And the real modal, driven in a browser: type `7061547698` at Access Bank →
resolves to **Samuel Udochukwu** with *"Yes, that is me"*. No provider name
anywhere on the page.

---

## Tests

- **`test:no-internal-leaks` — 54 assertions.** Sweeps signup, sign-in, OTP,
  bank resolution, quotes, withdrawals and support, checking every
  human-readable string against a denylist of 14 provider names plus internals.
- **`e2e/error-messages-journey.mjs` — 9 assertions in a real browser.** On its
  first run it caught the *deployed* API still leaking, which is exactly what a
  user saw at that moment.

### Mutation testing found three fake tests before it found anything else

This is the part worth recording:

1. **Restoring the exact production message passed.** The suite runs
   `NGN_PROVIDER=mock`, so it never entered the Breet branch at all. Now
   exercised in a subprocess with credentials forced wrong — because `env.ts`
   parses once at import, so a cache-busting re-import does not work.
2. **Removing the error-handler sweep passed**, because nothing leaked at source
   any more. The net now has its own test through a real Fastify instance.
3. **Emptying the provider denylist passed**, because iterating the exported
   list is vacuous when the list is empty. The names are asserted literally now.

A fourth: the browser suite **silently skipped the screen it was written for** —
the modal opens on the bank-search step, so the account field did not exist yet.
It printed "skipping" and reported success. Caught by looking at the screenshot
rather than the summary line.

All other suites green: verification-summary 62, session-autoapprove 31,
ngn-payout-accounts 66, kyc-policy 78, name-match 52, console-clean 10,
failure-paths 55, full-system 71, breet-e2e 41, operational-health 38,
kyc-ngn-gate 16.

---

## What you should do next

1. **Get live Breet credentials.** Bank verification is broken for every real
   user on production right now — the fix makes it *honest*, not *working*.
   Until then, `BREET_ENV=production` with sandbox keys will fail every check.
2. The user frontend on Vercel is still not auto-deploying; the layer-3 guard
   ships when it does. Layers 1 and 2 are live on the API already.

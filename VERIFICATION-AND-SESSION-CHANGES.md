# Bank auto-approval + sessions — done, and verified on the live test API

Everything below was checked by curling `sivan-payments-api-test-x9xq.onrender.com`
after deploy, not by reading the diff.

---

## 1. Your screenshot: "JONATHAN BENJAMIN HART needs a quick manual check"

**Two separate bugs were stacked on top of each other.** Fixing either alone
would not have cleared that screen.

### Bug A — an omitted middle name was treated as a possible stranger

The matcher sent a case to a human whenever the bank held *any* name the user
had not declared. That is far too blunt for the commonest shape there is: you
typed "Jonathan Hart", the bank has "JONATHAN BENJAMIN HART". One person, one
missing middle name.

The rule is now **positional**:

| declared | bank | before | now |
|---|---|---|---|
| Jonathan Hart | JONATHAN **BENJAMIN** HART | review | **auto-approve** |
| Chinedu Okeke | CHINEDU **ADEYEMI TUNDE** OKEKE | review | **auto-approve** |
| Sharafa Ogunmepon | OGUNMEPON SHARAFA **ADEBAYO** | review | **review** |
| Sharafa Ogunmepon | **ADEBAYO** SHARAFA OGUNMEPON | review | **review** |
| Chinedu | CHINEDU | review | **review** |

If the bank's **first and last** tokens are both accounted for, whatever is left
can only be interior — a middle name. An unexplained token at the *start* or
*end* is a surname, and sharing two common Nigerian names with a different
surname is exactly the different-person case the check exists to catch. Those
still wait for a human. The two-token floor still sits underneath, so a lone
shared first name can never auto-approve.

### Bug B — a clean match still could not auto-approve outside production

`trustworthy` was hardcoded to `BREET_ENV === 'production'`, so on api-test
**every** account — including a perfect match — was parked at `pending_review`.
The auto-approval path could not be exercised at all. There were **39 queued
cases on api-test and every single one was a 100% match** that needed no review.

`NGN_TRUST_SANDBOX_BANK_RESOLUTION=true` makes the test rig behave like
production.

**This flag is genuinely dangerous** and is fenced accordingly. Breet's sandbox
resolves *any* ten digits to the API key owner — re-verified live: PalmPay
`0000000000`, `1234567890`, `9999999999` and Access `8102524846` all return
"Samuel Udochukwu". So the service **refuses to boot** if it is ever set against
a live bank resolver or a production deployment.

### Verified live

```
resolve PalmPay 8102524846        -> trustworthy: true
"Samuel Udochukwu" exact match    -> status: verified, level 1   ← no admin wait
"Samuel Benjamin Udochukwu"       -> status: verified            ← extra middle name
"Chinedu Okafor" vs that account  -> status: rejected, level 0   ← still refused
```

---

## 2. Admin panel — where the manual reviews live

They land in **Name review** in the sivan-payment module sidebar. Two changes:

- **A count badge on the tab**, like Risk queue and Support. A review *blocks a
  real user from their first payout*, so a queue nobody notices is a silent
  outage. You no longer have to go looking.
- **The queue distinguishes its two jobs.** A real name judgement vs a case
  queued only because the resolution came from a sandbox. All 39 on api-test are
  the second kind (`reviewReason: unverified_source`, confirmed live) — mixed
  into one list they drown the cases that need a person, and train an operator
  to approve without reading.

---

## 3. Sessions — you were right, and the cause was worse than the timeout

**The token had a hard 60-minute expiry and there was no refresh endpoint
anywhere in the service.** Every session died at the hour mark on whatever
screen you were on, mid-withdrawal included. The first sign of it was a click
that failed.

Three separate causes, all fixed:

1. **No renewal at all.** `POST /api/auth/session/refresh` now renews a
   still-valid token, so the hour runs from your *last activity* rather than
   from login. An **expired token cannot renew itself** — verified live, 401.
   Deliberately not a long-lived refresh token: that is a second credential with
   a bigger blast radius. A 12-hour JWT would "fix" the complaint by making a
   stolen token valid for 12 hours.

2. **Every 401 logged you out.** A 401 is also what an endpoint returns when it
   needs auth and none was sent, and api-live sleeps on Render's free tier — a
   proxied call was measured taking **34 seconds** to fail with
   `UPSTREAM_UNAVAILABLE`. Killing a valid session over infrastructure is how an
   hour-long token feels like minutes. Only `invalid_token` / `auth_required`
   end a session now.

3. **The client idle timer was 30 minutes against a 60-minute token** — two
   different numbers for the same thing, so it could sign you out while your
   token was still valid *and blame inactivity*. Both are 60 now.

Renewal also fires on **returning to the tab**, not just on a timer:
`setInterval` is throttled in a background tab and does not run at all while a
laptop is asleep, so a skipped tick meant the token expired before the next
attempt.

**On your 30-vs-60 question:** 60 minutes *idle* is the right ceiling, and it is
now what you get — but the sliding window matters more than the number. While
you are using Sivan you are never signed out; the hour only applies once you
walk away. Longer than an hour idle means a session left open on a shared
machine stays usable most of a working day, with the balance and withdrawal
screens behind it. I would not go past 60.

---

## Tests

`session-autoapprove` **31 (new)**, `name-match` 42 → **52**.

Green: settlement-reconciliation 37, console-clean 10, failure-paths 55,
breet-e2e 41, full-system 71, ngn-payout-accounts 66, kyc-policy 78,
verification-summary 54, kyc-ngn-gate 16, offramp-autosettlement 11,
operational-health 38, no-mock-in-production 17, two-factor, migrations 13.

**Eleven mutations, every one caught meaningfully** — dropping the positional
check, reverting to always-review, checking only the first or only the last
token, removing the boot guard, keying it only on the provider, letting an
expired token refresh, hardcoding trustworthy false, logging out on any 401, and
dropping the idle timeout back to 30.

The boot-guard test runs in a **separate process**: `env.ts` parses once at
import, so re-importing `app.js` with a cache-busting query does not re-read it —
my first version of that test passed for the wrong reason. It also asserts the
same process boots fine *without* the flag, so it cannot pass on an unrelated
startup failure.

---

## Corrections I have to make

- **My boot guard was wrong.** I keyed it on `APP_ENV === 'production'`.
  api-test runs `APP_ENV=staging` — confirmed by curling `/health/operational`.
  Upstream's version keys on the *provider* being live, which is the real
  hazard; a production-or-staging check would have crash-looped the exact rig
  the flag exists for. Took theirs.
- **Upstream found a bug I missed:** `crypto.timingSafeEqual` throws
  `RangeError` on a length mismatch, so a truncated JWT signature returned
  **500 instead of 401**.
- **My session hook was weaker.** It refreshed on an interval only, missing the
  sleeping-laptop case. Took theirs.
- The merge left a duplicate env key, a duplicate variable declaration, and a
  duplicate route registration that **crashed boot** with
  `FST_ERR_DUPLICATED_ROUTE`. All three were caught by running the suite, not by
  reading the merge.

---

## Still open

1. **`BREET_WEBHOOK_SECRET` is still mismatched** — webhooks still 403. No
   longer blocks settlement (the reconciler heals it within 5 minutes) but worth
   fixing so it is seconds.
2. **`NGN_TRUST_SANDBOX_BANK_RESOLUTION` must stay false on api-live.** It is
   pinned explicitly in `render.yaml` and the service refuses to boot otherwise.
3. **39 stale queued rows on api-test** — all perfect matches from before the
   flag. Harmless, now labelled, and can be bulk-approved or left.
4. api-live is unchanged (`autoDeploy` false). All of this is on api-test.

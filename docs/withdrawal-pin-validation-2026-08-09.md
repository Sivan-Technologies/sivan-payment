# Withdrawal PIN — live validation

**Date:** 2026-08-09
**Against:** local API, real Postgres, `WITHDRAWAL_PIN_ENFORCED=true`
**Account:** a real developer account with a linked Telegram identity and a saved
payout account. Identifiers, the PIN and the destination account number are
deliberately omitted — see "A note on this document" at the end.


Every result below is an HTTP response from a running server, not a unit test with
mocked internals. The NGN provider is `mock`, so no real naira moved; the code path
up to and including the provider call is the production one.

---

## The result that matters

A real NGN off-ramp transfer — `ngnt_3656568a-f531-4a21-a3af-08f7fb37d6e6`,
5 USDC → ₦7,350 — was created **only** on the request that carried the correct PIN.
The four requests before it, differing only in what they presented for
authorisation, were all refused. The control gates money movement, not a
screen in front of it.

---

## Rail 1 — Bridge (`POST /api/withdrawals`)

| # | Request | Result | Code |
|---|---------|--------|------|
| 1 | no PIN, none ever set | refused | `PIN_NOT_SET` — "Set a withdrawal PIN before you withdraw." |
| 2 | no PIN, PIN exists | refused | `PIN_REQUIRED` — "Enter your withdrawal PIN to approve this withdrawal." |
| 3 | wrong PIN `999111` | refused, 403 | `PIN_INVALID` — "That PIN is not correct." |
| 4 | correct PIN | **passed the guard** | advanced to business validation |

1 and 2 differ by design. A user who has never set a PIN needs Settings; a user
who has one needs a prompt. One code for both would send someone who already has
a PIN to a page telling them to create it.

## Rail 2 — NGN / Breet (`POST /api/ngn/offramp/orders`)

The rail that would have made the whole control theatre, since changing the
destination currency to NGN is not an attack so much as a menu choice.
Run against a real quote `ngnq_f99a4a64…` (5 USDC → ₦7,350).

| # | Request | Result | Code |
|---|---------|--------|------|
| 5 | no PIN | refused | `PIN_REQUIRED` |
| 6 | wrong PIN `246813` | refused | `PIN_INVALID` |
| 7 | step-up token bound to **another account** (`9999999999`) | refused | "These withdrawal details changed after you confirmed." |
| 8 | step-up token bound to **another amount** (`999999`) | refused | same |
| 9 | correct PIN | **transfer created** | `ngnt_3656568a…`, `awaiting_crypto_deposit` |

7 and 8 are the replay attacks the binding exists to stop, and they are refused
on the rail whose request body is only `{ userId, quoteId }` — the one where it
would have been easiest to shrug and skip the check.

## PIN handling

| Check | Result |
|-------|--------|
| Weak PIN `111111` | refused — "avoid repeating the same digit" |
| Weak PIN `123456` | refused — "avoid running sequences like 123456" |
| PIN in server logs | **0 occurrences** across the entire run |

## Chat channel (Telegram)

| Check | Result |
|-------|--------|
| `withdrawal-pin-status` for the linked identity | `{"hasPin":true}` — bot prompts |
| Same call for an unknown identity | `{"hasPin":false}` — byte-identical to an account with no PIN |
| Wrong PIN over Telegram | `403 "That PIN is not correct."`, **no token minted** |
| Correct PIN over Telegram | token minted, bound to amount + currency + destination, ~2 min expiry |

The unknown-identity answer matters: distinguishing "no such account" from
"account without a PIN" would turn this endpoint into an account-existence
oracle for anyone holding the bot secret.

---

## Two things this run corrected

**1. The error code is at `error.details.code`, not `error.code`.**
`error.code` is the HTTP class (`bad_request`, `forbidden`); the actionable code
is nested one level down:

```json
{"error":{"code":"bad_request",
          "message":"Set a withdrawal PIN before you withdraw.",
          "details":{"code":"PIN_NOT_SET"}}}
```

Any client branching on `PIN_NOT_SET` vs `PIN_REQUIRED` must read
`error.details.code`. A client reading `error.code` sees `bad_request` for both
and cannot tell "go to Settings" from "enter your PIN". This is worth stating
plainly in the handoff, because it is invisible until someone builds the UI and
finds both branches behaving identically.

**2. `GET /api/ngn/quote` takes ~62 seconds locally.**
Not a hang and not caused by this work — the mock provider is simply slow on
this path. It cost two failed runs here; anyone testing this rail should budget
a 90-second timeout, and it is worth a look on its own merits before launch.

---

## Still open

**The bots cannot prompt for a PIN.** There is no PIN code in the Telegram or
WhatsApp layer — no prompt, no call to `/api/identity/verify-pin`, no forwarding
of a step-up token. The API half is proven and waiting; the chat half does not
exist yet.

The consequence is specific and worth being blunt about: enabling
`WITHDRAWAL_PIN_ENFORCED=true` today refuses **every chat-initiated withdrawal
on both rails**, because the bots have nothing to send. Web users can set a PIN
in Settings and withdraw normally.

Deploy order:

1. Ship the API with the flag **off** (its default) — no behaviour change.
2. Ship the bot prompt and the web PIN card.
3. Give users a window to set a PIN.
4. Then, and only then, turn the flag on.

## Reproducing

```bash
cd sivan-payment && WITHDRAWAL_PIN_ENFORCED=true npm run dev
bash /tmp/pin-e2e.sh      # rail 1 + PIN management
bash /tmp/rail2.sh        # rail 2 + step-up binding (needs a fresh quote id)
```

Note the assertions read `.error.details.code`. An earlier version of these
scripts read `.error.code` and reported five false failures against code that
was behaving correctly.

---

## A note on this document

The account identifiers, the PIN and the destination account number used in this
run are deliberately not written down here. The PIN in particular is a live
credential on a real account: a validation report is exactly the kind of file
that gets pasted into a ticket, forwarded to a reviewer, or pushed to a repo
that is public tomorrow, and a working PIN sitting in it would outlive the test
that needed it. The transfer and quote ids are kept because they are references
to test records, not credentials.

If you re-run this, use a throwaway account, and rotate the PIN afterwards if
you used a real one.


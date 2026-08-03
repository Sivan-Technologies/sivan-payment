# The first naira settlement — what actually happened

**Status: SETTLED.** `ngnt_88faa345-94b6-4f01-baa0-d8d53e8c6b0f` = `completed`, 15:51:25Z.

---

## The headline

**The money was never stuck. Sivan just never found out.**

Breet had already done the whole job, at 15:03 — about a minute after the USDC
landed:

| | |
|---|---|
| Trade `6a70adbe0b4ad380586424a1` | `completed`, 59 USDC @ 1605 |
| Withdrawal `6a70adbea4f8526669d89013` | `completed`, **94,171 NGN** |
| Bank | PalmPay **8102524846**, Samuel Udochukwu |
| Fee | 50 NGN |
| On-chain | `0x5a4a1b8f...a846a192` |

The naira reached the bank at **15:03:27**. Sivan's record said
"awaiting_crypto_deposit" until **15:51:25** — 48 minutes of a completed payout
looking, on screen, exactly like a deposit that never arrived.

That gap is the actual defect. A user in that state sends again.

---

## The secret was the least of it

Three independent bugs. **Each one strands the money on its own**, so fixing the
secret alone would have changed nothing.

### 1. The confirmation call hit an endpoint that does not exist for trades

`verifyWebhook` re-fetches the transaction from Breet before trusting the body —
correct, and Breet's own advice. It fetched `GET /transactions/:id`.

```
GET /v1/transactions/6a70adbe0b4ad380586424a1
{"success":false,"message":"Sorry, requested URL ... not found!"}
```

Trades live at `/trades/sell/:id`. And `GET /transactions` returns an **empty
list** even with a completed trade on the account — sell trades never appear
there.

`"not found"` is precisely the string the anti-forgery check matches. So every
genuine `trade.completed` Breet ever sent would have been rejected as
**fabricated** — *after* passing the secret check.

Mutation-proven against live Breet: reverting the path makes
`breet:settlement-check` fail.

### 2. The id in the webhook is not the id we stored

One settlement, three different ids:

| Event | id it carries | matches our record? |
|---|---|---|
| `trade.address.created` | address `6a70ad8c...` | ✅ (and useless) |
| `trade.pending` / `trade.completed` | trade `6a70adbe...` | ❌ |
| `withdrawal.*` | withdrawal `6a70adbe...9013` | ❌ |

We store the **address** id, because that is all Breet returns when the address
is generated. So `trade.completed` — the event that finishes the transfer —
matched no row and was silently dropped by `if (!transfer) return undefined`.

Now matched on the deposit address (case-insensitively; Breet checksums, we may
not), with each id learned as it arrives so the next event resolves exactly.

### 3. `trade.completed` was being read as "the user has their money"

It is not. It means the crypto became naira **inside Breet**. Only
`withdrawal.completed` means it reached the bank — and on an account without
autoSettlement it may never leave.

Now: completed trade → `settlement_processing`; completed withdrawal →
`completed`.

---

## The fix that makes all three survivable

**Settlement no longer depends on a webhook arriving.**

`NGN_SETTLEMENT_POLL_SECONDS` (default 300) reconciles against Breet's own
record. Delivery is now an *optimisation* — it makes settlement fast — rather
than the mechanism money depends on.

Reconstructed from the two endpoints that actually work:
`GET /payments/withdrawals` → each names its `.trade` → `GET /trades/sell/:id` →
the trade carries the deposit address, which is the only durable link back to a
Sivan transfer.

Idempotent, forward-only, never re-settles a terminal transfer, and reports what
it could not match instead of swallowing it. **This is what healed the live
transfer, at boot, with the webhooks still 403ing.**

Also on demand: `POST /api/admin/ngn/reconcile-settlements`.

---

## Two more bugs, found by testing the above

- **A second event erased the first's figures.** The trade knows the crypto
  amount, the withdrawal knows the naira. Writing every field on every event
  blanked the ones that event did not carry, so reconciliation lost the amounts.
- **`amount` means two different things.** Crypto on a trade, naira on a
  withdrawal. The shared fallback chain recorded 94,221 NGN as **94,221 USDC** —
  wrong by a factor of the exchange rate.

---

## The two console errors

**`GET /api/ngn/networks 401`** — an authenticated endpoint called from the
bootstrap effect on the **landing page**, before anyone could have a token.
Guaranteed to fail, result discarded by `.catch(() => null)`. Its only effect
was a red line on the first screen every visitor sees, plus a wasted round trip
per load. Now gated on `authToken`.

**`GET /api/customers/:id/kyc-status 404`** (twice — the view polls) — this is
the normal state of **every Nigerian user**. They verify by bank check and never
get a Bridge customer. The sibling route `GET /api/customers/:userId` had
already decided this is an absence and returns `null`; this one disagreed, and
the inconsistency was the bug. The frontend was compensating by regex-matching
the error *prose*.

Now returns `null`, narrowed to `not_found` so a genuine Bridge outage still
surfaces rather than being reported to a verified user as "you have no
verification record".

Neither was cosmetic: a console that cries wolf on the first screen is how a
real error gets missed.

---

## Tests

| Suite | |
|---|---|
| `test:settlement-reconciliation` | **37, new** |
| `test:console-clean` | **10, new** |
| `breet:settlement-check` | **6, new — hits real Breet** |
| `test:failure-paths` | 54 → 55 |
| `test:full-system` | 68 → 71 |
| `test:breet-e2e` | 41 |

Everything else green: offramp-autosettlement 11, autosettlement 11,
operational-health 38, verification-summary 54, kyc-policy 78,
ngn-payout-accounts 66, migrations 13, breet-flagged 18,
no-mock-in-production 17, controls, transaction-timeline.

**Three existing assertions asserted the old, wrong semantics** (`the transfer
settles -> completed` on a trade event) and were corrected with the reason
stated in the source.

**Four mutations initially did NOT fail** — the forward-only rule, the terminal
check, the narrowed catch, and `keepKnown` were all decorative. Each test was
fixed until the mutation fails meaningfully.

I also broke my own file with a stray `git checkout` mid-session and rebuilt it;
the suite is what caught that too.

---

## Still open

1. **`BREET_WEBHOOK_SECRET` still mismatched** — webhooks still 403. No longer
   blocks settlement, but fix it so settlement is seconds rather than up to five
   minutes. Breet → Settings → For Developer → Webhook Verification Secret Key →
   set on Render → **Manual Deploy → Restart** (env is an import-time snapshot).
2. **`transfers_stuck_in_flight = 15`** — abandoned test orders that were never
   funded. This is the off-ramp expiry work (Part B of the spec), not a new
   fault.
3. **api-live is unchanged** — `autoDeploy` is false. This fix is on api-test
   only.
4. Credential rotation, Cloudflare worker deploy, AWS migration — unchanged.

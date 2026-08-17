# Naira settlement: deploy, repair, verify

Written after a real payout on 2026-08-14 reached a customer's bank while the
app kept showing **"settlement processing"** for another day.

Everything below was measured against the live system or a running server. No
step says "should work" — each one names what you will see if it did.

---

## What was broken, in one paragraph

Breet pays out in **two separate lifecycles**. `trade.completed` means the
crypto was converted and Breet credited *its own* balance. The customer's bank
is only paid on `withdrawal.completed`, a different event with a different id.
Sivan mapped that correctly — but could not **match** the withdrawal event to
an order, so it was received and discarded. Three separate faults, all fixed:

| Fault | Effect |
|---|---|
| `withdrawal.completed` carries no address, txHash or label — only ids we never stored | The webhook was dropped silently |
| Per-address auto-settlement was recorded as `true` without ever being enabled | Payouts went through **business-wide** settlement — every customer's naira to one account |
| The reconciler matched by deposit address, which Breet **reuses** | With several orders on one address, only the oldest could ever complete |

---

## 1. Deploy

The fixes are on `main`. **Nothing changes for users until Render redeploys.**

```
main       557e3c4 or later
airspexta  188f765 or later
```

Confirm the deploy actually shipped, rather than assuming:

```bash
curl -s https://api.sivantech.online/api/payment/health
```

Then confirm the *new code* is running, not just that the service is up — the
`ngn.webhook_unmatched` audit action only exists after this deploy:

```bash
curl -s https://api.sivantech.online/api/payment/api/admin/audit-logs?action=ngn.webhook_unmatched \
  -H "x-admin-api-key: $ADMIN_KEY"
```

A `200` with an empty list means the new build is live and nothing has been
dropped since. A `404` or an error means the old build is still serving.

---

## 2. Repair the orders that are already stuck

Two withdrawals currently read "settlement processing" though the naira
arrived. Both are recoverable — no data was lost, only the status is wrong.

**Option A — run the reconciler on demand** (preferred, fixes all at once):

```bash
curl -s -X POST https://api.sivantech.online/api/payment/api/admin/ngn/reconcile-settlements \
  -H "x-admin-api-key: $ADMIN_KEY"
```

It returns `{ matched, advanced, unmatched }`. `advanced` names every transfer
it moved. The same routine also runs automatically every
`NGN_SETTLEMENT_POLL_SECONDS` (default **300**), so doing nothing also works —
this is just faster.

**Option B — resend the webhook from Breet.** In the Breet dashboard, open
Settings → Developer → Webhook Logs, find the `Completed Withdrawal` entry and
press **Resend Webhook**. With the fix deployed it will now match.

**If an order still will not move**, it is genuinely ambiguous — two open
orders for the same naira amount on the same address, where the payout cannot
be attributed safely. That is deliberate: completing an arbitrary one would
tell a customer their money arrived when a different order was paid. Resolve
it by hand:

```bash
curl -s -X POST https://api.sivantech.online/api/payment/api/admin/ngn/transfers/<id>/retry \
  -H "x-admin-api-key: $ADMIN_KEY"
```

---

## 3. Warm the existing Breet wallets — do this before any demo

**This is the step most likely to bite you.**

Existing wallets still have `autoSettlement: false` at Breet. The fix applies
**at order creation**, so the *next* off-ramp per asset either enables it
properly or **refuses loudly**.

That refusal is intentional — better to fail than hand a customer a deposit
address whose funds will never reach their bank. But it means the first real
order after deploy is the experiment.

So run **one small throwaway off-ramp per asset** (USDT and USDC) first. What
you should see:

- the order is created, and
- `metadata.transferMetadata.autoSettlementProof` reads
  `autoSettlementEnabled: true` with `verifiedFromProvider: true`.

`verifiedFromProvider: true` is the important one — it means Breet *reported*
the flag on when we read it back, rather than us assuming a `200` on the write
meant success. That assumption was the original bug.

If creation fails with `Breet: could not enable auto-settlement on this payout
wallet`, the wallet has no linked bank at Breet. Link it in the dashboard and
retry; do **not** work around it.

---

## 4. Verify a real payout end to end

One small off-ramp, watched the whole way:

| Stage | Expected status | Comes from |
|---|---|---|
| Order created | `awaiting_crypto_deposit` | order creation |
| Crypto detected | `blockchain_confirmed` | `trade.pending` |
| Converted | `settlement_processing` | `trade.completed` |
| **Bank paid** | **`completed`** | **`withdrawal.completed`** |

If it stops at `settlement_processing` and the money *has* arrived, the
withdrawal event was not matched. Check for it:

```bash
curl -s "https://api.sivantech.online/api/payment/api/admin/audit-logs?action=ngn.webhook_unmatched" \
  -H "x-admin-api-key: $ADMIN_KEY"
```

Before this work an unmatched webhook was **invisible** — delivery succeeded,
Breet showed `200`, and nothing recorded that the event had gone nowhere. That
is precisely why it ran unnoticed for a day. Now it is an error-severity log
naming the event, the trade ref and the amount.

---

## Per-address vs business-wide auto-settlement

Worth stating plainly, because the difference decides where customer money
lands.

| | Per-address (API) | Business-wide (dashboard) |
|---|---|---|
| Destination | The bank linked to **that** wallet | **One** account for everything |
| Set by | `PUT /trades/wallets/{id}/bank` + `PUT /trades/wallets/{id}/auto-settlement` | Settings → Automatic Settlement |
| Correct for Sivan | **Yes** — each customer paid their own bank | No — every customer's naira to one account |

The 2026-08-14 payout arrived via **business-wide** settlement, because
per-address was never actually enabled. That is survivable for a single
operator testing alone and completely wrong with real customers.

**Turn business-wide auto-settlement OFF** once per-address is confirmed
working, or a misconfigured wallet will keep silently falling back to it and
hide the same failure again.

---

## What protects this now

Guards, each with a test that fails when the guard is removed:

- `test:breet-withdrawal-completion` — the verbatim production payload
  completes the order, driven through `recordNgnWebhook`, the real entry point
- `test:breet-withdrawal-orphan` — the amount-based last resort
- `test:reconciler-address-reuse` — three orders on one reused address
- `test:breet-autosettlement-wallet` — both provider writes, the read-back, and
  refusal when Breet reports the flag still off
- `test:ngn-sweep-autosettlement-guard` — user funds are never swept into a
  wallet that cannot pay out

Matching order, strongest evidence first:

1. exact ids — `breetTradeId`, `breetWithdrawalId`, `breetAddressId`
2. `txHash`
3. the trade lookup — `GET /trades/sell/{id}` resolves the address a
   withdrawal payload does not carry
4. deposit address, scored by amount and recency
5. payout amount over open naira off-ramps — **exact or nothing**

Step 5 refuses when two orders could equally claim a payout. Leaving one order
pending is recoverable; telling the wrong customer their money arrived is not.

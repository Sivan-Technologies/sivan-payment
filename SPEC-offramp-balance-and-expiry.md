# Spec — sell from Sivan balance, and expire open off-ramp orders

Two changes, written to be executable the moment a first real settlement is
proven. Both came from the product's own questions; both are genuine gaps I
verified rather than assumed.

**Do not build these before the first settlement lands.** Reasoning at the end.

---

## ⚠️ THE ONE THING TO SET ASIDE RIGHT NOW

**No naira has ever reached a bank account. On any environment. Not once.**

Everything else in this repository is tested to an unusual standard — 429
backend assertions, 77 browser assertions, mutation tests on every guard, zero
criticals on production health. That work is real. It also all stops one step
short of the only thing the product exists to do.

The evidence, checked rather than remembered:

| | |
|---|---|
| NGN transfers on production | **0** |
| Ever settled, any environment | **0** |
| Provider webhooks on production | 1 — and it is a PajRamp artifact from 1 Aug, not a Breet settlement |
| Transfers on test | 14, all `awaiting_crypto_deposit`, none ever funded |

So the entire back half of the pipeline is unproven: crypto lands at Breet →
Breet converts → Breet pays the NUBAN → webhook fires → we mark it settled.
Every step before that is proven to death. **Not one of those five has ever
run.**

### Why this outranks everything else on the list

It is not the largest task. It is the one that can invalidate the others.

Both parts of this spec attach to that pipeline — Part A funds it
automatically, Part B decides when it has given up waiting. Writing either
against a pipeline that has never completed means inventing its failure modes.
A single real settlement tells us how long Breet takes to detect a deposit,
whether `trade.pending` really precedes `trade.completed`, and what the webhook
body actually contains. **That evidence should set the TTL and shape the
funding flow — not a number I picked in the abstract.**

The same applies beyond this spec. Credential rotation, the AWS migration and
the remaining polish are all deferrable. This is not, because it is the only
open item that could reveal the product does not work.

### What is already in place for it

| | |
|---|---|
| Funded wallet | `0x6d7D2Eb4667395437739634D3382A90Fff238295` — **59.59 USDC** on Base Sepolia |
| Above Breet's floor | yes, $50 minimum cleared; the API now accepts the order |
| Sivan can sign for it | verified, `personal_sign` → HTTP 200 |
| Gas | sponsored, proven on-chain with **0 ETH** in the wallet |
| Chains line up | Privy signs Base Sepolia; Breet's asset is "USD Coin (Base Testnet)" |

### The only things still missing

1. **Breet webhook URL** set to `https://test-sivan.sivantech.online/api/payment/api/webhooks/breet`
2. **`BREET_WEBHOOK_SECRET`** on api-test matching Breet's dashboard value
   byte-for-byte. The handler fails closed — a mismatch means every webhook
   403s and the settlement silently never completes.

Two configuration steps. Then the run takes minutes.

### One related unknown, same theme

Production reports `ngn_provider: breet, with credentials` — but that check
only confirms the env vars are **non-empty**. It never calls Breet. A sandbox
key sitting on production would 401 on every bank lookup and the signal would
still read `ok`. One command settles it, with the live admin key:

```bash
curl -s https://api.sivantech.online/api/payment/api/admin/ngn/provider-health \
  -H "x-admin-api-key: <LIVE_KEY>" | jq .data.active
```

Want `available: true` and `mode: "live"`. If it says `sandbox`, no Nigerian
can verify a bank account on production.

---

## Part A — auto-detect balance, fall back to a deposit address

### The behaviour asked for

> if user has balance in wallet then it should autodetect from the user balance
> first, but if no balance then it can display a deposit address

Agreed, with one important refinement below.

### Why this is small

`requestBalanceTransfer()` in `src/balances/balance.service.ts` is already
almost this feature. It:

- refuses when transfers are disabled, or the network is disabled
- enforces the minimum send amount
- **validates the destination address for the specific chain** before anything
  else, so a Solana address can never be used for a Base send
- refuses when the settled balance is insufficient
- places a `hold` ledger entry, then debits
- routes amounts over `manualReviewThreshold` to `pending_review`
- calls the wallet provider to actually sign and broadcast

The only difference for our case: the destination is **Breet's deposit address
from the off-ramp order** instead of an address the user typed.

Everything else already exists and is proven:

| piece | evidence |
|---|---|
| Backend can sign a user-owned wallet | `privy:delegated` 36/36 live; production quorum signs HTTP 200 |
| Gas sponsorship | proved on-chain: 0.01 USDC moved from a wallet holding **0 ETH**, sponsor `alchemy` |
| Per-chain address validation | `validateAddressForChain`, mutation-tested (removing it fails 4 assertions) |
| Breet address on the record | `NgnTransferRecord.depositAddress` |

### THE REFINEMENT THAT MATTERS

Do **not** silently auto-send. Detect the balance, then **ask**.

Moving a user's funds without an explicit confirmation on that specific screen
is the kind of thing that is technically correct and still feels like theft.
The flow should be:

```
user has >= amount settled in Sivan
  -> "Pay from your Sivan balance"  [primary button]
     "or send from another wallet"  [reveals the deposit address]

user has < amount
  -> deposit address shown directly, exactly as today
```

One tap, but a deliberate one. The deposit address must remain reachable in
BOTH cases — a user may hold a balance and still prefer to send from Binance,
and taking that choice away is a regression for them.

### Endpoint

`POST /api/ngn/offramp/orders/:transferId/fund-from-balance`

```
body: { userId }
```

Server-side, in order:

1. Load the transfer. Refuse unless `status === 'awaiting_crypto_deposit'`.
2. **Idempotency.** Refuse if a funding attempt already exists for this
   transfer id. This is the single most important guard in the change: if the
   send succeeds but the HTTP response is lost, a retry must not send twice.
   Key on `transferId`, not on a request id the client controls.
3. Re-read `depositAddress` from the transfer **server-side**. Never accept a
   destination from the client — a client-supplied address here is a
   drain-the-wallet bug.
4. Delegate to the existing `requestBalanceTransfer` path with that
   destination, so every guard above is inherited rather than reimplemented.
5. Record the resulting tx/userOp hash on the transfer.

### Failure states that must be handled

The user must never be left with funds gone and no naira, and must always know
which of these they are in:

| state | user sees |
|---|---|
| insufficient balance | "You have X, this needs Y" — and the deposit address, so they are not stuck |
| send fails before broadcast | hold released, balance restored, "nothing was sent" |
| broadcast succeeds, Breet has not credited yet | "Sent. Waiting for Breet to confirm" + tx hash |
| broadcast succeeds, Breet never credits | reconciliation finding + support path. **Never** silently settled |
| duplicate submit | second call returns the FIRST result, does not send again |

### Tests required before this ships

- API suite covering all five states above
- Mutation test the idempotency guard: remove it, confirm a double-submit
  sends twice, restore
- Mutation test the server-side address re-read: make it accept a client
  address, confirm a test catches funds going somewhere else
- Browser journey: balance present → one tap → status advances; balance absent
  → deposit address shown

Estimated: **~1 day** with the tests. Do not do the happy path alone.

---

## Part B — expire open off-ramp orders

### The behaviour asked for

> offramp should have expiration time right so user dont have an open order for
> a long time

Correct, and this gap is real. What exists today:

**The QUOTE expires — 10 minutes, and it IS enforced:**

```js
// ngn-quotes.service.ts
expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()

// ngn-transfers.service.ts:40
if (quote.expiresAt <= nowIso()) throw badRequest('NGN quote has expired.');
```

**The TRANSFER does not expire.** Once accepted, a transfer sits at
`awaiting_crypto_deposit` forever. There is no sweeper, no cron, no TTL — I
checked for `setInterval`, `cron` and `sweep` across the NGN module and found
nothing.

This is not hypothetical. Right now on the **test** environment there are 14
transfers stuck at `awaiting_crypto_deposit` from my own e2e runs, the oldest
from 18:20, and they are what is making the watchdog report
`transfers_stuck_in_flight: CRITICAL`. A real user abandoning a sell does
exactly the same thing.

### Why an un-expiring order is worse than untidy

**The rate is stale.** The transfer holds `rate` and `destinationAmount` from
when the quote was created. If a user funds a three-day-old address, Breet
converts at TODAY's rate but our record promises the OLD naira figure. Someone
is wrong, and the user has a screenshot.

**The address is reusable.** Breet's docs are explicit: sell addresses are
permanent and reusable, and a later deposit to the same address is a genuinely
new transaction. So a stale order does not merely go quiet — it can be funded
long after everyone forgot about it.

**It poisons monitoring.** Abandoned orders and genuinely stuck ones look
identical, so the CRITICAL signal that should mean "a settlement is failing"
becomes noise nobody reads.

### Proposed rule

```
awaiting_crypto_deposit  +  no deposit within TTL  ->  expired
```

- **TTL: 24 hours**, admin-configurable. Long enough for someone to move funds
  from an exchange with a withdrawal hold; short enough that the rate has not
  drifted absurdly.
- Expiry is **advisory, not destructive.** The Breet address stays valid,
  because we cannot un-issue it. Expiring means: stop showing it as an active
  order, stop counting it as stuck, and tell the user plainly.
- **If a deposit arrives after expiry, honour it.** The webhook must still
  settle the transfer, at the rate Breet actually used, with the record marked
  `settled_after_expiry`. Refusing a real deposit because our own timer fired
  would be taking a user's money and giving nothing back. This is the part
  most implementations get wrong.

### Copy

- Before expiry: "This address is valid for another 23 hours."
- After: "This sell expired because we did not receive your crypto. Nothing was
  charged. Start a new sell to get today's rate." — plus the address still
  visible with a warning, in case they already sent.

### Implementation

Not a background worker. A sweeper needs a scheduler, a lock and its own
failure mode. Instead:

1. Add `expiresAt` to the transfer record when the order is created.
2. **Derive** the expired state on read — `listNgnTransfers`, the summary, and
   the admin queue treat `awaiting_crypto_deposit` past `expiresAt` as expired.
   No job, nothing to run, no clock skew between instances.
3. Exclude expired transfers from `transfers_stuck_in_flight`, so the watchdog
   only cries about things that are genuinely wrong.
4. Persist the status lazily when the record is next written.

Estimated: **half a day**, mostly tests.

---

## Sequencing

Build **B before A**.

Expiry is smaller, has no ability to move money, and immediately cleans up the
monitoring signal that is currently CRITICAL for a benign reason. It makes the
system easier to reason about before adding an automated funds movement to it.

Then A, once a settlement has actually completed.

## Why neither ships before the first settlement

The single largest open risk is that **no naira has ever reached a bank
account, on any environment.** Both changes attach to the settlement pipeline:
A funds it automatically, B decides when it has given up waiting.

Building either against an unproven pipeline means guessing at the failure
modes. One real settlement tells us what the states actually look like — how
long Breet takes to detect a deposit, what the webhook sequence really is,
whether `trade.pending` arrives before `trade.completed`. That evidence should
shape the TTL and the funding flow, not the other way round.

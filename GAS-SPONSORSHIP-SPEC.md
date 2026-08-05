# Gas sponsorship: protecting the balance, and the admin Wallet tab

**Status:** spec, awaiting sign-off. No implementation code written.

Written after Privy enabled Solana gas sponsorship and asked Sivan to confirm
it will follow their [security best practices](https://docs.privy.io/wallets/gas-and-asset-management/gas/security).

---

## First, a correction: gas IS cheap. Rent is the cost.

I said gas sponsorship looked expensive. That was imprecise and it matters,
because it points at the wrong fix.

**The transaction fee is negligible.** A Solana transfer is 5,000 lamports:

| SOL price | Transaction fee |
|---:|---:|
| $80 | $0.0004 |
| $150 | $0.0008 |
| $250 | $0.0013 |

At any plausible price the fee is a **tenth of a cent**. Sponsoring a million
transfers costs about $800. You were right to expect it to be cheap.

**What is not cheap is Associated Token Account rent**, and it is a different
thing that happens to be paid by the same wallet. `spl-transfer.ts` defines
`TOKEN_ACCOUNT_RENT_SOL = 0.00203928`:

| SOL price | ATA rent |
|---:|---:|
| $80 | $0.16 |
| $150 | $0.31 |
| $200 | $0.41 |
| $250 | $0.51 |

So the honest statement is: **a transfer costs a fraction of a cent, unless the
recipient has never held this token before, in which case it costs 200-500x
that.** My "$0.35 per transfer" conflated the two and made routine sends look
expensive when they are not.

Two consequences:

- **Do not raise the minimum to $10 on account of gas.** That would price out
  the everyday Nigerian transfer this product exists for, to solve a problem
  that only occurs on first-time recipients. The $5 minimum stands.
- The exposure is **first-time recipients**, not volume. A user sending 500
  transfers to the *same* address costs ~$0.40 total. A user sending 500
  transfers to 500 *new* addresses costs ~$150 and is the actual attack.

---

## Where Sivan already complies

Checked against Privy's page item by item, in the code rather than from memory.

**Their headline Solana threat does not apply to us.** They warn that APIs like
Jupiter append a `CloseAccount` instruction so the user pockets the rent refund
while the app paid to create the account. I grepped the whole backend:
`CloseAccount` appears nowhere. `buildSplTransfer` constructs the instruction
list itself - an optional `createAssociatedTokenAccountInstruction`, then
`createTransferCheckedInstruction` - and nothing else.

**"Route transactions through the backend" is already satisfied.** There is no
path that accepts a client-supplied transaction. `signAndSendTransaction` is
only ever called with a transaction this backend built. Privy's mitigation
(stripping `CloseAccount`) would be a no-op here.

**The rent is already measured.** `buildSplTransfer` returns
`createsRecipientAccount` and `estimatedRentSol`. The number exists; nothing
currently reads it.

So of Privy's 8-item checklist, two are already met and one is not applicable.
The remaining five are below.

---

## The gap, stated plainly

**The rate limiter does not protect this.** `rate-limit.ts` keys on **IP
address**, not user id, at 120 requests/minute. A phone changing networks gets
a fresh bucket; a VPN gives unlimited buckets. Privy asks specifically for
**per-user and per-wallet** limits.

**There is no transfer frequency cap.** The only volume control in the transfer
path is `manualReviewThreshold` at 1000 USDC, which gates **size**, not
**count**. Nothing stops one user making 500 transfers in an hour.

**No circuit breaker, no monitoring.** `operational-health` has ~20 signals and
none watches gas spend or the sponsorship balance. The first sign of trouble
would be transfers failing for reasons unrelated to the real cause.

### The concrete abuse case

Sign up, verify with one Nigerian bank account, then loop 5 USDC transfers to
freshly generated addresses. Each new address costs an ATA creation. At SOL
$150 that is $0.31 of Sivan's money per transfer, against a $0.10 fee.

**Net drain: ~$0.21 per transaction, and the attacker keeps the rent** when
they later close those accounts. That is Privy's rent-refund exploit reached by
a different route - not through `CloseAccount` in our transaction, but through
us funding accounts the user controls.

---

## Proposed, in the order you set

### 1. Per-user daily transfer cap — count, not size

New admin controls beside the transfer fee, since they are the same economic
lever:

```
transferDailyCountLimit       default 20   per user, rolling 24h
transferDailyNewRecipientLimit default 5   NEW addresses per user per day
```

The second is the one that matters. A user paying 20 people they have paid
before costs a cent; a user paying 5 new addresses costs ~$1.50.

**Graduated by account age**, which Privy explicitly recommends ("start with
conservative limits for new accounts"). Given your point about early-phase
users being new, the tiers should be generous enough not to obstruct genuine
first-week use:

| Account age | Transfers/day | New recipients/day |
|---|---:|---:|
| < 24h | 5 | 2 |
| < 7 days | 10 | 3 |
| ≥ 7 days | 20 | 5 |

All admin-settable. Refusal must say *when the limit resets*, never just "limit
reached".

### 2. Charge for the ATA when we create one

`createsRecipientAccount` is already computed and thrown away. Two options:

- **(a) Fold it into the fee.** When true, add a configurable
  `transferNewRecipientFeeUsd` (default $0.35) to the quote, shown in the
  confirm dialog as a separate line: *"New recipient account — one-time $0.35"*.
- **(b) Refuse below a threshold.** Do not sponsor an ATA for transfers under,
  say, $20.

**Recommendation: (a).** It is honest, it is proportionate, and the user is
told before they commit. (b) produces a refusal the user cannot act on, since
they cannot know whether a recipient has held USDC before.

Note this is genuinely a cost being passed on, unlike the transfer fee - so
unlike the fee, calling it what it is *is* accurate.

### 3. Sponsorship balance and daily gas spend as health signals

Two new signals:

- `gas_sponsorship_balance` — critical below a configured floor. **Needs
  research: I have not confirmed Privy exposes a balance endpoint.** If they do
  not, this becomes "spend we have recorded ourselves", which is weaker but
  still useful.
- `gas_spend_24h` — sum of `estimatedRentSol` plus tx fees over 24h, warning at
  50% of the daily cap and critical at 90%.

This requires **recording** what each transfer cost, which nothing does today.
A `gasCostUsd` on the transfer record, written when the transaction is built.

### 4. Circuit breaker

`transferDailyGasBudgetUsd`, default $50. When 24h sponsored cost exceeds it,
transfers requiring a **new** ATA are refused; ordinary transfers continue,
because they cost a fraction of a cent and halting them would be an outage in
response to a cost problem.

Auto-resets on the rolling window. Emits a critical health signal and an audit
event while tripped. Privy asks for exactly this.

### 5. Rate-limit by user id on the transfer route

`checkRateLimit` gains an optional `userId` that takes precedence over IP for
authenticated routes. A specific policy for `POST /balance/transfers`, tighter
than the 120/min default.

This is defence in depth behind (1), which is the real control.

---

## The admin Wallet tab

Agreed, and overdue. Wallet information is currently scattered and gas
sponsorship has nowhere to live at all.

Proposed **Wallets** top-level tab with sub-tabs, matching the existing fee-tab
card style:

```
WALLETS
├── Overview        provider, reachability, key quorum, delegated signing
├── User wallets    searchable list: user, chain, address, balance, created
├── Gas sponsorship balance, 24h/7d spend, ATA creations, circuit breaker state
└── Controls        supported networks, minimum send, daily caps, gas budget
```

**Overview** surfaces what is currently only in `/health/operational` - the
active provider, whether Privy answers, **which key quorum is in use** (the
question that took three exchanges to answer this week), and whether delegated
signing is ready.

**User wallets** is genuinely missing. There is no admin view of who has a
wallet, on what chain, at what address. Support cannot answer "has this user
got a Solana address" without a database query.

**Gas sponsorship** is the new operational surface: balance, spend over time,
how many ATAs were created and for whom, and a visible circuit-breaker state
with a manual override.

**Controls** consolidates settings currently split between the balance-transfer
controls and the fee tab. Note the minimum send amount deliberately stays in
the **fee tab**, beside the curve it has to agree with - this tab should
*display* it and link across rather than offer a second place to set it. Two
editable copies of one number is how they drift.

---

## Test plan

Mutation-tested throughout.

- `test:transfer-daily-limits` — count and new-recipient caps, graduation by
  account age, reset messaging, admin-settability. Mutation: remove the cap,
  confirm 500 transfers succeed.
- `test:ata-fee` — the surcharge applies only when `createsRecipientAccount` is
  true, appears in the quote, and is separable in the ledger.
- `test:gas-circuit-breaker` — trips at the budget, refuses only new-ATA
  transfers, ordinary transfers still flow, auto-resets.
- `test:gas-health-signals` — thresholds, and that a missing balance reads as
  unknown rather than zero.
- Extend `test:wallet-error-honesty` for the quorum display in the admin tab.

---

## Open questions

1. **Daily caps** — are the graduated tiers right for an early-phase user base,
   or too tight for a first week?
2. **ATA cost** — surcharge (recommended) or refuse below a threshold?
3. **Does Privy expose a sponsorship balance endpoint?** I have not confirmed
   this. If not, signal 3 is self-reported spend only.
4. **Gas budget** — is $50/day the right circuit-breaker default?
5. **Wallet tab scope** — all four sub-tabs now, or Overview + Gas sponsorship
   first and user wallets later?
6. **Confirm to Privy now?** The two substantive items - backend-built
   transactions, no `CloseAccount` - are already true, so the confirmation is
   honest today. The rest is hardening.

# Transfer fee: pricing crypto-to-crypto sends

**Status:** spec, awaiting sign-off. No code written.

---

## The problem

Sivan sponsors gas on every crypto-to-crypto transfer and charges nothing for it.

Verified in the code, not assumed:

- `privy-wallet.provider.ts` sets `sponsor: true` on **both** the EVM and Solana
  paths. The user never pays gas; Sivan does.
- `balance.service.ts` — the entire transfer path — contains **no fee logic at
  all**. Grepped: the word "fee" does not appear in it. The only economic guard
  is `minimumSendAmount`, default 10 USDC.
- On Solana there is no alternative. Privy's token-gas feature is EVM-only, so
  the provider comment states plainly that "sponsorship is the only way a user
  without SOL can move" funds.

So every transfer is a pure loss, and the loss is invisible because nothing
records it.

### What already exists, and does nothing

`admin-fees.service.ts` defines:

```ts
networkFees: [{ network, estimatedFeeUsd, passedThrough }]
```

Grepped across the whole backend and frontend: it is referenced **only** in its
own schema and its own default value. `FeesTab.tsx` renders it read-only, as a
table of numbers nobody can edit and nothing consumes.

It is dead config, in the same category as `bankSettlementEnabled`. Someone
anticipated this exact feature and never wired it. That matters for two reasons:
the admin UI shape is already half-designed, and **the fee tab currently looks
like transfers are priced when they are not**.

---

## Why not a global fixed fee

This was the original proposal, and the numbers argue against it.

| Amount | $0.50 flat | $0.25 flat |
|---:|---:|---:|
| $10 | **5.00%** | 2.50% |
| $50 | 1.00% | 0.50% |
| $100 | 0.50% | 0.25% |

At $0.50 flat the $10 sender pays **ten times the rate** of the $100 sender for
an identical service. That is the "feels cheated" problem, and it is real rather
than perceptual.

It also lands hardest in the wrong place. Sivan is WhatsApp-first for a Nigerian
market; small everyday transfers are the core use case, not the edge.

A flat percentage fails in the other direction: 1% on $1,000 is $10 to cover
**half a cent** of Solana gas. That is not a fee, it is a tax, and it drives away
the transfers most worth having.

---

## Proposed: 0.5%, floor $0.10, cap $1.00

| Amount | Fee | Effective |
|---:|---:|---:|
| $10 | $0.10 | 1.00% |
| $20 | $0.10 | 0.50% |
| $50 | $0.25 | 0.50% |
| $100 | $0.50 | 0.50% |
| $500 | $1.00 | 0.20% |
| $1,000 | $1.00 | 0.10% |

**Fair in the middle.** Everyone from $20 to $200 pays exactly 0.5%. Nobody can
point at another user paying less for the same thing.

**Gentle at the bottom.** $0.10 on a $10 send is 1% — present, not punitive.

**Rewards size at the top.** The cap makes Sivan cheaper the more you send.

**No cliffs.** Checked at the boundaries: $19.99 → $0.1000, $20.01 → $0.1001.
Continuous everywhere. Contrast a banded fixed structure, which was modelled and
rejected:

```
0-25:$0.15 | 25-100:$0.35 | 100-500:$0.75 | 500+:$1.50
    $99.99 -> $0.35        $100.01 -> $0.75
```

The fee **more than doubles across two cents**. A user who notices is being
cheated in a way that is hard to defend. Tiers look tidy in an admin panel and
feel arbitrary in the hand.

**One sentence:** *0.5%, never less than $0.10, never more than $1.* A fee that
cannot be explained in a line reads as concealment.

**Matches the codebase.** `fee-policy.ts` already implements floor logic;
`admin-fees.service.ts` already has `onrampMinimumFeeUsd` and
`virtualAccountMaximumFeeUsd`. Floor-and-cap is an established pattern here.

---

## 🔴 Ethereum does not work at any cap

Modelled against real sponsored gas cost (Solana ~$0.0005, Base ~$0.01,
Ethereum ~$3):

| Amount | Fee | Solana | Base | Ethereum |
|---:|---:|---:|---:|---:|
| $10 | $0.10 | +$0.100 | +$0.090 | **−$2.90** |
| $100 | $0.50 | +$0.499 | +$0.490 | **−$2.50** |
| $500 | $1.00 | +$1.000 | +$0.990 | **−$2.00** |

Solana and Base are profitable at every size. **Ethereum loses money on every
transfer regardless of amount**, because a $1 cap cannot cover $2–5 of L1 gas.
Break-even at 0.5% needs a **$600** transfer, and the cap prevents ever reaching
it.

The fee does not fix Ethereum. It needs its own decision:

1. **Disable Ethereum for transfers.** Base and Solana serve the same purpose at
   1/300th the cost, and Base is already the default. Cleanest.
2. **Ethereum-specific cap (~$5).** Honest, but makes a $10 Ethereum transfer
   absurd — the fee would be half the amount.
3. **Keep absorbing it.** Defensible if volume is negligible, but it must be a
   decision rather than an accident.

**Recommendation: (1), with the door open to (2) later.** This is the real reason
the config must be per-network — not to vary the fee much, but because one chain
is structurally unprofitable.

Note `supportedNetworks` already defaults to `['base','solana','ethereum']`, so
this is a one-value change plus a migration thought for anyone mid-transfer.

---

## Also in scope

### Lower the minimum from 10 USDC

The 10 USDC floor exists partly *because* small transfers were pure loss. Once
priced, that reason weakens. With a $0.10 floor a $5 transfer costs 2% — high but
honest, and it opens up everyday sends for the WhatsApp user.

Proposed: **5 USDC**. Not lower yet; below that the floor starts to dominate.

Doing this in the same pass matters. Adding a fee without revisiting the minimum
leaves the smallest permitted transfer carrying the worst effective rate.

### Never call it a network or gas fee

Sivan sponsors gas. If the UI says "network fee" and a user checks the explorer,
they will see gas was sponsored and conclude they were lied to. It is a **Sivan
transfer fee**. The `passedThrough` flag on the dead `networkFees` schema implies
pass-through billing that is not what is happening.

### Show the effective rate

The confirm dialog should read `Fee $0.25 (0.5%)`, not just `Fee $0.25`. Users
resent fees they do not understand far more than fees they do.

---

## Mechanics — where the actual risk is

The fee value is trivial. Fee-on-transfer changes the money math, and that path
has already produced real bugs (a hold not released on gateway timeout, and a
`getSpendable` that asked the wrong source and blocked funded users).

### Decision required: on top, or deducted?

| | On top | Deducted |
|---|---|---|
| User sends 100 | recipient gets 100, balance −100.50 | recipient gets 99.50 |
| Matches sender intent | ✅ | ✗ |
| "Send max" | needs `spendable − fee` | always works |
| Familiar from | bank transfers | exchange withdrawals |

**Recommendation: deducted.** It is what exchanges do, so it matches what a user
withdrawing from Binance already expects, and it removes an entire class of
failure where a max-send is rejected for being fee-short of its own balance.

### Ledger

The current flow is `hold` → (`debit_transfer` | `hold_release`), with
`BalanceLedgerKind` a closed union.

The fee needs to be **visible as its own entry**, not folded into the debit, or
Sivan's revenue is unmeasurable. Options: a new `fee` kind, or a `debit_transfer`
carrying a separate `feeAmount` field. A new kind is cleaner but touches the
union and every reducer in `unified-balance.service.ts` — needs care, since the
`held`/`available`/`spent` arithmetic there is load-bearing.

### Everything the fee touches

- `createBalanceTransferSchema` / `requestBalanceTransfer` — compute and record
- the hold amount, and the `spendable < amount` check
- `getSpendable` consumers, so "send max" means max
- the `hold_release` paths on failure — **the fee must be released too**
- `TransferConfirm.tsx` — show fee and net before commit
- a quote endpoint, so the frontend does not recompute the rule and drift
- `admin-fees.service.ts` + `FeesTab.tsx` — make the control real

**The rule must live in one place** and be served to the frontend, not
reimplemented there. Two copies of a pricing rule is how they disagree.

---

## Test plan

Mutation-tested throughout.

- `test:transfer-fee-policy` — the curve. Floor below $20, cap above $200, exact
  0.5% between, continuity at both boundaries, and the banded-cliff case as a
  regression guard.
- `test:transfer-fee-ledger` — **the critical suite.** Hold equals amount, fee
  recorded separately, failure releases *both*, and the sum of user balance plus
  Sivan revenue is conserved. Mutation: drop the fee from the release path and
  confirm money goes missing.
- `test:transfer-fee-e2e` — request → hold → broadcast → confirm, against the
  mock provider, asserting the recipient receives the net amount.
- Extend `test:transfer-confirm` — the dialog states fee and net.
- Guard that the frontend does not contain a second copy of the fee formula.
- Guard that no UI string calls it a network or gas fee.

---

## Open questions

1. **Fee direction** — deducted (recommended) or on top?
2. **Ethereum** — disable (recommended), £5 cap, or keep absorbing?
3. **Minimum** — drop 10 → 5 USDC in the same pass?
4. **Ledger shape** — new `fee` kind, or a field on `debit_transfer`?
5. **Rate/floor/cap values** — 0.5% / $0.10 / $1.00 as proposed, or different?
6. **USDT** — same curve as USDC? Same gas cost, so yes unless you disagree.

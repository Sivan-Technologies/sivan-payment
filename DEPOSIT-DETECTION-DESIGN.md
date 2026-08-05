# Inbound deposits: detection, feed, notification

**Status:** design, awaiting sign-off. No code written yet.

The brief: build it once, layered, so that swapping the detector later is a
one-file change and everything downstream is untouched.

---

## The gap, stated precisely

A Sivan user sells on Binance and withdraws USDC to their Sivan address. Today:

- **No record is written.** Nothing in the database says money arrived.
- **No feed row.** All six activity sources are records Sivan *created*. An
  exchange deposit is in none of them.
- **No notification.** `src/notifications/` contains one file, `email.service.ts`,
  used by auth, support, username and account-recovery. Nothing money-related.

The only thing that happens is `unified-balance.service.ts` reads a live chain
balance and the number is bigger than last time.

Two consequences worth naming:

1. The activity feed's own docstring claims it is assembled from "every way
   money moves". For the most common inbound path, it structurally cannot be.
2. `UnifiedAssetBalance.chainUnavailable` exists because RPC reads fail. When
   one does, the deposit does not appear *at all*, and the user is holding an
   exchange receipt saying it was sent. That is the highest-anxiety support
   ticket a payments product can produce, and there is currently no record in
   the system to answer it with.

---

## Layering

Three layers, one direction of dependency. The point of the split is that
layer 1 is the only thing that knows *how* a deposit was noticed.

```
  ┌─────────────────────────────────────────────────────────┐
  │ DETECTOR  (swappable, the only vendor-aware part)       │
  │   poll+diff  |  Alchemy/Helius  |  Privy webhook        │
  └────────────────────────┬────────────────────────────────┘
                           │ recordDeposit(DepositObservation)
                           ▼
  ┌─────────────────────────────────────────────────────────┐
  │ 1. DEPOSIT RECORD   walletDeposits table                │
  │    the single source of truth. idempotent.              │
  └────────────────────────┬────────────────────────────────┘
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
  ┌────────────────────┐      ┌──────────────────────────┐
  │ 2. ACTIVITY FEED   │      │ 3. NOTIFICATION          │
  │    7th source      │      │    in-app / email / chat │
  └────────────────────┘      └──────────────────────────┘
```

`recordDeposit()` is the seam. A detector's whole job is to produce a
`DepositObservation` and hand it over. Nothing below layer 1 ever learns
whether that came from a poller, an RPC webhook or Privy.

---

## Layer 1 — the deposit record

New table `wallet_deposits` (migration `042`), new `WalletDepositRecord`, and
`walletDeposits` on the JSON DB shape. Both database implementations, as with
`findUserWalletForNetwork`.

```ts
interface WalletDepositRecord {
  id: string;
  userId: string;
  walletId: string;          // UserWalletRecord.id
  address: string;           // recipient, denormalised - survives wallet edits
  chain: string;             // 'base' | 'ethereum' | 'solana'
  asset: string;             // 'USDC'
  amount: string;            // human units, 6dp, NOT wei/lamports
  txHash?: string;           // absent for poll+diff. see below.
  sender?: string;           // absent for poll+diff.
  blockNumber?: number;
  blockTimestamp?: string;
  status: 'pending' | 'confirmed' | 'failed';
  detectionSource: 'balance_poll' | 'rpc_webhook' | 'privy_webhook' | 'manual';
  idempotencyKey: string;    // UNIQUE. see below.
  notifiedAt?: string;       // null = notification still owed
  rawPayload?: unknown;
  createdAt: string;
  updatedAt: string;
}
```

### Idempotency is the whole ballgame

Deposits get seen more than once — Privy is explicitly "at least once" with
retries, RPC webhooks re-fire, and a poller re-reads the same balance. A
duplicate here means a duplicated feed row and, worse, a second "you received
money" message for money received once.

- `idempotencyKey` is `UNIQUE` at the database level, not just checked in code.
  A check-then-insert races against itself the moment two detectors overlap.
- With a tx hash: `${chain}:${txHash}:${logIndex ?? 0}`.
- Poll+diff has no tx hash, so: `${chain}:${address}:${asset}:balance:${windowStart}`
  where the window is the poll tick. Deliberately coarse — it means two real
  deposits inside one tick collapse into one record. Documented as a known
  limitation of that detector, and it disappears the moment we move to
  webhooks. Preferable to the alternative, which is duplicate credit rows.
- `detectionSource` is stored so that when we swap detectors we can tell which
  rows came from where, and reconcile.

### This table does NOT credit anyone

Important boundary. `wallet_deposits` is an **observation log**, not a ledger.
Spendable balance still comes from `unified-balance.service.ts` reading the
chain. The deposit record exists to say *"this happened, at this time"* — it
must never become a second source of truth for how much money someone has, or
we get the classic drift between ledger and chain. Called out here because it
is the obvious next thing someone will be tempted to do.

---

## Layer 2 — the activity feed

`activityFeed.ts` gains a seventh source. It already merges six and sorts by
`createdAt`, so this is genuinely small:

```ts
for (const d of sources.walletDeposits ?? []) {
  rows.push({
    id: d.id,
    kind: 'wallet_deposit',
    direction: 'in',
    label: 'Deposit received',
    amount: d.amount,
    currency: upper(d.asset),
    asset: upper(d.asset),
    network: d.chain,          // gets a chain logo for free
    status: d.status,
    ...
  });
}
```

Notes:

- `direction: 'in'` — the arrow and the `+` sign already handle the rest.
- `network` is populated, so this row gets a chain logo under the inline-logo
  design. Takes the feed from 3-of-6 network-bearing sources to 4-of-7.
- The frontend must load a seventh source. That is a real change to the
  client-side fan-out and needs its own check that a failure of the new
  endpoint does not blank the whole feed.

---

## Layer 3 — notification

`notifiedAt` on the record is what makes this safe: the notifier claims a row
by stamping it, so a crash between "send" and "mark" cannot re-send, and a
notification is never owed twice.

Delivery is a separate concern from detection. Given Sivan is chat-first, and
`whatsapp-layer` / `telegram-layer` exist, and `SiaNotify` is already a
webhook-ingestion + notification engine with SIVAN as a tenant — the sequencing
I would suggest is:

1. **In-app** (the feed row itself + an unread marker) — no cross-repo work.
2. **Email** — `sendEmail()` already exists and Resend is wired in production.
3. **WhatsApp / Telegram** — highest value, most integration work. Separate PR.

Doing 1 and 2 first means the deposit is *visible and recorded* immediately;
chat delivery becomes an additive change rather than a prerequisite.

---

## Pending vs confirmed

A deposit is not final the instant it is seen. My recommendation:

**Notify on first sight, marked pending; flip to confirmed.** This is what
exchanges themselves do, so it matches user expectation. The anxious moment is
"I sent it and nothing happened" — resolving that fast is worth more than
sending one perfectly-final message later. `status` carries the state and the
feed row already renders a status pill.

The one rule: **the pending notification must not say "available to spend"**,
because it is not yet. Wording matters here.

---

## Detector choice

| | poll + diff | Alchemy/Helius | Privy |
|---|---|---|---|
| Cost | £0 | free tier covers this | **Enterprise, sales-gated** |
| Ships | now | days | after a contract |
| tx hash / sender | ✗ | ✓ | ✓ |
| Latency | poll interval | seconds | seconds |
| Survives wallet-provider change | ✓ | ✓ | ✗ |

**Recommended: poll+diff now, RPC webhooks straight after.**

Rationale: an exchange withdrawal takes minutes anyway, so a 60s poll is not
the weak link in that experience. It gets records, feed rows and notifications
in before launch with no vendor call. And because layer 1 is the seam, swapping
in the RPC detector later does not touch layers 2 or 3.

Against Privy specifically, beyond the cost: Privy webhooks only see wallets
Privy issued. There is a live `bridge`/`privy` provider switch — if that ever
moves, Privy-based deposit detection silently stops. Address-keyed detection
does not care who issued the wallet.

### Where the poller lives

`src/deposits/deposit-detection.service.ts`, scheduled in `server.ts` beside
the two existing timers, following their established rules exactly: started
outside `buildApp()` so tests do not spawn a live-chain timer, every failure
swallowed and logged, `.unref()`, and one run at boot because a deploy is
exactly when an event is most likely to have been missed.

Reuses `listUserWallets` + `getBalances(providerWalletId, customerId, address, chain)`
— already chain-aware since the double-count fix.

**Cost concern:** polling every wallet on a timer is O(users × chains) RPC
calls per tick. At launch scale that is fine; it will not be at 10k users.
Mitigation is to poll only wallets with recent activity, but that is premature
now — flagging it so it is a known scaling limit rather than a surprise.

---

## Test plan

Mutation-tested throughout, per the standing rule.

- `test:deposit-detection` — diff logic, no deposit on balance decrease, no
  deposit on zero delta, correct amount on increase.
- `test:deposit-idempotency` — **the critical suite.** Same observation twice
  → one record. Concurrent inserts → one record. Different tx, same amount →
  two records. Mutation: drop the UNIQUE constraint, confirm failure.
- `test:deposit-notification` — `notifiedAt` prevents re-send; crash between
  send and stamp does not double-notify.
- `test:activity-feed` — extend existing 68 assertions for the 7th source.
- Guard that pending-deposit wording never claims spendability.

---

## Open questions for sign-off

1. **Detector:** poll+diff now, or straight to Alchemy/Helius?
2. **Notification channel order:** in-app + email first, or go straight to
   WhatsApp/Telegram?
3. **Pending vs confirmed:** notify on first sight (recommended) or only final?
4. **Assets:** USDC only, or every asset the wallet can hold? USDC-only is
   fewer RPC calls and covers the exchange-withdrawal case. A user who deposits
   a random token would see nothing.

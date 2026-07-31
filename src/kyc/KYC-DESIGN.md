# Sivan KYC — design and flow

Design document. **No implementation.** Written to be argued with before any code
is written.

Verified against `sivan-payment@airspexta` on 2026-07-31. Every claim marked
**VERIFIED** was checked against the codebase or a primary source; everything
else is a proposal or an open question.

---

## 1. The problem in one line

Bridge charges **$2 per KYC** and **$10 per KYB**, billed on the verification,
not on the user ever transacting. So every signup who verifies and then does
nothing is a **real cash loss**, and the loss scales with signups rather than
with revenue.

**VERIFIED** — `src/config/env.ts:65-66`:

```ts
BRIDGE_KYC_COST_USD: z.coerce.number().min(0).default(2),
BRIDGE_KYB_COST_USD: z.coerce.number().min(0).default(10),
```

This is already modelled. `src/metrics/onboarding-costs.service.ts` computes
`potentialKycCostIfEverySignupVerifies`, tracks recovered vs unrecovered cost,
and nets it against developer-fee revenue. The economics were thought about;
what is missing is a **gate** that stops the spend happening in the first place.

### The unit economics, using live numbers

**VERIFIED** live fee config: on-ramp 1.25%, minimum fee $1.30.

| User does | Sivan earns | Bridge KYC cost | Net |
|---|---:|---:|---:|
| Verifies, never transacts | $0.00 | $2.00 | **−$2.00** |
| One $10 on-ramp | $1.30 | $2.00 | **−$0.70** |
| One $50 on-ramp | $1.30 | $2.00 | **−$0.70** |
| One $160 on-ramp | $2.00 | $2.00 | **$0.00** ← breakeven |
| One $500 on-ramp | $6.25 | $2.00 | **+$4.25** |

**A user must move about $160 before their KYC pays for itself.** At Nigerian
retail ticket sizes that is not the first transaction — it is several.

Now the part that actually decides the business:

```
10,000 signups × 30% verify × $2  =  $6,000 spent
                 of those, 20% transact
                 → 600 paying users, 2,400 verified-and-idle
                 → $4,800 of that $6,000 bought nothing
```

**The single most valuable thing this module can do is not verify people who
were never going to transact.**

---

## 2. Core principle: KYC is a purchase, not a signup step

Today's implicit model is `signup → KYC → wallet`. Every signup costs $2.

The proposed model:

```
signup → free tier → user does something that PROVES intent → then pay for KYC
```

KYC is triggered by **intent**, not by registration. Concretely: nobody reaches
Bridge until they have a funded reason to.

### Trigger, not gate

| Event | Costs $2? | Why |
|---|---|---|
| Account created | No | Free. Costs us nothing. |
| Browsing, viewing rates | No | |
| Joined an escrow deal as a party | No | Intent signal, still free |
| **Requests a deposit address / VA** | **Yes** | Real money is about to arrive |
| **Requests an off-ramp** | **Yes** | Real money is about to leave |

This alone should cut KYC spend by the share of signups who never transact —
which, on the numbers above, is most of them.

---

## 3. Two-layer KYC: Sivan's own, then the provider's

The insight that makes the $2 manageable: **Sivan's verification and Bridge's
verification are different things and do not have to happen together.**

```
        ┌──────────────────────────────────────────┐
        │  LAYER 1 — Sivan identity (cheap, ours)  │
        │  NIN / BVN / bank-name match             │
        │  ~$0.10–0.50 via a Nigerian provider     │
        │  Runs on EVERY user who wants to transact│
        └──────────────────┬───────────────────────┘
                           │  passes
                           ↓
        ┌──────────────────────────────────────────┐
        │  LAYER 2 — Provider KYC (expensive)      │
        │  Bridge $2  ·  only for USD/EUR/GBP      │
        │  NGN-only users NEVER reach this layer   │
        └──────────────────────────────────────────┘
```

**Why this works:** a Nigerian user who only ever moves NGN↔USDC through a
Nigerian provider does not need a Bridge customer record at all. Bridge is for
the USD/EUR/GBP rails. If most early users are NGN-only, most users cost cents,
not $2.

Layer 1 also protects Layer 2: a user who fails NIN/BVN never reaches Bridge, so
we never pay $2 to be told no. **Every rejection Bridge issues is a $2 loss** —
pre-screening converts those into $0.30 losses.

### Nigerian identity requirements

CBN guidance treats **BVN and NIN** as the identity credentials for individual
accounts and wallets, and expects onboarding to retrieve validated BVN/NIN
electronically rather than trusting typed input.

**Bridge's own requirement for non-US residents** is a *National identity
number* — **VERIFIED** at `apidocs.bridge.xyz/platform/customers/compliance/individuals`:

> National identity number (required for non-Usa residents)
> ID verification (optional for US residents with minimal payment activity)

Note the asymmetry: photo ID is optional *for US residents*, and the
$10,000/transaction, $100,000-lifetime database-check allowance is **US-only**.
No equivalent carve-out is documented for Nigeria, so we should assume Nigerian
onboarding needs the national ID number and be ready for ID verification.

**Open question — must be answered before build:** does Bridge accept a Nigerian
NIN as `national_id`, and does it require a photo ID for Nigerian individuals?
The country table lists per-country identification types; Nigeria's exact
accepted types need reading off that table directly. Getting this wrong means
paying $2 per rejection.

---

## 4. Verification levels, not a boolean

Do not store `kyc = true`. Store a level, so limits and requirements can move
without a schema rewrite.

```
LEVEL 0  Registered
         email or phone verified. No money movement. Free.

LEVEL 1  Identity verified          ← Layer 1
         NIN or BVN validated, name + DOB matched,
         bank account name matched, sanctions screen
         → NGN rails, modest limits

LEVEL 2  Provider verified          ← Layer 2, costs $2
         Bridge customer created and approved
         → USD/EUR/GBP rails, virtual accounts

LEVEL 3  Enhanced
         liveness, proof of address, source of funds
         → high limits, business use
```

Field shape (proposal):

```
verification_level        0 | 1 | 2 | 3
identity_status           not_started | pending | verified | failed
bank_status               not_started | pending | verified | failed
bvn_status                not_started | pending | verified | failed
liveness_status           not_started | pending | verified | failed   (L3)
proof_of_address_status   not_started | pending | verified | failed   (L3)
source_of_funds_status    not_started | pending | verified | failed   (L3)
risk_level                low | medium | high
enhanced_due_diligence    boolean
provider_ref              opaque reference from the verification provider
```

**Store the provider's reference and result, not raw NIN/BVN or ID images.**
Holding raw national identifiers turns a routine breach into a regulatory
incident and an NDPA notification. We need to know *that* a person was verified
and *by whom*; we do not need to keep the number.

### Fix the vocabulary while we are here

**VERIFIED** — `src/database/types.ts:7`:

```ts
export type CustomerStatus = 'created' | 'kyc_not_started' | 'kyc_incomplete'
  | 'kyc_under_review' | 'kyc_approved' | 'kyc_rejected' | 'paused' | 'offboarded';
```

But `'active'` is also in circulation elsewhere as a success state. **Two words
for "this user is good" is how a bug that lets an unverified user transact gets
written.** Pick one — `kyc_approved` — and normalise at the boundary.

---

## 5. Wallets: Privy, and why it should not be tied to KYC

The proposed split is right:

```
Privy    = wallet infrastructure
Bridge   = USD/EUR/GBP rails
NGN provider = naira on/off-ramp
Sivan    = identity, ledger, compliance, orchestration, UX
```

**Do not make Bridge the wallet layer.** Today it effectively is, and the result
is visible: every KYC-approved record in the live DB carries a `mock_cust_*`
provider id, so `Receive` 404s for every user. Wallet existence is coupled to a
provider relationship that may not exist.

### Verified facts about Privy

- **Non-custodial by default.** Keys are split via Shamir Secret Sharing across a
  device share, a Privy TEE share and a user recovery share; any 2 of 3
  reconstruct. Privy alone cannot move funds.
- **Solana is supported**, alongside EVM, Bitcoin and Stellar. Note that
  independent reviews describe Solana as a *secondary* chain for Privy, with
  primary depth on EVM. Worth testing before committing.
- **Server-side signing exists** via delegated wallets / server sessions —
  necessary for "user taps Withdraw, backend signs."
- **Privy was acquired by Stripe in June 2025** and sits alongside Bridge in
  Stripe's stack.

That last point deserves a moment: **choosing Privy + Bridge is not vendor
diversification.** Both are Stripe. If the concern behind this architecture was
reducing dependence on one provider, this does not achieve it. It is still the
right call for *architectural* reasons — a dedicated wallet abstraction beats
bolting wallets onto a rails provider — but the concentration risk should be
named rather than assumed away.

Also flagged in the security model: the 2-of-3 sharding means **device share +
Privy share = full key**. Browser malware on the device share is the realistic
attack path. That is an argument for server-side delegated signing with policy
limits rather than relying on the device share for high-value transfers.

### Sequencing

```
Account  →  Eligibility  →  Wallet provisioning  →  Privy wallet
```

Not `KYC complete → wallet`. Decoupling means a user can hold a wallet address
before Level 2, and compliance rules can change without a migration. A wallet
address is not a financial permission; the **ledger** decides what they can do.

---

## 6. The ledger is the source of truth

**On-chain balance ≠ Sivan customer balance.** This is the single most important
correctness rule in the whole design.

```
Privy wallet holds 250 USDC on-chain
        ↓
Sivan chain watcher observes the transfer
        ↓
Confirmations reached
        ↓
Ledger credits the user
        ↓
Available balance = 250 USDC
```

The database ledger is authoritative for accounting. Chain state is used to
**verify and reconcile**, never read directly as a balance.

Reasons this matters, all of which will happen:

- someone sends tokens directly to the address that were never a Sivan deposit
- a webhook is delivered twice
- a provider settles late, or partially, or reverses
- a refund needs to be traceable to an original credit
- an escrow holds funds that are on-chain but not spendable by the holder

Every ledger entry needs an idempotency key and a provider reference. This is
also where escrow "held" balances live — funds that exist on-chain but are
**not** available, which no chain query can tell you.

---

## 7. Off-ramp flow, end to end

```
User: Withdraw 250 USDC → NGN
        ↓
Sivan checks:  verification_level ≥ required for this rail
               limits for that level
               LEDGER balance (not chain balance)
               risk / status / sanctions
        ↓
Create withdrawal   (idempotency key issued here)
        ↓
Provider Router picks the fiat leg
        ↓
Obtain provider deposit destination
        ↓
Privy signs the USDC transfer  (server-side, policy-limited)
        ↓
USDC → provider
        ↓
Provider webhook  (verify signature; treat as possibly duplicate)
        ↓
Sivan confirms settlement, ledger updated
        ↓
NGN → user's bank account
```

The router is what keeps `Privy → Pajcash`, `Privy → Bridge`, `Privy → Nomba`
out of the application code:

```
Sivan Wallet → Transaction Engine → Provider Router ─┬─ Pajcash
                                                     ├─ Bridge
                                                     ├─ Nomba
                                                     └─ future
```

The user sees `Withdraw 250 USDC → NGN`. Which provider handled it is an
implementation detail — and, importantly, a detail we can change when a provider
raises prices or goes down.

---

## 8. What this means for the $2

Levers, in order of impact:

1. **Trigger on intent, not signup.** Most signups never transact; they should
   never cost $2. Biggest single saving.
2. **Pre-screen with cheap Layer 1.** Every Bridge rejection is $2 wasted. A
   $0.30 NIN check that fails first converts a $2 loss into a $0.30 loss.
3. **Keep NGN-only users off Bridge entirely.** If the NGN provider handles
   naira and Layer 1 handles identity, those users never touch Bridge.
4. **Never verify twice.** One Bridge customer per person, keyed and enforced.
   A duplicate is a clean $2 loss. (Related: production already had 16 virtual
   accounts where 1 was needed.)
5. **Recover the cost in pricing.** The $1.30 on-ramp minimum fee already exists
   and is deliberate. Note it does **not** cover $2 on a single small
   transaction — breakeven is ~$160 of volume. Worth deciding explicitly whether
   the first transaction should carry more of the onboarding cost.
6. **Report it.** `onboarding-costs.service.ts` already computes recovered vs
   unrecovered. Put it on the admin dashboard so the number is visible weekly,
   not discovered quarterly.

---

## 9. Open questions — answer before building

1. **Does Bridge accept Nigerian NIN as `national_id`, and is photo ID required
   for Nigerian individuals?** Decides whether Layer 1 can pre-screen accurately
   or whether every Nigerian needs full document verification.
2. **Which Layer 1 provider?** Needs NIN + BVN + bank name match. The NGN
   on/off-ramp provider is still undecided (0.50% rate, own markup allowed) —
   possibly the same vendor.
3. **Is the $2 charged on attempt or on approval?** Changes lever 2 entirely. If
   rejections are free, pre-screening is worth much less.
4. **Does Privy's Solana support meet our needs** for server-side signing, USDC
   and USDT, and fee payment? Solana is described as secondary for Privy.
5. **Who pays gas?** Solana fees are small but not zero, and a user cannot send
   USDC with no SOL. Fee-payer/sponsorship must be designed, not discovered.
6. **Limits per level?** Numbers needed, and they are a compliance decision, not
   an engineering one.
7. **Do we re-screen?** Ongoing sanctions/PEP monitoring is a recurring cost per
   customer per month and a likely regulatory expectation.

---

## 10. What exists today (do not rebuild)

**VERIFIED** — KYC already spans 35 files. Highest concentrations:

| File | Mentions | Role |
|---|---:|---|
| `customers/customers.service.ts` | 66 | de facto owner |
| `admin/admin-hardening.service.ts` | 37 | restricted-action gating |
| `providers/bridge/mock-bridge.provider.ts` | 18 | sandbox double |
| `metrics/onboarding-costs.service.ts` | 17 | **cost tracking already built** |
| `providers/bridge/bridge.provider.ts` | 15 | real Bridge calls |
| `webhooks/webhooks.service.ts` | 10 | status transitions |

Live endpoints:

```
POST /api/customers/kyc-link
GET  /api/customers/:userId/kyc-status
POST /api/customers/:userId/sandbox/simulate-kyc-approval
```

`kyc` is already a first-class restricted action in `app.ts`.

**Migrate, don't duplicate.** A second KYC implementation beside the first means
neither is authoritative.

### Three problems this module must fix

1. **Every KYC-approved record carries a `mock_cust_*` provider id.** No end user
   has a real Bridge customer; `Receive` 404s for all of them. **No real user has
   ever completed KYC.** This is also an opportunity: there is no migration
   burden, because there is nothing real to migrate.
2. **Two success vocabularies** (`kyc_approved` vs `active`).
3. **`POST /:userId/sandbox/simulate-kyc-approval` can mark a customer
   verified.** It must be provably unreachable in production — by test, not only
   by an env check.

---

## 11. Recommended build order

Nothing here is committed; this is the order I would argue for.

1. Levels and status fields — the data model, with `kyc_approved` normalised.
2. Move the `$2` spend behind an intent trigger. **Highest financial impact,
   smallest change.**
3. Layer 1 identity via the NGN provider.
4. Ledger — before any wallet writes, so no balance is ever read from chain.
5. Privy wallet provisioning, decoupled from KYC.
6. Provider router for the fiat leg.
7. Enhanced verification (L3) once volume justifies it.

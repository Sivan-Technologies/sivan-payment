# Stellar Settlement Laboratory

Isolated sandbox proving the Stellar path end to end: stablecoin bridged in, a
Service Agreement settled atomically, cash collected at a counter.

**Self-contained.** Its own `package.json` and `node_modules`. It imports
nothing from the parent application and alters nothing in it. Deleting this
directory leaves the rest of the repository untouched.

---

## The rule: no hardcoded URLs

Every endpoint comes from the environment. There is no `|| "https://..."`
anywhere in the source, and `npm run preflight` fails the run if one appears.

A default URL is invisible when it is wrong. A script that silently falls back
to a built-in Horizon endpoint keeps working after someone repoints the lab, and
the output still looks correct. The mistake only surfaces as a transaction
submitted to a network nobody intended.

The guard is tested, not assumed. Adding

```js
const x = "https://horizon-testnet.stellar.org";
```

to any file makes the preflight fail with the file and line number.

The only place URLs appear is `.env.example`, where they are documentation.

---

## Setup

```bash
cd scripts/stellar-lab
npm install
cp .env.example .env      # fill it in
npm run preflight         # reports exactly what is missing
```

`preflight` lists every unset variable with what it is for, so configuration is
a checklist rather than a guessing game.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run preflight` | URL guard, then list configured and missing variables |
| `npm run test:cctp` | Circle CCTP burn, attestation poll, mint |
| `npm run test:vault` | Derive the Service Agreement account, read its ledger state |
| `npm run test:release` | Atomic worker payout and protocol fee, fee-sponsored |
| `npm run test:cashout` | MoneyGram quote, receiver validation, commit |
| `npm run test:webhook` | Webhook listener with RSA-SHA256 verification |
| `npm run demo` | All of the above in sequence, for a screen recording |

---

## What is real and what is simulated

Stated plainly, because a demo where everything looks equally real stops being
believed the moment one simulated step is discovered.

| Step | Status |
|---|---|
| CCTP burn and mint | **Simulated.** Needs a funded source-chain key |
| CCTP attestation poll | **Real.** Calls Circle and reports what comes back |
| Agreement derivation | **Real.** Pure computation, verified against Horizon |
| Atomic release | **Real.** Builds, signs, submits to the network |
| MoneyGram calls | **Real.** Reports the actual response, including errors |
| Webhook verification | **Real.** RSA-SHA256 against the configured key |

Simulated values are printed with a `[simulated]` marker.

### Verified on Stellar testnet

The atomic release has been run for real:

```
hash     0239fbc032bd447014c2d0e2b9f562326578db7da34d90c6f1a28934cb9c4997
ledger   4769708
wall     4.47s
worker   19.4000000
treasury  0.6000000
```

One transaction, two payments, fee-sponsored by a third account.

---

## Design notes

### Deterministic Service Agreement accounts

```
seed32 = SHA256(masterSeed + ":" + agreementId)
```

Stellar Layer 1 has no contracts, so a Service Agreement cannot be a contract
holding state. It is an **account** instead, and because the account is derived
rather than recorded, its address is recomputable from the agreement id alone.
No database row sits between a user and their funds.

The `:` separator is load-bearing. Without it `("ab","c14")` and `("abc","14")`
concatenate identically and derive the same account, so two agreements would
settle into each other. `02_deterministic_vault_test.js` asserts that boundary
rather than assuming it.

The cost of this design is the master seed: whoever holds it can derive every
agreement account that will ever exist. In production it lives in an HSM. This
lab reads it from the environment only because it runs on testnet.

### Two corrections to the original brief

**A fee-bump is not an operation.** The brief asked for three operations, the
third being a CAP-0015 fee-bump. CAP-0015 defines a fee-bump as an outer
transaction that *wraps* an inner one. There is no `Operation.feeBumpSponsor`,
and written as an operation the script would not build. It uses
`TransactionBuilder.buildFeeBumpTransaction`, which is the mechanism the brief
was describing.

**"0.15s consensus" is not supportable.** Stellar closes ledgers in roughly five
seconds; the measured run above took 4.47s. The script reports wall-clock time
instead of a fixed claim. An unverifiable latency figure on a settlement product
is the first number a reviewer checks.

### Webhook verification

```
digest = `${unixSeconds}.${destinationHost}.${rawBody}`
```

Three things break this in practice, and the code guards each:

1. **The raw body, not the parsed one.** `express.json()` discards the exact
   bytes, and re-serialising produces different ones whenever key order or
   spacing differs. The route mounts `express.raw()`.
2. **The host is signed.** Behind a tunnel it must be the public hostname. A
   correct key with the wrong host fails identically to a forgery.
3. **A replay window.** Timestamps outside 300 seconds are rejected, so a
   captured callback cannot be replayed indefinitely.

MoneyGram requires **HTTP 200 with an empty body**. A JSON acknowledgement is
read as a delivery failure and retried, turning one event into a stream of
duplicates.

Verified behaviour:

| Case | Response |
|---|---|
| Valid signature | 200, empty body |
| Forged signature | 401 |
| Stale timestamp, 600s | 401 |
| Correct key, wrong host | 401 |

---

## Terminology

**Service Agreement**, never "escrow". The distinction is legal as much as
linguistic: an escrow implies a regulated third party holding funds, which is
not what a derived, non-custodial Stellar account is.

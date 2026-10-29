# Payment infra findings from the NGN lifecycle E2E

**Date:** 2026-10-23
**Branch:** `multichain-v2`
**Method:** four live NGN service agreements driven end to end on staging, paying from balance.
**Companion documents:** `sivan-escrow-agent/docs/E2E-NGN-LIFECYCLE-2026-10-23.md` for the escrow side.

> Note: the staging services write to the live merged `neondb`. Every figure below comes from production rows.

---

## 1. The hold does not cover the fee, and the ledger permits an overdraft

This is the most serious finding on the payment side.

`POST /api/users/:userId/balance/fund-agreement` places a hold for the **principal only**. At release, `POST /api/users/:userId/balance/release-agreement` debits the **principal plus the platform fee** whenever `feePayer` is the buyer. Nothing reconciles the two.

Observed on agreement `SIV-555143-4B63`:

| Step | Amount |
|---|---|
| Hold placed by `fund-agreement` | 3,000 |
| `debit_transfer` at release | 3,000 |
| `fee` at release | 500 |
| **Total debited against a 3,000 hold** | **3,500** |

The buyer's balance ended at **-500**.

The fee itself is correct. The active model is tiered, and the first tier covers everything up to 10,000 at a flat 500:

```
nairaFeeModel  = tiered
nairaFeeTiers  = [{"max":10000,"fee":500},{"max":20000,"fee":900},
                  {"max":25000,"fee":1000},{"max":50000,"rate":3.75},
                  {"max":100000,"rate":3.5},{"max":null,"rate":3.5}]
```

So a 3,000 agreement costs a buyer 3,500. The product does not ask them to hold 3,500.

Two independent defects:

1. **`fund-agreement` should hold the gross**, principal plus fee, when the buyer is the fee payer.
2. **The ledger should refuse a debit it cannot cover.** Going negative should not be reachable through a normal release. Today the release succeeds and the deficit is simply absorbed.

Consequences while this stands:

- Buyer balances can go negative through ordinary use.
- Between funding and release the platform is under-collateralised by the fee amount. A buyer who spends the difference leaves the fee uncollectable.
- A buyer holding exactly the agreement amount cannot actually afford the agreement, and nothing tells them before they commit.

Confirmed by contrast: agreement `SIV-086147-788C` was deliberately funded with 3,500 for a 3,000 agreement and settled cleanly to zero. The settlement logic is sound. The hold sizing is not.

## 2. The live deployment is missing the release route

`POST /api/users/:id/balance/release-agreement` behaves differently by environment:

| Target | Result |
|---|---|
| `sivan-payments-api-test-x9xq.onrender.com` (staging) | **200**, settles correctly |
| `api.sivantech.online/api/payment/...` (live gateway) | **404 Route POST not found** |

The gateway is routing correctly. It strips `/api/payment` and forwards `/api/users/...`, and the live payment service answers 404 because that deployment does not have the route. The live service is running older code than staging.

Until the live payment service is redeployed from `multichain-v2`, NGN releases in production will fail even with every environment variable set correctly. The escrow agent swallows that failure, so it will present as agreements marked released with the money still held.

## 3. Three different auth schemes on one service

Worth documenting because it cost real time to discover:

| Surface | Credential | Header |
|---|---|---|
| User endpoints, for example `GET /api/users/:id/balance` | user JWT, HS256 signed with `USER_JWT_SECRET` | `Authorization: Bearer` |
| Admin endpoints, for example `POST /api/admin/balance/adjustments` | `ADMIN_API_KEY` | `x-admin-api-key` or `x-admin-key` |
| Service to service, for example `fund-agreement`, `release-agreement` | `IDENTITY_LINK_SERVICE_SECRET` | `x-sivan-identity-link-secret` |

The user JWT claim shape is strict: `sub`, `roles`, `typ: "user"`, `iss: "sivan-payments-api"`, `aud: "sivan-payments-user"`.

An admin key presented to a user endpoint returns `401 auth_required`, which reads as a credential problem rather than a scheme mismatch. A clearer error would help.

## 4. Duplicate user records split balances from agreements

Each WhatsApp number exists twice, once bare and once with a `whatsapp:` prefix, as two distinct user IDs with independent balances:

| Number form | User ID | NGN balance at time of test |
|---|---|---|
| `+2348079604214` | `user-1792099021374-e32f2168` | 35,500 |
| `whatsapp:+2348079604214` | `user-1792252463176-beaf35f7` | 0 |
| `+2349136717403` | `user-1791389963540-d0576531` | 57,000 |
| `whatsapp:+2349136717403` | `user-1792123601762-952818bb` | 0 |

Creating an agreement with the bare form resolved the buyer to the **prefixed** record, which holds no money, while the real balance sat on the other. A buyer in this state sees a funded wallet and cannot pay, with no indication why.

`fundServiceAgreementFromBalance` already normalises a raw identifier (`balance.service.ts`, strips `whatsapp:` and `+`), which shows the ambiguity is known in one place but not applied at account creation.

Needs identity normalisation at user creation plus a merge migration for existing records. Count the affected accounts before merging.

## 5. Smaller notes

- `ngn_balance_agreements` stayed empty across all four agreements. Holds and releases are written to the balance ledger instead. Either the table is dead or it is silently not being populated.
- `grossAmount`, `platformFeeAmount` and `sellerNetAmount` are not persisted on the agreement record, so the quote that drove the money movement cannot be audited after the fact.

## 6. What is working

Settlement itself is correct once configured. Across agreements `SIV-555143-4B63` and `SIV-086147-788C` the release moved money atomically and accurately: buyer debited, seller credited, fee booked, hold cleared, no manual intervention. `fund-agreement` correctly enforces the buyer PIN. Bank account resolution works, with the caveat that Paystack test mode resolves only `0000000000` against bank `057` and caps at three live resolves per day.

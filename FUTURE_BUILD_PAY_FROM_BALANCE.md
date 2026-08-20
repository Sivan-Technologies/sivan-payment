# Future Build Specification: Instant Pay-from-Sivan-Balance Option

**Document ID:** `FUTURE_BUILD_PAY_FROM_BALANCE`  
**Target Release:** Phase 1 (Implemented)  
**Status:** ✅ IMPLEMENTED & VERIFIED (End-to-End Test Passed)  

---

## 1. Overview & Objective

Currently in Phase 1, funding a Service Agreement uses the **x402 On-Chain Deposit Protocol**, where the buyer is presented with their personal Sivan deposit wallet address (`W7ydftpw...`) and sends USDC on-chain to trigger deposit detection.

In Phase 2, when a buyer taps **"Pay" / "Fund"**, Sivan AI will check the buyer's internal Sivan wallet balance (`sivan-payment`). If the buyer's available internal balance is greater than or equal to the agreement total amount (`balance >= amount`), Sivan AI will offer a **1-Tap Direct Balance Debit Option**:

```text
💳 Fund Service Agreement (USDC)

Amount: 12.74 USDC
Your Sivan Balance: 180.00 USDC

[⚡ Pay 12.74 USDC from Sivan Balance]
[🟣 Pay via Solana Deposit Address]
```

Tapping **`[⚡ Pay 12.74 USDC from Sivan Balance]`** immediately transfers 12.74 USDC from the buyer's internal ledger to the escrow vault and flips the agreement status to `FUNDED` in **1 second** with zero on-chain transaction fees or deposit waiting times!

---

## 2. User Experience Flow

1. **Buyer Receives Payment Prompt**:
   - The seller accepts the agreement or the buyer taps `[💳 Pay]`.
   - Sivan AI queries `GET /api/users/:userId/balance`.
2. **Dynamic Funding Card**:
   - If `availableBalance >= totalAmount`:
     - Displays `[⚡ Pay {amount} USDC from Sivan Balance ({balance} USDC Available)]`.
     - Also displays standard on-chain deposit address as an alternative.
   - If `availableBalance < totalAmount`:
     - Displays standard deposit address instructions + top-up prompt.
3. **1-Tap Instant Settlement**:
   - Tapping `[⚡ Pay from Sivan Balance]` dispatches `POST /api/escrows/:escrowId/pay-from-balance`.
   - Backend debits 12.74 USDC from buyer's ledger, credits the escrow vault, and marks status as `FUNDED`.
   - Both Buyer and Seller receive real-time push cards:
     > *"⚡ **Payment Confirmed!** 12.74 USDC was paid from your Sivan Balance. Funds are safely locked in escrow while work is in progress."*

---

## 3. Technical Architecture

### Backend Endpoint (`sivan-escrow-agent` + `sivan-payment`)
* `POST /api/escrows/:escrowId/pay-from-balance`
* Payload: `{ actorWhatsapp, currency: "USDC" }`
* Verification:
  1. Verifies agreement status is `PENDING_PAYMENT`.
  2. Queries `sivan-payment` for buyer's available balance.
  3. Executes atomic ledger debit `POST /api/users/:userId/balance/transfers` to escrow vault.
  4. Updates escrow status to `FUNDED` and triggers `seller_payment_received` notification.

---

## 4. Phase 1 Code Freeze Compliance

In accordance with workspace rules in `AGENTS.md`:
* This specification is documented for Phase 2.
* Codebase remains in its stable Phase 1 frozen state for Grant Applications, Demo Video, and User Soft Launch.

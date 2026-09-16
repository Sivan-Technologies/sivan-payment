# Future Build Specification: Instant Pay-from-Sivan-Balance Option

Document ID: FUTURE_BUILD_PAY_FROM_BALANCE
Target Release: Multi-Chain Phase 1 & 2
Status: ✅ COMPLETED & 100% VERIFIED
Founder and Author: Samson Micheal (Founder, CEO, Technical Founder, Product Engineer)

---

## 1. Overview and Objective

Funding a Service Agreement in Sivan supports two distinct paths:
1. Multi-Chain On-Chain Deposit Protocol: The buyer is presented with their personal Sivan deposit address on their chosen network (Stellar, Celo, Solana, or Base) and sends USDC/cUSD on-chain.
2. Direct Unified Balance Debit Option: When a buyer taps "Pay" / "Fund", Sivan payment AI checks the buyer's unified balance across all provisioned wallets. If the buyer's available balance covers the agreement total, Sivan payment AI offers an instant 1-Tap Direct Balance Debit option:

Fund Service Agreement (USDC)
Amount: 25.00 USDC
Your Unified Sivan Balance: 180.00 USDC

Options:
- [⚡ Pay 25.00 USDC from Sivan Balance]
- [✦ Pay via Stellar (Zero Gas)]
- [🟡 Pay via Celo (L2 cUSD / USDC)]
- [🔵 Pay via Solana Deposit Address]
- [🔷 Pay via Base L2]

Tapping [Pay 25.00 USDC from Sivan Balance] immediately debits the buyer internal ledger, secures the funds in the service agreement vault, and transitions the agreement to FUNDED in 1 second with zero on-chain gas friction.

---

## 2. User Experience Flow

1. Buyer Receives Payment Prompt:
- The seller accepts the agreement terms or the buyer taps [Pay].
- Sivan queries the unified balance endpoint: GET /api/v1/developer/balance/:userId or GET /api/users/:userId/balance/unified.

2. Dynamic Funding Card:
- If availableBalance >= totalAmount:
  Displays [Pay {amount} USDC from Unified Balance] alongside on-chain network choices.
- If availableBalance < totalAmount:
  Displays deposit instructions for Stellar, Celo, Solana, and Base with copyable addresses and QR codes.

3. 1-Tap Instant Settlement:
- Tapping [Pay from Unified Balance] dispatches POST /api/escrows/:agreementId/pay-from-balance.
- Backend debits 25.00 USDC from buyer ledger, secures the funds, and marks status as FUNDED.
- Both Buyer and Seller receive real-time push cards:
  "Payment Confirmed! 25.00 USDC was paid from your Sivan Balance. Funds are securely locked under your Service Agreement while work is in progress."

---

## 3. Technical Architecture

### Backend Endpoints (sivan-escrow-agent + sivan-payment)
- POST /api/escrows/:agreementId/pay-from-balance
- Payload: { actorId: string, currency: "USDC" | "CUSD" }
- Verification:
  1. Verifies agreement status is PENDING_PAYMENT.
  2. Queries sivan-payment unified balance service across all active networks.
  3. Executes atomic ledger debit to the service agreement treasury.
  4. Updates agreement status to FUNDED and triggers seller delivery countdown.

---

## 4. Multi-Chain Settlement Routing

When delivery is completed and approved by the buyer, Sivan routes the settlement to the seller's preferred destination:
- Stellar: stellarSettlement.ts (Zero-gas CAP-0015 release to G-address)
- Celo: celoSettlement.ts (Micro-gas release to 0x address in cUSD/USDC)
- Solana: paymentService.ts (High-speed release to Base58 address in SPL USDC)
- Base: baseSettlement.ts (L2 EVM release to 0x address in Base USDC)
- Nigerian Bank Account: nairaPaymentProvider.ts (Instant direct payout in NGN)

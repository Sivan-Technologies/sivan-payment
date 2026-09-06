# Sivan Ai - Cross-Channel Identity & Wallet Merge Protocol

## Overview
This specification defines the automated architecture for merging split identities and multi-chain non-custodial wallets when a user creates an account on Telegram or WhatsApp first, and later creates an account on the Web Dashboard using different credentials.

Document Version: 1.0.0
Author: Samson Micheal, Founder & CEO (Abuja, Nigeria)
Platform: Sivan Ai / Sivan Payment Ai

---

## 1. The Split Identity Problem

### Scenario:
1. Step 1 (Chat First): A new user opens Telegram or WhatsApp and interacts with Sivan Ai. Sivan Ai automatically provisions Account A (User ID: usr_tg_123) and generates non-custodial multi-chain wallets (Solana, Base, Celo, BNB Chain, Stellar). The user receives 50.00 USDC in their wallet.
2. Step 2 (Web Later): The user opens app.sivantech.online and signs up via Google Login or Email, creating Account B (User ID: usr_web_456) with a new set of empty wallets (0.00 USDC).
3. Step 3 (Pairing Attempt): When the user attempts to link their Telegram account from the Web Dashboard, the pairing handler detects that the Telegram ID is already linked to Account A and throws a conflict refusal.

### Current Behavior vs Target Behavior:
- Current: Rejects pairing with an error message: "This Telegram account is already linked to another Sivan payment account."
- Target: Detects the pre-existing funds and wallets on Account A, prompts the user in chat for confirmation, and automatically reassigns all wallets, ledger entries, and Service agreements from Account A to Account B seamlessly.

---

## 2. Technical Architecture & Data Flow

### A. Conflict Detection on Pairing Redeem
Endpoint: POST /api/identity/link-telegram/redeem

When the pairing code issued by Account B is redeemed with a Telegram User ID that already belongs to Account A:
1. Inspect Account A wallet balances and pending agreements.
2. If Account A has active wallets, funds, or transaction history, flag a merge requirement instead of throwing a hard error.
3. Generate a secure, short-lived Merge Confirmation Token (TTL: 10 minutes).

### B. Interactive 2-Step Confirmation in Telegram
Sivan Ai sends an interactive confirmation card to the user on Telegram:

  Account Merge Request

  We found an existing Sivan wallet linked to this Telegram account with 50.00 USDC spendable balance.

  Would you like to merge this balance into your Web Dashboard account (user@example.com)?

  [ Approve & Merge Funds ]  [ Cancel ]

### C. Atomic Database Reassignment
Upon user approval via signed Telegram callback:
1. Lock Account A and Account B records in a single database transaction.
2. Transfer all rows in payments_user_wallets where user_id = Account A to user_id = Account B.
3. Transfer all balance ledger history, off-ramp orders, virtual account records, and Service agreements from Account A to Account B.
4. Update customer_identity_links so the primary paymentUserId points to Account B.
5. Soft-delete or mark Account A status as merged_into: Account B.
6. Trigger an audit log event: identity.accounts_merged.

---

## 3. Security & Fraud Protection Rules

1. Proof of Ownership on Both Sides:
   - Account B (Web) must generate the pairing code behind authenticated JWT session.
   - Account A (Chat) must approve the merge via signed Telegram / WhatsApp webhook callback.
2. Withdrawal PIN Invalidation & Reset:
   - If Account A had a withdrawal PIN set, it is preserved or merged into Account B.
   - If Account B already had a PIN, Account B PIN remains dominant.
3. Atomic Rollback:
   - If any step of the wallet transfer fails, the entire database transaction aborts to prevent orphaned funds.

---

## 4. User Experience Walkthrough

1. User logs into Web Dashboard (app.sivantech.online) and sees 0.00 USDC.
2. User clicks "Connect Telegram" on Web Dashboard.
3. Web Dashboard redirects to t.me/Sivan_Ai with pairing payload.
4. Sivan Ai detects the 50.00 USDC in the user Telegram wallet and asks: "Merge 50.00 USDC into user@example.com?".
5. User taps "Approve & Merge Funds".
6. Sivan Ai replies: "Accounts merged successfully! Your total balance is now 50.00 USDC."
7. The Web Dashboard refreshes via WebSocket/poll and instantly displays 50.00 USDC.

---

## 5. Implementation Checklist

- Backend API:
  - Add mergeAccountIdentities service function in identity.service.ts
  - Update redeemTelegramLink and redeemWhatsappLink to return merge_required payload when conflict has funds
  - Create POST /api/identity/merge/confirm endpoint
- Telegram Layer:
  - Add handleMergeConfirmation callback handler in dispatcher.ts
  - Render interactive Merge Review card
- WhatsApp Layer:
  - Add automated interactive button handler for WhatsApp merge confirmation
- Web Dashboard:
  - Display realtime sync toast upon successful pairing and merge

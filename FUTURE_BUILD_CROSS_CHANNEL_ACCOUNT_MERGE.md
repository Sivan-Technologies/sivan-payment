# Sivan Ai - Cross-Channel Identity & Wallet Merge Protocol (Telegram & WhatsApp)

## Overview
This specification defines the automated architecture for merging split identities and multi-chain non-custodial wallets when a user creates an account on Telegram or WhatsApp first, and later creates an account on the Web Dashboard using different credentials (or vice versa).

Document Version: 1.1.0
Author: Samson Micheal, Founder & CEO (Abuja, Nigeria)
Platform: Sivan Ai / Sivan Payment Ai

---

## 1. The Split Identity Problem Across Channels

### Scenario A (Telegram First, Web Later):
1. User starts on Telegram (@Sivan_Ai) with no email. Sivan Ai automatically provisions Account A (usr_tg_123) and generates multi-chain wallets (Solana, Base, Celo, BNB Chain, Stellar). The user receives 50.00 USDC in their wallet.
2. User later opens app.sivantech.online and signs in via Google or Email, creating Account B (usr_web_456) with empty wallets (0.00 USDC).
3. User attempts to link Telegram from the Web Dashboard. The backend detects Telegram ID is already bound to Account A and throws a conflict refusal.

### Scenario B (WhatsApp First, Web Later):
1. User starts on WhatsApp (+2348012345678) with no web login. Sivan Ai provisions Account A (usr_wa_123) with multi-chain wallets and receives 50.00 USDC.
2. User later logs into the Web Dashboard using a corporate or personal email (usr_web_456).
3. User clicks "Connect WhatsApp" from the Web Dashboard. When the WhatsApp OTP or pairing code is submitted, the backend detects the phone number belongs to Account A and throws a conflict refusal.

### Target Behavior Across Both Channels:
Instead of throwing a refusal error, Sivan Ai detects pre-existing wallets and balances on Account A, prompts the user directly on Telegram or WhatsApp for confirmation, and automatically merges all wallets, balances, and Service agreements into Account B with zero fund loss.

---

## 2. Technical Architecture & Data Flow

### A. Conflict Detection on Pairing Endpoints
Endpoints:
- POST /api/identity/link-telegram/redeem
- POST /api/identity/link-whatsapp/redeem

When a pairing code issued by Account B is redeemed with a Telegram User ID or WhatsApp Number belonging to Account A:
1. Inspect Account A wallet balances and pending agreements.
2. If Account A has active wallets, funds, or transaction history, return status: "merge_required" with a secure Merge Token (TTL: 10 minutes).
3. Sivan Ai sends an interactive confirmation card to the user on that specific channel (Telegram or WhatsApp).

### B. Channel-Specific Interactive Confirmations

#### 1. Telegram Confirmation Card:

  Account Merge Request

  We found an existing Sivan wallet linked to this Telegram account with 50.00 USDC spendable balance.

  Would you like to merge this balance into your Web Dashboard account (user@example.com)?

  [ Approve & Merge Funds ]  [ Cancel ]

#### 2. WhatsApp Confirmation Message & Quick-Reply Buttons:

  Account Merge Request

  We found an existing Sivan wallet linked to your WhatsApp number (+2348012345678) with 50.00 USDC spendable balance.

  Would you like to merge these funds into your Web Dashboard account (user@example.com)?

  Reply 1 or tap below:
  1. Approve & Merge Funds
  2. Cancel

### C. Atomic Database Reassignment
Upon user approval via signed Telegram callback or WhatsApp reply:
1. Lock Account A and Account B records in a single database transaction.
2. Transfer all rows in payments_user_wallets where user_id = Account A to user_id = Account B.
3. Transfer all balance ledger entries, off-ramp orders, virtual account records, and Service agreements from Account A to Account B.
4. Update customer_identity_links so both channels (Telegram and WhatsApp) point to Account B.
5. Soft-delete or archive Account A with status: merged_into: Account B.
6. Trigger an audit log event: identity.accounts_merged.

---

## 3. Security & Fraud Protection Rules

1. Dual Proof of Ownership:
   - Account B (Web) must initiate the link behind an authenticated JWT session.
   - Account A (Chat) must authorize the merge via signed webhook verification (Telegram HMAC / Twilio WhatsApp signature).
2. Withdrawal PIN Resolution:
   - If Account A had a withdrawal PIN set and Account B had none, Account A PIN transfers to Account B.
   - If both accounts had PINs, Account B PIN remains active, and the user receives a security notification in chat.
3. Atomic Rollback:
   - If any step fails, the entire database transaction aborts to prevent orphaned funds or duplicated balances.

---

## 4. End-to-End User Experience

### Telegram Journey:
1. User logs into Web Dashboard (0.00 USDC) and clicks "Connect Telegram".
2. Web Dashboard redirects to t.me/Sivan_Ai?start=pair_TOKEN.
3. Sivan Ai detects 50.00 USDC in the Telegram wallet and asks: "Merge 50.00 USDC into user@example.com?".
4. User taps "Approve & Merge Funds".
5. Sivan Ai confirms: "Accounts merged successfully! Total spendable balance: 50.00 USDC."
6. Web Dashboard updates immediately with 50.00 USDC.

### WhatsApp Journey:
1. User logs into Web Dashboard and clicks "Connect WhatsApp".
2. User enters their phone number on the dashboard.
3. Sivan Ai sends a WhatsApp message with an interactive approval button: "Merge 50.00 USDC into user@example.com?".
4. User taps "Approve & Merge Funds".
5. Sivan Ai sends a confirmation receipt on WhatsApp, and the Web Dashboard syncs instantly.

---

## 5. Implementation Checklist

- Backend API:
  - Add mergeAccountIdentities service function in identity.service.ts
  - Update redeemTelegramLink and redeemWhatsappLink to handle merge_required status
  - Implement POST /api/identity/merge/confirm
- Telegram Layer:
  - Add handleMergeConfirmation callback in dispatcher.ts
  - Render interactive Merge Review card
- WhatsApp Layer:
  - Add interactive list/button handler in whatsapp-bot dispatcher
  - Handle WhatsApp message reply confirmation ("1" or button click)
- Web Dashboard:
  - Add real-time sync listeners and merge status toast

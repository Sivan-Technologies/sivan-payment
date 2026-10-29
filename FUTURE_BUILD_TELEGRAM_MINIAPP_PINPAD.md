# Future Build Specification: Unified Sivan Transaction PIN and Telegram Mini-App Keypad

Document Identifier: FUTURE_BUILD_TELEGRAM_MINIAPP_PINPAD
Feature Name: Unified Sivan Transaction PIN ($50 Tiered Threshold and Mini-App Keypad)
Target Channels: Telegram Layer, WhatsApp, Web Dashboard, and Developer Gateway
Target Release Phase: Phase 2 (Scale Phase)
Status: ✅ COMPLETED & 100% VERIFIED
Founder and Author: Samson Micheal (Founder, CEO, Technical Founder, Product Engineer)

---

## 1. Executive Summary and Architecture

Sivan introduces a Unified Sivan Transaction PIN model providing bank-grade security with consumer-grade simplicity.

Instead of separate PINs for different actions, users have one single 6-digit Sivan Transaction PIN that protects all money-moving operations across the platform:
1. Direct On-Chain Multi-Chain Transfers (Stellar, Celo, Solana, Base).
2. Fiat Off-Ramp Bank Cashouts (USDC / cUSD to Nigerian Bank Accounts).
3. High-Value Service Agreement Milestone Releases.

---

## 2. Tiered Risk Threshold Policy ($50 Rule)

To prevent micro-payment fatigue while providing institutional-grade security for serious capital, Sivan enforces an automated threshold policy:

### A. Micro-Transactions (Under $50.00 USDC or under 50,000 NGN):
- Execution: Instant 1-tap confirmation.
- PIN Requirement: Zero PIN challenge.
- User Experience: Lightning-fast social payments for coffee, freelance tasks, and peer-to-peer transfers.

### B. High-Value Transactions ($50.00 USDC and above, or 50,000 NGN and above):
- Execution: Requires 6-digit Unified PIN authentication.
- PIN Requirement: Mandatory PIN challenge.
- Anti-Theft Defense: Even if a mobile device or Telegram session is compromised or SIM-swapped, unauthorized attackers cannot drain the treasury.

---

## 3. Interactive User Experience and Flow

### Step 1: Transaction Request
The user initiates a transfer, bank withdrawal, or service agreement release:
- "Transfer 75 USDC to GA5Z..." (Stellar)
- "Send 100 USDC to 0xcebA..." (Celo / Base)
- "Withdraw 60 USD to my GTBank account"
- Buyer clicks [Approve Delivery & Release $80] on a Service Agreement

### Step 2: Intelligent Threshold Evaluation
- If amount < $50.00 USDC: Sivan displays standard 1-tap confirmation card and executes immediately upon tap.
- If amount >= $50.00 USDC: Sivan displays the confirmation card with an inline Web App button: [ 🔐 Enter PIN to Confirm ].

### Step 3: Native Telegram Mini-App Modal
1. Tapping the button launches a native Telegram Mini-App modal sliding up over the chat window.
2. The user enters their 6-digit PIN on a sleek numeric keypad with masked banking dots.
3. As the 6th digit is tapped, the Mini-App submits the encrypted payload directly via HTTPS to sivan-payment (/api/identity/pin/verify-step-up).
4. Sivan verifies the single-use step-up token bound cryptographically to (amount + destination + currency).
5. The Mini-App automatically closes (Telegram.WebApp.close()).
6. Telegram and WhatsApp chat streams update in real time with the transaction explorer receipt (StellarExpert, Celoscan, Solscan, Basescan, or NGN bank transfer receipt).

### Step 4: Chat Fallback Protection
If a user chooses to type their PIN directly in text instead of tapping the button, the bot processes the request and instantly auto-deletes the PIN message bubble from chat history using deleteMessage.

---

## 4. Technical Architecture and Service Integration

### Component A: Unified PIN Guard (sivan-payment)
- Service: withdrawal-pin.service.ts & withdrawal-pin.guard.ts (renamed to transaction-pin.guard.ts in Phase 2).
- Covered Operations:
  1. POST /api/withdrawals (Foreign crypto off-ramps)
  2. POST /api/ngn/offramp/orders (Naira bank transfers)
  3. POST /api/users/:userId/balance/transfers (Direct multi-chain transfers above $50)
  4. POST /api/escrows/:agreementId/release (Service agreement releases above $50)
- Brute-Force Defense: Salted hash storage, rate limiting, and automatic temporary lockout after 5 consecutive failed attempts.

### Component B: Mini-App Frontend
- Web App Route: /pin-pad hosted on https://app.sivantech.online.
- BotFather Registration: Configured under @SivanAi_bot.
- Security: Cross-Origin payload isolation with HMAC session verification.

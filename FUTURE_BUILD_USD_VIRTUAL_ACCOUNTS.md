# Future Build Specification: Chat-Native USD Virtual Accounts

**Feature Name:** USD Virtual Account Display & Deposit Flow  
**Target Channels:** WhatsApp Bot & Telegram Layer  
**Target Release Phase:** Post-Grant / Phase 2 Build  
**Status:** Documented & Queued  

---

## 1. Executive Summary & Objective

Provide Sivan users with a friction-free way to receive USD bank transfers (ACH & Wire) directly inside WhatsApp and Telegram. 

When a user taps **"Deposit USD"** or issues a `/deposit` command, Sivan will display their assigned US Virtual Bank Account details (Bank Name, Account Holder Name, Routing Number, Account Number) in a copy-pasteable format. Incoming USD deposits are automatically converted to USDC/USDT on-chain and credited to the user's Sivan balance.

---

## 2. Target User Experience & Chat Flow

### Flow Steps:
1. User opens Sivan AI on WhatsApp or Telegram.
2. User selects **Deposit / Receive** -> **USD Bank Transfer (ACH / Wire)**.
3. System fetches the user's active virtual account record from `sivan-payment` API (`/api/virtual-accounts`).
4. Bot responds with a clean, formatted card containing copyable bank details.

### Message Card Template:

```text
🏛️ Your USD Bank Account Details

Send USD via ACH or Wire directly to your account. Incoming deposits automatically credit as USDC on Sivan.

• Bank Name: Choice Bank / Bridge
• Account Holder: [User Full Name]
• Account Number: 1234567890 (Tap to copy)
• Routing Number: 123456789 (ACH & Wire)
• Account Type: Checking

💡 ACH transfers take 1-2 business hours. Wire transfers settle instantly.
```

---

## 3. Technical Architecture & Endpoints

### Required Backend API Integration:
- **`GET /api/virtual-accounts`**: Fetches existing virtual account for the authenticated user.
- **`POST /api/virtual-accounts`**: Provisions a new virtual account via `sivan-payment` if one does not exist.

### Data Model Mapping:
- `bankName`: e.g., Choice Financial Group / Bridge
- `accountNumber`: 10-digit US bank account number
- `routingNumber`: 9-digit ABA routing number
- `accountHolderName`: Verified legal user name from KYC
- `supportedMethods`: `["ach", "wire"]`

---

## 4. Provider Prerequisites for Live Launch

Before enabling live USD virtual account generation in production:
1. **Bridge / Partner Production Credentials**: Production API key & webhook secret configured in `sivan-payment`.
2. **User KYC Verification**: User must have completed Tier 1/Tier 2 identity verification to issue a dedicated account.
3. **Webhook Listener**: Ensure `/api/webhooks/bridge` (or virtual account deposit listener) is active to handle incoming ACH/Wire credit notifications.

---

## 5. Security & Compliance Guidelines

- **Public Deposit Details Only**: Only display Bank Name, Account Holder Name, Routing Number, and Account Number.
- **Zero Sensitive Data**: Never display PINs, SSN/BVN, private keys, or wallet authorization tokens.
- **Credit-Only Rail**: Routing and account numbers allow inbound credits only; counterparties cannot withdraw or pull funds from this display.

---

## 6. Implementation Action Plan (When Triggered)

1. [ ] Update `sivan-payment/src/virtual-accounts` to expose `/api/users/:userId/virtual-account` lookup endpoint.
2. [ ] Add `buildVirtualAccountCard()` utility in `whatsapp-bot/src/dealCards.ts` and `Telegram-layer/src/dealCards.ts`.
3. [ ] Add **"Deposit USD"** button to main menu keyboards in both Telegram and WhatsApp layers.
4. [ ] Add test suite `test-chat-virtual-accounts.ts` to `scripts/run-all-tests.ts`.

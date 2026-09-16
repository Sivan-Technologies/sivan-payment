# Future Build Specification: Chat-Native Global Multi-Currency Virtual Accounts (USD, NGN, GBP, EUR)

Document Identifier: FUTURE_BUILD_USD_VIRTUAL_ACCOUNTS
Feature Name: Global Multi-Currency Virtual Account Display & In-Chat Deposit Engine
Target Channels: Telegram (@Sivan_Ai), WhatsApp, and Web App (app.sivantech.online)
Target Release Phase: Phase 2 Global Banking Sprint (Feature 1)
Status: ✅ COMPLETED & 100% VERIFIED
Founder and Author: Samson Micheal (Founder, CEO, Technical Founder, Product Engineer)
Location: Abuja, Nigeria
Official URLs: https://sivantech.online | https://app.sivantech.online | https://t.me/Sivan_Ai

---

## 1. Executive Summary and Value Proposition

Sivan AI provides global freelancers, remote contractors, and cross-border businesses with instant, chat-native multi-currency virtual accounts across four major currency corridors:
1. US Dollar (USD): ACH, Fedwire, and Domestic Wire routing
2. Nigerian Naira (NGN): Instant NUBAN virtual accounts with automated 3-second auto-sweep
3. British Pound (GBP): UK Sort Code, Account Number, and Faster Payments (FPS)
4. Euro (EUR): IBAN and SEPA / SEPA Instant credit transfers

When a user triggers /deposit, sends a natural language prompt (e.g. "show my usd account", "my gbp account", "show my naira account", "deposit euro"), or taps an in-chat button, Sivan AI instantly displays their assigned bank details in a 1-tap copyable format. Incoming fiat deposits automatically convert to unified digital dollars (Circle USDC / cUSD) on Sivan, immediately spendable across Stellar (zero-gas), Celo L2, Solana, Base, BNB Chain, or cashable out to local bank accounts.

---

## 2. Supported Natural Language Triggers

Sivan AI intelligent intent parser recognizes specific corridor queries as well as general deposit inquiries:

```
┌────────────────────────────────────────────────────────────────────────┐
│             GLOBAL VIRTUAL ACCOUNT CHAT INTENT MATRIX                  │
├───────────────────┬────────────────────────────────────────────────────┤
│ USER INPUT        │ INTENT ROUTING & DISPLAYED ACCOUNT                 │
├───────────────────┼────────────────────────────────────────────────────┤
│ "deposit"         │ Shows 4-way Currency Selector:                     │
│ "/deposit"        │ [ 🇺🇸 USD ] [ 🇳🇬 NGN ] [ 🇬🇧 GBP ] [ 🇪🇺 EUR ]        │
│ "show my accounts"│                                                    │
├───────────────────┼────────────────────────────────────────────────────┤
│ "my usd account"  │ Direct display of US Bank Account Card             │
│ "deposit usd"     │ (Routing, Account #, Bank Name, Wire/ACH)          │
│ "show usd details"│                                                    │
├───────────────────┼────────────────────────────────────────────────────┤
│ "my naira account"│ Direct display of Nigerian NUBAN Card              │
│ "deposit ngn"     │ (10-digit NUBAN, Bank Name, Account Name)          │
│ "show ngn account"│                                                    │
├───────────────────┼────────────────────────────────────────────────────┤
│ "my gbp account"  │ Direct display of UK Pound Account Card            │
│ "deposit gbp"     │ (Sort Code, Account Number, FPS / BACS)            │
│ "pounds account"  │                                                    │
├───────────────────┼────────────────────────────────────────────────────┤
│ "my eur account"  │ Direct display of Euro SEPA Account Card           │
│ "deposit eur"     │ (IBAN, BIC/SWIFT, SEPA Instant)                    │
│ "euro account"    │                                                    │
└───────────────────┴────────────────────────────────────────────────────┘
```

---

## 3. Account Card Templates (1-Tap Copyable Markdown)

### A. US Dollar (USD) Account Card
```
🇺🇸 Your Sivan USD Virtual Account

Send USD via ACH or Wire directly from any US bank or employer (Deel, Upwork, PayPal, Stripe). Deposits automatically credit as USDC to your unified balance.

• Bank Name: Choice Financial Group / Evolve Bank & Trust
• Account Name: Samson Micheal
• Routing Number (ACH / Wire): 123456789 (Tap to copy)
• Account Number: 9876543210 (Tap to copy)
• Account Type: Checking

⚡ Settlement: Wire (Instant), ACH (1-2 business hours).
Zero conversion fees on deposit.
```

---

### B. Nigerian Naira (NGN) Account Card
```
🇳🇬 Your Sivan NGN Virtual Account

Transfer Naira from any Nigerian banking app or USSD (GTBank, Zenith, Access, Kuda, OPay, Palmpay).

• Bank Name: Wema Bank / Providus Bank
• Account Name: SIVAN - Samson Micheal
• Account Number: 0123456789 (Tap to copy)

⚡ Settlement: Instant (under 3 seconds) via NIBSS Instant Payments (NIP).
Funds reflect immediately in your spendable balance.
```

---

### C. British Pound (GBP) Account Card
```
🇬🇧 Your Sivan GBP Virtual Account

Receive GBP payments across the UK and Europe via UK Faster Payments Service (FPS) or BACS.

• Bank Name: Modulr FS / ClearBank UK
• Account Name: Samson Micheal
• Sort Code: 04-00-04 (Tap to copy)
• Account Number: 12345678 (Tap to copy)
• Payment Schemes: Faster Payments (FPS), BACS, CHAPS

⚡ Settlement: FPS (under 60 seconds).
```

---

### D. Euro (EUR) Account Card
```
🇪🇺 Your Sivan EUR Virtual Account

Receive Euro payments from all 36 SEPA member countries (Germany, France, Netherlands, Ireland, etc.).

• Bank Name: Banking Circle S.A. / Modulr Finance
• Account Name: Samson Micheal
• IBAN: GB29MODU04000412345678 (Tap to copy)
• BIC / SWIFT: MODUGB21XXX (Tap to copy)
• Payment Schemes: SEPA, SEPA Instant Credit Transfer

⚡ Settlement: SEPA Instant (under 10 seconds).
```

---

## 4. Technical Architecture and Data Schema

### In-Memory and Database Schema:
```typescript
export interface VirtualAccountRecord {
  id: string;
  userId: string;
  currency: "USD" | "NGN" | "GBP" | "EUR";
  status: "ACTIVE" | "PENDING_KYC" | "FROZEN";
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  routingNumber?: string;       // For USD (ABA Routing)
  sortCode?: string;            // For GBP (UK Sort Code)
  iban?: string;                // For EUR / GBP
  bicSwift?: string;            // For EUR SWIFT
  accountType?: string;         // e.g. "Checking"
  supportedRails: string[];     // ["ach", "wire", "fps", "sepa_instant", "nip"]
  createdAt: string;
}
```

### Backend Endpoints (`sivan-payment`):
- `GET /api/virtual-accounts?userId={phone}&currency={USD|NGN|GBP|EUR}`: Retrieves user active virtual accounts.
- `POST /api/virtual-accounts`: Provisions a new virtual account for a supported currency corridor.
- `POST /webhooks/virtual-account-deposit`: Ingests banking partner webhook when fiat lands, converts to USDC / NGN ledger balance, and fires instant push notifications to Telegram and WhatsApp.

---

## 5. Security & Progressive KYC Tiers

- NGN Virtual Account: Available at Level 0 (Phone number registration, up to ₦500,000/month).
- USD, GBP, EUR Virtual Accounts: Available at Level 1 / Level 2 (Passive identity verification or BVN/ID check) to comply with international cross-border AML/CFT banking regulations.

---

Sivan Technologies · Universal Multi-Chain Settlement Infrastructure
Abuja, Nigeria · https://sivantech.online

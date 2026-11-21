# Sivan Future Build Specification: Celo Direct Bank Off-Ramp and Multi-Currency Rail Architecture

Document Version: 1.0.0
Status: Architecture Review & Technical Specification
Category: Phase 2 / Phase 3 Multi-Currency Settlement Roadmap
Author: Samson Micheal (Founder & Technical Lead, Sivan Technologies)
Team: Jonathan Hart (Co-Founder & Head of Operations)
Entity: Sivan Technology / Sivan payment Ai (Borderless Autonomous Web3 Payment Protocol)
Target Repositories: whatsapp-bot, sivan-payment, sivan-minipay-app, Telegram-layer, sivan-user-frontend
Official URLs: https://sivantech.online | https://app.sivantech.online
Official Support Email: support@sivantech.online
Compliance Email: sivantechnology@gmail.com

---

## 1. Executive Summary

This specification defines the architectural design, user experience flow, balance auto-detection, and provider routing engine for direct bank off-ramping from Celo assets (USDC, USDT, cNGN, wBRL, wARS) into national commercial bank accounts across emerging markets.

The central product principle of this architecture is Country-First Off-Ramping:
1. Everyday users do not navigate complex token swaps, liquidity pools, or blockchain bridges.
2. Sivan payment Ai automatically detects the user's available Celo balance (USDC or USDT).
3. The user simply selects their destination bank country (Nigeria, Brazil, Argentina).
4. Sivan payment Ai handles all asset absorption, RFQ pricing, on-chain settlement on Celo, and local bank clearing behind the scenes.
5. In addition to direct bank off-ramping, users can choose an In-App Balance Swap to convert and hold local digital currencies (cNGN, wBRL, wARS) directly inside their Sivan spendable balance.

---

## 2. Core Architectural Principles

### Principle 1: Smart Asset Auto-Detection
When a user initiates a withdrawal in WhatsApp, Telegram, MiniPay, or the Web App:
- Sivan payment Ai inspects the user's connected wallet and internal ledger balances across active networks.
- If the user holds Celo USDC, Celo USDT, or cNGN, the interface automatically detects these withdrawable assets.
- Example Prompt: "Available on Celo: $25.00 USDC. Where would you like to send your funds?"

### Principle 2: Country-First Mental Model
Rather than asking users to pick an ERC-20 token or contract address first, Sivan structures the withdrawal around their real-world goal:
- Destination: Local Bank Account
- Select Country:
  - Nigeria (₦ NGN via NIBSS Instant Payment)
  - Brazil (R$ BRL via Central Bank Pix)
  - Argentina ($ ARS via CBU / CVU Bank Transfer)

### Principle 3: Textile FX Direct Asset Absorption (Zero Manual Swap)
For the Nigerian corridor:
- Textile Credit (Textile FX) operates as Sivan's institutional liquidity engine on Celo.
- Textile FX directly accepts Celo USDC and Celo USDT as sell tokens.
- Sivan does not need to execute a manual DEX swap from USDC to cNGN before off-ramping.
- Textile absorbs the Celo USDC, locks a firm RFQ exchange rate, and dispatches the Naira payout over NIBSS / NIP directly to the user's 10-digit NUBAN account in under 1 to 2 minutes.

### Principle 4: Multi-Provider Regional Routing
Because no single provider bridges every emerging market under one API:
- Nigeria Corridor (NGN): Routed via Textile Credit (and Paystack/Breet fallback).
- Brazil Corridor (BRL): Routed via Celo Pix rails / Transfero. Settles directly to Nubank, Inter, or Itaú via Pix Key (CPF, phone, or email) in under 30 seconds.
- Argentina Corridor (ARS): Routed via LatAm Celo partners / Ripio / Mento rails. Settles directly to Mercado Pago, CVU, or CBU accounts.

---

## 3. The Two User Withdrawal Modalities

Sivan payment Ai provides two distinct paths depending on whether the user wants national cash in their bank account or digital currency in a wallet:

```
                          [ User Taps Withdraw ]
                                     │
          ┌──────────────────────────┴──────────────────────────┐
          │                                                     │
   [ Path A: Direct Bank Off-Ramp ]              [ Path B: Crypto / Balance Swap ]
          │                                                     │
   Select Country:                               Select Network & Asset:
   • 🇳🇬 Nigeria (NIBSS / NIP)                    • Celo -> USDC, USDT, cNGN, wBRL, wARS
   • 🇧🇷 Brazil (Pix)                                            │
   • 🇦🇷 Argentina (CBU/CVU)                       ┌──────────────┴──────────────┐
          │                                      │                             │
   Auto-Detect Celo Asset                 [ Send to External ]          [ Swap to Sivan ]
   (USDC / USDT / cNGN)                   [ Celo 0x Address  ]          [ Spendable Balance ]
          │                                                                    │
   Live Firm Quote & Name Inquiry                                       Instant Mento Swap
          │                                                             Hold Local Stablecoin
   PIN Authorization & Payout
   (Bank delivery under 1-2 mins)
```

---

## 4. End-to-End User Flow: Nigeria (Textile FX)

### Step 1: Trigger & Auto-Detection
User types "withdraw" or taps the "Withdraw" button in WhatsApp:
```
Sivan payment Ai . Withdraw Funds

Available Spendable Balance:
• Celo Mainnet: $30.00 USDC

Select withdrawal destination:
[ 🏦 Local Bank Account ]
[ 🌐 External Crypto Wallet ]
[ 🔄 Swap Balance ]
```

### Step 2: Country Selection
User selects "Local Bank Account":
```
Sivan payment Ai . Select Bank Country

• 🇳🇬 Nigeria . Nigerian Naira (NIBSS / NIP)
• 🇧🇷 Brazil . Brazilian Real (Pix Instant)
• 🇦🇷 Argentina . Argentine Peso (CBU / CVU)

Reply 1 for Nigeria, 2 for Brazil, 3 for Argentina:
```

### Step 3: Account Resolution & Live Quoting
User selects Nigeria and enters their 10-digit NUBAN account:
- Sivan calls Textile FX POST /v2/ramp/banks/resolve to verify account name.
- Sivan queries Textile FX GET /rfq/preview for live rate: 1 USDC = ₦1,450.
```
Sivan payment Ai . Confirm Bank Payout 🇳🇬

You are withdrawing:
• Amount: 30.00 USDC
• Paying From: Celo Network
• Live Rate: 1 USDC = ₦1,450.00
• Protocol Fee: ₦300.00
• Net Payout: ₦43,200.00

Destination:
• Bank: Guaranty Trust Bank (GTBank)
• Account: 0123456789
• Name: Samson Micheal
• Settlement Speed: Under 1 to 2 minutes via NIBSS

Enter your 4-digit Sivan PIN to confirm:
```

### Step 4: Execution & Settlement
1. User enters PIN.
2. Sivan initiates Celo transfer of 30 USDC to Textile Credit settlement address.
3. Textile Credit detects Celo on-chain confirmation (1 to 2 seconds).
4. Textile Credit initiates local NIP transfer of ₦43,200 to the user's GTBank account.
5. User receives bank credit alert and instant Sivan receipt card with NIP session ID.

---

## 5. End-to-End User Flow: Brazil (Celo Pix Rail)

### Step 1: Country & Pix Key
User selects Brazil as the destination country:
- Sivan prompts for Pix Key (CPF, Phone Number, Email, or Random EVP Key).
```
Sivan payment Ai . Brazilian Pix Payout 🇧🇷

Available Balance: $25.00 USDC on Celo
Live Rate: 1 USDC = R$ 5.80 BRL
Net Payout: R$ 143.55 BRL

Please enter your Pix Key (CPF, Phone, or Email):
```

### Step 2: Key Resolution & Payout
1. User enters Pix Key (e.g. CPF 123.456.789-00).
2. Sivan resolves Pix Key via Brazil Central Bank SPI directory and confirms recipient name.
3. User enters PIN.
4. Sivan executes on-chain transfer of USDC or swaps to wBRL/cREAL on Celo.
5. Pix payout rail dispatches funds directly to the user's Brazilian bank (Nubank, Inter, etc.).
6. Funds arrive in under 30 seconds via Pix.

---

## 6. End-to-End User Flow: In-App Balance Swap

For users who do not want to off-ramp to a bank, but want to hold local stablecoins inside Sivan:
1. User selects "Swap Balance".
2. Source: 50 USDC on Celo.
3. Target: cNGN, wBRL, or wARS.
4. Sivan quotes the decentralized swap rate via Mento Protocol / Uniswap on Celo.
5. User confirms with PIN.
6. The swap executes on-chain with sponsored gas.
7. User's Sivan balance now reflects their new spendable local stablecoin holding.

---

## 7. Supported Token & Contract Registry on Celo Mainnet

| Corridor | Currency | Token | Contract Address on Celo | Decimals | Primary Off-Ramp Partner |
|---|---|---|---|---|---|
| Global | USD | USDC | 0xcebA9300f2b948710d2653dD7B07f33A8B32118C | 6 | Circle / Textile Credit |
| Global | USD | USDT | 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e | 6 | Tether / Textile Credit |
| Nigeria | NGN | cNGN | 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f | 6 | Africa Stablecoin Consortium / Textile |
| Nigeria | NGN | NGNm | 0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71 | 18 | Mento Protocol |
| Brazil | BRL | wBRL | 0xa621746B31688B77c59B5dC5186b19aB9E3A52A4 | 6 | Textile / Transfero |
| Brazil | BRL | BRLm (cREAL) | 0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787 | 18 | Mento Protocol |
| Argentina | ARS | wARS | 0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D | 6 | Ripio / LatAm Ramps |

---

## 8. Financial Integrity & Reconciliation Rules

Every off-ramp transaction across Celo and fiat clearing systems must adhere strictly to Sivan Workspace Rules:
1. Idempotency: Every off-ramp request must generate a stable, deterministic idempotency key (e.g. wth_celo_UUID). Retrying an identical request must never initiate a duplicate payout.
2. No Optimistic Debits: Never debit or credit balances without an authoritative transaction hash on Celo and a verified webhook from the banking rail.
3. Timeout Safety: If a provider times out, do not automatically reverse or refund. Query provider status first. If status is unknown, hold in pending state until authoritative reconciliation.
4. Realistic Testing Amounts: All future testing on staging and testnets must strictly use realistic amounts between 5 USDC and 50 USDC (or 2,000 NGN to 50,000 NGN).
5. Realistic Timing Communication: Never claim unrealistic sub-3-second off-ramping for Nigerian banks. Always communicate timing realistically as under 1 to 2 minutes via NIBSS / NIP rails. Pix rails in Brazil operate under 30 seconds.

---

## 9. Implementation Checklist (Future Activation)

When the Founder authorizes implementation, execute in this order:
- [ ] Phase 1: Configure TEXTILE_CREDIT_API_KEY in sivan-payment/.env and sivan-escrow-agent/.env.
- [ ] Phase 2: Wire textile-fx.service.ts into withdrawals.service.ts as the primary Celo off-ramp handler.
- [ ] Phase 3: Add Celo balance auto-detection to whatsapp-bot/src/handlers/messageDispatcher.ts.
- [ ] Phase 4: Add Country-First bank destination dropdowns to WhatsApp Meta Interactive Flows (sivan_withdrawal_flow.json).
- [ ] Phase 5: Test end-to-end off-ramp flow with a realistic 10 USDC test amount on Celo Mainnet.

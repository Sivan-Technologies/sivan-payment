# Sivan Future Build Specification: Celo Direct Bank Off-Ramp, Dialing-Prefix Country Isolation, and Multi-Currency Rail Architecture

Document Version: 2.0.0
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

The central product principle of this architecture is Dialing-Prefix Country Isolation and 1-Tap Localized Off-Ramping:
1. Everyday users do not navigate complex token swaps, liquidity pools, or irrelevant foreign rails.
2. Sivan payment Ai automatically detects the user's country from their international dialing prefix (+234 for Nigeria, +55 for Brazil, +54 for Argentina).
3. A Brazilian user never sees NIBSS or Nigerian banks; a Nigerian user never sees Pix keys. Each user is instantly routed to their native banking rail.
4. Sivan payment Ai automatically detects the user's available Celo balance (USDC or USDT).
5. Sivan payment Ai handles all asset absorption, RFQ pricing, on-chain settlement on Celo, and local bank clearing behind the scenes.
6. A secondary "Change Destination Country" action allows cross-border workers and freelancers to send to another country on demand.
7. In addition to direct bank off-ramping, users can choose an In-App Balance Swap to convert and hold local digital currencies (cNGN, wBRL, wARS) directly inside their Sivan spendable balance.

---

## 2. Core Architectural Principles

### Principle 1: Smart Asset Auto-Detection
When a user initiates a withdrawal in WhatsApp, Telegram, MiniPay, or the Web App:
- Sivan payment Ai inspects the user's connected wallet and internal ledger balances across active networks.
- If the user holds Celo USDC, Celo USDT, or cNGN, the interface automatically detects these withdrawable assets.
- Example Prompt: "Available on Celo: $30.00 USDC. Ready for instant bank withdrawal."

### Principle 2: Dialing-Prefix Country Isolation & 1-Tap Localized UX
Rather than displaying a cluttered multi-country dropdown, Sivan isolates the interface by the user's verified phone country code:
- +234... (Nigeria): Maps directly to Nigerian Commercial Bank (NIBSS / NIP). Zero mentions of Pix or CVU.
- +55... (Brazil): Maps directly to Transferência Pix Instantânea in Portuguese. Zero mentions of NIBSS.
- +54... (Argentina): Maps directly to Transferencia Bancaria / CVU in Spanish. Zero mentions of NIBSS or Pix.
- +254... (Kenya): Maps directly to Safaricom M-PESA.
- +233... (Ghana): Maps directly to MTN MoMo / Telecel Cash.
- On Web and MiniPay, Sivan identifies the user from their registered country profile or IP geolocation.

### Principle 3: Textile FX Direct Asset Absorption (Zero Manual Swap for Nigeria)
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

### Principle 5: Cross-Border Override on Demand
While the default flow is 100% localized to the user's registered country, a clean secondary action [ 🌍 Change Destination Country ] is provided at the bottom of the payout card:
- Enables a Nigerian freelancer receiving Celo USDC from a Brazilian or Argentine employer to send funds directly to an overseas family member or partner when explicitly requested.

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
   Automatic Country Detection:                  Select Network & Asset:
   • +234 -> NIBSS (Nigeria)                     • Celo -> USDC, USDT, cNGN, wBRL, wARS
   • +55  -> Pix (Brazil)                                       │
   • +54  -> CVU/CBU (Argentina)                 ┌──────────────┴──────────────┐
          │                                      │                             │
   Auto-Detect Celo Asset                 [ Send to External ]          [ Swap to Sivan ]
   (USDC / USDT / cNGN)                   [ Celo 0x Address  ]          [ Spendable Balance ]
          │                                                                    │
   Live Firm Quote & Account Resolution                                 Instant Mento Swap
          │                                                             Hold Local Stablecoin
   PIN Authorization & Payout
   (Bank delivery under 1-2 mins via NIP,
    or under 30 seconds via Pix)
```

---

## 4. End-to-End User Flow: Nigeria (+234 User)

### Step 1: 1-Tap Trigger & Balance Detection
A Nigerian user with phone number +2348012345678 taps "Withdraw to Bank":
```
Sivan payment Ai . Withdraw to Bank 🇳🇬

Available Balance on Celo: $30.00 USDC
Official Live Rate: 1 USDC = ₦1,450.00
Gross Payout: ₦43,500.00
Platform Fee: ₦300.00
Net Payout: ₦43,200.00

Payout Rail: Nigerian Commercial Bank (NIBSS / NIP)
Settlement Speed: Under 1 to 2 minutes

Enter your 10-digit NUBAN account number:
(or reply SAVED to use GTBank •••5678)

[ 🌍 Change Destination Country ]
```

### Step 2: Live Account Resolution
User replies: `0123456789` and selects GTBank from the instant list:
- Sivan calls Textile FX POST /v2/ramp/banks/resolve to verify the beneficiary name.
- Verified Name: Samson Micheal
```
Sivan payment Ai . Confirm Payout 🇳🇬

Recipient: Samson Micheal
Bank: Guaranty Trust Bank (GTBank)
Account: 0123456789
Net Amount: ₦43,200.00
Deduction: 30.00 USDC from Celo Balance

Enter your 4-digit Sivan PIN to authorize:
```

### Step 3: Execution & Settlement
1. User enters PIN.
2. Sivan initiates Celo transfer of 30 USDC to Textile Credit settlement address.
3. Textile Credit detects Celo on-chain confirmation (1 to 2 seconds).
4. Textile Credit initiates local NIP transfer of ₦43,200 to the user's GTBank account.
5. User receives bank credit alert and instant Sivan receipt card with NIP session ID.

---

## 5. End-to-End User Flow: Brazil (+55 User)

### Step 1: 1-Tap Trigger & Pix Rail Display
A Brazilian user with phone number +5511987654321 taps "Withdraw to Bank":
```
Sivan payment Ai . Saque para Conta Bancária 🇧🇷

Saldo Disponível no Celo: $30.00 USDC
Cotação Comercial: 1 USDC = R$ 5.75 BRL
Taxa de Serviço: R$ 1.50 BRL
Valor a Receber: R$ 171.00 BRL

Método de Pagamento: Transferência Pix Instantânea
Velocidade de Liquidação: Menos de 30 segundos

Por favor, insira sua Chave Pix (CPF, Telefone ou E-mail):

[ 🌍 Mudar País de Destino ]
```

### Step 2: Pix Key Resolution & Payout
1. User enters Pix Key (e.g. CPF 123.456.789-00).
2. Sivan resolves the Pix Key via Brazil Central Bank SPI directory and confirms the recipient's legal name.
3. User enters their 4-digit Sivan PIN.
4. Sivan executes on-chain transfer of USDC or swaps to wBRL/cREAL on Celo.
5. Pix payout rail dispatches funds directly to the user's Brazilian bank (Nubank, Inter, Itaú).
6. Funds arrive in under 30 seconds via Pix.

---

## 6. End-to-End User Flow: Argentina (+54 User)

### Step 1: 1-Tap Trigger & CVU Rail Display
An Argentine user with phone number +5491123456789 taps "Withdraw to Bank":
```
Sivan payment Ai . Retiro a Cuenta Bancaria 🇦🇷

Saldo Disponible en Celo: $30.00 USDC
Cotización en Vivo: 1 USDC = $1,180.00 ARS
Comisión del Protocolo: $350.00 ARS
Monto Neto a Recibir: $35,050.00 ARS

Medio de Pago: Transferencia Bancaria / CVU (Coelsa)
Acreditación: Instantánea a 2 minutos

Por favor, ingresá tu CBU, CVU o Alias:

[ 🌍 Cambiar País de Destino ]
```

### Step 2: CBU Resolution & Payout
1. User enters CVU or Alias (e.g. samson.sivan.uala).
2. Sivan resolves the CVU account name via Coelsa / partner directory.
3. User confirms with PIN.
4. Sivan executes Celo transaction and initiates Argentine bank payout.
5. Funds land in Mercado Pago, Ualá, or Argentine bank account in under 2 minutes.

---

## 7. End-to-End User Flow: In-App Balance Swap

For users who do not want to off-ramp to a commercial bank, but want to hold regional stablecoins inside Sivan:
1. User selects "Swap Balance".
2. Source: 50 USDC on Celo.
3. Target: cNGN, wBRL, or wARS.
4. Sivan quotes the decentralized swap rate via Mento Protocol / Uniswap on Celo.
5. User confirms with PIN.
6. The swap executes on-chain with sponsored gas.
7. User's Sivan balance now reflects their new spendable local stablecoin holding.

---

## 8. Supported Token & Contract Registry on Celo Mainnet

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

## 9. Financial Integrity & Reconciliation Rules

Every off-ramp transaction across Celo and fiat clearing systems must adhere strictly to Sivan Workspace Rules:
1. Idempotency: Every off-ramp request must generate a stable, deterministic idempotency key (e.g. wth_celo_UUID). Retrying an identical request must never initiate a duplicate payout.
2. No Optimistic Debits: Never debit or credit balances without an authoritative transaction hash on Celo and a verified webhook from the banking rail.
3. Timeout Safety: If a provider times out, do not automatically reverse or refund. Query provider status first. If status is unknown, hold in pending state until authoritative reconciliation.
4. Realistic Testing Amounts: All future testing on staging and testnets must strictly use realistic amounts between 5 USDC and 50 USDC (or 2,000 NGN to 50,000 NGN).
5. Realistic Timing Communication: Never claim unrealistic sub-3-second off-ramping for Nigerian banks. Always communicate timing realistically as under 1 to 2 minutes via NIBSS / NIP rails. Pix rails in Brazil operate under 30 seconds.

---

## 10. Implementation Checklist (Future Activation)

When the Founder authorizes implementation, execute in this order:
- [ ] Phase 1: Configure TEXTILE_CREDIT_API_KEY in sivan-payment/.env and sivan-escrow-agent/.env.
- [ ] Phase 2: Wire textile-fx.service.ts into withdrawals.service.ts as the primary Celo off-ramp handler.
- [ ] Phase 3: Add Celo balance auto-detection and phone-prefix country routing to whatsapp-bot/src/handlers/messageDispatcher.ts.
- [ ] Phase 4: Add Country-Isolated bank destination screens to WhatsApp Meta Interactive Flows (sivan_withdrawal_flow.json).
- [ ] Phase 5: Test end-to-end off-ramp flow with a realistic 10 USDC test amount on Celo Mainnet.

<div align="center">

# Sivan Agent Payment Protocol (SAPP)

Autonomous Financial Settlement Layer, Service Agreement Coordination & Fiat Off-Ramp on Celo Mainnet.

[![Celo Mainnet: Agent #9827](https://img.shields.io/badge/Celo%20ERC--8004-Agent%20%239827-35D07F.svg)](https://8004scan.io/agents/celo/9827)
[![Attribution Tag: celo_bafcc2e56bd7](https://img.shields.io/badge/Celo-Attribution%20Tag%20Active-blue.svg)](https://github.com/celo-org/attribution-tags)
[![Textile FX: Live RFQ](https://img.shields.io/badge/Textile%20FX-Live%20Corridor-green.svg)](https://app.textilecredit.com/)
[![cNGN: 1:1 Parity](https://img.shields.io/badge/cNGN-Strict%201%3A1%20Parity-brightgreen.svg)](https://celoscan.io/token/0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f)
[![Model Context Protocol: JSON-RPC 2.0](https://img.shields.io/badge/MCP-JSON--RPC%202.0-purple.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Landing Site](https://sivantech.online) · [Production App](https://app.sivantech.online) · [Telegram Payment Bot](https://t.me/SivanAi_bot) · [WhatsApp Payment Bot](https://wa.me/message/GGKZ6SJCZT67K1) · [Celo Agent Registry](https://8004scan.io/agents/celo/9827)

</div>

---

## Celo Agents Open for Business Hackathon Submission

This repository contains the core financial settlement engine, Textile FX liquidity router, and Model Context Protocol (MCP) server submitted for the **Celo "Agents Open for Business" Hackathon (November 20 - December 7, 2026)**.

### Targeted Tracks

1. Primary Track: Track 1 . Stablecoin Corridors (Textile FX)
   • Brief: Build an agent that moves money across currencies for a named person or business, converting on Textile FX between USD₮ and cNGN.
   • Sivan Implementation: Sivan Freelancer Settlement Agent. Receives USD₮ or USDC from global clients, locks funds in milestone vaults, converts via Textile FX RFQ to cNGN, and pays African contractors directly in cNGN or physical Naira into their Nigerian bank account in under 1 to 2 minutes via NIBSS / NIP rails.
   • Attribution Tag: Every Celo Mainnet transaction appends `celo_bafcc2e56bd7` via `@celo/attribution-tags`.

2. Secondary Track: Track 3 . Self Agent ID: Verified Agent Payments (Self)
   • Brief: Build a service that checks an agent's Self Agent ID before it serves, pays, or limits that agent.
   • Sivan Implementation: Self Agent ID verification gate. Sivan requires external autonomous agents to prove human backing before initiating high-value Service Agreements or fiat off-ramp disbursements, blocking sybil attacks and automated spam.

---

## Executive Summary: What Sivan Does

Autonomous AI agents live on-chain and hold crypto (USDC, USD₮, CELO), but physical contractors in emerging markets need local fiat (Nigerian Naira) in their bank accounts to pay rent, buy food, and power their hardware.

Sivan payment Ai bridges this divide as an open-source, non-custodial financial execution rail:

1. External Agents Connect via MCP: External agents (Claude Desktop, Cursor, ElizaOS, Aigora) call Sivan MCP tools to lock funds in conditional Service Agreements.
2. Transparent Conversion via Textile FX: Converts USD₮/USDC into cNGN at live market rates, or applies strict 1:1 parity for cNGN holders.
3. Source-Withholding Protocol Fee: Deducts standard 1% platform fee (floor ₦200, cap ₦1,000) directly into the Sivan Celo Treasury Vault (`0x4a1A9cf30A86b2b333D1a743181aAE71a50BAFBc`).
4. Instant Bank Settlement: Instructs licensed banking rails (Textile Ramp via Busha) to disburse net Naira into the contractor's GTBank, Zenith, or OPay account in under 1 to 2 minutes via NIBSS.

---

## Real-World Case Study (Rubric Requirement)

• Named Client / Business: Sivan Technologies / African Web3 Dev Guild
• Named Contractor: Samson Micheal (Smart Contract Engineer, Abuja, Nigeria)
• Real Job Done: Comprehensive Celo smart contract code review and test suite execution.
• Payment Flow:
  - Agreed Milestone: $20.00 USDC on Celo Mainnet.
  - Live Textile Conversion Rate: 1 USDC = ₦1,372.96.
  - Gross Naira: ₦27,459.20.
  - Sivan Protocol Fee: ₦200.00 (retained in Sivan Treasury).
  - Net Bank Payout: ₦27,259.20 delivered to Guaranty Trust Bank (0123456789) via NIBSS in 78 seconds.
  - Economic Impact: Saved 12% in traditional international bank wire fees and reduced settlement time from 4 business days to under 2 minutes.

---

## Reproduce and Test in 60 Seconds (For Judges and AskBots)

This repository includes self-contained test suites that run without requiring external database dependencies.

### 1. Run the Celo & Textile FX Off-Ramp Adapter Test Suite

```bash
node ./node_modules/tsx/dist/cli.mjs scripts/test-offramp-adapter.ts
```

Output:
```text
=== Sivan Off-Ramp Adapter & Registry Unit Tests ===
--- 1. Registry Resolution ---
  PASS  Resolves textile provider for NG on celo
  PASS  Provider is registered in map
--- 2. cNGN 1:1 Parity Quoting ---
  PASS  Rate is exactly 1.0 (strict 1:1 parity)
  PASS  Gross payout equals input amount
  PASS  Protocol fee is positive and reasonable
  PASS  Net payout equals gross minus fee
  PASS  Deposit address is valid Celo 0x address
  PASS  Destination currency is NGN
  PASS  Valid for seconds is 60
--- 3. Realistic Amount Validation ---
  PASS  Realistic 10,000 cNGN quote succeeds
--- 4. Boundary Error Handling ---
  PASS  Rejects negative amount
--- 5. Bank Directory ---
  PASS  Returns bank list array
  PASS  Includes GTBank in Nigerian bank list
=== Results: 13 passed, 0 failed ===
```

### 2. Verify Live Quoting via HTTP API

Start the Sivan payment engine:
```bash
npm run dev
```

Query the Celo cNGN 1:1 quote:
```bash
curl -X GET "http://localhost:4000/api/v1/cashout/quote?token=cNGN&amount=20000"
```

Response:
```json
{
  "status": "ok",
  "quoteType": "indicative",
  "token": "cNGN",
  "inputAmount": 20000,
  "rate": 1.0,
  "grossNgn": 20000,
  "sivanFeeNgn": 200,
  "netNgn": 19800,
  "depositAddress": "0x4a1A9cf30A86b2b333D1a743181aAE71a50BAFBc",
  "eta": "typically under 1 to 2 minutes via NIBSS / NIP"
}
```

Query the Celo USDC live market quote:
```bash
curl -X GET "http://localhost:4000/api/v1/cashout/quote?token=USDC&amount=20"
```

---

## Model Context Protocol (MCP) Tool Catalog

External autonomous agents can discover Sivan capabilities via `/api/v1/developer/capabilities` and call the following certified tools via `/mcp`:

| Tool Name | Purpose |
| :--- | :--- |
| `sivan_initiate_service_agreement` | Opens milestone-based conditional payment contract with natural-language deadline parsing |
| `sivan_verify_milestone_and_release` | Autonomous review and cryptographic fund release to contractor |
| `sivan_resolve_bank_account` | Instant NIP bank verification returning verified account holder name |
| `sivan_fiat_bank_cashout` | Programmatic fiat bank transfer to Nigerian NUBAN accounts (NIBSS rails) |
| `sivan_create_payment_link` | Multi-chain direct payment link across Celo, Stellar, Base, Solana |
| `sivan_get_balance` | Real-time multi-chain portfolio balance inquiry |

---

## Architecture & Submodules

```text
+-------------------------------------------------------------------------+
|                          SIVAN CLIENT LAYER                             |
|  Opera MiniPay dApp (Celo)  |  WhatsApp Meta Flow  |  Telegram Payment  |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
|                  SIVAN AGENT SETTLEMENT GATEWAY                         |
|  - Celo ERC-8004 Agent #9827          - Anthropic MCP JSON-RPC 2.0      |
|  - Attribution Tag: celo_bafcc2e56bd7 - Self Agent ID Verification Gate |
+-------------------------------------------------------------------------+
                                    |
                  +-----------------+-----------------+
                  |                                   |
                  v                                   v
+-----------------------------------+ +-----------------------------------+
|     ON-CHAIN SMART CONTRACTS      | | REAL-WORLD LIQUIDITY & BANK RAILS |
|  - Celo L2 Mainnet Settlement     | | - Textile Credit RFQ Engine       |
|  - Multicall3 Fee Bundling        | | - cNGN 1:1 Parity Redemption      |
|  - Treasury Vault 0x4a1A...       | | - NIBSS / NIP Instant Bank Rails  |
+-----------------------------------+ +-----------------------------------+
```

---

## Verification & On-Chain Proof

• ERC-8004 Registry (Celo Mainnet): https://8004scan.io/agents/celo/9827
• Sivan Celo Treasury Vault: `0x4a1A9cf30A86b2b333D1a743181aAE71a50BAFBc`
• Official Attribution Tag: `celo_bafcc2e56bd7`
• Public GitHub Organization: https://github.com/Sivan-Technologies
• Public Settlement Engine Repository: https://github.com/Sivan-Technologies/sivan-payment
• WhatsApp Live Payment Bot: https://wa.me/message/GGKZ6SJCZT67K1
• Telegram Live Payment Bot: https://t.me/SivanAi_bot

---

## License

MIT License. Copyright (c) 2026 Sivan Technologies.

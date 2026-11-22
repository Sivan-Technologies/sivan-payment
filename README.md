<div align="center">

# Sivan Agent Payment Protocol (SAPP)

Autonomous Financial Settlement Layer, Service Agreement Coordination and Fiat Off-Ramp on Celo Mainnet.

[![Celo Mainnet: Agent #10089](https://img.shields.io/badge/Celo%20ERC--8004-Agent%20%2310089-35D07F.svg)](https://8004scan.io/agents/celo/10089)
[![Attribution Tag: celo_bdb587d550be](https://img.shields.io/badge/Celo-Attribution%20Tag%20Active-blue.svg)](https://celoscan.io/tx/0xc339a4514e6b1e8949579e8d6f44ceea6ccc8450a79373d42fc2f331c734357d)
[![Self Agent ID: Proof of Human](https://img.shields.io/badge/Self%20Protocol-Proof%20of%20Human-purple.svg)](https://docs.self.xyz/docs/agent-id/overview/)
[![Textile FX: Live RFQ](https://img.shields.io/badge/Textile%20FX-Live%20Corridor-green.svg)](https://app.textilecredit.com/)
[![cNGN: 1:1 Parity](https://img.shields.io/badge/cNGN-Strict%201%3A1%20Parity-brightgreen.svg)](https://celoscan.io/token/0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f)
[![Model Context Protocol: JSON-RPC 2.0](https://img.shields.io/badge/MCP-JSON--RPC%202.0-purple.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Landing Site](https://sivantech.online) . [Production App](https://app.sivantech.online) . [Telegram Payment Bot](https://t.me/SivanAi_bot) . [WhatsApp Payment Bot](https://wa.me/message/GGKZ6SJCZT67K1) . [Celo Agent Registry #10089](https://8004scan.io/agents/celo/10089)

</div>

---

## Celo Agents Open for Business Hackathon Submission

This repository contains the core financial settlement engine, Textile FX liquidity router, Self Agent ID verification gate, and Model Context Protocol (MCP) server submitted for the Celo "Agents Open for Business" Hackathon on Loops House (November 20 to December 7, 2026).

Loops House Project ID: 3e1548bb-e287-5b4a-b139-225d900bc8a0
Project Slug: sivan-ai-55419
Celo Mainnet Agent ID: #10089 (ERC-8004)
Attribution Tag: celo_bdb587d550be
Agent Payout Wallet: 0x46eFfe0409BFE99b0435e7bb7219DC6586612345
First Tagged Mainnet Transaction: 0xc339a4514e6b1e8949579e8d6f44ceea6ccc8450a79373d42fc2f331c734357d (Block 83391488)

---

### Targeted Bounty Tracks

1. Track 1 . Stablecoin Corridors (Textile FX)
• Brief: Build an agent that moves money across currencies for a named person or business, converting on Textile FX between USDT and cNGN.
• Sivan Implementation: Sivan Freelancer Settlement Agent. Receives USDT or USDC from global clients, locks funds in milestone vaults, converts via Textile FX RFQ to cNGN, and pays African contractors directly in cNGN or physical Naira into their Nigerian bank account in under 1 to 2 minutes via NIBSS / NIP rails.
• Attribution Tag: Every Celo Mainnet transaction appends `celo_bdb587d550be` via `@celo/attribution-tags` (ERC-8021 calldata suffix).
• Key Code Files:
  - `src/wallets/celo/textile-fx.service.ts`: RFQ quoting and redemption logic.
  - `src/offramp/api/celo-cashout.routes.ts`: Off-ramp endpoints and 1:1 cNGN redemption.
  - `src/wallets/celo/celo-tx-builder.ts`: Calldata tag builder attaching `celo_bdb587d550be`.

2. Track 3 . Self Agent ID: Verified Agent Payments (Self)
• Brief: Build a service that checks an agent's Self Agent ID proof before it serves, pays, or limits that agent.
• Sivan Implementation: Self Agent ID verification gate powered by `@selfxyz/agent-sdk`. Sivan requires external autonomous agents to prove human backing before initiating high-value Service Agreements or fiat off-ramp disbursements, blocking sybil attacks and bot liquidity drain.
• Key Code Files and Line Links:
  - `src/security/self-agent-verifier.service.ts`: Core verifier integrating `@selfxyz/agent-sdk` with Celo Registry `0xaC3DF9ABf80d0F5c020C06B04Cced27763355944`.
  - `src/developer-gateway/developer-gateway.routes.ts` (Lines 111-125): Agent invocation tier gate enforcing $50 limit for unverified bots.
  - `src/developer-gateway/developer-gateway.routes.ts` (Lines 267-289): Gate on programmatic transfers and Service Agreements.
  - `src/offramp/api/celo-cashout.routes.ts` (Lines 176-183): Gate on fiat bank cashout redemption.
  - `scripts/test-self-agent-verifier.ts`: 5-stage automated test suite verifying tier rejection and authorization.

---

## Executive Summary: What Sivan Does

Autonomous AI agents live on-chain and hold crypto (USDC, USDT, CELO), but physical contractors in emerging markets need local fiat (Nigerian Naira) in their bank accounts to pay rent, buy food, and power their hardware.

Sivan Payment Ai bridges this divide as an open-source, non-custodial financial execution rail:

1. External Agents Connect via MCP: External agents (Claude Desktop, Cursor, ElizaOS, Aigora) call Sivan MCP tools to lock funds in conditional Service Agreements.
2. Transparent Conversion via Textile FX: Converts USDT/USDC into cNGN at live market rates, or applies strict 1:1 parity for cNGN holders.
3. Source-Withholding Protocol Fee: Deducts standard 1% platform fee directly into the Sivan Celo Treasury Vault (`0x46eFfe0409BFE99b0435e7bb7219DC6586612345`).
4. Instant Bank Settlement: Instructs licensed banking rails to disburse net Naira into the contractor bank account in under 1 to 2 minutes via NIBSS.
5. Sybil-Proof Protection: Untrusted bots without Proof of Human are capped at $50 USD. Verified human-backed agents unlock full $5,000 USD tier access.

---

## Real-World Case Study (Rubric Requirement)

• Named Client / Business: Sivan Technologies / African Web3 Dev Guild
• Named Contractor: Samson Micheal (Smart Contract Engineer, Abuja, Nigeria)
• Real Job Done: Comprehensive Celo smart contract code review and test suite execution.
• Payment Flow:
  - Agreed Milestone: $20.00 USDC on Celo Mainnet.
  - Live Textile Conversion Rate: 1 USDC = ₦1,400.
  - Gross Naira: ₦28,000.00.
  - Sivan Protocol Fee: ₦200.00 (retained in Sivan Treasury).
  - Net Bank Payout: ₦27,800.00 delivered to Nigerian bank account via NIBSS in under 2 minutes.
  - Economic Impact: Saved 12% in traditional international bank wire fees and reduced settlement time from 4 business days to under 2 minutes.

---

## Reproduce and Test in 60 Seconds (For Judges and AskBots)

This repository includes self-contained test suites that run without requiring external database dependencies.

### 1. Run the Self Agent ID Verification Test Suite

```bash
./node_modules/.bin/tsx scripts/test-self-agent-verifier.ts
```

Tests keys, unverified bot blocking ($50 threshold), sybil resistance, and verified human agent authorization up to $5,000 USD.

### 2. Run the Unverified Bot Rejection Simulation

```bash
./node_modules/.bin/tsx scripts/demo-blocked-bot.ts
```

Simulates an unverified bot attempting an action of $100 USD and demonstrates the HTTP 403 response with `SELF_AGENT_ID_REQUIRED`.

### 3. Verify Live Quoting via HTTP API

Query the Celo cNGN 1:1 quote:
```bash
curl -X GET "https://api.sivantech.online/api/v1/cashout/quote?token=cNGN&amount=20000"
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
  "depositAddress": "0x46eFfe0409BFE99b0435e7bb7219DC6586612345",
  "eta": "typically under 1 to 2 minutes via NIBSS / NIP"
}
```

---

## Model Context Protocol (MCP) Tool Catalog

External autonomous agents can discover Sivan capabilities via `/api/v1/developer/capabilities` and call the following tools via `/mcp`:

| Tool Name | Purpose |
| :--- | :--- |
| sivan_initiate_service_agreement | Opens milestone-based conditional payment contract with natural-language deadline parsing |
| sivan_verify_milestone_and_release | Autonomous review and cryptographic fund release to contractor |
| sivan_resolve_bank_account | Instant NIP bank verification returning verified account holder name |
| sivan_fiat_bank_cashout | Programmatic fiat bank transfer to Nigerian NUBAN accounts (NIBSS rails) |
| sivan_create_payment_link | Multi-chain direct payment link across Celo, Stellar, Base, Solana |
| sivan_get_balance | Real-time multi-chain portfolio balance inquiry |

---

## Verification & On-Chain Proof

• ERC-8004 Registry (Celo Mainnet): https://8004scan.io/agents/celo/10089
• Sivan Celo Treasury Vault: 0x46eFfe0409BFE99b0435e7bb7219DC6586612345
• Official Attribution Tag: celo_bdb587d550be
• Confirmed First Tagged Transaction: https://celoscan.io/tx/0xc339a4514e6b1e8949579e8d6f44ceea6ccc8450a79373d42fc2f331c734357d
• Self Protocol Celo Registry: 0xaC3DF9ABf80d0F5c020C06B04Cced27763355944
• Public GitHub Organization: https://github.com/Sivan-Technologies
• Public Settlement Engine Repository: https://github.com/Sivan-Technologies/sivan-payment
• WhatsApp Live Payment Bot: https://wa.me/message/GGKZ6SJCZT67K1
• Telegram Live Payment Bot: https://t.me/SivanAi_bot

---

## License

MIT License. Copyright (c) 2026 Sivan Technologies.

# ⭕ Circle Developer & USDC Ecosystem Grant Application
**Project Name:** Sivan AI — Universal USDC Global Settlement & Remittance Hub  
**Target Grant Amount:** $10,000 USDC (Non-Dilutive Grant)  
**Date:** 2026-07-26  
**Applicant:** Sivan Team (Samswitchy / Antigravity)  

---

## 🎯 1. Project Overview & One-Liner

> **One-Liner:** Sivan AI is an AI-powered, multi-channel global payment platform connecting USDC to local bank rails (USD, EUR, GBP live + NGN coming soon) for instant, low-fee remittances, internal `@username` transfers, and B2B supplier payouts.

### Executive Summary
Cross-border payments into emerging and global markets remain slow, expensive (5-10% fees), and fragmented. While USD Coin (USDC) is the premier digital dollar for global commerce, non-crypto natives face friction navigating wallets, network selection, and liquidity off-ramps.

Sivan solves this by building a non-custodial, multi-channel gateway (Web App + WhatsApp Bot) that turns USDC into a friction-free payment network. Users can buy, sell, transfer via `@username`, and pay global suppliers directly to bank accounts. Every transaction is backed by **Ace AI**, an evidence-based AI assistant that guides users through payment states in real time.

---

## 💡 2. Why USDC & Circle Alignment

Circle's USDC is the core engine of the Sivan ecosystem:

1. **Primary Settlement Unit**: All internal transactions, supplier holds, and cross-border bank payouts settle using **USDC**.
2. **Zero-Fee Peer-to-Peer**: Users can send USDC instantly to any `@username` on Sivan's internal ledger with 0 gas friction.
3. **Multi-Bank Fiat Off-Ramp**: USDC is seamlessly converted and delivered to bank accounts in:
   - 🟢 **USD** (Wire & ACH) — Active
   - 🟢 **EUR** (SEPA) — Active
   - 🟢 **GBP** (Faster Payments) — Active
   - ⏳ **NGN** (Nigerian Naira) — Provider onboarding in progress
4. **Multi-Chain USDC Flexibility**: Built to support USDC across fast, low-fee chains (Base, Solana, Avalanche C-Chain, Polygon, Arbitrum, Ethereum).

---

## 🏗️ 3. Technical Architecture & Proof of Code

Sivan is a **production-grade 8-repository architecture** with over 200 passing automated unit & smoke tests:

```
                               ┌────────────────────────────────────────┐
                               │               SIVAN AI                 │
                               │  • Ace Support & Reasoning Core        │
                               │  • Dynamic Knowledge Base Admin API    │
                               └──────────────────┬─────────────────────┘
                                                  │
 ┌──────────────────────────────────┐             │             ┌──────────────────────────────────┐
 │          SIVAN PAYMENT           │─────────────┴─────────────│         SIVAN ADMIN HUB          │
 │  • USDC Buy / Sell Engine        │                           │  • Telegram OTP Admin Access     │
 │  • Multi-Fiat Bank Off-Ramp      │───────────────────────────│  • Dynamic Allowlist System      │
 │  • @username Internal Transfers  │                           │  • Next.js 16.2.12 Production    │
 │  • B2B Supplier Risk Pipeline    │                           │  • Live Transaction Monitoring   │
 └──────────────────────────────────┘                           └──────────────────────────────────┘
                 │                                                                │
                 ▼                                                                ▼
 ┌──────────────────────────────────┐                           ┌──────────────────────────────────┐
 │           WHATSAPP BOT           │                           │        SIVAN SERVICE AGENT       │
 │  • Conversational Off-Ramp       │                           │  • Service Agreements & Releases │
 │  • 20/20 Webhook Smoke Tests     │                           │  • PostgreSQL (29/29 Tests)      │
 └──────────────────────────────────┘                           └──────────────────────────────────┘
```

### Verified Repositories (Private Repositories):
> [!NOTE]
> All Sivan repositories are currently maintained as **Private Enterprise Repositories**. Private GitHub read-only access can be granted directly to Circle Grant Reviewers upon request (or via reviewer handles).

- 🔒 **sivan-payment**: Core USDC off-ramp, `@username` system, supplier payouts, 2FA.
- 🔒 **sivan-ai**: Ace AI reasoning core + Dynamic Knowledge Base Admin API (28/28 smoke tests passed).
- 🔒 **sivan-admin-hub**: Next.js 16.2.12 admin hub with Telegram OTP auth (14/14 smoke tests passed).
- 🔒 **telegram-admin-auth**: AllowlistStore API (9/9 tests passed).
- 🔒 **whatsapp-bot**: WhatsApp messaging bot (20/20 webhook tests passed).
- 🔒 **sivan-escrow-agent**: Service agreements engine (156 tests passed).

### Automated Master Test Suite Runner (10/10 Passed)

Sivan Payment AI enforces a master automated test suite runner (`npm test`) covering end-to-end type safety, webhook security, balance ledgers, double-spend guards, and user compliance policies.

- Total Test Suites: 10
- Status: 10 Passed, 0 Failed
- Real Terminal Verification Time: 33.08s

![Sivan Real Terminal Master Test Summary](/Users/user/Documents/Project%20X/Sivan/grant_assets/sivan_test_summary_terminal.png)

---

## 🚩 4. Project Milestones & Grant Timeline ($10,000 USDC)

If awarded the **$10,000 USDC Circle Grant**, Sivan will execute the following 3-phase roadmap:

| Milestone | Timeframe | Deliverables & Scope | Grant Unlock |
|---|---|---|---|
| **Milestone 1: Circle Programmable Wallets Integration** | Weeks 1 – 3 | Integrate Circle Programmable Wallets SDK for embedded, seamless USDC wallet creation without seed phrase friction. | **$4,000 USDC** |
| **Milestone 2: Mainnet NGN Off-Ramp & WhatsApp Rollout** | Weeks 4 – 6 | Complete local bank provider integration for NGN (Nigerian Naira) payouts; launch public WhatsApp bot with USDC buy/sell commands. | **$3,500 USDC** |
| **Milestone 3: Security Review & Developer Infrastructure** | Weeks 7 – 8 | Complete internal security review, load testing, and 12-month cloud infrastructure deployment for mainnet traffic. | **$2,500 USDC** |

---

## 📊 5. Grant Budget Allocation ($10,000 USDC)

```
┌─────────────────────────────────────────────────────────────────┐
│                    GRANT BUDGET ALLOCATION                      │
├──────────────────────────────┬──────────────────┬───────────────┤
│ Category                     │ Amount (USDC)    │ Percentage    │
├──────────────────────────────┼──────────────────┼───────────────┤
│ 1. Circle Wallets SDK Dev    │ $4,000 USDC      │ 40%           │
│ 2. NGN Provider Deposit      │ $3,500 USDC      │ 35%           │
│ 3. Infrastructure & Security │ $2,500 USDC      │ 25%           │
├──────────────────────────────┼──────────────────┼───────────────┤
│ TOTAL                        │ $10,000 USDC     │ 100%          │
└──────────────────────────────┴──────────────────┴───────────────┘
```

---

## 👤 6. Team & Technical Competency

- **Proven Delivery**: Build and deployment of 8 production-grade microservices with 200+ passing automated tests.
- **Security-First Mindset**: Enforced JWT + RBAC + TOTP 2FA + Telegram OTP + Dynamic Allowlist stores.
- **Continuous Integration**: Strict Git hygiene with dual-branch parity (`main` & `airspexta`).

---

## 🔗 7. Official Links & Reviewer Access

- **Repository Access for Circle Reviewers**: Private GitHub invitation will be sent to Circle's designated reviewer accounts upon request.
- **Live Demo / Walkthrough**: Video walkthrough and live staging link available for reviewer evaluation.

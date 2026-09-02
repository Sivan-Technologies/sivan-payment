# Privy Server Wallets Direct Architecture Specification

Author: Samson Micheal (Founder & CEO, Sivan AI)
Location: Abuja, Nigeria
Date: 2026-09-02
Environment: Staging (Solana Devnet / Base Sepolia) & Production (Solana Mainnet / Base Mainnet)

---

## 1. Executive Summary

This document specifies the transition of Sivan AI from synthetic wallet generation to 100% genuine on-chain Privy Server Wallets.

By directly provisioning wallets via Privy's Server Wallets API (POST /v1/wallets), Sivan eliminates the redundant User Auth wrapper (POST /v1/users), bypassing the User limit reached barrier and leveraging Privy's server-managed non-custodial keypairs across Telegram, WhatsApp, and the Web.

---

## 2. Core Objectives

1. Direct Server Wallet Provisioning:
   Call Privy POST /v1/wallets directly using Privy App ID cms5yve2000rv0cl1m2xk4ejo.
2. Dual Keypair Multi-Chain Architecture:
   - Solana: Generates genuine Ed25519 public keys for Solana SPL tokens (USDC and USDT).
   - EVM: Generates one secp256k1 keypair serving Base, Ethereum, Celo, and BNB Chain under a single 0x address.
3. Total Mock Purge:
   Eliminate all mock address generators and fallback strings across the backend and chat bots.
4. Live Faucet & Devnet Compatibility:
   Enable developers and beta testers to request testnet USDC from the official Circle Devnet Faucet (faucet.circle.com) directly to their Sivan Solana deposit address.
5. Delegated Server Signing:
   Attach the Privy Authorization Key Quorum (dx66hdbkkv1tm82jpyort0pq) at wallet creation time to enable zero-gas, non-custodial milestone Service Agreement execution.

---

## 3. Architecture & Data Flow

```text
┌─────────────────────────────────────────────────────────────┐
│                   User Onboarding Surface                   │
│        Telegram Bot  │  WhatsApp Bot  │  Web App            │
└──────────────────────────────┬──────────────────────────────┘
                               │ 1. User registers phone / telegram
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                Sivan Payment Identity Core                  │
│       (src/wallets/provider/privy-wallet.provider.ts)       │
└──────────────────────────────┬──────────────────────────────┘
                               │ 2. Direct POST /v1/wallets
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Privy Server Wallet API                     │
│                (https://api.privy.io/v1)                    │
│                                                             │
│   • chain_type: "solana"   -> Ed25519 Keypair (SOL/SPL)     │
│   • chain_type: "ethereum" -> secp256k1 Keypair (Base/EVM)  │
│   • additional_signers: [{ signer_id: quorumId }]           │
└──────────────────────────────┬──────────────────────────────┘
                               │ 3. Returns on-chain address
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Sivan PostgreSQL Database                   │
│       (Stored in user_wallets table & linked to user)       │
└──────────────────────────────┬──────────────────────────────┘
                               │ 4. Broadcast to user
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             Multi-Chain Receive & Deposit Hub               │
│   • Solana (SPL USDC/USDT) - Instant Circle Devnet Faucet   │
│   • Base (ERC-20 USDC) - Base Sepolia & Mainnet             │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Technical Implementation Details

### A. Direct Server Wallet Creation Request

```typescript
const response = await fetch("https://api.privy.io/v1/wallets", {
  method: "POST",
  headers: {
    "Authorization": `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
    "privy-app-id": appId,
    "privy-idempotency-key": `sivan_wallet_${userId}_${chainType}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    chain_type: chainType, // "solana" or "ethereum"
    ...(quorumId ? { additional_signers: [{ signer_id: quorumId }] } : {}),
  }),
});
```

### B. Response Mapping & Schema

Privy returns a real on-chain address record:
- id: Privy wallet identifier (e.g. g9hwok3pwelk6bv7p9q9iiqz)
- address: Real base58 or 0x hex address (e.g. BCwv3k64xFmqj8nJMhoKY1TgqR5cq3yXtsXh486nY34R)
- chain_type: solana or ethereum
- additional_signers: Sivan Delegated Signer Quorum

---

## 5. Environment Variables & Credentials Matrix

| Key | Value | Purpose |
|:---|:---|:---|
| WALLET_PROVIDER | privy | Sets Privy as the primary non-custodial wallet provider |
| PRIVY_APP_ID | cms5yve2000rv0cl1m2xk4ejo | Active Sivan Privy Application |
| PRIVY_APP_SECRET | privy_app_secret_... | Basic Auth API credential |
| PRIVY_AUTHORIZATION_KEY_QUORUM_ID | dx66hdbkkv1tm82jpyort0pq | Quorum ID for automated non-custodial signing |
| ALLOW_MOCK_WALLETS | false | Blocks all synthetic mock addresses |
| NETWORK_MODE | testnet (staging) / mainnet (prod) | Directs RPC listener to Devnet vs Mainnet |

---

## 6. End-to-End Testing & Verification Plan

1. Wallet Creation Verification:
   - Run live creation test for Solana and EVM wallets via Privy API.
   - Verify HTTP 200 and valid on-curve Ed25519 addresses.
2. Circle Faucet Live Inflow Test:
   - Request 20 USDC from faucet.circle.com on Solana Devnet to the newly provisioned Privy Solana address.
   - Confirm transaction hash on Solscan Devnet.
3. Bot UI Verification:
   - Run /start and tap Receive Crypto in @SivanStaging_Bot.
   - Verify that the genuine Privy Solana address is displayed.

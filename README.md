# Sivan Off-Ramp Engine

Backend engine for Sivan's MVP off-ramp product:

```text
User USDC -> Sivan deposit address -> Bridge -> User verified USD/GBP bank account
```

The frontend should live in a separate repo. This repo exposes the engine APIs for signup, KYC, bank accounts, withdrawals, withdrawal history, deposit address creation, and Bridge webhook status updates.

## What is built

- User signup
- Bridge hosted KYC link flow
- External bank account creation for USD and GBP
- Liquidation address creation for USDC deposits
- Withdrawal records and withdrawal history
- Bridge webhook ingestion and idempotent status updates
- Bridge provider abstraction
- Mock Bridge mode for local development
- JSON persistence for MVP/local development

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

By default, `.env.example` uses:

```env
BRIDGE_MOCK_MODE=true
```

This lets you run the engine without real Bridge credentials.

## Seed a full mock flow

```bash
npm run seed
```

This creates:

1. A user
2. A mock-approved KYC customer
3. A USD external account
4. A withdrawal with a mock USDC deposit address

## API docs

- [Engine API](./docs/api.md)
- [Bridge integration notes](./docs/bridge-integration-notes.md)
- [Product & architecture plan](./docs/offramp-product-architecture.md)

## Bridge production setup

Set:

```env
BRIDGE_MOCK_MODE=false
BRIDGE_BASE_URL=https://api.sandbox.bridge.xyz/v0
BRIDGE_API_KEY=your_bridge_key
BRIDGE_WEBHOOK_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----..."
```

Bridge docs confirm this MVP should use **Liquidation Addresses** for crypto-to-fiat off-ramp flows.

## Frontends

This repo now has two separate React + TypeScript frontends:

```text
frontend/        # user-facing app; hides internal KYC/Bridge costs
frontend-admin/  # internal admin dashboard; shows controls, KYC costs, margins, and recovery
```

Run user frontend:

```bash
cd frontend
npm install
npm run dev
```

Run admin frontend:

```bash
cd frontend-admin
npm install
npm run dev
```

## Core endpoints

```http
POST /api/users
POST /api/customers/kyc-link
POST /api/external-accounts
POST /api/withdrawals
GET  /api/users/{userId}/withdrawals
GET  /api/fees/offramp
POST /api/fees/offramp/estimate
POST /api/webhooks/bridge
```

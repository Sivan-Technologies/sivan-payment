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
- [Admin API contract](./docs/admin-api-contract.md)
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

This repo keeps the user-facing React + TypeScript app and the Sivan Payments backend APIs.

```text
frontend/  # user-facing app; hides internal KYC/Bridge costs
```

The admin frontend has moved to the dedicated Admin Hub repo:

```text
https://github.com/Samswitchy/sivan-admin-hub
```

Admin Hub serves the Sivan Payment admin module at:

```text
/dashboard/modules/sivan-payment
```

Keep all backend admin APIs in this repo. Admin Hub calls them through its server-side proxy, so these routes must remain available:

```text
/api/admin/*
```

Run user frontend:

```bash
cd frontend
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

## Shared customer identity

Sivan Payment now owns the canonical customer identity linking layer for connecting email-based Payment users with WhatsApp-based Escrow users.

Customer-facing endpoints:

```txt
GET  /api/users/me/identity
POST /api/users/me/identity/link-whatsapp/start
POST /api/users/me/identity/link-whatsapp/cancel
POST /api/users/me/identity/unlink-whatsapp
```

WhatsApp/Escrow service redemption endpoint:

```txt
POST /api/identity/link-whatsapp/redeem
Header: x-sivan-identity-link-secret: <IDENTITY_LINK_SERVICE_SECRET>
```

Admin modules should show link status only by default. Cross-module support/compliance lookup is a later phase.

## Virtual account provider adapter pipeline

Sivan Payment includes a disabled-by-default `src/virtual-accounts` provider adapter foundation for future virtual bank/account issuance.

The product should call the internal virtual account service, not a provider directly. This keeps Bridge, Nomba, Monnify, Flutterwave, or another banking partner swappable later by env/config instead of rewriting the product code.

Default env:

```env
VIRTUAL_ACCOUNTS_ENABLED=false
VIRTUAL_ACCOUNT_REQUESTS_ENABLED=false
VIRTUAL_ACCOUNT_PROVIDER=mock
```

Do not enable virtual accounts publicly until provider, compliance, KYC, approval, reconciliation, and support workflows are ready.

### Bridge virtual account adapter

Bridge virtual account creation is implemented through the provider adapter layer, but remains disabled by default.

Bridge docs confirm virtual accounts are permanent reusable fiat deposit addresses, customers must be onboarded/KYC-approved before creation, and the creation endpoint is:

```txt
POST /v0/customers/{customerID}/virtual_accounts
```

Required Sivan env before enabling Bridge provisioning:

```env
VIRTUAL_ACCOUNTS_ENABLED=true
VIRTUAL_ACCOUNT_PROVIDER=bridge
BRIDGE_VIRTUAL_ACCOUNTS_ENABLED=true
BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_CURRENCY=usdc
BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_PAYMENT_RAIL=base
BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_ADDRESS=<destination wallet address>
# or BRIDGE_VIRTUAL_ACCOUNT_BRIDGE_WALLET_ID=<bridge wallet id>
BRIDGE_VIRTUAL_ACCOUNT_DEVELOPER_FEE_PERCENT=0.0
```

Do not enable until Bridge confirms your program is approved for the requested currencies/rails.

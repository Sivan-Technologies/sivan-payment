# PAJ / Pajcash NGN Provider Integration

## Product rule

PAJ is treated as an NGN payment rail. Sivan owns the customer relationship, risk controls, support, audit, and KYC gate.

```txt
Bridge = KYC / USD virtual account / USDC infrastructure
PAJ = NGN settlement rail
Sivan = orchestration, provider routing, support, audit, reconciliation
```

Customers should not need to know whether the NGN rail is PAJ, Linkio, Eversend, or a future provider. The frontend should say:

```txt
Provider: Automatic
```

## KYC gate

Before any PAJ quote/order, Sivan requires:

```txt
customer exists
customer.provider = bridge
customer.kycStatus = kyc_approved
customer.tosStatus = approved
```

If this gate fails, PAJ NGN ramp is blocked with a customer-safe message:

```txt
Complete verification before using NGN transfers.
```

## Current implementation

Provider adapter:

```txt
src/ngn/provider/paj.provider.ts
```

Provider name:

```ts
'mock' | 'linkio' | 'eversend' | 'nomba' | 'paj'
```

Admin controls can now select:

```txt
activeProvider = paj
backupProvider = paj
```

## Environment

Backend-only Render env:

```env
NGN_PROVIDER=paj
NGN_LIVE_PROVIDER_ENABLED=true
PAJ_RAMP_ENV=staging
PAJ_RAMP_BASE_URL=https://api-staging.paj.cash
PAJ_RAMP_API_KEY=...
PAJ_RAMP_WEBHOOK_URL=https://api.sivantech.online/api/payment/api/webhooks/paj
PAJ_RAMP_DEFAULT_CURRENCY=NGN
PAJ_RAMP_DEFAULT_CHAIN=SOLANA
PAJ_RAMP_USDC_MINT=...
PAJ_RAMP_BUSINESS_USDC_FEE=0
PAJ_RAMP_REQUIRE_SIVAN_KYC=true
PAJ_RAMP_SESSION_MODE=merchant
PAJ_RAMP_MERCHANT_TOKEN=...
```

For production PAJ:

```env
PAJ_RAMP_ENV=production
PAJ_RAMP_BASE_URL=https://api.paj.cash
```

The API key must never be exposed to frontend/Vercel/browser code.

## Provider abstraction

The frontend flow stays the same for all NGN providers:

```txt
Withdraw to NGN
↓
Choose bank
↓
Review quote
↓
Confirm
↓
Sivan backend routes to active provider
↓
Money arrives
```

The backend can switch providers through controls/env without changing frontend UI.

## PAJ endpoints wrapped

```txt
GET  /pub/rate
GET  /pub/bank
GET  /pub/bank-account/confirm
POST /pub/onramp
POST /pub/offramp
GET  /pub/transactions/:id
```

Sivan endpoints added:

```txt
GET  /api/admin/ngn/paj/banks
GET  /api/admin/ngn/paj/bank-account/resolve
GET  /api/ngn/paj/banks
GET  /api/ngn/paj/bank-account/resolve
POST /api/webhooks/paj
```

## Target one-click NGN off-ramp architecture

```txt
Bridge USD Virtual Account deposit
↓
Bridge converts to USDC
↓
Sivan internal settled USDC balance
↓
User clicks Withdraw to NGN
↓
Sivan provider router selects PAJ / Linkio / Eversend
↓
Backend executes provider flow
↓
Webhook updates Sivan
↓
Sivan marks transaction complete
```

The customer sees:

```txt
USDC Balance
↓
Withdraw to NGN
↓
Choose Bank
↓
Confirm
↓
Money arrives
```

## Current safety level

This integration is provider-adapter ready and E2E-tested with a mocked PAJ server. Live money movement should remain disabled until:

```txt
PAJ staging API key is verified
PAJ webhook signing/IP policy is confirmed
USDC mint and chain are confirmed
Bridge programmatic transfer path to PAJ deposit address is confirmed
Admin controls/manual review policy is confirmed
Small live test transaction succeeds
```

## Staging preflight result

Use:

```bash
npm run paj:staging-smoke
```

Current staging findings with the provided PAJ key:

```txt
GET /pub/rate -> works
GET /pub/bank with Authorization: Bearer <apiKey> -> works
POST /pub/offramp with Authorization: Bearer <apiKey> and invalid body -> 401 Session is invalid or expired
GET /token/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v?chain=SOLANA -> 400 token metadata lookup failed
```

Meaning:

```txt
The API key can read public/auth utility data like banks.
The API key is not accepted as an order Bearer token on staging.
Order endpoints currently require a PAJ session token, or PAJ must issue a separate merchant/server token.
```

Do not run live order creation until PAJ confirms one of:

```txt
PAJ_RAMP_MERCHANT_TOKEN for server-to-server order creation
or
required user OTP session flow for Sivan users
```

The SDK examples identify Solana USDC as:

```txt
EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

However, PAJ staging token metadata currently rejects the token-info lookup, so PAJ should confirm whether this endpoint is broken in staging or whether they require a different token identifier for order creation.

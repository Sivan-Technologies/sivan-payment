# Testing Sivan Off-Ramp With Bridge API

This guide explains how to move from local mock mode to Bridge API testing.

## 1. Complete Sivan/Bridge KYB

Bridge requires your developer account KYB to be submitted and approved before API access and small transaction testing.

## 2. Configure environment

Update `.env`:

```env
BRIDGE_MOCK_MODE=false
BRIDGE_BASE_URL=https://api.sandbox.bridge.xyz/v0
BRIDGE_API_KEY=your_bridge_sandbox_api_key
BRIDGE_WEBHOOK_PUBLIC_KEY=your_bridge_webhook_public_key

SIVAN_OFFRAMP_FEE_PERCENT=1.25
BRIDGE_OFFRAMP_COST_PERCENT=0.5
BRIDGE_KYC_COST_USD=2
BRIDGE_KYB_COST_USD=10
```

Then restart the backend:

```bash
npm run dev
```

## 3. Confirm Bridge auth

```bash
curl https://api.sandbox.bridge.xyz/v0/customers \
  -H "Api-Key: $BRIDGE_API_KEY" \
  -H "Accept: application/json"
```

If the key is valid, Bridge should return a JSON response instead of `401`.

## 4. Sandbox onboarding note

Bridge sandbox may require customer creation through the Customers API instead of hosted KYC links. For sandbox, use:

```http
POST /api/customers
```

with a Bridge-compatible customer payload, then simulate KYC approval:

```http
POST /api/customers/{userId}/sandbox/simulate-kyc-approval
```

In production, use hosted KYC links:

```http
POST /api/customers/kyc-link
```

## 5. Test flow through Sivan engine

1. `POST /api/users`
2. `POST /api/customers` with Bridge customer payload
3. `POST /api/customers/{userId}/sandbox/simulate-kyc-approval`
4. `POST /api/external-accounts`
5. `POST /api/withdrawals`
6. Send a small supported USDC amount to the returned deposit address, or test Bridge webhooks from the Bridge dashboard/API.
7. Confirm status via `GET /api/users/{userId}/withdrawals`.

## 6. Webhooks

Create a Bridge webhook endpoint pointing to:

```text
https://your-api-domain.com/api/webhooks/bridge
```

Subscribe at least to:

```text
liquidation_address.drain
customer
kyc_link
external_account
```

Bridge returns a webhook public key. Put it in:

```env
BRIDGE_WEBHOOK_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----..."
```

## 7. Do not use real money first

Start with sandbox or very small live transactions only after KYB approval. Confirm supported chains, minimums, rails, and countries in your Bridge dashboard/agreement.

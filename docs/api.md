# Sivan Off-Ramp Engine API

Base URL locally:

```text
http://localhost:3000
```

## Health

```http
GET /health
```

## 1. Signup

```http
POST /api/users
Content-Type: application/json

{
  "email": "ada@example.com",
  "fullName": "Ada Lovelace"
}
```

## 2. Start KYC

Uses Bridge hosted KYC links. In mock mode, the KYC status is auto-approved.

```http
POST /api/customers/kyc-link
Content-Type: application/json

{
  "userId": "usr_xxx",
  "type": "individual",
  "redirectUri": "https://app.sivan.com/kyc/complete"
}
```

## 3. Add verified bank account

### USD / US account

```http
POST /api/external-accounts
Content-Type: application/json

{
  "userId": "usr_xxx",
  "currency": "usd",
  "accountType": "us",
  "paymentRail": "ach",
  "bankName": "Lead Bank",
  "accountName": "Ada Checking",
  "accountOwnerName": "Ada Lovelace",
  "accountOwnerType": "individual",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "address": {
    "street_line_1": "923 Folsom Street",
    "country": "USA",
    "state": "CA",
    "city": "San Francisco",
    "postal_code": "94107"
  },
  "account": {
    "routing_number": "101019644",
    "account_number": "215268129123",
    "checking_or_savings": "checking"
  }
}
```

### GBP / UK account

```http
POST /api/external-accounts
Content-Type: application/json

{
  "userId": "usr_xxx",
  "currency": "gbp",
  "accountType": "gb",
  "paymentRail": "faster_payments",
  "bankName": "Example UK Bank",
  "accountName": "Ada Current",
  "accountOwnerName": "Ada Lovelace",
  "accountOwnerType": "individual",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "address": {
    "street_line_1": "1 King Street",
    "country": "GBR",
    "city": "London",
    "postal_code": "SW1A 1AA"
  },
  "account": {
    "account_number": "12345678",
    "sort_code": "123456"
  }
}
```

## 4. Create withdrawal

This creates a Bridge liquidation address behind the scenes and returns a user-facing deposit address.

```http
POST /api/withdrawals
Content-Type: application/json

{
  "userId": "usr_xxx",
  "externalAccountId": "ea_xxx",
  "sourceCurrency": "usdc",
  "sourceChain": "ethereum",
  "destinationCurrency": "usd",
  "returnAddress": "0x0000000000000000000000000000000000000000"
}
```

Response includes:

```json
{
  "data": {
    "withdrawal": {
      "status": "pending_deposit"
    },
    "deposit": {
      "address": "0x...",
      "chain": "ethereum",
      "currency": "usdc"
    }
  }
}
```

## 5. Withdrawal history

```http
GET /api/users/{userId}/withdrawals
GET /api/withdrawals/{withdrawalId}
GET /api/withdrawals/{withdrawalId}/deposit-address
```

## 6. Bridge webhook endpoint

```http
POST /api/webhooks/bridge
X-Webhook-Signature: t=<timestamp>,v0=<base64-signature>
```

Supported event categories:

- `liquidation_address.drain`
- `customer`
- `kyc_link`
- `external_account` / `external_acccount`

The engine stores webhook events idempotently by `event_id`.

## 7. Fees

The MVP uses a percentage-based developer fee on Bridge liquidation addresses.

Current policy:

```http
GET /api/fees/offramp
```

Estimate a user-facing fee before they deposit:

```http
POST /api/fees/offramp/estimate
Content-Type: application/json

{
  "amount": "100.00",
  "currency": "usd"
}
```

Example response when `SIVAN_OFFRAMP_FEE_PERCENT=1.25`:

```json
{
  "data": {
    "amount": "100.00",
    "currency": "usd",
    "feePercent": "1.25",
    "estimatedFeeAmount": "1.25",
    "estimatedNetAmount": "98.75",
    "note": "This is an estimate. Final fee is calculated by Bridge when the liquidation-address drain is processed."
  }
}
```

The final fee is stored on the withdrawal from Bridge webhook drain data as `feeAmount`.

## 8. Bridge cost assumptions and unit economics

Bridge pricing can include Sivan-side costs such as:

- Off-ramp variable cost percent
- KYC cost per individual verification
- KYB cost per business verification
- Third-party rail/gas/wire fees

Configured in `.env`:

```env
BRIDGE_OFFRAMP_COST_PERCENT=0.5
BRIDGE_KYC_COST_USD=2
BRIDGE_KYB_COST_USD=10
```

Fetch configured Bridge cost assumptions:

```http
GET /api/fees/costs/bridge
```

Estimate Sivan unit economics:

```http
POST /api/fees/economics/estimate
Content-Type: application/json

{
  "amount": "1000.00",
  "currency": "usd",
  "customerType": "individual",
  "includeOnboardingCost": true,
  "thirdPartyRailFee": "0"
}
```

This separates:

- **Sivan revenue**: `SIVAN_OFFRAMP_FEE_PERCENT`
- **Bridge variable cost**: `BRIDGE_OFFRAMP_COST_PERCENT`
- **Onboarding cost**: `$2 KYC` or `$10 KYB`
- **Third-party rail fees**: ACH/wire/gas/etc.

The frontend should normally show the user-facing Sivan fee estimate, not internal Bridge cost economics.

## 9. Onboarding cost tracking

Bridge KYC/KYB costs are tracked once per provider customer/KYC link creation.

Important:

- User signup alone does **not** create a Bridge KYC cost.
- KYC cost is recorded when Sivan creates the Bridge KYC link/customer.
- Existing Sivan users reuse their existing Bridge customer to avoid duplicate KYC costs.

Fetch onboarding cost totals:

```http
GET /api/metrics/onboarding-costs
```

Example response:

```json
{
  "data": {
    "users": {
      "totalSignedUp": 100,
      "withBridgeCustomer": 70,
      "withoutBridgeCustomer": 30
    },
    "onboardingCosts": {
      "trackedCustomers": 70,
      "kycCount": 68,
      "kybCount": 2,
      "kycCostTotalUsd": "136.00",
      "kybCostTotalUsd": "20.00",
      "totalOnboardingCostUsd": "156.00"
    }
  }
}
```

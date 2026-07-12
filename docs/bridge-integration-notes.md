# Bridge Integration Notes

I reviewed Bridge's orchestration docs and the correct MVP path for Sivan is **Liquidation Addresses**, not one-off Transfers.

Bridge orchestration products include:

- Transfers: one-time movement between fiat/stablecoin rails.
- Static Template Transfers: reusable recurring transfer instructions.
- Virtual Accounts: fiat deposit details.
- Liquidation Addresses: permanent on-chain addresses that auto-route incoming crypto to a destination.

For Sivan's MVP, the right flow is:

```text
User sends USDC
   -> Bridge liquidation address
   -> Bridge converts/routes
   -> User's verified external bank account receives USD/GBP
```

## Required Bridge calls

### Create KYC link

```http
POST /kyc_links
Idempotency-Key: <uuid>
```

Used by this engine in:

```text
POST /api/customers/kyc-link
```

### Create external account

```http
POST /customers/{customerID}/external_accounts
Idempotency-Key: <uuid>
```

Used by this engine in:

```text
POST /api/external-accounts
```

### Create liquidation address

```http
POST /customers/{customerID}/liquidation_addresses
Idempotency-Key: <uuid>
```

For USD:

```json
{
  "currency": "usdc",
  "chain": "ethereum",
  "external_account_id": "ea_xxx",
  "destination_payment_rail": "ach",
  "destination_currency": "usd",
  "return_address": "0x..."
}
```

For GBP:

```json
{
  "currency": "usdc",
  "chain": "ethereum",
  "external_account_id": "ea_xxx",
  "destination_payment_rail": "faster_payments",
  "destination_currency": "gbp",
  "return_address": "0x..."
}
```

Used by this engine in:

```text
POST /api/withdrawals
```

## Webhook signature verification

Bridge sends:

```text
X-Webhook-Signature: t=<timestamp>,v0=<base64 encoded signature>
```

Verification logic implemented in:

```text
src/bridge/bridge.webhooks.ts
```

Rules:

1. Parse timestamp and signature.
2. Reject old events using `WEBHOOK_MAX_AGE_MS`.
3. Verify `timestamp + "." + rawBody` with the webhook endpoint public key.
4. Store/process events idempotently by `event_id`.

## Drain status mapping

Bridge liquidation-address `dr
ain` states map to Sivan withdrawal statuses as follows:

| Bridge drain state | Sivan status |
|---|---|
| `funds_received` | `deposit_received` |
| `payment_submitted` | `payout_processing` |
| `payment_processed` | `completed` |
| `in_review` | `requires_action` |
| `undeliverable` | `failed` |
| `returned` | `failed` |
| `error` | `failed` |
| `canceled` | `cancelled` |
| `refunded` | `failed` |

## Important implementation notes

- All Bridge `POST` requests include an `Idempotency-Key`.
- Bridge-specific terms are hidden from frontend users; the API returns a `deposit.address` for the user to send USDC.
- MVP supports only user-owned bank accounts.
- MVP supports USD and GBP bank payouts.
- Mock mode is enabled by default so the frontend team can integrate before Bridge credentials are available.

## Fees structure

Bridge supports developer fees for Liquidation Addresses using either:

1. A global default liquidation-address fee configured in Bridge, or
2. A per-address override using `custom_developer_fee_percent` when creating the liquidation address.

For Sivan MVP, the engine uses the per-address approach:

```json
{
  "currency": "usdc",
  "chain": "ethereum",
  "external_account_id": "ea_xxx",
  "destination_payment_rail": "ach",
  "destination_currency": "usd",
  "custom_developer_fee_percent": "0.5"
}
```

Configuration:

```env
SIVAN_OFFRAMP_FEE_PERCENT=1.25
```

This means 1.25%. If the user deposits the equivalent of 100.00 USD, the estimated Sivan fee is 1.25 and the estimated net payout is 98.75.

Important notes:

- Fees are optional. Set `SIVAN_OFFRAMP_FEE_PERCENT=0` to disable them.
- Liquidation address deposits have unknown amounts upfront, so percentage fee is the clean MVP model.
- The API can return an estimate before the user sends USDC.
- The final fee should be read from Bridge drain/webhook data and stored as `withdrawals.feeAmount`.
- Bridge settles developer fees monthly to the configured developer fee external account.

## Bridge KYC/KYB costs

Bridge pricing shared with Sivan includes:

- `$2 per KYC`
- `$10 per KYB`
- `0.50% offramp volume`
- third-party costs such as ACH, wire, gas, etc.

Treat KYC/KYB as **onboarding cost of goods sold**, not as a withdrawal fee.

Recommended MVP approach:

1. Do not charge the user upfront for KYC.
2. Track the `$2` KYC cost internally.
3. Recover it through Sivan's off-ramp spread/developer fee over the user's first withdrawals.
4. Add abuse controls so users cannot create many accounts and cost Sivan repeated KYC charges.

Example economics:

```text
Bridge off-ramp cost: 0.50%
Sivan user-facing fee: 1.00%
Net variable margin: 0.50%
KYC cost: $2.00
Break-even user volume: $2 / 0.005 = $400
```

If Sivan charges only `0.50%` and Bridge also charges Sivan `0.50%`, then there is no variable margin to recover KYC. In that case Sivan needs either:

- a higher Sivan fee,
- a small onboarding fee,
- a minimum withdrawal amount,
- a first-withdrawal fee,
- or a monthly/user subscription model.

The engine now includes internal economics endpoints to model this before deciding final pricing.

## Provider routing architecture

The off-ramp service must not hardcode Bridge everywhere. It routes through the provider interface and provider router.

Core files:

```text
src/providers/offramp-provider.interface.ts
src/providers/provider-routing.ts
src/providers/provider-registry.ts
src/providers/bridge/
src/offramp/service/withdrawals.service.ts
```

The routing context supports decisions based on:

- Currency
- Country
- Rail
- Fee / priority
- Speed
- Reliability
- Compliance model
- Availability

Current MVP provider catalog has Bridge only, but the shape is ready for additional providers later.

Provider routing API:

```http
GET  /api/providers/offramp/capabilities
POST /api/providers/offramp/route
```

Example route request:

```json
{
  "sourceCurrency": "usdc",
  "sourceChain": "ethereum",
  "destinationCurrency": "usd",
  "destinationCountry": "USA",
  "destinationPaymentRail": "ach",
  "complianceModel": "first_party_withdrawal",
  "requiredSpeed": "standard"
}
```

For MVP, this returns Bridge. Later we can add more providers to `providerCapabilities` and implement their provider classes.

## EUR / SEPA expansion

EUR support is now added at the Sivan Payments layer:

- External account type: `iban`
- Destination currency: `eur`
- Default payout rail: `sepa`
- Source currency remains `usdc`

Bridge may require the customer to have the `sepa` endorsement before using EUR rails. For production, make sure users going through EUR onboarding request or refresh the required Bridge endorsement and complete any required proof-of-address checks.

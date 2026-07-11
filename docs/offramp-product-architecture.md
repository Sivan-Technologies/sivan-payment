# Sivan Off-Ramp Product & Architecture Plan

## Overview

Sivan should start with a focused, compliant off-ramp experience before expanding into broader payment and B2B flows.

The goal of the MVP is simple:

> Let a verified user withdraw USDC into their own verified bank account as USD or GBP.

This keeps the first version narrow enough to build, test, and validate quickly while still delivering a complete user-facing product.

---

## Core Product Principle

One of the biggest mistakes founders make is trying to solve every payment use case from day one.

Instead, Sivan should:

1. Start with the simplest compliant flow.
2. Validate that users want the core off-ramp experience.
3. Build reliability around deposits, conversions, withdrawals, and status tracking.
4. Expand only after there is real usage and transaction volume.

---

## Phase 1: MVP

### Supported Flow

```text
User's USDC
     │
     ▼
User's Verified Bank Account
     │
     ▼
USD or GBP
```

### MVP Scope

The MVP should support only:

- USDC deposits
- Withdrawals to the user's own verified bank account
- USD and GBP payouts
- Bridge as the initial off-ramp provider

### MVP Features

- ✅ User signs up
- ✅ User completes KYC
- ✅ User adds a bank account
- ✅ Sivan creates an external account with Bridge
- ✅ Sivan creates a liquidation address with Bridge
- ✅ User receives a USDC deposit address
- ✅ User sends USDC
- ✅ Bridge converts USDC to USD or GBP
- ✅ Money arrives in the user's own bank account
- ✅ User can view withdrawal history
- ✅ Webhook status updates are processed

### MVP Outcome

This is a complete, focused product that validates the core experience:

> USDC → USD/GBP → user's verified bank account

The MVP should prove whether users trust and want Sivan for crypto-to-bank withdrawals.

---

## User-Facing Product Flow

Avoid exposing provider-specific language like **liquidation address** to users.

From the user's perspective, the experience should feel like this:

### Withdraw

1. Choose payout currency: **USD** or **GBP**
2. Choose a verified bank account
3. Get a USDC deposit address
4. Send USDC to the deposit address
5. Sivan converts the funds and sends money to the user's bank account
6. User tracks the withdrawal status inside Sivan

### Suggested User Copy

```text
Send USDC to your deposit address.
We'll convert it and deposit the funds into your verified bank account.
```

### Terms to Hide From Users

These should remain internal/backend concepts:

- Liquidation address
- External account
- Provider customer ID
- Bridge transfer ID
- Webhook payload

### Terms Users Should See

Use simple product language:

- Deposit address
- Bank account
- Withdrawal
- Processing
- Completed
- Failed
- Requires action

---

## Phase 2: Product Expansion

Once the MVP is stable, add:

- Multiple bank accounts per user
- More payout currencies, such as EUR
- More supported blockchains
- Better withdrawal tracking
- Saved withdrawal destinations
- Improved notifications
- Better admin tooling
- Transaction analytics

Phase 2 should improve the consumer off-ramp experience before moving into complex B2B flows.

---

## Phase 3: B2B Supplier Payouts

When Sivan is ready for B2B, the flow can expand into buyer-to-supplier payments.

```text
Buyer
  │
  ▼
USDC
  │
  ▼
Sivan
  │
  ▼
Supplier
  │
  ▼
Verified Bank Account
```

At this stage, Sivan should determine whether Bridge supports the compliance model required for B2B supplier payouts or whether another provider should be added.

Because the payment layer will already exist, changing or adding providers should be much easier.

---

## Recommended Repository Name

The repository should be named:

```text
sivan-offramp
```

This is clearer than names like `bridge-service` because the product is Sivan's off-ramp system, not just a Bridge wrapper.

Bridge should be treated as one provider implementation inside the product, not the identity of the whole service.

---

## Recommended Project Structure

```text
sivan-offramp/
│
├── api/
│   ├── routes/
│   ├── middleware/
│   └── validators/
│
├── bridge/
│   ├── bridge.client.ts
│   ├── bridge.provider.ts
│   ├── bridge.types.ts
│   └── bridge.webhooks.ts
│
├── customers/
│   ├── customers.controller.ts
│   ├── customers.service.ts
│   └── customers.repository.ts
│
├── external-accounts/
│   ├── external-accounts.controller.ts
│   ├── external-accounts.service.ts
│   └── external-accounts.repository.ts
│
├── liquidation-addresses/
│   ├── liquidation-addresses.service.ts
│   └── liquidation-addresses.repository.ts
│
├── withdrawals/
│   ├── withdrawals.controller.ts
│   ├── withdrawals.service.ts
│   └── withdrawals.repository.ts
│
├── webhooks/
│   ├── webhooks.controller.ts
│   ├── webhooks.service.ts
│   └── webhook-events.repository.ts
│
├── providers/
│   ├── offramp-provider.interface.ts
│   └── provider-registry.ts
│
├── database/
│   ├── migrations/
│   └── schema/
│
├── docs/
│   └── offramp-product-architecture.md
│
├── tests/
│   ├── unit/
│   └── integration/
│
├── .env.example
├── package.json
└── README.md
```

---

## Architecture Approach

Sivan's business logic should not talk directly to Bridge everywhere.

Instead:

```text
Sivan Business Logic
        │
        ▼
Off-Ramp Provider Interface
        │
        ▼
Bridge Provider Implementation
```

This gives Sivan flexibility without overengineering the MVP.

### Why This Matters

If Bridge is hardcoded throughout the application, it becomes difficult to add another provider later.

If Bridge is placed behind a provider interface, Sivan can later add:

- Another off-ramp provider
- Region-specific providers
- Currency-specific providers
- Backup providers
- B2B payout providers

without rewriting the entire product.

---

## Provider Interface Example

```ts
export interface OfframpProvider {
  createCustomer(input: CreateCustomerInput): Promise<ProviderCustomer>;

  createExternalAccount(
    input: CreateExternalAccountInput
  ): Promise<ProviderExternalAccount>;

  createLiquidationAddress(
    input: CreateLiquidationAddressInput
  ): Promise<ProviderLiquidationAddress>;

  getWithdrawalStatus(
    providerWithdrawalId: string
  ): Promise<ProviderWithdrawalStatus>;

  verifyWebhookSignature(input: VerifyWebhookInput): Promise<boolean>;

  handleWebhookEvent(input: ProviderWebhookEvent): Promise<void>;
}
```

The application should depend on `OfframpProvider`, while Bridge implements that interface.

---

## Suggested Internal Modules

### `customers/`

Responsible for:

- User onboarding state
- KYC status
- Provider customer mapping
- Customer verification lifecycle

### `external-accounts/`

Responsible for:

- Bank account creation
- Bank account verification status
- Provider external account IDs
- Bank account metadata

### `liquidation-addresses/`

Responsible for:

- Creating deposit addresses
- Mapping deposit addresses to users
- Mapping deposit addresses to bank accounts and payout currencies
- Storing chain/currency information

### `withdrawals/`

Responsible for:

- User withdrawal history
- Deposit/withdrawal lifecycle
- Status tracking
- Amounts, currencies, fees, and timestamps

### `webhooks/`

Responsible for:

- Receiving provider webhook events
- Verifying signatures
- Deduplicating webhook events
- Updating internal records
- Logging raw provider payloads safely

### `providers/`

Responsible for:

- Defining provider interfaces
- Registering provider implementations
- Keeping product logic independent from Bridge-specific details

### `bridge/`

Responsible for:

- Bridge API client
- Bridge request/response types
- Bridge webhook parsing
- Bridge-specific error mapping
- Bridge implementation of the off-ramp provider interface

---

## Suggested API Endpoints

These are internal examples and can be adjusted based on the final framework.

### Authentication & Users

```http
POST /api/auth/signup
GET  /api/me
```

### KYC

```http
POST /api/customers/kyc/start
GET  /api/customers/kyc/status
```

### Bank Accounts

```http
POST /api/external-accounts
GET  /api/external-accounts
GET  /api/external-accounts/:id
```

### Withdrawals

```http
POST /api/withdrawals
GET  /api/withdrawals
GET  /api/withdrawals/:id
```

### Deposit Address

```http
POST /api/withdrawals/:id/deposit-address
GET  /api/withdrawals/:id/deposit-address
```

### Webhooks

```http
POST /api/webhooks/bridge
```

---

## Suggested Withdrawal Statuses

Use clean internal statuses that can map to Bridge-specific statuses.

```text
created
pending_deposit
deposit_received
converting
payout_processing
completed
failed
cancelled
requires_action
```

### User-Friendly Status Labels

| Internal Status | User Label |
|---|---|
| `created` | Created |
| `pending_deposit` | Waiting for USDC deposit |
| `deposit_received` | Deposit received |
| `converting` | Converting funds |
| `payout_processing` | Sending to bank |
| `completed` | Completed |
| `failed` | Failed |
| `cancelled` | Cancelled |
| `requires_action` | Action required |

---

## Suggested Database Tables

### `users`

Stores the Sivan user account.

Key fields:

- `id`
- `email`
- `created_at`
- `updated_at`

### `customers`

Stores KYC and provider customer information.

Key fields:

- `id`
- `user_id`
- `provider`
- `provider_customer_id`
- `kyc_status`
- `created_at`
- `updated_at`

### `external_accounts`

Stores verified bank accounts.

Key fields:

- `id`
- `user_id`
- `provider`
- `provider_external_account_id`
- `currency`
- `bank_name`
- `account_last4`
- `status`
- `created_at`
- `updated_at`

### `liquidation_addresses`

Stores provider deposit addresses.

Key fields:

- `id`
- `user_id`
- `external_account_id`
- `provider`
- `provider_liquidation_address_id`
- `address`
- `chain`
- `source_currency`
- `destination_currency`
- `status`
- `created_at`
- `updated_at`

### `withdrawals`

Stores user withdrawal records.

Key fields:

- `id`
- `user_id`
- `external_account_id`
- `liquidation_address_id`
- `provider`
- `provider_transfer_id`
- `source_currency`
- `destination_currency`
- `source_amount`
- `destination_amount`
- `fee_amount`
- `status`
- `created_at`
- `updated_at`
- `completed_at`

### `webhook_events`

Stores provider webhook events for auditing and idempotency.

Key fields:

- `id`
- `provider`
- `provider_event_id`
- `event_type`
- `payload`
- `processed_at`
- `created_at`

---

## Webhook Processing Rules

Webhook handling should be safe and idempotent.

Recommended flow:

1. Receive webhook request.
2. Verify provider signature.
3. Store the raw event.
4. Check whether the event has already been processed.
5. Map provider event type to internal event type.
6. Update the relevant withdrawal, bank account, customer, or deposit address.
7. Mark webhook event as processed.
8. Return success to provider.

Important rules:

- Never process unsigned webhooks.
- Never assume webhook events arrive in order.
- Always deduplicate webhook events.
- Store enough event data for debugging and reconciliation.
- Keep raw payload access restricted.

---

## Compliance & Risk Notes

For Phase 1, the compliance model should be simple:

> The user can only withdraw to their own verified bank account.

This avoids the added complexity of third-party payouts at the MVP stage.

Important controls:

- Require KYC before withdrawal activation.
- Only allow verified external accounts.
- Keep audit logs for customer, account, and withdrawal changes.
- Monitor failed deposits and failed payouts.
- Reconcile provider records with internal records.
- Do not market the MVP as supplier payouts until the compliance model is confirmed.

---

## Environment Variables

Example `.env` values:

```env
APP_ENV=development
APP_URL=http://localhost:3000

DATABASE_URL=postgresql://user:password@localhost:5432/sivan_offramp

BRIDGE_API_KEY=
BRIDGE_WEBHOOK_SECRET=
BRIDGE_BASE_URL=

DEFAULT_OFFRAMP_PROVIDER=bridge
```

---

## MVP Build Checklist

### Product

- [ ] Define supported countries and user eligibility
- [ ] Define supported payout currencies: USD and GBP
- [ ] Define supported USDC chains
- [ ] Write user-facing withdrawal copy
- [ ] Define withdrawal status labels

### Backend

- [ ] User signup
- [ ] KYC integration
- [ ] External account creation
- [ ] Liquidation address creation
- [ ] Withdrawal creation
- [ ] Withdrawal history
- [ ] Bridge webhook endpoint
- [ ] Webhook signature verification
- [ ] Webhook event idempotency
- [ ] Provider interface
- [ ] Bridge provider implementation

### Data

- [ ] Users table
- [ ] Customers table
- [ ] External accounts table
- [ ] Liquidation addresses table
- [ ] Withdrawals table
- [ ] Webhook events table

### Admin & Operations

- [ ] View users
- [ ] View KYC status
- [ ] View bank account status
- [ ] View withdrawals
- [ ] View webhook event logs
- [ ] Retry failed internal processing where safe
- [ ] Reconciliation process

### Security

- [ ] Encrypt sensitive data where required
- [ ] Protect webhook endpoints
- [ ] Validate all inputs
- [ ] Use least-privilege API keys
- [ ] Avoid logging sensitive bank or identity data
- [ ] Add audit logs for important actions

---

## Final Recommendation

This is the right balance for Sivan:

> Build a reliable USDC → USD/GBP withdrawal experience first, prove that users want it, then expand into supplier payouts and broader B2B payment flows once there is traction.

This keeps the initial scope manageable while leaving room to grow.


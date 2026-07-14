# On-Ramp Module

Fiat → stablecoin order flow for Sivan Payments.

This module is intentionally split like the off-ramp module so no single God file owns the full flow.

## Structure

- `api/onramp-orders.routes.ts` — HTTP routes only.
- `types/onramp.schemas.ts` — request validation schemas and input types.
- `service/onramp-orders.service.ts` — order creation/list/get orchestration.
- `service/onramp-fees.service.ts` — fee percent and quote calculations.
- `service/onramp-rails.service.ts` — source rail and destination rail helpers.
- `service/onramp-validation.service.ts` — user/customer/control validation.
- `service/onramp-sync.service.ts` — provider transfer sync and webhook application.
- `service/onramp-reconciliation.service.ts` — admin reconciliation checks.
- `service/onramp-mapping.ts` — provider transfer state mapping.
- `bridge/bridge-onramp.types.ts` — Bridge on-ramp transfer types used by provider adapters.

## Flow

1. User must be signed in and KYC approved.
2. Controls must allow the source fiat currency, destination asset, and destination network.
3. Backend creates a Bridge transfer with fiat source and crypto destination.
4. Provider payment instructions/reference are stored on the on-ramp order.
5. Webhooks or sync update order status and destination transaction hash.
6. Admin can monitor orders and run on-ramp reconciliation.

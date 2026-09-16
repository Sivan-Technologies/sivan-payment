# Future Build Plan - USDC Structured Tiers and Fee Boundary Enforcement

Status: ⏳ QUEUED FOR POST-LAUNCH PHASE 2 (Phase 1 Code Freeze Active)  
Target: Phase 2 - Post Grant Applications and Soft Launch

---

## Background

During the Phase 1 fee audit on 2026-08-20, two gaps were identified:

1. USDC fee model in the service agreement engine only supports Simple Mode (percent + fixed flat fee). Naira already supports both Simple and Structured Tiers. USDC must reach parity.

2. An explicit architectural rule must be enforced in code so that service agreement fees and Sivan Payment fees are never mixed, cross-read, or shared between microservices.

---

## Feature 1 - USDC Structured Tiers for Service Agreements

### What to Build

Mirror the Naira fee model system for USDC inside sivan-escrow-agent.

The admin panel should allow switching between two USDC fee modes:

Mode A - Simple (existing)
Formula: fee = (amount x percent) + fixed flat fee  
Example at 2% + $0.50 on a $100 deal: fee = $2.50

Mode B - Structured Tiers (new)
Bracket-based fee by deal size, same logic as Naira tiered mode.  
Example tier structure:

- Up to $50 USDC - flat fee $1.50
- Up to $100 USDC - flat fee $2.50
- Up to $250 USDC - flat fee $5.00
- Up to $500 USDC - 1.75% of amount
- Up to $1,000 USDC - 1.5% of amount
- Above $1,000 USDC - 1.25% of amount (fallback)

Note: exact tier values are admin-configurable. The above is a suggested starting structure.

### Files to Change (sivan-escrow-agent)

- src/services/settingsStore.ts
  - Add usdcFeeModel field ("simple" | "tiered") to PlatformSettings interface
  - Add usdcFeeTiers field (JSON string) to PlatformSettings interface
  - Add calculateUSDCFee() tiered branch (mirror of calculateNairaFee() tiered branch)
  - Add DB column: usdc_fee_model TEXT NOT NULL DEFAULT 'simple'
  - Add DB column: usdc_fee_tiers TEXT NOT NULL DEFAULT '[...]'

- src/routes/admin.ts
  - Expose usdcFeeModel and usdcFeeTiers fields in settings GET and PUT endpoints

- Admin UI (sivan-admin-hub)
  - Add USDC Fee Model selector (Simple / Structured Tiers)
  - Add USDC Structured Tiers editor table (mirrors the Naira tiers UI already present)

### Acceptance Criteria

- Admin can switch USDC between Simple and Structured Tiers from the admin panel
- Tiered USDC fees apply correctly per bracket on deal creation and payout quote
- Simple mode remains default if no change is made (backward compatible)
- All existing tests pass with no regressions

---

## Feature 2 - Hard Fee Boundary Enforcement

### What to Build

Add a code-level guarantee that fee engines do not cross service boundaries.

### Rule to Enforce

sivan-escrow-agent:
- All deal/service agreement fees are read ONLY from settingsStore.getSettings() inside sivan-escrow-agent
- No import, call, or HTTP fetch of fee data from sivan-payment is permitted

sivan-payment:
- All supplier payout fees are read ONLY from supplier-fee-policy.ts and fee-policy.ts inside sivan-payment
- No import, call, or HTTP fetch of fee data from sivan-escrow-agent is permitted

### Implementation

- Add a comment block at the top of settingsStore.ts marking it as the exclusive fee source for service agreements
- Add a comment block at the top of supplier-fee-policy.ts and fee-policy.ts marking them as the exclusive fee source for Sivan Payment
- Add a lint rule or CI check that fails if any cross-service fee import is introduced

### Acceptance Criteria

- Each microservice calculates fees exclusively from its own settings store
- CI pipeline fails if a cross-service fee reference is added
- Documentation clearly states the boundary for any future developer

---

## Current State (As of Code Freeze)

- sivan-escrow-agent fee engine: ISOLATED and correct. Uses settingsStore.ts only.
- sivan-payment fee engine: ISOLATED and correct. Uses supplier-fee-policy.ts and fee-policy.ts only.
- No mixing exists today. This build plan adds explicit guardrails to keep it that way permanently.

---

## Priority

Build Feature 1 and Feature 2 together in Phase 2 Sprint 1.  
Estimated effort: 2 to 3 development days.

# Sivan AI - Master Future Build Roadmap (Phase 2 & Beyond)

**Status:** Code Freeze Active for Phase 1  
**Scope Policy:** All new feature proposals are documented here and deferred until Grant Applications, Demo Video, and User Soft Launch are complete.

---

## 1. Phase 2 Future Features Queue

Below is the catalog of planned post-launch features, including their purpose, UX impact, and technical prerequisites.

### Feature 1: Chat-Native USD Virtual Account Display
- **Documented Spec:** `FUTURE_BUILD_USD_VIRTUAL_ACCOUNTS.md`
- **Description:** Display copy-pasteable ACH/Wire account details inside WhatsApp and Telegram when a user requests `/deposit` or taps "Deposit USD".
- **Impact:** Converts non-crypto remote workers and freelancers instantly by offering a familiar US bank receiving account.
- **Deferral Rationale:** Requires live production credentials from Bridge/Choice Bank and Tier 1/2 KYC integration.

### Feature 2: Automated Multi-Token Swap (USDT <-> USDC)
- **Description:** Allow users to convert USDT to USDC (or vice versa) directly within chat or the web app before initiating service agreements.
- **Impact:** Eliminates currency friction for users who hold USDT on Tron/Avalanche but want to settle service agreements in USDC.
- **Deferral Rationale:** Sivan currently settles in USDC/USDT natively per network mode. Introducing inline DEX routing adds external liquidity risks best tested post-launch.

### Feature 3: Scheduled & Recurring Payouts (Payroll / Retainers)
- **Description:** Allow businesses or clients to set recurring monthly or weekly USDC service agreement payouts to freelancers directly via chat commands.
- **Impact:** Establishes Sivan as a complete global payroll tool for remote agencies.
- **Deferral Rationale:** Core manual service agreement creation and release must be battle-tested with real users first.

### Feature 4: Standalone Fraud Engine Microservice
- Documented Spec: Internal Fraud Engine Architecture
- Description: Activate the full standalone Fraud_engine service for real-time velocity checking, IP geolocation risk scoring, and device fingerprinting.
- Impact: Replaces basic risk heuristics with advanced machine-learning fraud scoring.
- Deferral Rationale: Existing supplier-risk.service.ts and complianceRisk.ts inside sivan-payment and sivan-escrow-agent provide sufficient coverage for early launch cohorts.

### Feature 5: Per-Channel Notification Toggles & Default Policy
- Documented Spec: FUTURE_BUILD_NOTIFICATION_CONTROLS.md
- Description: Add web dashboard notification toggles under Linked Telegram and Linked WhatsApp identity cards. Telegram defaults to ON (free/instant API); WhatsApp defaults to OFF (prevents per-message Meta API costs and spam).
- Impact: Gives users granular privacy control while optimizing outbound messaging API costs for the platform.
- Deferral Rationale: Enforced under Phase 1 Code Freeze Protocol. All future UX enhancements are documented here for Phase 2 implementation.

---

## 2. Code Freeze & Maintenance Protocol

Henceforth, only the following categories of work are permitted on the Phase 1 codebase:

### Permitted Work (Fixes Only):
1. **Verified Edge Cases**: Handling unexpected input nulls, unexpected network drops, or edge-case string formatting.
2. **Production / Deployment Issues**: CORS origin updates, server environment variable adjustments, or SSL reverse proxy configs.
3. **Testing & CI Failures**: Fixing broken test assertions or test suite environment isolation.

### Strictly Forbidden Work (Until Unfrozen):
- Adding new user-facing endpoints or chat commands.
- Modifying core database schemas or existing service agreement state machine logic.
- Refactoring working code for cosmetic reasons.

---

## 3. Immediate Focus (The 3 Execution Pillars)

1. **Grant Applications**: Circle, Avalanche, Celo applications submitted with passing `npm test` proof.
2. **Demo Video**: 2-minute walkthrough showing WhatsApp/Telegram deal flow + Solscan verification.
3. **Soft Launch**: 10–20 real users transacting and providing feedback.

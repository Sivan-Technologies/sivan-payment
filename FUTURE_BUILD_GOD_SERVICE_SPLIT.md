# FUTURE_BUILD_GOD_SERVICE_SPLIT.md

Document Type: Future Build Plan (Architectural Refactor)
Status: QUEUED — Code freeze active on sivan-escrow-agent and sivan-payment backends
Author: Samson Micheal — Founder, CEO, Technical Founder, Product Engineer
Trigger: Execute when Grant Applications, Demo Video, and Soft Launch are complete

---

## Problem Summary

Three files contain too many responsibilities. When a bug appears, it is unclear which layer owns it.
When a test is added, it pulls in dependencies from unrelated layers. This will not cause failures
today — it will cause painful multi-hour debugging sessions once 50+ active agreements are in flight.

File                                              Lines  Responsibilities Mixed In
sivan-escrow-agent/src/services/escrowService.ts  1,920  Lifecycle, payment polling, notification dispatch, R2 media, participant identity, deal cards, compliance, delivery proof validation
sivan-payment/src/agreements/agreement.service.ts 1,790  Lifecycle, fee calculation, Celo settlement, multi-channel notifications, identity resolution, countdown labels, balance ledger
sivan-escrow-agent/src/services/escrowStore.ts    3,083  Schema, SQLite driver, Postgres driver, migration runner, business logic gatekeeper

---

## Part 1 — sivan-escrow-agent: escrowService.ts Split Plan

### 1.1 Responsibility Map (with exact line ranges)

Cluster                   Functions                                                    Lines (approx)   Target Module
Notification Core         queueWhatsAppNotification, sendOrQueueWhatsAppNotification   68–175           notificationDispatcher.ts
Message Formatters        escrowCreatedMessage, participantLifecycleMessage, etc.       40–50, 177–199   messageFormatter.ts
Notification Orchestrators notifyEscrowCreatedParticipants, notifyEscrowParticipants    200–239, 530–563 notificationOrchestrator.ts
Payment Lifecycle Refresh  refreshEscrowPaymentLifecycle, forRead variant               241–364          paymentLifecycleRefresh.ts
R2 Media Resolver         resolveR2MediaUrls                                           366–403          mediaResolver.ts
Detail Builder            buildEscrowDetail, buildDisputeRows, disputeHistoryForEscrow  405–514          escrowDetailBuilder.ts
Participant Identity      resolveActorUserId, roleForEscrowParticipant                  580–665          participantIdentity.ts
Deal Cards                buildParticipantDeal, buildParticipantDealSummary             691–846          dealCardBuilder.ts
Evidence Handling         validateDeliveryProofMedia, recordDisputeEvidence             908–1100+        evidenceHandler.ts
Shared Utilities          parseMaybeJson, firstPresent                                  52–66            escrowUtils.ts

### 1.2 Target File Structure

sivan-escrow-agent/src/services/
  escrowService.ts              <- Thin barrel (re-exports all modules, all callers unchanged)
  notificationDispatcher.ts     <- NEW: queueWhatsAppNotification + sendOrQueueWhatsAppNotification
  notificationOrchestrator.ts   <- NEW: notify*Participants functions (call dispatcher)
  messageFormatter.ts           <- NEW: message string builders (pure functions, zero DB)
  paymentLifecycleRefresh.ts    <- NEW: refreshEscrowPaymentLifecycle + forRead variant
  mediaResolver.ts              <- NEW: resolveR2MediaUrls (also fixes disputeAnalyst.ts duplicate)
  escrowDetailBuilder.ts        <- NEW: buildEscrowDetail, buildDisputeRows
  participantIdentity.ts        <- NEW: resolveActorUserId, roleForEscrowParticipant
  dealCardBuilder.ts            <- NEW: buildParticipantDeal, buildParticipantDealSummary
  evidenceHandler.ts            <- NEW: validateDeliveryProofMedia, recordDisputeEvidence
  escrowUtils.ts                <- NEW: parseMaybeJson, firstPresent

### 1.3 Zero-Regression Rule

The split must be zero-logic-change. The only changes allowed are:
1. Move function bodies into new files.
2. Add export where missing.
3. Update import paths.
4. escrowService.ts becomes a thin re-export barrel:

// escrowService.ts — public API barrel (re-exports only)
export * from './notificationDispatcher';
export * from './notificationOrchestrator';
export * from './messageFormatter';
export * from './paymentLifecycleRefresh';
export * from './mediaResolver';
export * from './escrowDetailBuilder';
export * from './participantIdentity';
export * from './dealCardBuilder';
export * from './evidenceHandler';
export * from './escrowUtils';

All existing callers remain valid with no changes needed.

### 1.4 Fix the resolveR2MediaUrls Duplication

resolveR2MediaUrls appears in:
- escrowService.ts (line 366)
- disputeAnalyst.ts as localResolveR2MediaUrls

When creating mediaResolver.ts, update disputeAnalyst.ts to import from '../services/mediaResolver'
and delete localResolveR2MediaUrls. This is the only cross-file fix in the entire split.

### 1.5 Execution Order (one file at a time, run tests after each)

1. Create escrowUtils.ts — zero dependencies, safe first step.
2. Create messageFormatter.ts — pure string functions, zero async.
3. Create mediaResolver.ts — fix disputeAnalyst.ts duplication here.
4. Create participantIdentity.ts — depends on escrowStore only.
5. Create dealCardBuilder.ts — depends on participantIdentity + paymentService.
6. Create notificationDispatcher.ts — depends on notificationService + opsStore.
7. Create notificationOrchestrator.ts — depends on notificationDispatcher + dealCardBuilder.
8. Create paymentLifecycleRefresh.ts — depends on notificationOrchestrator + paymentService.
9. Create escrowDetailBuilder.ts — depends on paymentLifecycleRefresh + participantIdentity.
10. Create evidenceHandler.ts — depends on escrowStore + opsStore + storageService.
11. Update escrowService.ts to re-export barrel.
12. Run full test suite (npm test) — all 36 test files must pass without any changes to test files.

---

## Part 2 — sivan-payment: agreement.service.ts Split Plan

### 2.1 Responsibility Map

Cluster                  Functions                                          Target Module
Identity Resolution      resolveBuyerUUID, resolveTelegramId, resolveWhatsApp   agreement-identity.service.ts
Notification Helpers     notifyAgreementAccepted, notifyAgreementCancellation   agreement-notifications.service.ts
Fee + Wallet Calc        getSivanServiceAgreementFeeWallet, getCountdownLabel   agreement-finance.service.ts
Lifecycle CRUD           createAgreement, fundAgreement, markDelivered, etc.    agreement-lifecycle.service.ts
Celo Settlement          dispatchCeloSettlementTransfer calls                   agreement-settlement.service.ts
Query + Read Layer       listAgreements, getAgreement, listForDeadlineSweep     agreement-queries.service.ts

### 2.2 Target File Structure

sivan-payment/src/agreements/
  agreement.service.ts               <- Thin barrel (re-exports all modules below)
  agreement-identity.service.ts      <- NEW: buyer/seller identity resolution
  agreement-notifications.service.ts <- NEW: all notify* functions
  agreement-finance.service.ts       <- NEW: fee wallet resolver, countdown label, fee quoting
  agreement-lifecycle.service.ts     <- NEW: create/fund/deliver/release/cancel state transitions
  agreement-settlement.service.ts    <- NEW: Celo/Stellar/Solana on-chain settlement dispatch
  agreement-queries.service.ts       <- NEW: read queries for lists and sweeper
  agreement-fee-policy.ts            <- Existing (unchanged)
  agreement.routes.ts                <- Existing (unchanged)
  agreement-controls.routes.ts       <- Existing (unchanged)
  agreement-controls.service.ts      <- Existing (unchanged)
  deadline-parser.ts                 <- Existing (unchanged)
  deadline-sweeper.service.ts        <- Existing (unchanged)

### 2.3 Dependency Creation Order

Create agreement-identity.service.ts first (no internal dependencies).
Create agreement-finance.service.ts second (depends on agreement-fee-policy only).
Create agreement-notifications.service.ts third (depends on identity module).
Create agreement-settlement.service.ts fourth (depends on wallet providers, no internal dep).
Create agreement-lifecycle.service.ts fifth (depends on identity + finance + settlement).
Create agreement-queries.service.ts sixth (depends on db only).
Update agreement.service.ts to barrel.

---

## Part 3 — escrowStore.ts Driver Extraction Plan

### 3.1 Target Structure

sivan-escrow-agent/src/services/
  escrowStore.ts     <- Thin interface + factory (returns correct driver by config.databaseMode)
  store/
    types.ts         <- All TypeScript types (EscrowRecord, PayoutAccountRecord, etc.)
    sqlite-driver.ts <- Full SQLite implementation
    postgres-driver.ts <- Full Postgres implementation
    migrations.ts    <- Migration runner (called by both drivers at startup)
    guards.ts        <- Business logic guards (status transition validation, amount checks)

### 3.2 Postgres Test Gap Fix

Add test environment:
  DATABASE_MODE=test_pg

This forces tests to run against real Postgres (Docker or test container).
All 36 test files must pass on both SQLite and Postgres.
Any test that passes only on SQLite is a hidden production bug.

---

## Part 4 — Estimated Effort

Task                                    Effort
escrowService.ts split (11 modules)     4–6 hours
disputeAnalyst.ts deduplication fix     30 minutes
agreement.service.ts split (6 modules)  3–5 hours
escrowStore.ts driver extraction        6–8 hours
Postgres test environment setup         2 hours

Total: approximately 2 focused working days.

Note: The splits are purely mechanical moves. No logic changes, no new features.
The main risk is a missed import path. Running npm test after each module extraction
catches import errors immediately. Do not batch multiple modules — do one at a time.

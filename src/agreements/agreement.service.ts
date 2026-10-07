/**
 * agreement.service — public API barrel.
 *
 * SERVICE AGREEMENT LIFECYCLE MANAGER
 *
 * This file used to be a 1,789-line god object owning creation, state
 * transitions, identity resolution, fee/wallet maths, multi-channel
 * notifications, escrow-agent sync and the read queries all at once. It was
 * decomposed per FUTURE_BUILD_GOD_SERVICE_SPLIT.md Part 2 and now re-exports
 * those modules, so every existing caller
 * (`import { x } from './agreement.service.js'`) keeps working unchanged.
 *
 * STATE MACHINE (implemented in agreement-lifecycle.service.ts):
 *   createAgreement()   → pending_payment
 *   fundAgreement()     → funded        (computes delivery_due_at)
 *   startDelivery()     → in_delivery   (optional; seller signals work started)
 *   markDelivered()     → delivered
 *   releaseAgreement()  → released
 *   cancelAgreement()   → cancelled
 *
 * Import the specific module directly in new code.
 */

export * from './agreement-identity.service.js';
export * from './agreement-finance.service.js';
export * from './agreement-notifications.service.js';
export * from './agreement-escrow-sync.service.js';
export * from './agreement-queries.service.js';
export * from './agreement-lifecycle.service.js';

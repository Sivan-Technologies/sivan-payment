/**
 * The verification decision.
 *
 * Pure functions only - no database, no network. Everything here is a function
 * of (state, flow, amount, prior volume), which is what makes it exhaustively
 * testable. The caller supplies the numbers; this decides.
 *
 * Two rules this file exists to enforce:
 *
 *   1. Thresholds are CUMULATIVE. The question is never "is this transfer under
 *      the limit" but "does this transfer take the user's 30-day total over the
 *      limit". Ten transfers of NGN 99,000 must not slip past a NGN 100,000
 *      ceiling.
 *
 *   2. Sivan decides, providers inherit. No provider's KYC status is consulted
 *      to answer "may this user transact". That is Sivan's answer to give.
 */

import {
  CheckStatus,
  FLOW_LIMITS,
  VerificationLevel,
  VOLUME_WINDOW_DAYS,
  type FlowType,
  type RailFamily,
  type VerificationState,
} from '../types/verification.types.js';

export interface TransactionRequest {
  flow: FlowType;
  rail: RailFamily;
  /** This transaction, in NGN. Foreign-rail amounts must be converted first. */
  amountNgn: number;
  /** Completed NGN volume in the last VOLUME_WINDOW_DAYS, excluding this one. */
  priorVolumeNgn: number;
}

export type DecisionCode =
  | 'allowed'
  | 'upgrade_required'
  | 'blocked_invalid_amount'
  | 'blocked_risk'
  | 'blocked_check_failed';

export interface Decision {
  allowed: boolean;
  code: DecisionCode;
  /** Level that would permit this transaction, when one exists. */
  requiredLevel?: VerificationLevel;
  currentLevel: VerificationLevel;
  /** Ceiling that applied, in NGN. `null` means unlimited at this level. */
  limitNgn: number | null;
  /** Headroom left in the window before this transaction. */
  remainingNgn: number | null;
  /** User-facing, no internal detail. */
  reason: string;
}

/** Ceiling for a (flow, rail, level), or 0 if the combination is not permitted. */
export function limitFor(flow: FlowType, rail: RailFamily, level: VerificationLevel): number | null {
  const match = FLOW_LIMITS.find((l) => l.flow === flow && l.rail === rail && l.level === level);
  if (!match) return 0;
  return match.cumulativeNgn;
}

/**
 * Lowest level that would permit this transaction, or undefined if none does.
 *
 * Walks upward so the user is asked for the least verification that unblocks
 * them, never the most. Demanding an ID document for a NGN 60,000 transfer that
 * NIN alone would clear is how a funded user abandons.
 */
export function lowestSufficientLevel(
  flow: FlowType,
  rail: RailFamily,
  totalNgn: number
): VerificationLevel | undefined {
  const ladder = [
    VerificationLevel.BANK,
    VerificationLevel.IDENTITY,
    VerificationLevel.ENHANCED,
  ];
  for (const level of ladder) {
    const limit = limitFor(flow, rail, level);
    if (limit === null || totalNgn <= limit) return level;
  }
  return undefined;
}

/**
 * Has every check this level claims to represent actually passed?
 *
 * A stored `level` is a cached conclusion. If the underlying check later fails
 * or expires - a re-screen, a document lapse - the level is stale and must not
 * be honoured. Trusting the cached number over the evidence is how a revoked
 * user keeps transacting.
 */
export function levelIsIntact(state: VerificationState): boolean {
  const ok = (s: CheckStatus) => s === CheckStatus.VERIFIED;

  if (state.level >= VerificationLevel.BANK && !ok(state.bankStatus)) return false;

  if (state.level >= VerificationLevel.IDENTITY) {
    // NIN or BVN is sufficient - Bridge accepts either for Nigeria, and
    // requiring both would block users who hold only one.
    if (!ok(state.ninStatus) && !ok(state.bvnStatus)) return false;
    if (!ok(state.identityStatus)) return false;
  }

  if (state.level >= VerificationLevel.ENHANCED && !ok(state.proofOfAddressStatus)) return false;

  return true;
}

export function decide(state: VerificationState, request: TransactionRequest): Decision {
  const currentLevel = state.level;
  const amount = Number(request.amountNgn);
  const prior = Number(request.priorVolumeNgn);

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      allowed: false,
      code: 'blocked_invalid_amount',
      currentLevel,
      limitNgn: 0,
      remainingNgn: 0,
      reason: 'Enter a valid amount.',
    };
  }
  if (!Number.isFinite(prior) || prior < 0) {
    // Unknown history is not zero history. Failing closed here beats letting an
    // accounting glitch reset somebody's cumulative window.
    return {
      allowed: false,
      code: 'blocked_invalid_amount',
      currentLevel,
      limitNgn: 0,
      remainingNgn: 0,
      reason: 'We could not confirm your recent activity. Please try again shortly.',
    };
  }

  // An intact level must be proven before any limit is consulted: a stale level
  // with a failed check underneath should never even reach the arithmetic.
  if (!levelIsIntact(state)) {
    return {
      allowed: false,
      code: 'blocked_check_failed',
      currentLevel,
      limitNgn: 0,
      remainingNgn: 0,
      reason: 'One of your verification checks needs attention before you can continue.',
    };
  }

  // High risk stops here regardless of level. EDD is a decision about the
  // person, not about the amount.
  if (state.riskLevel === 'high' && !state.enhancedDueDiligence) {
    return {
      allowed: false,
      code: 'blocked_risk',
      currentLevel,
      limitNgn: 0,
      remainingNgn: 0,
      reason: 'This account needs a manual review before it can transact.',
    };
  }

  const limit = limitFor(request.flow, request.rail, currentLevel);
  const total = prior + amount;

  if (limit === null) {
    return {
      allowed: true,
      code: 'allowed',
      currentLevel,
      limitNgn: null,
      remainingNgn: null,
      reason: 'Allowed.',
    };
  }

  const remaining = Math.max(limit - prior, 0);

  if (total <= limit) {
    return {
      allowed: true,
      code: 'allowed',
      currentLevel,
      limitNgn: limit,
      remainingNgn: remaining,
      reason: 'Allowed.',
    };
  }

  const requiredLevel = lowestSufficientLevel(request.flow, request.rail, total);

  return {
    allowed: false,
    code: 'upgrade_required',
    requiredLevel,
    currentLevel,
    limitNgn: limit,
    remainingNgn: remaining,
    reason: requiredLevel === undefined
      ? 'This amount is above the maximum we can process. Please contact support.'
      : upgradeMessage(requiredLevel, limit, remaining),
  };
}

function ngn(value: number): string {
  return `NGN ${value.toLocaleString('en-NG')}`;
}

/**
 * Say what is needed and why, in the user's terms.
 *
 * "Verification required" tells someone nothing and reads as a rejection. The
 * remaining headroom is included so the user can also just send less, which is
 * often what they want and costs Sivan nothing.
 */
function upgradeMessage(required: VerificationLevel, limit: number, remaining: number): string {
  const ask: Record<number, string> = {
    [VerificationLevel.BANK]: 'confirm your payout bank account',
    [VerificationLevel.IDENTITY]: 'add your NIN or BVN',
    [VerificationLevel.ENHANCED]: 'add a photo ID and proof of address',
  };

  return [
    `You have ${ngn(remaining)} left of your ${ngn(limit)} limit for the last ${VOLUME_WINDOW_DAYS} days.`,
    `To go higher, ${ask[required] ?? 'complete verification'}.`,
  ].join(' ');
}

/**
 * Does this flow require a Bridge customer - and therefore the $2?
 *
 * The single most expensive question in the system, so it is answered in one
 * place. NGN-to-NGN never touches Bridge, so it must never trigger the charge.
 *
 * Production today does the opposite: ngn-quotes.service.ts requires a Bridge
 * customer with kycStatus 'kyc_approved' before ANY naira transfer, including
 * NGN 1,000 between two Nigerian banks that Bridge plays no part in.
 */
export function requiresBridgeCustomer(rail: RailFamily): boolean {
  return rail === 'foreign';
}

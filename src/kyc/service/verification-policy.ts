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
  UPLIFT_CEILING_NGN,
  VerificationLevel,
  VOLUME_WINDOW_DAYS,
  upliftApplies,
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
  /** True when the ceiling was removed by Bridge approval rather than by level. */
  bridgeUplift?: boolean;
}

/**
 * A ceiling an admin has deliberately set, replacing the shipped default.
 *
 * Sparse on purpose: only combinations an admin has actually changed appear.
 * `cumulativeNgn: null` is UNLIMITED and is meaningfully different from 0,
 * which closes the flow - so the presence of the entry, not the value, is what
 * signals an override.
 */
export interface VerificationLimitOverride {
  flow: FlowType;
  rail: RailFamily;
  level: VerificationLevel;
  cumulativeNgn: number | null;
}

/**
 * Ceiling for a (flow, rail, level), or 0 if the combination is not permitted.
 *
 * Deliberately still SYNCHRONOUS and pure. Overrides are passed in rather than
 * fetched here: this function sits inside decide(), which is called on every
 * quote, and turning it into a database read would put an I/O call on the hot
 * path and make the policy untestable without a database.
 *
 * The caller loads overrides once and hands them down.
 */
export function limitFor(
  flow: FlowType,
  rail: RailFamily,
  level: VerificationLevel,
  overrides?: readonly VerificationLimitOverride[]
): number | null {
  // An override wins outright. It is not clamped against the default, and
  // that is intentional: an admin raising the BANK off-ramp ceiling to clear
  // Breet's minimum is doing exactly what this exists for, and silently
  // capping them back to the shipped number would be a lie in the UI.
  const override = overrides?.find(
    (o) => o.flow === flow && o.rail === rail && o.level === level
  );
  if (override) return override.cumulativeNgn;

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
  totalNgn: number,
  overrides?: readonly VerificationLimitOverride[]
): VerificationLevel | undefined {
  const ladder = [
    VerificationLevel.BANK,
    VerificationLevel.IDENTITY,
    VerificationLevel.ENHANCED,
  ];
  for (const level of ladder) {
    // Overrides must reach here too. Without them this would tell a user to
    // complete IDENTITY when the admin had already raised BANK high enough to
    // clear their transaction - asking for documents that are not needed.
    const limit = limitFor(flow, rail, level, overrides);
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

export function decide(
  state: VerificationState,
  request: TransactionRequest,
  /**
   * Admin ceilings, loaded once by the caller. Omitted in tests and in any
   * path that only cares about the shipped defaults.
   */
  overrides?: readonly VerificationLimitOverride[],
  /**
   * THIS USER'S OWN CEILING, when an admin has granted one.
   *
   * Passed in rather than fetched, for the same reason `overrides` is: decide()
   * runs on every quote, and a database read here would put I/O on the hot path
   * and make the policy untestable without a database.
   *
   * `undefined` means no override - fall back to the tier. `{ cumulativeNgn:
   * null }` means an admin explicitly set this user to UNLIMITED. Those are
   * different instructions, which is why this is an object rather than a bare
   * `number | null` that could not distinguish them.
   */
  userOverride?: { cumulativeNgn: number | null }
): Decision {
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

  // Fully identity-verified users get a HIGH ceiling, not an unlimited one.
  //
  // Whoever performed the check: Sivan's own NIN/BVN, or Bridge's. A Nigerian
  // user who never needs a USD account should not be capped below someone who
  // paid for one on identical evidence - see upliftApplies().
  //
  // Deliberately not `null`. Unlimited means no amount ever triggers a second
  // look, and an identity check says who someone IS, not whether this
  // particular transfer is normal for them. Crossing the ceiling asks for
  // source of funds, which is what ENHANCED collects.
  //
  // ENHANCED is exempt: that user HAS supplied proof of address and source of
  // funds, so there is nothing further to ask for and the table's own `null`
  // applies below.
  /**
   * A PER-USER OVERRIDE BEATS THE UPLIFT, so this branch is skipped when one
   * exists.
   *
   * Found by a test that refused to go green: an admin pinned a user to
   * NGN 1,000,000, the user had 800,000 of volume, and a 400,000 withdrawal
   * was still ALLOWED. The uplift branch returns before the override is ever
   * read, so anyone who had cleared Bridge KYC - which is to say every user an
   * exception would realistically be granted to - silently kept the
   * 10,000,000 uplift ceiling no matter what an operator set.
   *
   * That breaks the feature in both directions. Raising a merchant's cap
   * appeared to work and changed nothing; LOWERING one as a soft restriction
   * short of a freeze also changed nothing, while the admin hub displayed the
   * new figure as though it were in force. A limit screen that lies is worse
   * than no limit screen.
   *
   * The override still cannot bypass verification: levelIsIntact() runs above
   * this and is unaffected.
   */
  if (currentLevel < VerificationLevel.ENHANCED && upliftApplies(state) && !userOverride) {
    const upliftLimit = upliftCeilingFor(request.flow, request.rail, overrides);
    const upliftTotal = prior + amount;
    const upliftRemaining = Math.max(upliftLimit - prior, 0);

    if (upliftTotal <= upliftLimit) {
      return {
        allowed: true,
        code: 'allowed',
        currentLevel,
        limitNgn: upliftLimit,
        remainingNgn: upliftRemaining,
        bridgeUplift: true,
        reason: 'Allowed.',
      };
    }

    // Over the uplifted ceiling. The only thing left to ask for is ENHANCED -
    // photo ID, proof of address, source of funds.
    return {
      allowed: false,
      code: 'upgrade_required',
      requiredLevel: VerificationLevel.ENHANCED,
      currentLevel,
      limitNgn: upliftLimit,
      remainingNgn: upliftRemaining,
      bridgeUplift: true,
      reason:
        `You have ${ngn(upliftRemaining)} left of your ${ngn(upliftLimit)} limit for the last ` +
        `${VOLUME_WINDOW_DAYS} days. To go higher we need proof of address and where the funds ` +
        `come from.`,
    };
  }

  /**
   * A PER-USER CEILING WINS OVER THE TIER.
   *
   * Placed AFTER levelIsIntact() and after the uplift branch on purpose. An
   * override raises how much a verified user may move; it is not a way to skip
   * verification, so a user whose level is not intact is still refused above
   * regardless of any exception granted to them.
   *
   * Not clamped against the tier default, in either direction. An admin
   * lowering one user below their tier is a legitimate risk action - a soft
   * restriction short of a full freeze - and silently refusing to apply it
   * would be worse than not offering it.
   */
  const limit = userOverride ? userOverride.cumulativeNgn : limitFor(request.flow, request.rail, currentLevel, overrides);
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

  const requiredLevel = lowestSufficientLevel(request.flow, request.rail, total, overrides);

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
 * The uplifted ceiling for a flow/rail.
 *
 * Reads the ENHANCED row's override if an admin has set one, because "how much
 * may a fully verified user move" is the same question that row answers. A
 * `null` there means the admin has deliberately chosen unlimited, and that is
 * their call to make - the default simply is not unlimited.
 */
export function upliftCeilingFor(
  flow: FlowType,
  rail: RailFamily,
  overrides?: readonly VerificationLimitOverride[]
): number {
  const override = overrides?.find(
    (o) => o.flow === flow && o.rail === rail && o.level === VerificationLevel.ENHANCED
  );
  if (override && override.cumulativeNgn !== null) return override.cumulativeNgn;
  if (override && override.cumulativeNgn === null) return Number.POSITIVE_INFINITY;
  return UPLIFT_CEILING_NGN;
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

/**
 * Everything the UI needs to describe a user's verification, in one call.
 *
 * WHY THIS EXISTS
 *
 * getVerificationState() computes the level, the per-check statuses and the
 * ceilings, and decide() turns those into an allow/deny with a real number.
 * None of it was reachable over HTTP, so the frontend invented its own answer:
 *
 *     isVerified = customer?.kycStatus === 'kyc_approved'
 *     hasBank    = externalAccounts.length > 0
 *
 * Both read Bridge-only data. A Nigerian who completed the bank check has no
 * Bridge customer and no Bridge external account, so the UI showed them as
 * unverified with 25% progress and every action blocked - while the backend
 * had already granted them Level 1. The two disagreed, and the user believed
 * the UI.
 *
 * EVERY NUMBER HERE COMES FROM THE DATABASE-BACKED LIMIT TABLE.
 *
 * Ceilings are resolved through limitFor(), which consults the admin overrides
 * first and falls back to the shipped FLOW_LIMITS default. Nothing is
 * hardcoded in the response and nothing may be hardcoded in the UI - an admin
 * moving a ceiling in the hub must change what the user is told, immediately,
 * with no deploy.
 */

import { getVerificationState, getCumulativeNgnVolume } from './verification-state.js';
import { listVerificationLimitOverrides } from './verification-limits.service.js';
import { limitFor, lowestSufficientLevel, upliftCeilingFor } from './verification-policy.js';
import {
  UPLIFT_CEILING_NGN,
  VOLUME_WINDOW_DAYS,
  VerificationLevel,
  upliftApplies,
  type FlowType,
  type RailFamily,
} from '../types/verification.types.js';
import { verificationPathFor } from './verification-path.js';
import { db } from '../../database/json-database.js';
import { notFound } from '../../shared/errors.js';

export interface FlowAllowance {
  flow: FlowType;
  rail: RailFamily;
  /** null means genuinely uncapped at this level. */
  limitNgn: number | null;
  usedNgn: number;
  remainingNgn: number | null;
  /** The level that would raise this ceiling, when one exists. */
  nextLevel?: VerificationLevel;
}

export interface VerificationSummary {
  level: VerificationLevel;
  levelLabel: string;
  /** Which flow the user should be shown to progress - country decides. */
  path: 'ngn_bank' | 'bridge_kyc';
  country?: string;

  checks: {
    identity: string;
    bank: string;
    nin: string;
    bvn: string;
    proofOfAddress: string;
    sourceOfFunds: string;
  };

  /** Where the identity came from. Undefined when there is none. */
  identitySource?: 'sivan' | 'bridge';
  /** True when the uplifted ceiling is in force rather than the level's own. */
  upliftApplies: boolean;

  /** Has the user completed the check their country's path requires? */
  pathComplete: boolean;
  /** A payout destination exists and is usable. */
  hasPayoutAccount: boolean;
  /** An NGN payout account is sitting in the review queue. */
  hasPendingPayoutReview: boolean;

  windowDays: number;
  allowances: FlowAllowance[];
}

const LEVEL_LABELS: Record<number, string> = {
  [VerificationLevel.NONE]: 'Level 0: Starter',
  [VerificationLevel.BANK]: 'Level 1: Bank verified',
  [VerificationLevel.IDENTITY]: 'Level 2: Identity verified',
  [VerificationLevel.ENHANCED]: 'Level 3: Enhanced',
};

/**
 * The flows worth reporting.
 *
 * Foreign rails are included even though they are closed below IDENTITY,
 * because "0, and here is the level that opens it" is the answer a user needs
 * - silently omitting the row reads as though the feature does not exist.
 */
const REPORTED: Array<{ flow: FlowType; rail: RailFamily }> = [
  { flow: 'offramp', rail: 'ngn' },
  { flow: 'onramp', rail: 'ngn' },
  { flow: 'escrow', rail: 'ngn' },
  { flow: 'offramp', rail: 'foreign' },
];

export async function getVerificationSummary(userId: string): Promise<VerificationSummary> {
  const user = await db.findUserById(userId);
  if (!user) throw notFound('User');

  const state = await getVerificationState(userId);
  const overrides = await listVerificationLimitOverrides();
  const usedNgn = await getCumulativeNgnVolume(userId, VOLUME_WINDOW_DAYS);
  const path = verificationPathFor(user.country);

  const ngnAccounts = await db.listNgnPayoutAccounts(userId);
  const hasVerifiedNgnAccount = ngnAccounts.some((a) => a.status === 'verified');
  const hasPendingPayoutReview = ngnAccounts.some((a) => a.status === 'pending_review');

  const data = await db.read();
  const hasBridgeAccount = (data.externalAccounts ?? []).some(
    (a: any) => a.userId === userId && (a.status === 'verified' || a.status === 'active')
  );

  const uplifted = upliftApplies(state) && state.level < VerificationLevel.ENHANCED;

  const allowances: FlowAllowance[] = REPORTED.map(({ flow, rail }) => {
    // The uplifted ceiling replaces the level's own when it applies, exactly
    // as decide() does. Reporting the level's ceiling to a user who is
    // actually on the uplift would understate their headroom by 20x.
    const rawLimit = uplifted
      ? upliftCeilingFor(flow, rail, overrides)
      : limitFor(flow, rail, state.level, overrides);

    // upliftCeilingFor returns Infinity when an admin has explicitly set the
    // ENHANCED override to null. Normalised to null - the wire format has no
    // Infinity, and JSON.stringify would emit it as the string "null" anyway.
    const limitNgn = rawLimit === null || !Number.isFinite(rawLimit) ? null : rawLimit;

    const remainingNgn = limitNgn === null ? null : Math.max(limitNgn - usedNgn, 0);

    // What would actually raise this ceiling. Only meaningful when capped.
    let nextLevel: VerificationLevel | undefined;
    if (limitNgn !== null) {
      nextLevel = uplifted
        ? VerificationLevel.ENHANCED
        : lowestSufficientLevel(flow, rail, limitNgn + 1, overrides);
    }

    return { flow, rail, limitNgn, usedNgn, remainingNgn, nextLevel };
  });

  return {
    level: state.level,
    levelLabel: LEVEL_LABELS[state.level] ?? `Level ${state.level}`,
    path,
    country: user.country,
    checks: {
      identity: state.identityStatus,
      bank: state.bankStatus,
      nin: state.ninStatus,
      bvn: state.bvnStatus,
      proofOfAddress: state.proofOfAddressStatus,
      sourceOfFunds: state.sourceOfFundsStatus,
    },
    identitySource: state.identitySource,
    upliftApplies: uplifted,
    // The Nigerian path is complete when a NUBAN cleared the name match; the
    // Bridge path when Bridge approved. Asking "is this user verified" without
    // reference to their path is what produced the original bug.
    pathComplete: path === 'ngn_bank' ? hasVerifiedNgnAccount : state.level >= VerificationLevel.IDENTITY,
    hasPayoutAccount: hasVerifiedNgnAccount || hasBridgeAccount,
    hasPendingPayoutReview,
    windowDays: VOLUME_WINDOW_DAYS,
    allowances,
  };
}

export { UPLIFT_CEILING_NGN };

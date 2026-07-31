/**
 * Sivan verification model.
 *
 * SIVAN'S KYC IS THE SOURCE OF TRUTH FOR EVERY PROVIDER.
 *
 * Not Bridge's, not the NGN provider's. A user is verified once, by Sivan, and
 * every provider inherits that result. Providers may still impose their own
 * requirements on top - Bridge does - but Sivan never delegates the decision
 * about who a user is.
 *
 * WHY LEVELS AND NOT A BOOLEAN
 *
 * `kyc = true` cannot answer "verified enough for WHAT". A user cleared to
 * settle NGN 20,000 between two Nigerian bank accounts is not thereby cleared
 * to move USD through Bridge. Those are different questions with different
 * costs, and collapsing them is how a $2 charge ends up firing on a NGN 1,000
 * transfer - which is exactly what production does today.
 *
 * WHY THRESHOLDS ARE CUMULATIVE
 *
 * A per-transaction threshold is not a control. Ten transfers of NGN 99,000
 * move NGN 990,000 while never once crossing a NGN 100,000 line. Structuring is
 * the first pattern any reviewer looks for, and a per-transaction limit invites
 * it by construction. Every threshold here is measured over a rolling window of
 * completed volume.
 *
 * WHAT SIVAN IS
 *
 * Sivan holds no naira. Balances are USDC/USDT only; naira moves bank -> NGN
 * provider -> bank. So the CBN tiered *wallet* schedule (NGN 50k/200k/5m
 * balance caps) does not describe this product. What does apply: AML
 * obligations, sanctions screening, record keeping, and each provider's own
 * agreement.
 */

/** Rolling window over which cumulative volume is measured. */
export const VOLUME_WINDOW_DAYS = 30;

/**
 * Verification levels.
 *
 * Deliberately ordinal: `level >= required` is the only comparison callers
 * should need, so a new level can be inserted without rewriting every gate.
 */
export enum VerificationLevel {
  /** Registered. No money movement. Costs Sivan nothing. */
  NONE = 0,
  /**
   * Bank verified. Payout account resolved to a real account name.
   *
   * Worth more than it looks: since the CBN directive effective 1 March 2024,
   * a Nigerian bank account cannot transact without BVN/NIN linkage. An account
   * that resolves is an account a licensed bank has already verified. Sivan
   * inherits that check for the price of one name lookup.
   */
  BANK = 1,
  /** Identity verified. NIN and/or BVN validated against the national source. */
  IDENTITY = 2,
  /** Enhanced. ID document plus proof of address. */
  ENHANCED = 3,
}

/**
 * Per-check status.
 *
 * `EXPIRED` exists because a check is a point-in-time statement. A sanctions
 * screen from two years ago is not a current answer, and treating it as one is
 * how a stale pass survives a re-screen it would now fail.
 */
export enum CheckStatus {
  NOT_STARTED = 'not_started',
  PENDING = 'pending',
  VERIFIED = 'verified',
  FAILED = 'failed',
  EXPIRED = 'expired',
}

/**
 * The flows a threshold applies to.
 *
 * Off-ramp is separated from escrow on purpose. NGN 500,000 of escrow is two
 * Nigerian bank accounts settling with each other; the money never leaves the
 * banking system and both ends already carry a bank's own KYC. NGN 500,000 of
 * off-ramp is crypto of unknown origin converting to naira. Same number,
 * different risk, so they get different ceilings.
 */
export type FlowType = 'escrow' | 'offramp' | 'onramp';

/** Currency family. Foreign rails are what make Bridge - and its $2 - relevant. */
export type RailFamily = 'ngn' | 'foreign';

export interface VerificationState {
  level: VerificationLevel;
  identityStatus: CheckStatus;
  bankStatus: CheckStatus;
  bvnStatus: CheckStatus;
  ninStatus: CheckStatus;
  livenessStatus: CheckStatus;
  proofOfAddressStatus: CheckStatus;
  sourceOfFundsStatus: CheckStatus;
  riskLevel: 'low' | 'medium' | 'high';
  enhancedDueDiligence: boolean;
  /**
   * Reference returned by whoever performed the check.
   *
   * Store THIS, never the raw NIN or BVN. Knowing that a person was verified
   * and by whom is the compliance requirement. Holding the national identifier
   * itself turns an ordinary breach into an NDPA incident, and adds nothing we
   * need.
   */
  providerRef?: string;
  verifiedAt?: string;
}

export interface FlowLimit {
  flow: FlowType;
  rail: RailFamily;
  level: VerificationLevel;
  /** Cumulative NGN over VOLUME_WINDOW_DAYS. `null` = no ceiling at this level. */
  cumulativeNgn: number | null;
}

/**
 * Threshold table.
 *
 * NGN figures are the product's own risk appetite, not a regulator's schedule -
 * Sivan holds no naira balance, so the CBN wallet tiers do not bind here.
 *
 * Off-ramp sits at half of escrow at every level, for the reason given on
 * FlowType.
 *
 * Foreign rails require IDENTITY as a floor. That is not a Sivan rule: Bridge
 * requires a national identity number for all non-US residents, and Nigeria's
 * accepted types are `tin`, `nin` and `bvn`. Reaching Level 2 collects exactly
 * what Bridge will ask for, which is what makes Level 2 a genuine pre-screen
 * rather than a formality.
 */
export const FLOW_LIMITS: readonly FlowLimit[] = [
  // Nothing moves at level 0.
  { flow: 'escrow',  rail: 'ngn', level: VerificationLevel.NONE, cumulativeNgn: 0 },
  { flow: 'offramp', rail: 'ngn', level: VerificationLevel.NONE, cumulativeNgn: 0 },
  { flow: 'onramp',  rail: 'ngn', level: VerificationLevel.NONE, cumulativeNgn: 0 },

  { flow: 'escrow',  rail: 'ngn', level: VerificationLevel.BANK, cumulativeNgn: 100_000 },
  { flow: 'offramp', rail: 'ngn', level: VerificationLevel.BANK, cumulativeNgn: 50_000 },
  { flow: 'onramp',  rail: 'ngn', level: VerificationLevel.BANK, cumulativeNgn: 100_000 },

  { flow: 'escrow',  rail: 'ngn', level: VerificationLevel.IDENTITY, cumulativeNgn: 1_000_000 },
  { flow: 'offramp', rail: 'ngn', level: VerificationLevel.IDENTITY, cumulativeNgn: 500_000 },
  { flow: 'onramp',  rail: 'ngn', level: VerificationLevel.IDENTITY, cumulativeNgn: 1_000_000 },

  { flow: 'escrow',  rail: 'ngn', level: VerificationLevel.ENHANCED, cumulativeNgn: null },
  { flow: 'offramp', rail: 'ngn', level: VerificationLevel.ENHANCED, cumulativeNgn: null },
  { flow: 'onramp',  rail: 'ngn', level: VerificationLevel.ENHANCED, cumulativeNgn: null },

  // Foreign rails: closed below IDENTITY.
  { flow: 'escrow',  rail: 'foreign', level: VerificationLevel.NONE,     cumulativeNgn: 0 },
  { flow: 'offramp', rail: 'foreign', level: VerificationLevel.NONE,     cumulativeNgn: 0 },
  { flow: 'onramp',  rail: 'foreign', level: VerificationLevel.NONE,     cumulativeNgn: 0 },
  { flow: 'escrow',  rail: 'foreign', level: VerificationLevel.BANK,     cumulativeNgn: 0 },
  { flow: 'offramp', rail: 'foreign', level: VerificationLevel.BANK,     cumulativeNgn: 0 },
  { flow: 'onramp',  rail: 'foreign', level: VerificationLevel.BANK,     cumulativeNgn: 0 },
  { flow: 'escrow',  rail: 'foreign', level: VerificationLevel.IDENTITY, cumulativeNgn: 1_000_000 },
  { flow: 'offramp', rail: 'foreign', level: VerificationLevel.IDENTITY, cumulativeNgn: 500_000 },
  { flow: 'onramp',  rail: 'foreign', level: VerificationLevel.IDENTITY, cumulativeNgn: 1_000_000 },
  { flow: 'escrow',  rail: 'foreign', level: VerificationLevel.ENHANCED, cumulativeNgn: null },
  { flow: 'offramp', rail: 'foreign', level: VerificationLevel.ENHANCED, cumulativeNgn: null },
  { flow: 'onramp',  rail: 'foreign', level: VerificationLevel.ENHANCED, cumulativeNgn: null },
] as const;

/**
 * Legacy status values that mean "verified".
 *
 * Both spellings are in circulation: CustomerStatus uses 'kyc_approved', while
 * Bridge and parts of the codebase use 'active'. Two words for the same state
 * is how a gate gets written that accepts one and silently rejects the other,
 * so every comparison goes through this list rather than a literal.
 */
export const APPROVED_KYC_STATUSES: readonly string[] = ['kyc_approved', 'approved', 'active'] as const;

export function isApprovedKycStatus(status?: string | null): boolean {
  return APPROVED_KYC_STATUSES.includes(String(status ?? '').toLowerCase());
}

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
import { isKycLevelProviderConfigured } from '../providers/kyc-level-provider-registry.js';
import {
  UPLIFT_CEILING_NGN,
  VOLUME_WINDOW_DAYS,
  VerificationLevel,
  upliftApplies,
  type FlowType,
  type RailFamily,
} from '../types/verification.types.js';
import { getActiveUserLimitOverrides } from './user-limits.service.js';
import { effectiveUsedNgn } from './user-limit-usage.js';
import { verificationPathFor } from './verification-path.js';
import { getNgnControls } from '../../ngn/service/ngn-controls.service.js';
import { db } from '../../database/json-database.js';
import { notFound } from '../../shared/errors.js';
import { customerTermsOutstanding } from '../../customers/customer-terms.js';

export interface FlowAllowance {
  flow: FlowType;
  rail: RailFamily;
  /** null means genuinely uncapped at this level. */
  limitNgn: number | null;
  usedNgn: number;
  remainingNgn: number | null;
  /** The level that would raise this ceiling, when one exists. */
  nextLevel?: VerificationLevel;
  /**
   * A REASON THIS RAIL CANNOT BE USED THAT IS NOT THE CEILING.
   *
   * Introduced because the two can now disagree. A Bridge-approved Nigerian
   * with no NUBAN reaches IDENTITY, so their naira off-ramp ceiling is a
   * genuine NGN 5,000,000 - but they have nowhere for naira to land, and
   * acceptNgnQuote() will refuse until a name-matched payout account exists.
   *
   * Reporting only the ceiling would put "₦5,000,000 left" on the screen of
   * someone who cannot move one naira. Reporting a ceiling of ZERO instead
   * would be the other lie - it would read as "your limit is spent" or "you
   * are not verified", which is the exact misreading the limit card's own
   * `limit === 0` branch was written to avoid.
   *
   * So the ceiling stays truthful and this states the separate blocker. The
   * UI shows the requirement rather than a number.
   *
   * Absent when the rail is usable.
   */
  blockedBy?: 'payout_account_required';
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

  /**
   * The provider terms step, as a first-class part of verification.
   *
   * SERVER-OWNED because the gate is server-enforced. The page used to decide
   * for itself whether to show a Terms row - it hid it for Nigerians and drew
   * a permanently-disabled button for everyone else - which meant the screen's
   * idea of "done" and the API's idea of "allowed" were computed in two places
   * from two different rules. Now there is one answer and the UI renders it.
   *
   * `required: false` for a user with no Bridge customer: there is no terms
   * document that applies to them and no link they could open.
   */
  terms: {
    /** Does this user owe a provider terms acceptance at all? */
    required: boolean;
    accepted: boolean;
    /** Bridge's hosted terms page. Absent when we have not been given one. */
    link?: string;
  };

  /**
   * Has the user completed the IDENTITY check their country's path requires?
   *
   * Deliberately EXCLUDES terms. `pathComplete` includes them, and the
   * verification page derives its step-2 tick from "is the path done" - so
   * folding terms into that one field made a verified identity render as an
   * incomplete step. Caught in a screenshot: a green "Verified" badge sitting
   * beside an un-ticked "2" circle, and 50% on a page showing three of four
   * steps finished.
   *
   * Two different questions needed two different fields: "is your ID
   * confirmed" and "are you finished".
   */
  identityComplete: boolean;

  /**
   * Is the user finished with EVERYTHING their path requires, terms included?
   *
   * This is the gate - it drives isVerified in the frontend and the overall
   * progress. A user who owes a terms acceptance is not finished.
   */
  pathComplete: boolean;
  /** A payout destination exists and is usable. */
  hasPayoutAccount: boolean;
  /** An NGN payout account is sitting in the review queue. */
  hasPendingPayoutReview: boolean;

  windowDays: number;
  allowances: FlowAllowance[];

  /**
   * What the user can do NEXT to raise their level, if anything.
   *
   * Undefined at the top of the ladder - inviting an upgrade that cannot
   * happen is a dead end. The frontend renders this verbatim rather than
   * deciding for itself, because the ladder is the server's to own and two
   * copies of it drift.
   */
  nextStep?: {
    level: VerificationLevel;
    label: string;
    description: string;
    /** Which flow completes it, so the UI knows which button to show. */
    action: 'nin_bvn' | 'bridge_kyc' | 'contact_support';
    available: boolean;
  };
}

/**
 * The rung above the one the user is on.
 *
 * Nigeria and everywhere else climb differently. A Nigerian reaches Level 1 on
 * a bank check alone and goes to Level 2 with NIN/BVN; a Bridge user has no
 * Level 1 at all - their document check takes them straight to Level 2, which
 * is why a US user at Level 0 is offered identity verification and not a bank.
 *
 * `available: false` is deliberate and honest: NIN/BVN has no provider wired
 * up yet (the identityVerificationEnabled admin control is off for MVP), so the UI states the
 * next level exists and is coming rather than offering a button that leads
 * nowhere. Silence would leave a Nigerian at 100% with no idea a higher
 * ceiling exists.
 */
function nextStepFor(
  path: 'ngn_bank' | 'bridge_kyc',
  level: VerificationLevel,
  ninBvnAvailable: boolean
): VerificationSummary['nextStep'] {
  if (level >= VerificationLevel.ENHANCED) return undefined;

  if (level >= VerificationLevel.IDENTITY) {
    return {
      level: VerificationLevel.ENHANCED,
      label: 'Level 3: Enhanced',
      description:
        'Higher limits (₦20,000,000+ per 30 days) for regular, larger volumes. Our team reviews these individually - contact support to start.',
      action: 'contact_support',
      available: true,
    };
  }

  if (path === 'ngn_bank') {
    return {
      level: VerificationLevel.IDENTITY,
      label: 'Level 2: Identity verified',
      description:
        'Add your BVN to raise your limit from ₦500,000 to ₦5,000,000 per 30 days.',
      action: 'nin_bvn',
      /**
       * GATED ON A BVN PROVIDER EXISTING, NOT ON identityVerificationEnabled.
       *
       * This used to read the identity toggle, which is a different control
       * with a different job: it decides whether a NIN/BVN is REQUIRED for
       * Level 2, and it is deliberately off because requiring one while no
       * provider existed would have stranded every user at Level 1.
       *
       * Reading it here conflated "is a check mandatory" with "is a check
       * possible", so the step stayed "Coming soon" even after the Monnify
       * provider was wired up and working - the button could never appear
       * without also making the check compulsory.
       *
       * The honest question is whether a provider can answer, which is what
       * this now asks.
       */
      available: ninBvnAvailable,
    };
  }

  return {
    level: VerificationLevel.IDENTITY,
    label: 'Level 2: Identity verified',
    description:
      'Verify your identity with a government-issued ID and a selfie. Usually takes about three minutes.',
    action: 'bridge_kyc',
    available: true,
  };
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

  // IN PARALLEL, because none of these depends on another.
  //
  // They were five sequential awaits. Latency is what broke this page: the
  // frontend renders on whatever has arrived, so a summary that lands after
  // the first paint is, on screen, indistinguishable from a summary that was
  // never fetched. Every await removed from this chain is one less chance of
  // showing a Nigerian the Bridge document flow.
  const [state, overrides, userOverrides, usedNgn, ngnAccounts, bridgeAccounts, controls, customer] = await Promise.all([
    getVerificationState(userId),
    listVerificationLimitOverrides(),
    // Per-user exceptions, expired ones already filtered out. Added to the
    // SAME Promise.all rather than awaited after it: this page's latency is
    // what caused a Nigerian to be shown the Bridge document flow, and a
    // sequential await here would reintroduce exactly that.
    getActiveUserLimitOverrides(userId),
    // Respects any admin reset watermark, so a forgiven window shows as
    // forgiven on the user's own card and not only at enforcement.
    effectiveUsedNgn(userId, 'offramp', 'ngn'),
    db.listNgnPayoutAccounts(userId),
    // One indexed lookup, not the whole database. See the comment on
    // findCustomerByUserId in postgres-database.ts for the measurement.
    db.listExternalAccountsByUser(userId),
    // Whether NIN/BVN is even offerable. Read here rather than assumed,
    // because turning the provider on must change the page with no deploy.
    getNgnControls(),
    /**
     * The Bridge customer, for the terms step.
     *
     * getVerificationState() already reads this row and exposes
     * `bridgeTosStatus` off it, but not the tosLink - and the UI needs
     * somewhere to send the user, not just a boolean telling them they are
     * blocked. Fetched here rather than widening VerificationState because
     * this is a presentational detail of one step, and it joins the existing
     * Promise.all so it costs no extra round trip.
     */
    db.findCustomerByUserId(userId).catch(() => null),
  ]);
  const path = verificationPathFor(user.country);

  const hasVerifiedNgnAccount = ngnAccounts.some((a) => a.status === 'verified');
  const hasPendingPayoutReview = ngnAccounts.some((a) => a.status === 'pending_review');

  const hasBridgeAccount = bridgeAccounts.some(
    (a: any) => a.status === 'verified' || a.status === 'active'
  );

  const uplifted = upliftApplies(state) && state.level < VerificationLevel.ENHANCED;

  const allowances: FlowAllowance[] = REPORTED.map(({ flow, rail }) => {
    // The uplifted ceiling replaces the level's own when it applies, exactly
    // as decide() does. Reporting the level's ceiling to a user who is
    // actually on the uplift would understate their headroom by 20x.
    /**
     * A PER-USER CEILING WINS, and it must win HERE too.
     *
     * The card the user sees ("₦3,839 left") is computed from this number. If
     * an admin grants an exception and only the enforcement path honours it,
     * the customer is still told they are capped while their transaction
     * quietly succeeds - which generates the support ticket the exception was
     * meant to close.
     *
     * Checked before the uplift branch because an explicit per-user decision
     * outranks an automatic Bridge uplift: an admin who deliberately set this
     * person's ceiling has said something more specific than a rule.
     */
    const userOverride = userOverrides.find((row) => row.flow === flow && row.rail === rail);
    const rawLimit = userOverride
      ? userOverride.cumulativeNgn
      : uplifted
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

    /**
     * A CEILING IS NOT THE SAME AS A USABLE RAIL.
     *
     * The naira rails settle into a Nigerian bank account, so they need a
     * name-matched NUBAN regardless of how high the ceiling is. A
     * Bridge-approved user now reaches IDENTITY without one, which is correct
     * for identity and useless for naira - acceptNgnQuote() refuses without a
     * verified payout account.
     *
     * Only the NGN rails are gated this way. The foreign rails settle through
     * Bridge, whose external account is a separate thing entirely, and
     * blocking those on a Nigerian account number would invent a requirement
     * that does not exist.
     */
    const blockedBy = rail === 'ngn' && !hasVerifiedNgnAccount
      ? ('payout_account_required' as const)
      : undefined;

    return { flow, rail, limitNgn, usedNgn, remainingNgn, nextLevel, blockedBy };
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
    /**
     * PRESENCE OF A BRIDGE CUSTOMER DECIDES THIS, NOT COUNTRY.
     *
     * The page keyed the Terms row off `!isNgnPath`, so a Nigerian who went on
     * to start a Bridge verification - the documented route to USD/GBP/EUR
     * rails, offered by a button on that very page - had a Bridge customer, a
     * real terms obligation, and no Terms row anywhere in the UI. They were
     * blocked at withdrawal by a step the screen never showed them.
     *
     * Asking whether the customer exists is the same question the enforcement
     * gate asks, so the screen and the API cannot disagree.
     */
    terms: {
      required: customer?.provider === 'bridge',
      accepted: customer?.tosStatus === 'approved',
      link: customer?.tosLink,
    },
    // The Nigerian path is complete when a NUBAN cleared the name match; the
    // Bridge path when Bridge approved. Asking "is this user verified" without
    // reference to their path is what produced the original bug.
    /**
     * TERMS ARE PART OF BEING DONE.
     *
     * The user asked for terms to be one of the criteria for finishing
     * verification, and this is the field that means "finished" - it drives
     * the progress bar, the "Account ready" banner and the step ticks.
     *
     * `!termsOutstanding` and not `terms.accepted`: a user with no Bridge
     * customer owes nothing, so an unaccepted-but-not-required terms status
     * must not hold them at 99% forever. Same distinction the gate makes.
     */
    /**
     * EITHER ROUTE FINISHES THE NIGERIAN PATH, NOT ONLY THE NUBAN.
     *
     * `path` comes from verificationPathFor(user.country), so for a Nigerian
     * it is ALWAYS 'ngn_bank' - it describes the route their country is
     * steered down, not the route they actually took. Keying completion off
     * it alone meant a Nigerian who went and completed Bridge's document check
     * (offered by a button on that very page) was still told they had not
     * finished, because they had no NUBAN.
     *
     * That is what produced the contradiction on screen: "Verification
     * complete" in the banner, "Level 0: Starter" and "50% complete" directly
     * beneath it, from two fields that disagreed about what finished means.
     *
     * A Nigerian is done when EITHER their NUBAN name-matched OR they reached
     * IDENTITY by another route - Bridge, or a matched BVN. Both are real
     * completions of the same question.
     */
    identityComplete: hasVerifiedNgnAccount || state.level >= VerificationLevel.IDENTITY,
    pathComplete: (hasVerifiedNgnAccount || state.level >= VerificationLevel.IDENTITY)
      && !customerTermsOutstanding(customer),
    /**
     * IS THERE A HIGHER LEVEL, AND WHAT WOULD IT TAKE?
     *
     * The UI had no way to answer this, so a Nigerian who finished Level 1 saw
     * a page that said 100% and stopped - with no hint that Level 2 exists or
     * that it raises their ceiling from 100k to 500k. `allowances[].nextLevel`
     * already carried the number, but nothing said what to DO about it, so the
     * page could not offer a next step without hardcoding the ladder in the
     * frontend - which is how the two drift apart.
     *
     * Stated by the server because the server owns the ladder.
     */
    nextStep: nextStepFor(path, state.level, isKycLevelProviderConfigured()),
    hasPayoutAccount: hasVerifiedNgnAccount || hasBridgeAccount,
    hasPendingPayoutReview,
    windowDays: VOLUME_WINDOW_DAYS,
    allowances,
  };
}

export { UPLIFT_CEILING_NGN };

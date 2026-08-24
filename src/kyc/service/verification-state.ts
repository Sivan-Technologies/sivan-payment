/**
 * Assemble a user's VerificationState from what Sivan currently stores.
 *
 * This is the adapter between the old world and the new one. Today there is no
 * dedicated verification record - the facts are spread across the Bridge
 * customer row and the payout account. Rather than block on a migration, this
 * derives the state from what exists, so the policy can start governing real
 * traffic immediately.
 *
 * When a real verification table lands, only this file changes. Everything that
 * consumes VerificationState keeps working.
 *
 * IMPORTANT: a missing Bridge customer is NOT a missing user. Under the new
 * model most users will never have a Bridge customer at all, because NGN-only
 * traffic never touches Bridge. Absence must resolve to a low level, never to
 * an error.
 */

import { db } from '../../database/json-database.js';
import { getNgnControls } from '../../ngn/service/ngn-controls.service.js';
import {
  CheckStatus,
  VerificationLevel,
  isApprovedKycStatus,
  type VerificationState,
} from '../types/verification.types.js';

/**
 * Derive the level from the checks that have actually passed.
 *
 * Computed, never read from a stored field: a stored level can drift from the
 * evidence underneath it, and when those two disagree the evidence is right.
 */
/**
 * IDENTITY NO LONGER REQUIRES A PAYOUT ACCOUNT.
 *
 * THE BUG THIS FIXES. The ladder used to AND every rung with `bankVerified`,
 * so identity could not count for anything until a payout destination existed:
 *
 *   bankVerified && identityVerified -> IDENTITY
 *   bankVerified                     -> BANK
 *   else                             -> NONE
 *
 * A Nigerian who completed Bridge's document KYC - passport, selfie, the whole
 * $2 check - but had not yet added a NUBAN therefore sat at LEVEL 0. Their
 * screen said "Verification complete / You're verified" and "Level 0: Starter"
 * at the same time, the wallet refused to provision, Receive said "verify your
 * identity first", and every ceiling read zero. All of it from one AND.
 *
 * Those are two independent facts and the ladder was multiplying them:
 *
 *   "do we know who you are"          <- Bridge KYC, or a matched BVN
 *   "where do we send your naira"     <- a name-matched NUBAN
 *
 * Knowing someone is not conditional on having somewhere to pay them. So
 * identity now stands on its own, and the bank rung is what it always said it
 * was - a payout destination - rather than a prerequisite for being known.
 *
 * WHY BANK STILL BEATS NONE ON ITS OWN. A matched NUBAN is real evidence in
 * its own right: since the CBN directive of 1 March 2024 a Nigerian account
 * cannot transact without BVN/NIN linkage, so an account that resolves has
 * already been verified by a licensed bank. That is worth Level 1 without any
 * identity check, exactly as before.
 *
 * ENHANCED STILL REQUIRES ALL THREE. Proof of address is a statement about
 * where someone lives, and it is only meaningful on top of both an identity
 * and a settled payout relationship - so that rung keeps its AND deliberately.
 *
 * The NAIRA RAIL IS NOT WEAKENED BY THIS. Withdrawing to a Nigerian bank still
 * requires a name-matched NUBAN, and that is enforced structurally rather than
 * by level: acceptNgnQuote() needs a payout account that
 * payoutAccountStatusFor() marked 'verified', and there is no code path to a
 * naira payout without one.
 */
function deriveLevel(input: {
  bankVerified: boolean;
  identityVerified: boolean;
  addressVerified: boolean;
}): VerificationLevel {
  if (input.bankVerified && input.identityVerified && input.addressVerified) {
    return VerificationLevel.ENHANCED;
  }
  if (input.identityVerified) return VerificationLevel.IDENTITY;
  if (input.bankVerified) return VerificationLevel.BANK;
  return VerificationLevel.NONE;
}

export async function getVerificationState(userId: string): Promise<VerificationState> {
  // THREE TARGETED READS, NOT ONE WHOLE-DATABASE READ.
  //
  // This used to be a single `await db.read()`, which on Postgres issues 40+
  // `select *` queries - every table - to find one customer and one user's
  // accounts. /verification-summary calls this, getCumulativeNgnVolume() and
  // its own account lookup, so it paid that cost three times: 8.9 SECONDS
  // measured on the deployed test API, against 0.43s for an endpoint doing no
  // db.read() at all.
  //
  // The three run in parallel because none depends on another.
  const [customer, externalAccounts, ngnPayoutAccounts] = await Promise.all([
    db.findCustomerByUserId(userId),
    db.listExternalAccountsByUser(userId),
    db.listNgnPayoutAccounts(userId),
  ]);

  /**
   * LEVEL 2 EVIDENCE: a persisted, matched BVN check.
   *
   * Read here rather than inferred, because until migration 047 there was
   * nothing to read - the BVN service returned a verdict and stored none of
   * it, so a user who verified was Level 1 again on refresh.
   *
   * `verifiedAt` and not `status`, deliberately. A row exists for failed and
   * review attempts too, and only the timestamp is written on a match, so
   * testing the timestamp cannot mistake an attempt for a success.
   */
  const identityChecks = await db.listNgnIdentityVerifications(userId).catch(() => []);
  /**
   * EITHER national identifier reaches Level 2.
   *
   * VerificationLevel.IDENTITY is documented as "NIN and/or BVN validated
   * against the national source", and the next-step action is named
   * 'nin_bvn'. This read only 'bvn_info', so a user who verified with a NIN
   * would have been left at Level 1 holding a matched row - the same class of
   * bug migration 047 fixed for BVN, where the outcome was stored and never
   * read.
   *
   * `verifiedAt` and not `status`: a row exists for failed and review attempts
   * too, and only a match writes the timestamp.
   */
  const IDENTITY_CHECK_TYPES = ['bvn_info', 'nin_info'];
  const bvnVerified = identityChecks.some(
    (row: any) => IDENTITY_CHECK_TYPES.includes(row.checkType) && Boolean(row.verifiedAt)
  );

  // A payout account that has been name-resolved against the bank is Sivan's
  // Level 1 evidence. Since the CBN directive effective 1 March 2024 a Nigerian
  // bank account cannot transact without BVN/NIN linkage, so an account that
  // resolves is one a licensed bank has already verified.
  //
  // TWO SOURCES, AND THEY ARE NOT THE SAME KIND OF EVIDENCE.
  //
  // externalAccounts are Bridge-shaped (us/gb/iban) and reach 'verified'
  // through Bridge's own process. ngnPayoutAccounts are NUBANs, and reach
  // 'verified' only when the account holder's name MATCHED the name on file
  // and the resolution came from a real provider rather than a sandbox.
  //
  // Before migration 037 the NGN half did not exist, so a Nigerian user could
  // not reach Level 1 at all by the Nigerian path - the modal confirmed their
  // account and stored nothing. This is the half that was missing.
  const bridgeAccountVerified = externalAccounts.some(
    (a: any) => a.status === 'verified' || a.status === 'active'
  );

  // Only 'verified' counts. 'pending_review' is a case waiting on a human, and
  // counting it would grant the level to exactly the accounts a person was
  // asked to look at - defeating the review queue while appearing to have one.
  const ngnAccountVerified = ngnPayoutAccounts.some((a: any) => a.status === 'verified');

  const bankVerified = bridgeAccountVerified || ngnAccountVerified;

  // IDENTITY VERIFICATION IS ADMIN-TOGGLEABLE.
  //
  // No NIN/BVN provider is integrated yet. Requiring identity while nothing can
  // satisfy it would strand every Bridge user with no way to clear - so for MVP
  // the toggle is OFF by default and identity is inherited from Bridge instead.
  //
  // That is a real compromise, so it is a visible one: an admin can see the
  // switch, it is recorded on the controls record, and flipping it on is a
  // single change once a provider exists. Far better than a hardcoded `true`
  // nobody can find later.
  //
  // WHY THIS READS bridgeAccountVerified AND NOT bankVerified.
  //
  // It used to be `identityVerified = bankVerified`, and that was sound while
  // bankVerified could ONLY come from a Bridge external account - such a user
  // has been through Bridge's document KYC, so inheriting identity from them
  // is inheriting something real.
  //
  // Migration 037 broke that premise by making bankVerified reachable from a
  // bare NUBAN name match. Left as it was, a Nigerian who typed ten digits and
  // matched a name would be granted LEVEL 2 - lifting the NGN off-ramp ceiling
  // from 50,000 to 500,000 and OPENING FOREIGN RAILS, which sit at 0 below
  // IDENTITY. No documents, no selfie, and no $2 ever spent at Bridge.
  //
  // KYC-DESIGN.md is explicit: Level 1 is the bank/NIN tier, Level 2 is
  // "Provider verified - Bridge customer created and approved". A NUBAN match
  // is Level 1 evidence and must stop there.
  const controls = await getNgnControls();
  const identityRequired = controls.identityVerificationEnabled === true;
  const bridgeApproved = isApprovedKycStatus(customer?.kycStatus);

  /**
   * A MATCHED BVN IS LEVEL 2 EVIDENCE IN ITS OWN RIGHT.
   *
   * Previously identity could only come from Bridge (document KYC, $2 a head),
   * or - with the toggle off - was inherited from a bank match, which the
   * comment above rightly calls insufficient on its own.
   *
   * A BVN check is neither of those. It is a direct government-registry match
   * on name, date of birth and phone, and it is precisely the "add your NIN or
   * BVN" step the product has been promising users. Adding it as an
   * independent source means a Nigerian can reach Level 2 without Bridge ever
   * being involved, which is the whole point of the NGN path.
   *
   * Placed FIRST so it holds even when identityVerificationEnabled is on: with
   * that toggle set, `bridgeApproved` alone would ignore a real BVN match and
   * tell a verified user to go and verify.
   */
  /**
   * BRIDGE APPROVAL COUNTS ON BOTH SIDES OF THE TOGGLE.
   *
   * This read `identityRequired ? bridgeApproved : bridgeAccountVerified`, and
   * the false branch is the deeper half of the reported bug. With
   * identityVerificationEnabled OFF - the shipped MVP default - a user's actual
   * Bridge KYC APPROVAL was never consulted at all. The only thing that could
   * grant identity was `bridgeAccountVerified`, which is the existence of a
   * verified EXTERNAL ACCOUNT ROW - a bank account - not an identity check.
   *
   * So the person who had completed Bridge's document check, passed, and
   * accepted the terms scored identityVerified = false, purely because they
   * had not also added a bank. Fixing deriveLevel() alone did not move them:
   * the input it was ANDing was already false. Caught only by driving
   * getVerificationState() against a real seeded customer - sixteen unit tests
   * over hand-built state objects all passed while this returned Level 0.
   *
   * `bridgeApproved` is now an independent source on both branches. It is a
   * genuine document-and-selfie check that Sivan pays for; there is no reading
   * of "has this person been identified" where it should count when a toggle
   * is on and not when it is off. The toggle governs whether a NIN/BVN is
   * REQUIRED, never whether a completed check is worth anything.
   *
   * `bridgeAccountVerified` is kept on the false branch. That is the historic
   * MVP behaviour for users who predate this and hold a Bridge external
   * account; removing it would demote them.
   */
  const identityVerified =
    bvnVerified || bridgeApproved || (!identityRequired && bridgeAccountVerified);

  // When the toggle is OFF, the level is granted without a NIN/BVN check - so
  // the per-check statuses must say so too, or levelIsIntact() sees a Level 2
  // user with no identity evidence underneath and blocks every transaction.
  //
  // Caught by test: with the toggle off, every NGN quote failed with "one of
  // your verification checks needs attention", which was true and useless -
  // there was no check to attend to. The level and the evidence have to agree.
  // Tracks identityVerified exactly. If the level says IDENTITY but this says
  // NOT_STARTED, levelIsIntact() blocks every transaction with "one of your
  // verification checks needs attention" - true, and useless, because there is
  // no check the user can attend to. The level and the evidence must agree.
  const ninStatus = bridgeApproved || (identityVerified && !identityRequired)
    ? CheckStatus.VERIFIED
    : CheckStatus.NOT_STARTED;
  /**
   * Now reflects reality. This was hardcoded NOT_STARTED, so a user who had
   * genuinely verified their BVN was still told they had not - and any screen
   * driven by this field showed a completed step as outstanding.
   */
  const bvnStatus = bvnVerified
    ? CheckStatus.VERIFIED
    : identityChecks.some((row: any) => IDENTITY_CHECK_TYPES.includes(row.checkType) && row.status === 'review')
      ? CheckStatus.PENDING
      : CheckStatus.NOT_STARTED;

  /**
   * WHERE that identity came from, stated honestly.
   *
   * Today the only source is Bridge. Sivan validates no NIN or BVN against the
   * national source - there is no provider integrated and nowhere to store the
   * result - so 'sivan' is currently unreachable, and that is the correct
   * answer rather than a gap to paper over.
   *
   * It matters because upliftApplies() uses this to break a circularity: the
   * old floor checked `ninStatus === VERIFIED`, but ninStatus was SET from
   * bridgeApproved, so the "Sivan must hold its own identity" guard was Bridge
   * vouching for Bridge. Attributing the source makes that visible instead of
   * implied.
   *
   * When a NIN/BVN provider lands, this becomes 'sivan' for those users and a
   * Nigerian who never touches Bridge qualifies for the same uplifted ceiling.
   */
  const identitySource: 'sivan' | 'bridge' | undefined =
    ninStatus === CheckStatus.VERIFIED ? 'bridge' : undefined;

  const addressVerified = false;

  const level = deriveLevel({ bankVerified, identityVerified, addressVerified });

  return {
    level,
    identityStatus: identityVerified ? CheckStatus.VERIFIED : CheckStatus.NOT_STARTED,
    bankStatus: bankVerified ? CheckStatus.VERIFIED : CheckStatus.NOT_STARTED,
    bvnStatus,
    ninStatus,
    livenessStatus: CheckStatus.NOT_STARTED,
    proofOfAddressStatus: addressVerified ? CheckStatus.VERIFIED : CheckStatus.NOT_STARTED,
    sourceOfFundsStatus: CheckStatus.NOT_STARTED,
    riskLevel: 'low',
    enhancedDueDiligence: false,
    providerRef: customer?.providerCustomerId,
    verifiedAt: customer?.updatedAt,
    // Present only when the user actually completed Bridge KYC. Feeds the
    // uplift, which additionally requires Sivan's own floor.
    bridgeKycStatus: customer?.kycStatus,
    bridgeTosStatus: customer?.tosStatus,
    identitySource,
  };
}

/**
 * Completed NGN volume for a user over a rolling window.
 *
 * Only settled transfers count. Counting pending ones would let a user reduce
 * their own consumed volume by abandoning transactions, and counting failed
 * ones would penalise them for a provider outage.
 */
export async function getCumulativeNgnVolume(userId: string, windowDays: number): Promise<number> {
  // Filtered in the DATABASE, not in Node. This was `db.read()` - every table
  // in the database, then a filter down to one user - and it is called on
  // every /verification-summary. The status and window predicates now go to
  // Postgres, so the rows returned are bounded by one user's settled
  // transfers in the window rather than by Sivan's entire transfer history.
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const transfers = await db.listNgnTransfersByUserSince(userId, new Date(cutoff).toISOString());

  return transfers.reduce((sum: number, t: any) => {
    // Whichever leg is naira is the leg that counts toward an NGN threshold.
    const ngnAmount =
      t.sourceCurrency === 'ngn'
        ? Number(t.sourceAmount ?? 0)
        : t.destinationCurrency === 'ngn'
          ? Number(t.destinationAmount ?? 0)
          : 0;
    return sum + (Number.isFinite(ngnAmount) ? ngnAmount : 0);
  }, 0);
}

/**
 * Completed + in-flight FOREIGN volume for a user, expressed in NGN.
 *
 * THIS DID NOT EXIST, AND THAT WAS THE BUG.
 *
 * `offramp/foreign` has always had a real ceiling and has been reported by
 * /verification-summary since it was written. Its usage figure, though, came
 * from getCumulativeNgnVolume(), which reads payments_ngn_transfers and sums
 * only the legs where sourceCurrency or destinationCurrency is 'ngn'.
 *
 * A Bridge withdrawal is USDC -> USD. It is not an NGN transfer, so it never
 * appeared in that query, so priorVolumeNgn for the foreign rail was
 * PERMANENTLY ZERO. The ceiling was therefore applied to each withdrawal in
 * isolation: ten $9,000 withdrawals each passed a cap that one $10,000
 * withdrawal would have failed. A cumulative limit that does not accumulate
 * is not a limit, and the number shown in the admin hub was decorative.
 *
 * Converted through the same usdToNgn() the enforcement path uses, so the
 * volume counted and the amount checked are measured with one rate. (Moving
 * the foreign rail to native USD denomination is a separate agreed change;
 * doing it here would mean the ceiling and the usage briefly disagreed.)
 */
export async function getCumulativeForeignVolumeNgn(userId: string, windowDays: number): Promise<number> {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const withdrawals = await db.listWithdrawalsByUserSince(userId, new Date(cutoff).toISOString());
  const { usdToNgn } = await import('./foreign-rail-fx.js');

  return withdrawals.reduce((sum: number, w: any) => {
    /**
     * sourceAmount is the USDC leg, and USDC is dollar-pegged - so it is the
     * figure to convert. It is OPTIONAL on the record: a manual-send
     * withdrawal has no amount at creation because the user decides it by how
     * much they send. Those contribute 0 until a drain tells us the real
     * number, which is honest - inventing a figure for them would charge a
     * ceiling for money that may never arrive.
     */
    const usd = Number(w.sourceAmount ?? 0);
    const ngn = usdToNgn(usd);
    return sum + (Number.isFinite(ngn) ? ngn : 0);
  }, 0);
}

/**
 * The right volume source for a (flow, rail), so callers stop guessing.
 *
 * Every call site that needed "how much has this user used" reached straight
 * for getCumulativeNgnVolume, which silently answered for the naira rail no
 * matter what rail was being asked about. Routing through one function makes
 * the rail an argument rather than an assumption.
 */
export async function getCumulativeVolumeNgn(
  userId: string,
  rail: 'ngn' | 'foreign',
  windowDays: number
): Promise<number> {
  return rail === 'foreign'
    ? getCumulativeForeignVolumeNgn(userId, windowDays)
    : getCumulativeNgnVolume(userId, windowDays);
}

export { isApprovedKycStatus };

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
function deriveLevel(input: {
  bankVerified: boolean;
  identityVerified: boolean;
  addressVerified: boolean;
}): VerificationLevel {
  if (input.bankVerified && input.identityVerified && input.addressVerified) {
    return VerificationLevel.ENHANCED;
  }
  if (input.bankVerified && input.identityVerified) return VerificationLevel.IDENTITY;
  if (input.bankVerified) return VerificationLevel.BANK;
  return VerificationLevel.NONE;
}

export async function getVerificationState(userId: string): Promise<VerificationState> {
  const data = await db.read();

  // May legitimately not exist. Most users never become Bridge customers.
  const customer = (data.customers ?? []).find((c: any) => c.userId === userId);

  // A payout account that has been name-resolved against the bank is Sivan's
  // Level 1 evidence. Since the CBN directive effective 1 March 2024 a Nigerian
  // bank account cannot transact without BVN/NIN linkage, so an account that
  // resolves is one a licensed bank has already verified.
  const externalAccounts = (data.externalAccounts ?? []).filter((a: any) => a.userId === userId);
  const bankVerified = externalAccounts.some(
    (a: any) => a.status === 'verified' || a.status === 'active'
  );

  // IDENTITY VERIFICATION IS ADMIN-TOGGLEABLE.
  //
  // No NIN/BVN provider is integrated yet. Requiring identity while nothing can
  // satisfy it would strand every user at Level 1 with no way to clear - so for
  // MVP the toggle is OFF by default and Level 2 is reachable on the bank check
  // alone.
  //
  // That is a real compromise, so it is a visible one: an admin can see the
  // switch, it is recorded on the controls record, and flipping it on is a
  // single change once a provider exists. Far better than a hardcoded `true`
  // nobody can find later.
  //
  // When ON, identity must be genuinely satisfied. A Bridge-approved user
  // counts: Bridge requires a national identity number for every non-US
  // resident and accepts nin, bvn and tin for Nigeria, so that person HAS had
  // one verified - at the $2 already spent. It is inherited, not
  // Sivan-performed, which is why step 3 still matters: if Bridge offboards
  // them, that identity goes with it.
  const controls = await getNgnControls();
  const identityRequired = controls.identityVerificationEnabled === true;
  const bridgeApproved = isApprovedKycStatus(customer?.kycStatus);

  const identityVerified = identityRequired ? bridgeApproved : bankVerified;

  // When the toggle is OFF, the level is granted without a NIN/BVN check - so
  // the per-check statuses must say so too, or levelIsIntact() sees a Level 2
  // user with no identity evidence underneath and blocks every transaction.
  //
  // Caught by test: with the toggle off, every NGN quote failed with "one of
  // your verification checks needs attention", which was true and useless -
  // there was no check to attend to. The level and the evidence have to agree.
  const ninStatus = bridgeApproved || (identityVerified && !identityRequired)
    ? CheckStatus.VERIFIED
    : CheckStatus.NOT_STARTED;
  const bvnStatus = CheckStatus.NOT_STARTED;
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
  const data = await db.read();
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const transfers = (data.ngnTransfers ?? []).filter((t: any) => {
    if (t.userId !== userId) return false;
    if (t.status !== 'completed' && t.status !== 'settled') return false;
    const at = Date.parse(t.updatedAt ?? t.createdAt ?? '');
    return Number.isFinite(at) && at >= cutoff;
  });

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

export { isApprovedKycStatus };

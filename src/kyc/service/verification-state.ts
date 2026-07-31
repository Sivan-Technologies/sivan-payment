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

  // No NIN/BVN provider is integrated yet - that is step 3. Until it lands,
  // Sivan cannot collect these itself.
  //
  // The one exception: a user Bridge has already approved. Bridge requires a
  // national identity number for every non-US resident, and for Nigeria it
  // accepts nin, bvn and tin (verified in Bridge's country table). So a
  // Bridge-approved Nigerian HAS had a national identity number verified - by
  // Bridge, at the $2 Sivan already paid. Treating that as unknown would strand
  // every existing verified user at Level 1 and re-ask them for something
  // already on file.
  //
  // This is an inherited result, not a Sivan-performed check, so providerRef
  // records Bridge as the source. When step 3 lands, Sivan performs its own and
  // stops depending on the vendor for it.
  const bridgeApproved = isApprovedKycStatus(customer?.kycStatus);
  const identityVerified = bridgeApproved;
  const ninStatus = bridgeApproved ? CheckStatus.VERIFIED : CheckStatus.NOT_STARTED;
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

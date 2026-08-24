export type KycLevelMatchStatus = 'matched' | 'review' | 'failed';

export interface BvnInfoMatchInput {
  bvn: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  mobileNo: string;
}

export interface BvnAccountMatchInput {
  bvn: string;
  bankCode: string;
  accountNumber: string;
  accountName: string;
}

/**
 * A NIN check.
 *
 * Names are OPTIONAL because the upstream NIMC lookup does no matching of its
 * own - IdentifyOrg cross-matches for us when we supply them. Sending nothing
 * still returns the record on file, which is a lookup rather than a
 * verification, so callers that care about identity must pass the names.
 *
 * There is no phone field: unlike BVN, the NIN endpoint does not require one.
 */
export interface NinInfoMatchInput {
  nin: string;
  firstName?: string;
  lastName?: string;
}

export interface KycLevelMatchResult {
  provider: string;
  status: KycLevelMatchStatus;
  message: string;
  bvnLast4: string;
  matchedFields?: Record<string, boolean | string>;
  providerReference?: string;
  raw?: unknown;
}

export interface KycLevelProviderHealth {
  provider: string;
  available: boolean;
  mode: 'mock' | 'live';
  message?: string;
  checkedAt: string;
}

export interface KycLevelProvider {
  name: string;
  verifyBvnIdentity(input: BvnInfoMatchInput): Promise<KycLevelMatchResult>;
  verifyBvnBankAccount(input: BvnAccountMatchInput): Promise<KycLevelMatchResult>;
  /**
   * OPTIONAL, because only one vendor offers it.
   *
   * Monnify and Flutterwave have no NIN endpoint. Declaring this required
   * would force two providers to implement a throwing stub, and the failover
   * chain would then have to tell "throws because unsupported" apart from
   * "throws because down" - the exact confusion capabilities() exists to
   * remove. Absent means unsupported, and the chain skips it.
   */
  verifyNinIdentity?(input: NinInfoMatchInput): Promise<KycLevelMatchResult>;
  /**
   * What this vendor can actually answer. Absent means "assume capable", so
   * providers written before this existed behave exactly as they did.
   */
  capabilities?(): { bvnIdentity: boolean; bvnBankAccount: boolean; ninIdentity?: boolean };
  health(): Promise<KycLevelProviderHealth>;
}

export function bvnLast4(bvn: string) {
  return String(bvn || '').replace(/\D/g, '').slice(-4);
}

/**
 * A NIN is as sensitive as a BVN and is stored the same way: last four only.
 * Named separately from bvnLast4 so a reader of a call site can see WHICH
 * identifier is being truncated.
 */
export function ninLast4(nin: string) {
  return String(nin || '').replace(/\D/g, '').slice(-4);
}

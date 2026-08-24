import crypto from 'node:crypto';
import { z } from 'zod';
import { badRequest, forbidden } from '../../shared/errors.js';
import { db } from '../../database/json-database.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { id, nowIso } from '../../shared/id.js';
import { env } from '../../config/env.js';
import { getKycLevelProvider } from '../providers/kyc-level-provider-registry.js';
import type { KycLevelMatchResult } from '../providers/kyc-level-provider.js';

function cleanDigits(value: unknown) {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeDateOfBirth(value: unknown) {
  const raw = String(value ?? '').trim();
  const iso = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`;
  const local = raw.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (local) return `${local[1]}-${local[2]}-${local[3]}`;
  return raw;
}

export const bvnInfoMatchSchema = z.object({
  bvn: z.preprocess(cleanDigits, z.string().regex(/^\d{11}$/, 'BVN must be 11 digits')),
  firstName: z.preprocess((value) => String(value ?? '').trim(), z.string().min(2).max(80)),
  lastName: z.preprocess((value) => String(value ?? '').trim(), z.string().min(2).max(80)),
  dateOfBirth: z.preprocess(normalizeDateOfBirth, z.string().regex(/^\d{2}-\d{2}-\d{4}$/, 'dateOfBirth must be dd-MM-yyyy')),
  mobileNo: z.preprocess(cleanDigits, z.string().min(8).max(20))
});

/**
 * A NIN check. Names are REQUIRED here even though the vendor treats them as
 * optional: without them the upstream returns the record on file and there is
 * nothing to cross-match against, which is a lookup, not a verification.
 * Granting Level 2 on "this NIN exists" would hand a NGN 5,000,000 ceiling to
 * anyone who typed eleven digits belonging to someone else.
 */
export const ninInfoMatchSchema = z.object({
  nin: z.preprocess(cleanDigits, z.string().regex(/^\d{11}$/, 'NIN must be 11 digits')),
  firstName: z.preprocess((value) => String(value ?? '').trim(), z.string().min(2).max(80)),
  lastName: z.preprocess((value) => String(value ?? '').trim(), z.string().min(2).max(80))
});

export const bvnAccountMatchSchema = z.object({
  bvn: z.preprocess(cleanDigits, z.string().regex(/^\d{11}$/, 'BVN must be 11 digits')),
  bankCode: z.string().min(2).max(20),
  accountNumber: z.preprocess(cleanDigits, z.string().min(8).max(20)),
  accountName: z.string().min(2).max(160)
});

const attempts = new Map<string, { count: number; resetAt: number }>();
const maxAttempts = 3;
const windowMs = 24 * 60 * 60 * 1000;

function attemptKey(userId: string, kind: 'bvn_info' | 'bvn_bank' | 'nin_info', suffix = '') {
  return `${userId}:${kind}:${suffix}`;
}

function enforceAttemptLimit(key: string) {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > maxAttempts) throw forbidden('Too many verification attempts. Please try again later or contact Sivan Support.');
}

function toCustomerSafe(result: KycLevelMatchResult, level: 'ngn_level_2' | 'ngn_bank_ownership') {
  /**
   * "WAITING FOR YOU" IS NOT "WAITING FOR US".
   *
   * Both arrive as status 'review', and collapsing them into one message -
   * "Your verification needs manual review" - is wrong in the way that costs
   * a conversion. Flutterwave's BVN flow is consent-based: the CBN requires
   * the BVN owner to approve, so the first call returns a NIBSS URL the
   * customer has to open and enter an OTP on. Nobody at Sivan is reviewing
   * anything; the user simply has not finished, and telling them to wait for
   * a human means they never will.
   *
   * The consent URL was also being dropped here entirely. The provider set it
   * on matchedFields.consentUrl, this function returned matchedFields, and
   * the frontend rendered only `message` - so the one link that could finish
   * the check never reached the screen. The flow could start and could never
   * complete.
   */
  const consentUrl = typeof result.matchedFields?.consentUrl === 'string'
    ? result.matchedFields.consentUrl
    : undefined;

  return {
    status: result.status,
    level,
    provider: result.provider,
    bvnLast4: result.bvnLast4,
    message: result.status === 'matched'
      ? level === 'ngn_level_2' ? 'Your Nigerian identity check was successful.' : 'Your bank account was matched successfully.'
      : result.status === 'review'
        ? consentUrl
          ? 'Approve the request with your BVN provider to finish. This opens a secure page from our partner.'
          : 'Your verification needs manual review.'
        : 'Your verification could not be matched. Check your details or contact Sivan Support.',
    matchedFields: result.matchedFields,
    providerReference: result.providerReference,
    /**
     * Lifted out of matchedFields to the top level deliberately. A client
     * should not have to know that a URL is hiding inside a bag of match
     * booleans in order to render the button that completes the flow.
     */
    consentUrl,
    /** True when the next move belongs to the USER, not to a Sivan reviewer. */
    awaitingUserConsent: Boolean(consentUrl)
  };
}

/**
 * Hash a BVN for cross-account comparison, never for retrieval.
 *
 * Peppered with USER_JWT_SECRET rather than salted per row. A per-row salt is
 * the right default for passwords and the WRONG one here: the entire purpose
 * is to notice the same BVN appearing under two accounts, and per-row salts
 * make identical inputs hash differently, which defeats it.
 *
 * The pepper means a stolen database alone cannot be brute-forced against the
 * 11-digit BVN space - which is small enough (10^11) to enumerate offline
 * without one.
 */
function hashBvn(bvn: string): string {
  return crypto
    .createHmac('sha256', env.USER_JWT_SECRET)
    .update(String(bvn).replace(/\D/g, ''))
    .digest('hex');
}

export async function verifyNgnBvnIdentity(userId: string, input: z.infer<typeof bvnInfoMatchSchema>) {
  enforceAttemptLimit(attemptKey(userId, 'bvn_info'));
  const provider = getKycLevelProvider();
  const result = await provider.verifyBvnIdentity(input);

  /**
   * PERSIST THE OUTCOME. Without this the whole feature is a no-op.
   *
   * The provider, service and route all existed and worked - a user could
   * submit and Monnify would answer 'matched' - but grep showed this file
   * touching the database zero times. The result lived only in the HTTP
   * response, so a refresh put the user back at Level 1 with no record they
   * had ever verified. Same shape as the deposit confirmer: machinery built,
   * outcome never written, feature unable to take effect.
   *
   * Every outcome is stored, not just success. A 'review' is a case a human
   * must pick up and there is no queue without a row; a 'failed' is what
   * support reads when a user says "I tried and it did not work".
   */
  const at = nowIso();
  const bvnHash = hashBvn(input.bvn);

  const record = await db.upsertNgnIdentityVerification({
    id: id('ngnkyc'),
    userId,
    checkType: 'bvn_info',
    status: result.status,
    provider: result.provider,
    providerReference: result.providerReference,
    bvnLast4: result.bvnLast4,
    bvnHash,
    matchedFields: result.matchedFields,
    // ONLY a match sets this, and only this grants Level 2.
    verifiedAt: result.status === 'matched' ? at : undefined,
    createdAt: at,
    updatedAt: at
  });

  /**
   * ONE BVN, SEVERAL ACCOUNTS - the pattern this check exists to catch.
   *
   * Recorded rather than blocked. A shared BVN has innocent explanations (a
   * user who lost access to an old email and re-registered) and refusing
   * automatically would strand them with no route back. Flagged at warning
   * severity so it is findable, and left for a human.
   */
  if (result.status === 'matched') {
    const others = await db.countUsersWithBvnHash(bvnHash, userId).catch(() => 0);
    if (others > 0) {
      await createAuditLog({
        actorType: 'system',
        action: 'kyc.bvn_reused_across_accounts',
        resourceType: 'ngn_identity_verification',
        resourceId: record.id,
        severity: 'warning',
        metadata: { userId, bvnLast4: result.bvnLast4, otherAccounts: others }
      }).catch(() => undefined);
    }
  }

  await createAuditLog({
    actorType: 'user',
    actorId: userId,
    action: 'kyc.ngn_bvn_verification',
    resourceType: 'ngn_identity_verification',
    resourceId: record.id,
    severity: result.status === 'matched' ? 'info' : 'warning',
    // The BVN is deliberately absent. Only its last four digits and the
    // provider's verdict are recorded - an audit log is not a place to leak
    // the identifier the table itself refuses to store.
    metadata: {
      status: result.status,
      provider: result.provider,
      bvnLast4: result.bvnLast4,
      providerReference: result.providerReference ?? null
    }
  }).catch(() => undefined);

  return toCustomerSafe(result, 'ngn_level_2');
}

/**
 * FINISH A CONSENT-BASED BVN CHECK AFTER THE CUSTOMER HAS APPROVED.
 *
 * THE MISSING HALF. FlutterwaveKycLevelProvider.completeBvnConsent() was
 * written, correct, and had NO CALLER anywhere in the codebase - grep found it
 * only in its own file. It is not on the KycLevelProvider interface either, so
 * nothing could reach it generically.
 *
 * The consequence: on Flutterwave a user could START a BVN check and never
 * finish one. The first call stores a 'review' row with the provider's
 * reference, the customer approves on the NIBSS page, and then nothing ever
 * asked Flutterwave for the result. The row sat at 'review' forever and the
 * user stayed at Level 1.
 *
 * NO BVN IS RE-SUBMITTED HERE, and that is the point of storing
 * providerReference. Asking the user to type their BVN again after they have
 * already approved would be a second chance to typo the thing that is now
 * settled, and a second copy of it crossing the wire for no reason. The
 * reference is read from THEIR OWN pending row, so a caller cannot complete
 * someone else's consent by guessing a reference.
 *
 * Idempotent by construction: it re-reads the provider's current answer and
 * upserts the same (userId, checkType) row, so polling it twice cannot create
 * two verifications or grant Level 2 twice.
 */
export async function completeNgnBvnConsent(userId: string) {
  const rows = await db.listNgnIdentityVerifications(userId);
  const pending = rows.find((row) => row.checkType === 'bvn_info');

  if (!pending) {
    throw forbidden('Start a BVN check before trying to finish one.');
  }
  /**
   * Already done - return the stored outcome rather than calling the provider
   * again. A user who refreshes the return page must not burn an attempt or
   * pay for a second lookup.
   */
  if (pending.verifiedAt) {
    return {
      status: 'matched' as const,
      level: 'ngn_level_2' as const,
      provider: pending.provider,
      bvnLast4: pending.bvnLast4,
      message: 'Your Nigerian identity check was successful.',
      matchedFields: pending.matchedFields,
      providerReference: pending.providerReference,
      consentUrl: undefined,
      awaitingUserConsent: false
    };
  }
  if (!pending.providerReference) {
    throw forbidden('This verification has no provider reference to complete. Start a new check.');
  }

  const provider: any = providerOverrideForTests ?? getKycLevelProvider();
  if (typeof provider.completeBvnConsent !== 'function') {
    // Monnify and the mock answer synchronously and have nothing to complete.
    throw forbidden('This verification provider does not use a separate approval step.');
  }

  const result: KycLevelMatchResult = await provider.completeBvnConsent(pending.providerReference);

  const at = nowIso();
  const record = await db.upsertNgnIdentityVerification({
    ...pending,
    status: result.status,
    provider: result.provider,
    providerReference: result.providerReference ?? pending.providerReference,
    bvnLast4: result.bvnLast4 ?? pending.bvnLast4,
    // The hash is carried from the ORIGINAL submission. completeBvnConsent
    // never sees the BVN, so recomputing here would blank the one column the
    // cross-account fraud check reads.
    bvnHash: pending.bvnHash,
    matchedFields: result.matchedFields ?? pending.matchedFields,
    verifiedAt: result.status === 'matched' ? at : undefined,
    updatedAt: at
  });

  // Same fraud signal the initial path records, because this is now the path
  // on which a Flutterwave user actually becomes verified.
  if (result.status === 'matched' && record.bvnHash) {
    const others = await db.countUsersWithBvnHash(record.bvnHash, userId).catch(() => 0);
    if (others > 0) {
      await createAuditLog({
        actorType: 'system',
        action: 'kyc.bvn_reused_across_accounts',
        resourceType: 'ngn_identity_verification',
        resourceId: record.id,
        severity: 'warning',
        metadata: { userId, bvnLast4: record.bvnLast4, otherAccounts: others }
      }).catch(() => undefined);
    }
  }

  await createAuditLog({
    actorType: 'user',
    actorId: userId,
    action: 'kyc.ngn_bvn_consent_completed',
    resourceType: 'ngn_identity_verification',
    resourceId: record.id,
    severity: result.status === 'matched' ? 'info' : 'warning',
    metadata: {
      status: result.status,
      provider: result.provider,
      bvnLast4: result.bvnLast4,
      providerReference: record.providerReference ?? null
    }
  }).catch(() => undefined);

  return toCustomerSafe(result, 'ngn_level_2');
}

/**
 * Verify a NIN. A SECOND ROUTE TO LEVEL 2, not a higher level.
 *
 * Mirrors verifyNgnBvnIdentity deliberately - same rate limit shape, same
 * persistence, same audit trail - because the two are alternatives for the
 * same rung and anything they do differently becomes a discrepancy an operator
 * has to reason about later.
 *
 * The one real difference: there is no cross-account hash. hashBvn() exists to
 * notice one BVN under several accounts, and the equivalent for NIN would need
 * its own column and its own migration. Recording a NIN in the bvnHash column
 * would silently corrupt that check by mixing two identifier spaces - a NIN
 * and a BVN that hash into the same column would look like a reused BVN. Left
 * out rather than done wrongly; noted so it is a known gap, not an oversight.
 */
export async function verifyNgnNinIdentity(userId: string, input: z.infer<typeof ninInfoMatchSchema>) {
  enforceAttemptLimit(attemptKey(userId, 'nin_info'));
  const provider = getKycLevelProvider();

  /**
   * No vendor in the chain offers NIN -> say so plainly.
   *
   * The failover chain skips providers that cannot answer, so with only
   * Monnify or Flutterwave configured this would otherwise surface as a
   * confusing "all providers failed" when in truth none was ever asked.
   */
  const verifyNin = (provider as any).verifyNinIdentity;
  if (typeof verifyNin !== 'function') {
    throw badRequest('NIN verification is not available with the current identity provider.');
  }

  const result: KycLevelMatchResult = await verifyNin.call(provider, input);

  const at = nowIso();
  const record = await db.upsertNgnIdentityVerification({
    id: id('ngnkyc'),
    userId,
    checkType: 'nin_info',
    status: result.status,
    provider: result.provider,
    providerReference: result.providerReference,
    // The provider put the NIN's last four here; checkType says which
    // identifier it belongs to. See the note on the column.
    bvnLast4: result.bvnLast4,
    matchedFields: result.matchedFields,
    // ONLY a match sets this, and only this grants Level 2.
    verifiedAt: result.status === 'matched' ? at : undefined,
    createdAt: at,
    updatedAt: at
  });

  await createAuditLog({
    actorType: 'user',
    actorId: userId,
    action: 'kyc.ngn_nin_verification',
    resourceType: 'ngn_identity_verification',
    resourceId: record.id,
    severity: result.status === 'matched' ? 'info' : 'warning',
    // The NIN itself is deliberately absent, exactly as the BVN is. An audit
    // log is not a place to leak the identifier the table refuses to store.
    metadata: {
      status: result.status,
      provider: result.provider,
      ninLast4: result.bvnLast4,
      providerReference: result.providerReference ?? null
    }
  }).catch(() => undefined);

  return toCustomerSafe(result, 'ngn_level_2');
}

export async function verifyNgnBvnBankAccount(userId: string, input: z.infer<typeof bvnAccountMatchSchema>) {
  enforceAttemptLimit(attemptKey(userId, 'bvn_bank', `${input.bankCode}:${input.accountNumber}`));
  const provider = getKycLevelProvider();
  const result = await provider.verifyBvnBankAccount(input);
  return toCustomerSafe(result, 'ngn_bank_ownership');
}

export async function getNgnKycProviderHealth() {
  return getKycLevelProvider().health();
}

/**
 * TEST SEAMS. Not used by any production path.
 *
 * The consent flow cannot be exercised against the real vendor - it needs a
 * human on a NIBSS page with an OTP - so the only way to prove the completion
 * path is to substitute the provider. Kept to two narrow exports rather than
 * loosening getKycLevelProvider() itself, so nothing in the running system can
 * reach them by accident.
 */
let providerOverrideForTests: any = null;

export function __setKycProviderForTests(provider: any) {
  providerOverrideForTests = provider;
}

export const __toCustomerSafeForTests = toCustomerSafe;

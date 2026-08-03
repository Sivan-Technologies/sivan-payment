/**
 * Save a Nigerian payout account, matched against the name on file.
 *
 * THE GAP THIS CLOSES
 *
 * Before this, /api/ngn/bank-account/resolve returned a name, the modal showed
 * it, the user clicked "Yes, that is me" and NOTHING WAS STORED. The Nigerian
 * path could not grant Level 1 because there was no record to grant it from,
 * and the name matcher - 42 assertions, fully tested - was never called by
 * anything. The strongest evidence in the system was computed nowhere.
 *
 * The flow is now: resolve -> match -> persist a verdict -> derive the level
 * from that verdict.
 *
 * WHY THE MATCH RUNS SERVER SIDE
 *
 * The client already resolves the account to show the name. It would be easy
 * to let it post the resolved name back and save that. It must not: a client
 * can post any accountName it likes, so trusting the submitted value lets a
 * user hand over a stranger's account number together with their own name and
 * inherit Level 1 on it. The account is re-resolved here, against the
 * provider, and the name that is matched is the one the BANK returned.
 */

import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import type { NgnPayoutAccountRecord } from '../../database/types.js';
import { matchAccountName, nameMatchGrantsVerification } from '../../kyc/service/name-match.js';
import { resolveNgnBankAccount } from './ngn-banks.service.js';
import { env } from '../../config/env.js';
import { createAuditLog } from '../../audit/audit.service.js';

export const saveNgnPayoutAccountSchema = z.object({
  userId: z.string().min(1),
  bankId: z.string().min(1),
  // A NUBAN is exactly ten digits. Rejected here as well as in the resolver so
  // a malformed number never reaches a paid provider call.
  accountNumber: z.string().regex(/^\d{10}$/, 'A Nigerian account number is exactly 10 digits.')
});

/** The provider whose bank directory a saved bankId belongs to. */
function activeProviderName(): string {
  return env.NGN_PROVIDER ?? 'mock';
}

/**
 * Decide the stored status from the verdict and the provenance.
 *
 * Two independent gates, and BOTH must pass to reach 'verified':
 *
 *   1. The verdict must be a full match. A 'review' is pending a human, not
 *      verified - treating pending as verified defeats the check entirely.
 *   2. The resolution must be trustworthy. Breet's sandbox returns a plausible
 *      name for ANY account number (verified live: 0000000000 at UBA returned
 *      "Samuel Udochukwu"), so a match there is a match against a fabrication.
 *
 * Gate 2 is the one that is easy to forget, and forgetting it means every
 * developer and every sandbox tester silently holds real Level 1.
 */
export function payoutAccountStatusFor(
  verdict: 'match' | 'review' | 'mismatch',
  resolutionTrustworthy: boolean
): 'pending_review' | 'verified' | 'rejected' {
  if (verdict === 'mismatch') return 'rejected';
  if (!nameMatchGrantsVerification(verdict)) return 'pending_review';
  // A clean match on an untrustworthy resolution is not evidence. It goes to a
  // human rather than being rejected, because the USER did nothing wrong - the
  // environment did.
  if (!resolutionTrustworthy) return 'pending_review';
  return 'verified';
}

export async function saveNgnPayoutAccount(input: z.infer<typeof saveNgnPayoutAccountSchema>) {
  const user = await db.findUserById(input.userId);
  if (!user) throw notFound('User');

  const declaredName = String(user.fullName ?? '').trim();
  if (!declaredName) {
    // Without a name on file there is nothing to match against, so the account
    // could never be evidence about this person.
    throw badRequest('Add your full name to your profile before adding a bank account.');
  }

  // Re-resolved server side. The client's copy is display only - see the file
  // header for why trusting it would be the whole vulnerability.
  const resolved = await resolveNgnBankAccount(input.bankId, input.accountNumber, 'ngn');

  const match = matchAccountName(declaredName, resolved.accountName);
  const status = payoutAccountStatusFor(match.verdict, resolved.trustworthy);
  const now = nowIso();

  const record: NgnPayoutAccountRecord = {
    id: id('ngnacct'),
    userId: input.userId,
    provider: activeProviderName(),
    bankId: input.bankId,
    bankName: resolved.bankName,
    accountNumber: resolved.accountNumber,
    accountName: resolved.accountName,
    declaredName,
    matchVerdict: match.verdict,
    matchScore: match.score,
    matchExplanation: match.explanation,
    matchedTokens: match.matchedTokens,
    unmatchedBankTokens: match.unmatchedBankTokens,
    resolutionTrustworthy: resolved.trustworthy,
    status,
    raw: resolved,
    createdAt: now,
    updatedAt: now
  };

  const saved = await db.upsertNgnPayoutAccountRecord(record);

  // A name mismatch is the signal this whole feature exists to produce. It has
  // to be visible to compliance even if nobody ever opens the review queue.
  await createAuditLog({
    action: 'ngn.payout_account.name_match',
    resourceType: 'ngn_payout_account',
    resourceId: saved.id,
    actorType: 'system',
    actorId: 'name-matcher',
    // A mismatch means someone submitted an account held by another person.
    // That must not be filed at the same severity as a routine save.
    severity: match.verdict === 'mismatch' ? 'warning' : 'info',
    metadata: {
      userId: input.userId,
      verdict: match.verdict,
      score: match.score,
      status,
      resolutionTrustworthy: resolved.trustworthy,
      explanation: match.explanation
    }
  }).catch(() => undefined);

  return saved;
}

export async function listNgnPayoutAccounts(userId: string) {
  return db.listNgnPayoutAccounts(userId);
}

/**
 * Does this user hold a payout account that clears Level 1?
 *
 * The single question verification-state asks. Deliberately strict: only
 * 'verified' counts, so a pending review grants nothing.
 */
export async function hasVerifiedNgnPayoutAccount(userId: string): Promise<boolean> {
  const accounts = await db.listNgnPayoutAccounts(userId);
  return accounts.some((account) => account.status === 'verified');
}

export const reviewNgnPayoutAccountSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  reviewedBy: z.string().min(1),
  note: z.string().max(1000).optional()
});

/**
 * A human decision on a queued account.
 *
 * Only 'pending_review' rows are decidable. Re-approving an already-verified
 * account is a no-op worth refusing loudly: it usually means two operators are
 * working the same queue, and silently accepting the second decision hides
 * that.
 */
export async function reviewNgnPayoutAccount(
  accountId: string,
  input: z.infer<typeof reviewNgnPayoutAccountSchema>
) {
  const account = await db.findNgnPayoutAccountById(accountId);
  if (!account) throw notFound('NGN payout account');

  if (account.status !== 'pending_review') {
    throw badRequest(
      `This account is already ${account.status.replace('_', ' ')} and cannot be reviewed again.`
    );
  }

  const now = nowIso();
  const updated: NgnPayoutAccountRecord = {
    ...account,
    status: input.decision === 'approve' ? 'verified' : 'rejected',
    reviewedBy: input.reviewedBy,
    reviewedAt: now,
    reviewNote: input.note,
    updatedAt: now
  };

  const saved = await db.upsertNgnPayoutAccountRecord(updated);

  await createAuditLog({
    action: `ngn.payout_account.${input.decision}`,
    resourceType: 'ngn_payout_account',
    resourceId: saved.id,
    actorType: 'admin',
    actorId: input.reviewedBy,
    metadata: {
      userId: account.userId,
      previousVerdict: account.matchVerdict,
      score: account.matchScore,
      note: input.note
    }
  }).catch(() => undefined);

  return saved;
}

/** The admin review queue: accounts a human still has to decide. */
/**
 * WHY IS THIS CASE HERE?
 *
 * Two completely different situations both land in this queue and they need
 * completely different handling, but the row looked identical for both:
 *
 *   'name'        the bank's name did not cleanly match the declared one.
 *                 A real judgement call - middle names, married names,
 *                 transliterations, or a stranger's account.
 *
 *   'unverified_source'  the name matched PERFECTLY, and the only reason it is
 *                 queued is that the resolution came from a sandbox that
 *                 returns a plausible name for any ten digits. There is no
 *                 judgement to make; an operator cannot learn anything by
 *                 staring at "Samuel Udochukwu" vs "Samuel Udochukwu".
 *
 * On the test rig every single one of the 38 queued cases was the second kind,
 * which makes the queue pure noise and trains operators to approve without
 * looking - the exact habit that makes the first kind dangerous.
 */
export type PayoutReviewReason = 'name' | 'unverified_source';

export function payoutReviewReasonFor(account: {
  matchVerdict?: string;
  resolutionTrustworthy?: boolean;
}): PayoutReviewReason {
  if (account.matchVerdict === 'match' && !account.resolutionTrustworthy) {
    return 'unverified_source';
  }
  return 'name';
}

export async function listNgnPayoutAccountReviews() {
  const all = await db.listNgnPayoutAccounts();
  return all
    .filter((account) => account.status === 'pending_review')
    // Oldest first. A queue worked newest-first strands the cases that have
    // already waited longest, which are the users most likely to give up.
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((account) => ({
      ...account,
      reviewReason: payoutReviewReasonFor(account),
    }));
}

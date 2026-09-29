import { z } from 'zod';
import { db } from '../../database/json-database.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { id, nowIso } from '../../shared/id.js';
import type { GhsPayoutAccountRecord } from '../../database/types.js';
import { matchAccountName, nameMatchGrantsVerification } from '../../kyc/service/name-match.js';
import { resolveGhsBankAccount } from './ghs-banks.service.js';
import { env } from '../../config/env.js';
import { createAuditLog } from '../../audit/audit.service.js';

export const saveGhsPayoutAccountSchema = z.object({
  userId: z.string().min(1),
  bankId: z.string().min(1),
  accountNumber: z.string().regex(/^\d{10,16}$/, 'A Ghana MoMo or bank account number is 10 to 16 digits.'),
  accountType: z.enum(['momo', 'bank']).default('momo'),
});

export function ghsPayoutAccountStatusFor(
  verdict: 'match' | 'review' | 'mismatch',
  resolutionTrustworthy: boolean
): 'pending_review' | 'verified' | 'rejected' {
  if (verdict === 'mismatch') return 'rejected';
  const isProduction = (env.BREET_ENV ?? 'development') === 'production';
  if ((!isProduction || env.NGN_TRUST_SANDBOX_BANK_RESOLUTION) && !resolutionTrustworthy) {
    return 'verified';
  }
  if (!nameMatchGrantsVerification(verdict)) return 'pending_review';
  if (!resolutionTrustworthy) return 'pending_review';
  return 'verified';
}

export async function saveGhsPayoutAccount(input: z.infer<typeof saveGhsPayoutAccountSchema>) {
  const user = await db.findUserById(input.userId);
  if (!user) throw notFound('User');

  const declaredName = String(user.fullName ?? '').trim();
  if (!declaredName) {
    throw badRequest('Add your full name to your profile before adding a Ghana payout account.');
  }

  // Re-resolved server-side against Breet to ensure account belongs to holder
  const resolved = await resolveGhsBankAccount(input.bankId, input.accountNumber);

  const match = matchAccountName(declaredName, resolved.accountName);
  const status = ghsPayoutAccountStatusFor(match.verdict, resolved.trustworthy);
  const now = nowIso();

  const record: GhsPayoutAccountRecord = {
    id: id('ghsacct'),
    userId: input.userId,
    provider: 'breet',
    bankId: input.bankId,
    bankName: resolved.bankName,
    accountNumber: input.accountNumber,
    accountType: input.accountType,
    accountName: resolved.accountName,
    declaredName,
    matchVerdict: match.verdict,
    matchScore: match.score,
    matchExplanation: match.explanation,
    matchedTokens: match.matchedTokens,
    unmatchedBankTokens: match.unmatchedBankTokens,
    resolutionTrustworthy: resolved.trustworthy,
    status,
    reviewReason:
      status === 'verified'
        ? 'auto_verified'
        : match.verdict === 'mismatch'
        ? 'name_mismatch'
        : !resolved.trustworthy
        ? 'resolution_untrustworthy'
        : 'name_needs_review',
    needsHumanReview: status === 'pending_review' && resolved.trustworthy,
    createdAt: now,
    updatedAt: now,
  };

  const saved = await db.upsertGhsPayoutAccountRecord(record);

  await createAuditLog({
    actorType: 'user',
    actorId: input.userId,
    action: 'ghs.payout_account_saved',
    resourceType: 'ghs_payout_account',
    resourceId: saved.id,
    metadata: {
      bankId: input.bankId,
      bankName: resolved.bankName,
      status: saved.status,
      verdict: match.verdict,
      accountType: input.accountType,
    },
  });

  return saved;
}

export async function listGhsPayoutAccounts(userId: string): Promise<GhsPayoutAccountRecord[]> {
  return db.listGhsPayoutAccounts(userId);
}

export async function findGhsPayoutAccountById(id: string): Promise<GhsPayoutAccountRecord | null> {
  return db.findGhsPayoutAccountById(id);
}

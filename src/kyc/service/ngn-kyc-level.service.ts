import { z } from 'zod';
import { forbidden } from '../../shared/errors.js';
import { getKycLevelProvider } from '../providers/kyc-level-provider-registry.js';
import type { KycLevelMatchResult } from '../providers/kyc-level-provider.js';

export const bvnInfoMatchSchema = z.object({
  bvn: z.string().regex(/^\d{11}$/, 'BVN must be 11 digits'),
  firstName: z.string().min(2).max(80),
  lastName: z.string().min(2).max(80),
  dateOfBirth: z.string().regex(/^\d{2}-\d{2}-\d{4}$/, 'dateOfBirth must be dd-MM-yyyy'),
  mobileNo: z.string().min(8).max(20)
});

export const bvnAccountMatchSchema = z.object({
  bvn: z.string().regex(/^\d{11}$/, 'BVN must be 11 digits'),
  bankCode: z.string().min(2).max(20),
  accountNumber: z.string().min(8).max(20),
  accountName: z.string().min(2).max(160)
});

const attempts = new Map<string, { count: number; resetAt: number }>();
const maxAttempts = 3;
const windowMs = 24 * 60 * 60 * 1000;

function attemptKey(userId: string, kind: 'bvn_info' | 'bvn_bank', suffix = '') {
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
  return {
    status: result.status,
    level,
    provider: result.provider,
    bvnLast4: result.bvnLast4,
    message: result.status === 'matched'
      ? level === 'ngn_level_2' ? 'Your Nigerian identity check was successful.' : 'Your bank account was matched successfully.'
      : result.status === 'review'
        ? 'Your verification needs manual review.'
        : 'Your verification could not be matched. Check your details or contact Sivan Support.',
    matchedFields: result.matchedFields,
    providerReference: result.providerReference
  };
}

export async function verifyNgnBvnIdentity(userId: string, input: z.infer<typeof bvnInfoMatchSchema>) {
  enforceAttemptLimit(attemptKey(userId, 'bvn_info'));
  const provider = getKycLevelProvider();
  const result = await provider.verifyBvnIdentity(input);
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

import { env } from '../../config/env.js';
import { badRequest, serviceUnavailable } from '../../shared/errors.js';
import { BreetNgnProvider } from '../../ngn/provider/breet.provider.js';
import type { GhsBank, GhsBankAccountResolution } from '../types/ghs.types.js';

const MOCK_GHS_BANKS: GhsBank[] = [
  { id: '1', name: 'MTN Mobile Money', slug: 'mtn-momo', type: 'momo' },
  { id: '0', name: 'AIRTEL Mobile / AT Money', slug: 'at-money', type: 'momo' },
  { id: '3', name: 'Telecel Cash', slug: 'telecel-cash', type: 'momo' },
  { id: '4', name: 'ABSA Bank Ghana', slug: 'absa-gh', type: 'bank' },
  { id: '5', name: 'Access Bank (Ghana) PLC', slug: 'access-gh', type: 'bank' },
  { id: '24', name: 'Ecobank Ghana', slug: 'ecobank-gh', type: 'bank' },
  { id: '34', name: 'GCB Bank Limited', slug: 'gcb-bank', type: 'bank' },
  { id: '66', name: 'Stanbic Bank Ghana Limited', slug: 'stanbic-gh', type: 'bank' },
  { id: '76', name: 'Zenith Bank (Ghana) Limited', slug: 'zenith-gh', type: 'bank' },
];

export async function listGhsBanks(): Promise<GhsBank[]> {
  const breetConfigured = Boolean(env.BREET_APP_ID && env.BREET_APP_SECRET);

  if (breetConfigured) {
    try {
      const provider = new BreetNgnProvider();
      const banks = await provider.listBanks('ghs');
      if (Array.isArray(banks) && banks.length > 0) {
        return banks.map((b) => ({
          id: String(b.id),
          name: b.name,
          slug: b.slug,
          type: /mtn|telecel|vodafone|airtel|tigo|mobile/i.test(b.name) ? 'momo' : 'bank',
        }));
      }
    } catch {
      // Degrade gracefully to known bank directory if live call fails or in test
    }
  }

  return MOCK_GHS_BANKS;
}

export async function resolveGhsBankAccount(
  bankId: string,
  accountNumber: string
): Promise<GhsBankAccountResolution> {
  const trimmedBankId = String(bankId ?? '').trim();
  const trimmedAccount = String(accountNumber ?? '').trim();

  if (!trimmedBankId || !trimmedAccount) {
    throw badRequest('bankId and accountNumber are required');
  }

  // Ghana account number validation:
  // MoMo numbers are 10 digits starting with 0. Bank accounts are 10-16 digits.
  if (!/^\d{10,16}$/.test(trimmedAccount)) {
    throw badRequest('Ghana MoMo and bank account numbers must be 10 to 16 digits.');
  }

  const breetConfigured = Boolean(env.BREET_APP_ID && env.BREET_APP_SECRET);
  const isProduction = env.BREET_ENV === 'production';

  if (breetConfigured) {
    try {
      const provider = new BreetNgnProvider();
      const result = await provider.verifyBankAccount(trimmedBankId, trimmedAccount, 'ghs');
      const accountName = String(result?.accountName ?? '').trim();

      if (accountName) {
        return {
          accountName,
          accountNumber: result?.accountNumber ?? trimmedAccount,
          bankId: trimmedBankId,
          bankName: result?.bankName,
          type: /mtn|telecel|vodafone|airtel|tigo|mobile/i.test(result?.bankName ?? '') ? 'momo' : 'bank',
          // Trustworthy in production or when explicitly allowed in sandbox/staging
          trustworthy: isProduction || Boolean(env.NGN_TRUST_SANDBOX_BANK_RESOLUTION),
        };
      }
    } catch (err: any) {
      if (err?.statusCode === 422 || err?.statusCode === 400) {
        throw badRequest(err?.message || 'Could not resolve that Ghana account number.');
      }
      // Re-throw bad requests
      if (err?.statusCode && err.statusCode < 500) throw err;
    }
  }

  // Mock / Sandbox fallback for hermetic local testing
  const bank = MOCK_GHS_BANKS.find((b) => b.id === trimmedBankId);
  return {
    accountName: 'KWAME MENSAH',
    accountNumber: trimmedAccount,
    bankId: trimmedBankId,
    bankName: bank?.name ?? 'Ghana Financial Institution',
    type: bank?.type ?? 'momo',
    trustworthy: isProduction ? false : Boolean(env.NGN_TRUST_SANDBOX_BANK_RESOLUTION || env.APP_ENV === 'development'),
  };
}

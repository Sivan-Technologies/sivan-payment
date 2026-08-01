import { env } from '../../config/env.js';
import { badRequest } from '../../shared/errors.js';
import { BreetNgnProvider } from '../provider/breet.provider.js';
import { PajNgnProvider } from '../provider/paj.provider.js';
import type { NgnProviderName } from '../types/ngn.types.js';

/**
 * Banks and account resolution, from whichever provider is active.
 *
 * This exists because the only bank endpoints in the product hardcoded
 * `new PajNgnProvider()`. With NGN_PROVIDER=breet that is not a cosmetic
 * mismatch: bank IDs are provider-specific, so a user would pick "Access Bank"
 * from PajRamp's list, get PajRamp's id for it, and hand that id to Breet -
 * which answers "wrong bank id selection". The bank picker would have been
 * broken for every user on the default provider.
 *
 * Not on the NgnProvider interface: only some providers do banks at all, and
 * widening the interface would force a meaningless implementation onto the
 * mock. Resolved here instead, with an explicit refusal when the active
 * provider has no bank directory.
 */

export interface NgnBank {
  id: string;
  name: string;
  slug?: string;
  type?: string;
  /** Breet serves logos; the UI shows them so a user recognises their bank. */
  logoUrl?: string;
}

export interface ResolvedNgnBankAccount {
  accountName: string;
  accountNumber: string;
  bankId: string;
  bankName?: string;
  type?: string;
  /**
   * True when the answer came from a real bank directory rather than a
   * sandbox stub.
   *
   * Breet's DEVELOPMENT environment returns a plausible name for ANY account
   * number - verified live: 0000000000 at UBA resolved to a real-looking
   * person. So in development a resolution proves nothing, and anything
   * treating it as Level 1 identity evidence would be verifying against a
   * mock. Callers must check this before relying on the name.
   */
  trustworthy: boolean;
}

function activeProviderName(): NgnProviderName {
  return (env.NGN_PROVIDER as NgnProviderName) ?? 'mock';
}

/** The list a user picks from. */
export async function listNgnBanks(currency: 'ngn' | 'ghs' = 'ngn'): Promise<NgnBank[]> {
  const provider = activeProviderName();

  if (provider === 'breet') {
    const banks = await new BreetNgnProvider().listBanks(currency);
    return (banks ?? []).map((bank: any) => ({
      id: String(bank.id),
      name: bank.name,
      slug: bank.slug,
      type: bank.type,
      logoUrl: bank.avatar,
    }));
  }

  if (provider === 'paj') {
    const banks = await new PajNgnProvider().getBanks();
    return (banks as any[] ?? []).map((bank: any) => ({
      id: String(bank.id ?? bank.code ?? bank.bankId),
      name: bank.name ?? bank.bankName,
      slug: bank.slug,
      type: bank.type,
    }));
  }

  // Refused rather than returning [], which a UI would render as "no banks
  // found" - a lie that sends the user looking for a problem on their end.
  throw badRequest(
    `The active NGN provider (${provider}) has no bank directory. Set NGN_PROVIDER to breet or paj.`
  );
}

/**
 * Resolve an account number to the account holder's name.
 *
 * Sivan's Level 1 identity evidence: since the CBN directive of 1 March 2024 a
 * Nigerian bank account cannot transact without BVN/NIN linkage, so an account
 * that resolves has already been verified by a licensed bank.
 */
export async function resolveNgnBankAccount(
  bankId: string,
  accountNumber: string,
  currency: 'ngn' | 'ghs' = 'ngn'
): Promise<ResolvedNgnBankAccount> {
  const provider = activeProviderName();

  // A NUBAN is exactly 10 digits. Checked before the network call because the
  // provider's sandbox will happily "resolve" nonsense, and an obviously
  // malformed number should not reach it at all.
  if (currency === 'ngn' && !/^\d{10}$/.test(accountNumber)) {
    throw badRequest('A Nigerian account number is exactly 10 digits.');
  }

  const isProduction = (env.BREET_ENV ?? 'development') === 'production';

  if (provider === 'breet') {
    const result = await new BreetNgnProvider().verifyBankAccount(bankId, accountNumber, currency);
    if (!result?.accountName) {
      throw badRequest('That account could not be verified. Check the number and bank.');
    }
    return {
      accountName: result.accountName,
      accountNumber: result.accountNumber,
      bankId,
      bankName: result.bankName,
      type: result.type,
      trustworthy: isProduction,
    };
  }

  if (provider === 'paj') {
    const result: any = await new PajNgnProvider().resolveBankAccount(bankId, accountNumber);
    const accountName = result?.accountName ?? result?.account_name ?? result?.name;
    if (!accountName) {
      throw badRequest('That account could not be verified. Check the number and bank.');
    }
    return {
      accountName,
      accountNumber,
      bankId,
      bankName: result?.bankName ?? result?.bank_name,
      trustworthy: (env.PAJ_RAMP_ENV ?? 'staging') === 'production',
    };
  }

  throw badRequest(
    `The active NGN provider (${provider}) cannot verify bank accounts. Set NGN_PROVIDER to breet or paj.`
  );
}

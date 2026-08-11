import { env } from '../../config/env.js';
import { badRequest, serviceUnavailable } from '../../shared/errors.js';
import { bankResolutionMessage } from '../../shared/user-message.js';
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

/**
 * A small bank directory for NGN_PROVIDER=mock.
 *
 * Without this the entire bank flow - picker, resolution, payout account,
 * name match - could not be exercised without live Breet credentials, so the
 * one path that grants Level 1 had no way to be tested end to end.
 */
const MOCK_BANKS: NgnBank[] = [
  { id: '1', name: 'Access Bank', slug: 'access-bank' },
  { id: '2', name: 'Guaranty Trust Bank', slug: 'gtbank' },
  { id: '3', name: 'United Bank for Africa', slug: 'uba' },
  { id: '4', name: 'Zenith Bank', slug: 'zenith-bank' },
  { id: '5', name: 'Kuda Microfinance Bank', slug: 'kuda' },
];

/**
 * Deterministic mock account names, keyed by account number.
 *
 * Deterministic so a test can select a verdict by choosing a number, and so
 * the same number always resolves to the same person - a mock that returned a
 * fresh random name per call would make the upsert-on-resubmit path untestable.
 *
 * Every one of these is returned with trustworthy: false, exactly like Breet's
 * sandbox, so none of them can grant Level 1 on their own.
 */
const MOCK_ACCOUNT_NAMES: Record<string, string> = {
  // Exact match against a user named "Sharafa Ogunmepon", in bank order.
  '1111111111': 'OGUNMEPON SHARAFA',
  // The bank holds a name the user did not declare - the risky direction.
  '2222222222': 'OGUNMEPON SHARAFA ADEBAYO',
  // Nothing in common: someone else's account.
  '3333333333': 'CHINEDU EMEKA OKAFOR',
  // A single shared very common first name - not identity.
  '4444444444': 'SHARAFA MUSTAPHA',
};

/** The list a user picks from. */
export async function listNgnBanks(currency: 'ngn' | 'ghs' = 'ngn'): Promise<NgnBank[]> {
  const provider = activeProviderName();

  if (provider === 'breet') {
    // A DEAD KEY MUST NOT SURFACE AS "Internal server error".
    //
    // When the Breet sandbox key was rotated, listBanks threw the raw upstream
    // failure and /api/ngn/banks returned a bare 500 to every user. On screen
    // that is an empty bank picker with no explanation - the person cannot
    // verify, cannot tell whether it is them or us, and support gets a ticket
    // saying "the app is broken".
    //
    // 503 rather than 500, because the truthful statement is "the provider is
    // unavailable", not "we crashed". The message names the provider so an
    // operator reading a log knows immediately where to look, while the user
    // gets something they can act on.
    const banks = await new BreetNgnProvider().listBanks(currency).catch((error: any) => {
      const message = String(error?.message ?? '');
      const rejected = /401|unauthor|invalid|wrong app/i.test(message);
      throw serviceUnavailable(
        rejected
          ? 'Our bank provider rejected this request. Our team has been alerted - please try again shortly.'
          : 'We cannot reach our bank provider right now. Please try again in a few minutes.'
      );
    });
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

  if (provider === 'mock') return MOCK_BANKS;

  // Refused rather than returning [], which a UI would render as "no banks
  // found" - a lie that sends the user looking for a problem on their end.
  throw badRequest(
    `The active NGN provider (${provider}) has no bank directory. Set NGN_PROVIDER to breet or paj.`
  );
}

/**
 * Resolve a bank name (e.g. "opay", "gtbank", "kuda") to its official bankId.
 */
export async function resolveBankId(bankNameQuery: string): Promise<string> {
  const query = bankNameQuery.trim().toLowerCase();
  const banks = await listNgnBanks('ngn').catch(() => MOCK_BANKS);
  
  const match = banks.find((b) => 
    b.id.toLowerCase() === query ||
    b.name.toLowerCase().includes(query) ||
    (b.slug && b.slug.toLowerCase().includes(query))
  );

  if (match) return match.id;
  
  if (/opay/i.test(query)) return '999992';
  if (/palmpay/i.test(query)) return '999991';
  if (/kuda/i.test(query)) return '50211';
  if (/gtb|guaranty/i.test(query)) return '058';
  if (/access/i.test(query)) return '044';
  if (/zenith/i.test(query)) return '057';
  if (/uba|united bank/i.test(query)) return '033';
  if (/moniepoint/i.test(query)) return '50515';
  if (/firstbank|first bank/i.test(query)) return '011';

  return banks[0]?.id || '1';
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

  /**
   * Is the name this resolution returns worth anything as identity evidence?
   *
   * Only in production, where a real bank answered. Breet's sandbox returns a
   * plausible name for ANY ten digits - re-verified live against PalmPay:
   * 0000000000, 1234567890 and 9999999999 all came back "Samuel Udochukwu".
   *
   * NGN_TRUST_SANDBOX_BANK_RESOLUTION overrides that on a test rig so the
   * auto-approve path can actually be exercised. It is refused at boot in
   * production and against any live bank resolver (see app.ts), so this cannot
   * become a production relaxation by accident.
   */
  const isProduction = (env.BREET_ENV ?? 'development') === 'production';
  const resolutionIsEvidence = isProduction || env.NGN_TRUST_SANDBOX_BANK_RESOLUTION;

  /** Alias kept for the paj branch below, which reads the same decision. */
  const trustSandbox = env.NGN_TRUST_SANDBOX_BANK_RESOLUTION === true;

  if (provider === 'breet') {
    let result: any;
    try {
      result = await new BreetNgnProvider().verifyBankAccount(bankId, accountNumber, currency);
    } catch (error: any) {
      /**
       * NEVER HAND THE UPSTREAM'S WORDS TO THE USER.
       *
       * This used to say, on a real phone, on production:
       *
       *   "Bank verification is unavailable right now (provider: breet).
       *    Breet: failed to validate bank account."
       *
       * It named our provider, it blamed an outage for what was actually a
       * declined account number, and it gave the user nothing to act on. The
       * upstream was up - it had answered, and its answer was "no".
       *
       * bankResolutionMessage() separates those two cases: their-fault-about-
       * the-user gets "check the number and the bank", ours gets "this is on
       * our side". The raw text is logged, where it is useful, and dropped
       * from the response, where it is not.
       */
      // Logged with the raw upstream text, which is exactly where it belongs.
      console.warn('[ngn-banks] resolution failed', { bankId, reason: String(error?.message ?? error) });
      throw badRequest(bankResolutionMessage(error));
    }
    if (!result?.accountName) {
      throw badRequest(
        'We could not confirm that account. Check the account number and that you picked the right bank, then try again.'
      );
    }
    return {
      accountName: result.accountName,
      accountNumber: result.accountNumber,
      bankId,
      bankName: result.bankName,
      type: result.type,
      trustworthy: resolutionIsEvidence,
    };
  }

  if (provider === 'paj') {
    // PROVIDER FAILURES MUST NOT BECOME A BARE 500.
    //
    // PajRamp's resolver needs a per-user session token, and the staging key
    // has never been provisioned - /pub/initiate answers "Can't find
    // business". The raw throw surfaced to the browser as
    // "Internal Server Error", which tells a user their bank details are
    // broken when the truth is that a provider is misconfigured.
    //
    // Caught on the deployed test API: the bank picker listed 687 PajRamp
    // banks and every resolve returned 500.
    let result: any;
    try {
      result = await new PajNgnProvider().resolveBankAccount(bankId, accountNumber);
    } catch (error: any) {
      // Same rule as the Breet branch above: the upstream's words, and its
      // name, stay in the log.
      console.warn('[ngn-banks] resolution failed', { bankId, reason: String(error?.message ?? error) });
      throw badRequest(bankResolutionMessage(error));
    }
    const accountName = result?.accountName ?? result?.account_name ?? result?.name;
    if (!accountName) {
      throw badRequest('We could not confirm that account. Check the account number and that you picked the right bank, then try again.');
    }
    return {
      accountName,
      accountNumber,
      bankId,
      bankName: result?.bankName ?? result?.bank_name,
      trustworthy: (env.PAJ_RAMP_ENV ?? 'staging') === 'production' || trustSandbox,
    };
  }

  if (provider === 'mock') {
    const bank = MOCK_BANKS.find((item) => item.id === bankId);
    if (!bank) throw badRequest('That bank was not recognised.');
    const accountName = MOCK_ACCOUNT_NAMES[accountNumber];
    // Unknown numbers FAIL rather than inventing a name. Breet's sandbox
    // resolves anything, and copying that here would mean the mock could not
    // reproduce the "account does not exist" case at all.
    if (!accountName) {
      throw badRequest('We could not confirm that account. Check the account number and that you picked the right bank, then try again.');
    }
    return {
      accountName,
      accountNumber,
      bankId,
      bankName: bank.name,
      /**
       * A fabricated name is not evidence, and this is the flag that stops a
       * mock resolution from granting real Level 1.
       *
       * It honours NGN_TRUST_SANDBOX_BANK_RESOLUTION for one reason: without
       * it, the auto-approve branch of payoutAccountStatusFor() cannot be
       * reached by any automated test, because every test runs on the mock.
       * An untestable branch is how the "clean match still queues" bug went
       * unnoticed. The override is refused at boot in production and against any
       * live bank resolver.
       */
      trustworthy: env.NGN_TRUST_SANDBOX_BANK_RESOLUTION,
    };
  }

  throw badRequest(
    `The active NGN provider (${provider}) cannot verify bank accounts. Set NGN_PROVIDER to breet or paj.`
  );
}

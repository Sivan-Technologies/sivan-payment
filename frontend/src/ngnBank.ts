/**
 * NGN bank selection and quoting, client side.
 *
 * Two steps the NGN off-ramp cannot work without, and neither existed:
 *
 *   1. A Nigerian user has no way to say WHERE the naira goes. Bridge external
 *      accounts are US/UK/EU shapes - routing number, sort code, IBAN - and a
 *      NUBAN is none of those.
 *   2. POST /api/ngn/offramp/orders settles an ACCEPTED QUOTE. Without a quote
 *      there is nothing to accept, so the call fails whatever else is right.
 *
 * The bank list and the resolution both come from whichever provider is
 * active. That matters more than it looks: bank IDs are provider-specific, so
 * a list fetched from one provider and an id handed to another is a mismatch
 * the user cannot see and cannot fix.
 */

export interface NgnBank {
  id: string;
  name: string;
  slug?: string;
  type?: string;
  logoUrl?: string;
}

export interface ResolvedNgnBankAccount {
  accountName: string;
  accountNumber: string;
  bankId: string;
  bankName?: string;
  type?: string;
  /**
   * False in sandbox. Breet's development environment resolves ANY account
   * number to a plausible name - 0000000000 returns a real-looking person - so
   * a resolution there proves nothing. The UI must not present an untrustworthy
   * name as confirmation that the account is real.
   */
  trustworthy: boolean;
}

export interface NgnQuote {
  id: string;
  direction: 'onramp' | 'offramp';
  sourceCurrency: string;
  destinationCurrency: string;
  sourceAmount: string;
  destinationAmount: string;
  rate: string;
  feeAmount: string;
  expiresAt?: string;
  status?: string;
}

/** A NUBAN is exactly ten digits. Nothing else is worth a network call. */
export function isValidNuban(accountNumber: string): boolean {
  return /^\d{10}$/.test(accountNumber.trim());
}

/**
 * Should the account be resolved yet?
 *
 * Resolution is a paid, rate-limited call at the provider, and firing it on
 * every keystroke would spend a request per digit while showing the user a
 * string of failures for a number they are still typing.
 */
export function shouldResolveAccount(bankId: string, accountNumber: string): boolean {
  return Boolean(bankId) && isValidNuban(accountNumber);
}

/**
 * Filter the bank list as the user types.
 *
 * 169 banks is far too many to scroll, and Nigerian banks are habitually known
 * by abbreviation - GTB, UBA, FCMB - so the slug is searched alongside the
 * display name.
 */
export function filterBanks(banks: NgnBank[], query: string): NgnBank[] {
  const term = query.trim().toLowerCase();
  if (!term) return banks;

  return banks.filter((bank) => {
    const name = bank.name.toLowerCase();
    const slug = (bank.slug ?? '').toLowerCase();
    if (name.includes(term) || slug.includes(term)) return true;

    // "gtb" should find "Guaranty Trust Bank" and "uba" should find "United
    // Bank For Africa". Initials of EVERY word gives "ubfa" for the latter,
    // which does not match how anyone refers to it - so short connecting words
    // are dropped first. Checked with startsWith rather than equality so "gt"
    // still finds Guaranty Trust.
    const significantWords = bank.name.split(/\s+/).filter((word) => !['for', 'of', 'and', 'the'].includes(word.toLowerCase()));
    const initials = significantWords.map((word) => word[0] ?? '').join('').toLowerCase();
    return initials.startsWith(term);
  });
}

/** Has the quote expired? Quotes are priced against a moving rate. */
export function isQuoteExpired(quote: NgnQuote | null, now: number = Date.now()): boolean {
  if (!quote?.expiresAt) return false;
  const expiry = new Date(quote.expiresAt).getTime();
  return Number.isFinite(expiry) && expiry <= now;
}

/** Seconds left on a quote, floored at zero, for a countdown. */
export function quoteSecondsRemaining(quote: NgnQuote | null, now: number = Date.now()): number {
  if (!quote?.expiresAt) return 0;
  const expiry = new Date(quote.expiresAt).getTime();
  if (!Number.isFinite(expiry)) return 0;
  return Math.max(0, Math.floor((expiry - now) / 1000));
}

/**
 * Mask an account number for display once confirmed.
 *
 * The last four are enough for the user to recognise their own account, and
 * the full number does not need to sit on screen afterwards.
 */
export function maskAccountNumber(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  if (digits.length <= 4) return digits;
  return `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/**
 * A payout account after the server has matched it against the name on file.
 *
 * status is NOT cosmetic. 'verified' means Level 1 is granted; 'pending_review'
 * means a human has to look and the user is still blocked. Rendering both as
 * success would tell a queued user they can withdraw, and they would find out
 * otherwise at the moment they tried.
 */
export interface SavedNgnPayoutAccount {
  id: string;
  userId: string;
  bankId: string;
  bankName?: string;
  accountNumber: string;
  accountName: string;
  declaredName: string;
  matchVerdict: 'match' | 'review' | 'mismatch';
  matchScore: number;
  matchExplanation?: string;
  resolutionTrustworthy: boolean;
  status: 'pending_review' | 'verified' | 'rejected';
  createdAt: string;
  updatedAt: string;
}

/** What to tell the user about a saved account, per outcome. */
export function payoutAccountOutcomeMessage(account: SavedNgnPayoutAccount): {
  tone: 'success' | 'pending' | 'error';
  message: string;
} {
  if (account.status === 'verified') {
    return { tone: 'success', message: `Verified. ${account.accountName} is ready for naira payouts.` };
  }
  if (account.status === 'rejected') {
    return {
      tone: 'error',
      // Named plainly: the account belongs to someone else, and a vague error
      // would send the user back to retype a number that was never the problem.
      message:
        `That account is held by ${account.accountName}, which does not match your name. ` +
        `You can only pay out to an account in your own name.`,
    };
  }
  return {
    tone: 'pending',
    message:
      `Saved. ${account.accountName} needs a quick manual check before your first naira payout — ` +
      `usually within a few hours.`,
  };
}

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
 * The banks most Nigerians actually hold, in the order they are likely wanted.
 *
 * WHY A CURATED LIST AND NOT PURE ALPHABETICAL.
 *
 * The provider returns 169 banks sorted A-Z, so the default screen opened on
 * Abbey Mortgage Bank, ASO Savings and Loans, Bowen Microfinance, CEMCS
 * Microfinance... while OPay sat at #26, PalmPay #27, Zenith #43. Nobody's
 * bank is at the top, so every single user has to scroll or type. On a phone
 * that is a wall of a hundred and sixty-nine near-identical rows.
 *
 * Matched on NAME rather than id, deliberately: bank ids differ between
 * providers and between Breet's sandbox and production, so pinning ids would
 * silently stop working the day the rail changes. A name that no longer
 * matches simply drops out of the shortlist - the bank is still findable by
 * search, so a stale entry degrades to the old behaviour rather than hiding a
 * bank.
 */
const POPULAR_BANK_MATCHERS: readonly string[] = [
  'opay',
  'palmpay',
  'kuda',
  'moniepoint',
  'guaranty trust',
  'access bank',
  'zenith bank',
  'united bank for africa',
  'first bank of nigeria',
  'sterling bank',
  'fidelity bank',
  'union bank',
  'wema bank',
  'stanbic ibtc bank',
  'polaris bank',
  'ecobank',
  'first city monument',
  'keystone bank',
];

/** Is this one of the banks most users are looking for? Returns its rank, or -1. */
function popularRank(bank: NgnBank): number {
  const name = bank.name.toLowerCase();
  return POPULAR_BANK_MATCHERS.findIndex((matcher) => name.startsWith(matcher));
}

/**
 * The list to show BEFORE the user types anything.
 *
 * The common banks first, in popularity order, then everything else
 * alphabetically. A user whose bank is in the shortlist taps it immediately; a
 * user whose bank is not still sees a normal list underneath and can search.
 *
 * Nothing is hidden. Hiding banks behind a search box would strand anyone with
 * a microfinance account who does not know its exact spelling.
 */
export function orderBanksForDisplay(banks: NgnBank[]): NgnBank[] {
  const popular: NgnBank[] = [];
  const rest: NgnBank[] = [];

  for (const bank of banks) {
    if (popularRank(bank) >= 0) popular.push(bank);
    else rest.push(bank);
  }

  popular.sort((a, b) => popularRank(a) - popularRank(b));
  rest.sort((a, b) => a.name.localeCompare(b.name));
  return [...popular, ...rest];
}

/** How many banks are shown as "common" before the rest of the list. */
export function popularBankCount(banks: NgnBank[]): number {
  return banks.filter((bank) => popularRank(bank) >= 0).length;
}

/**
 * Filter the bank list as the user types.
 *
 * 169 banks is far too many to scroll, and Nigerian banks are habitually known
 * by abbreviation - GTB, UBA, FCMB - so the slug is searched alongside the
 * display name.
 *
 * RESULTS ARE RANKED, NOT JUST FILTERED.
 *
 * A plain substring filter returns provider order, which put the wrong bank
 * first in real cases:
 *
 *   "titan"   -> Paystack-Titan   before TITAN TRUST BANK
 *   "polaris" -> Polaris Bank     then ASTRAPOLARIS MFB
 *   "pay"     -> OPay, PalmPay, KongaPay, PayAttitude, Paystack-Titan
 *
 * A bank whose name STARTS with what you typed is what you meant; a bank that
 * merely contains it somewhere is a coincidence. Ranking by where the match
 * falls - and breaking ties by popularity - puts the intended bank first
 * without hiding the others.
 */
export function filterBanks(banks: NgnBank[], query: string): NgnBank[] {
  const term = query.trim().toLowerCase();
  if (!term) return orderBanksForDisplay(banks);

  const scored: Array<{ bank: NgnBank; score: number }> = [];

  for (const bank of banks) {
    const name = bank.name.toLowerCase();
    const slug = (bank.slug ?? '').toLowerCase();

    // "gtb" should find "Guaranty Trust Bank" and "uba" should find "United
    // Bank For Africa". Initials of EVERY word gives "ubfa" for the latter,
    // which does not match how anyone refers to it - so short connecting words
    // are dropped first. Checked with startsWith rather than equality so "gt"
    // still finds Guaranty Trust.
    const significantWords = bank.name.split(/\s+/).filter((word) => !['for', 'of', 'and', 'the'].includes(word.toLowerCase()));
    const initials = significantWords.map((word) => word[0] ?? '').join('').toLowerCase();

    // Lower is better.
    let score: number;
    if (name === term || slug === term) score = 0;
    else if (name.startsWith(term)) score = 1;
    else if (initials.startsWith(term)) score = 2;
    else if (slug.startsWith(term)) score = 3;
    // A match at a word boundary ("trust" in "TITAN TRUST BANK") beats one
    // buried inside a word ("polaris" in "ASTRAPOLARIS").
    else if (new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(name)) score = 4;
    else if (name.includes(term) || slug.includes(term)) score = 5;
    else continue;

    scored.push({ bank, score });
  }

  const rank = (bank: NgnBank) => {
    const index = popularRank(bank);
    return index < 0 ? POPULAR_BANK_MATCHERS.length : index;
  };

  /**
   * POPULARITY OUTRANKS MATCH POSITION FOR THE BANKS PEOPLE ACTUALLY HOLD.
   *
   * Sorting on match position first was right for "titan" but wrong for "pay":
   * it produced PayAttitude Online, Paystack-Titan, then OPay and PalmPay -
   * because those two match mid-name. Nobody typing "pay" on a Nigerian
   * payments app means PayAttitude before OPay.
   *
   * So a shortlisted bank is compared on popularity FIRST and only falls back
   * to match position against another shortlisted bank. Everything outside the
   * shortlist still ranks purely on where the match falls, which is what keeps
   * TITAN TRUST BANK above Paystack-Titan.
   */
  const bothPopular = (a: NgnBank, b: NgnBank) => popularRank(a) >= 0 && popularRank(b) >= 0;

  return scored
    .sort((a, b) => {
      const aPopular = popularRank(a.bank) >= 0;
      const bPopular = popularRank(b.bank) >= 0;
      if (aPopular !== bPopular) return aPopular ? -1 : 1;
      if (bothPopular(a.bank, b.bank)) {
        return rank(a.bank) - rank(b.bank) || a.score - b.score;
      }
      return a.score - b.score || a.bank.name.localeCompare(b.bank.name);
    })
    .map((entry) => entry.bank);
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
  /** Why it is in this status. Optional: rows predating the field have none. */
  reviewReason?: 'auto_verified' | 'name_needs_review' | 'name_mismatch' | 'resolution_untrustworthy';
  needsHumanReview?: boolean;
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
  /**
   * WHY it is pending, because the two reasons need different words.
   *
   * "needs a quick manual check ... within a few hours" is a promise, and on
   * a name-review case it is one a person can keep. On a case held because
   * the provider environment cannot be trusted, nobody is coming: no operator
   * can approve it, because the names DO match and the resolution is the
   * problem. Telling that user to wait a few hours is simply false.
   */
  if (account.reviewReason === 'resolution_untrustworthy') {
    return {
      tone: 'pending',
      message:
        `Saved. ${account.accountName} matches your name, but bank verification is running ` +
        `against a test provider on this environment, so it cannot be confirmed automatically.`,
    };
  }
  return {
    tone: 'pending',
    message:
      `Saved. ${account.accountName} needs a quick manual check before your first naira payout — ` +
      `usually within a few hours.`,
  };
}

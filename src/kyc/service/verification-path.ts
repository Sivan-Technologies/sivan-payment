/**
 * Which verification path a user takes, decided by country.
 *
 * The two paths are not variants of one flow. They collect different evidence,
 * cost different amounts, and end in different capabilities:
 *
 *   NIGERIA -> bank account name resolution
 *     Since the CBN directive of 1 March 2024 a Nigerian account cannot
 *     transact without BVN/NIN linkage, so an account that resolves has been
 *     verified by a licensed bank. Matching the holder's name to the name on
 *     file makes it evidence about THIS user. Costs nothing and takes seconds.
 *
 *   EVERYWHERE ELSE -> Bridge KYC
 *     There is no equivalent check: the resolver only understands NUBANs, so
 *     a US or EU account cannot be verified this way at all. Bridge runs
 *     document and identity verification instead, costs $2 per customer, and
 *     is what unlocks USD/GBP/EUR virtual accounts.
 *
 * Country is a ROUTING HINT, not proof. It decides which flow a user sees.
 * What they are permitted to do is decided by evidence that was actually
 * verified - see verification-state.ts. A self-declared country must never
 * gate a regulated decision on its own.
 */

export type VerificationPath = 'ngn_bank' | 'bridge_kyc';

/** ISO 3166-1 alpha-2. Uppercased and validated at the edges. */
export type CountryCode = string;

export const NIGERIA: CountryCode = 'NG';

/**
 * Countries whose local rail Sivan can verify directly.
 *
 * Only Nigeria today. Breet also settles Ghana (GHS), so GH is the obvious
 * next entry - but it is deliberately absent until the Ghanaian resolver has
 * been tested, because adding it here would route Ghanaian users into a check
 * that does not exist yet and strand them with no path at all.
 */
const LOCAL_RAIL_COUNTRIES = new Set<CountryCode>([NIGERIA]);

export function normalizeCountry(value: string | undefined | null): CountryCode | undefined {
  const trimmed = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The path for a country.
 *
 * An unknown or missing country routes to BRIDGE, deliberately. The Nigerian
 * path is the cheaper, faster one, so defaulting to it would mean a user with
 * no country set gets offered a check that cannot possibly succeed for them -
 * their account number will not resolve, and they end up stuck with a failure
 * they cannot act on. Defaulting to Bridge is slower but always completable.
 */
export function verificationPathFor(country: string | undefined | null): VerificationPath {
  const normalized = normalizeCountry(country);
  if (!normalized) return 'bridge_kyc';
  return LOCAL_RAIL_COUNTRIES.has(normalized) ? 'ngn_bank' : 'bridge_kyc';
}

export function isNigerianUser(country: string | undefined | null): boolean {
  return normalizeCountry(country) === NIGERIA;
}

/**
 * Everything a UI needs to render the right verification screen.
 *
 * Returned as one object so the frontend does not reimplement the branch and
 * drift from the backend - the two disagreeing about which path a user is on
 * is exactly how someone gets shown a form that cannot succeed.
 */
export interface VerificationPathPlan {
  path: VerificationPath;
  country?: CountryCode;
  /** True when the country is missing and this is a fallback rather than a choice. */
  isFallback: boolean;
  title: string;
  description: string;
  /** What the user gets at the end. Different per path, and worth stating. */
  unlocks: string[];
  /** Whether completing this costs Sivan money. Drives when it is triggered. */
  costsProviderFee: boolean;
}

export function verificationPlanFor(country: string | undefined | null): VerificationPathPlan {
  const normalized = normalizeCountry(country);
  const path = verificationPathFor(normalized);

  if (path === 'ngn_bank') {
    return {
      path,
      country: normalized,
      isFallback: false,
      title: 'Verify with your bank account',
      description:
        'Enter your Nigerian bank account. We confirm the account name matches your name - ' +
        'no documents, no selfie, usually under a minute.',
      unlocks: ['Sell crypto to naira', 'Withdraw to your Nigerian bank'],
      costsProviderFee: false,
    };
  }

  return {
    path,
    country: normalized,
    isFallback: !normalized,
    title: 'Verify your identity',
    description: normalized
      ? 'Our partner Bridge will check your ID and a short selfie. This usually takes a few minutes.'
      : 'Tell us where you are based so we can show you the right verification.',
    unlocks: ['USD, GBP and EUR virtual accounts', 'Withdraw to your local bank'],
    // $2 per customer at Bridge, so this should be triggered on intent - when
    // a user asks for a virtual account - rather than at signup for everyone.
    costsProviderFee: true,
  };
}

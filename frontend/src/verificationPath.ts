/**
 * Which verification flow a user sees, mirrored from the server.
 *
 * The authoritative answer comes from GET /api/users/:id/verification-plan.
 * This exists so the UI can render immediately rather than flashing an empty
 * screen while that resolves, and so the shapes are typed on the client.
 *
 * The two paths are genuinely different products, not variants of one screen:
 *
 *   NIGERIA    bank account name resolution. Free, seconds, no documents.
 *   ELSEWHERE  Bridge KYC. Costs $2, takes minutes, unlocks virtual accounts.
 *
 * A US user has no Nigerian path available at all - the resolver only
 * understands NUBANs - so showing them that form is a check that cannot
 * succeed, with nothing they can do about it.
 */

export type VerificationPath = 'ngn_bank' | 'bridge_kyc';

export interface VerificationPathPlan {
  path: VerificationPath;
  country?: string;
  /** True when the country is unknown and Bridge is a fallback, not a choice. */
  isFallback: boolean;
  title: string;
  description: string;
  unlocks: string[];
  costsProviderFee: boolean;
}

export const NIGERIA = 'NG';

/**
 * Countries offered at signup.
 *
 * Deliberately short. A 200-entry dropdown buries the one country that has a
 * different flow, and every entry other than NG behaves identically anyway -
 * so the list covers the markets Sivan actually serves plus an "other" escape.
 */
export const SIGNUP_COUNTRIES: Array<{ code: string; name: string; flag: string }> = [
  { code: 'NG', name: 'Nigeria', flag: '🇳🇬' },
  { code: 'US', name: 'United States', flag: '🇺🇸' },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'CA', name: 'Canada', flag: '🇨🇦' },
  { code: 'DE', name: 'Germany', flag: '🇩🇪' },
  { code: 'FR', name: 'France', flag: '🇫🇷' },
  { code: 'IE', name: 'Ireland', flag: '🇮🇪' },
  { code: 'NL', name: 'Netherlands', flag: '🇳🇱' },
  { code: 'ZA', name: 'South Africa', flag: '🇿🇦' },
  { code: 'GH', name: 'Ghana', flag: '🇬🇭' },
];

/**
 * Order the picker so the likely answer is first.
 *
 * Nigeria was hardcoded at the top with an "INSTANT" badge, which reads to an
 * American as though it were the default choice - and the country decides
 * their whole verification path, so a mis-click sends them down a NUBAN check
 * their account cannot pass.
 *
 * The detected country floats to the top instead. When nothing is detected the
 * shipped order stands, which keeps Nigeria first for the market that is most
 * of the userbase without asserting it about a specific visitor.
 */
export function orderCountriesForDetected(
  countries: typeof SIGNUP_COUNTRIES,
  detected: string | undefined | null
): typeof SIGNUP_COUNTRIES {
  const code = normalizeCountry(detected);
  if (!code) return countries;
  const match = countries.find((item) => item.code === code);
  if (!match) return countries;
  return [match, ...countries.filter((item) => item.code !== code)];
}

export function normalizeCountry(value: string | undefined | null): string | undefined {
  const trimmed = String(value ?? '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : undefined;
}

export function isNigerianUser(country: string | undefined | null): boolean {
  return normalizeCountry(country) === NIGERIA;
}

/**
 * Local mirror of the server's routing.
 *
 * An unknown country routes to BRIDGE, matching the server. Defaulting to the
 * Nigerian path would be cheaper but strands a non-Nigerian user on a check
 * their account number cannot pass.
 */
export function verificationPathFor(country: string | undefined | null): VerificationPath {
  return isNigerianUser(country) ? 'ngn_bank' : 'bridge_kyc';
}

/** A plan to render before the server responds. */
export function localVerificationPlan(country: string | undefined | null): VerificationPathPlan {
  const normalized = normalizeCountry(country);
  const path = verificationPathFor(normalized);

  if (path === 'ngn_bank') {
    return {
      path,
      country: normalized,
      isFallback: false,
      title: 'Verify with your bank account',
      description:
        'Enter your Nigerian bank account. We confirm the account name matches your name — ' +
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
    costsProviderFee: true,
  };
}

/**
 * Can this user request a virtual account?
 *
 * Only after Bridge KYC is approved. Bridge issues the account, so asking
 * before approval produces a provider error the user cannot act on - far
 * worse than a disabled button that says why.
 */
export function canRequestVirtualAccount(kycStatus: string | undefined): boolean {
  return String(kycStatus ?? '').toLowerCase() === 'approved';
}

/** Why the virtual-account button is disabled, phrased for a user. */
export function virtualAccountBlockedReason(
  kycStatus: string | undefined,
  path: VerificationPath
): string | undefined {
  if (canRequestVirtualAccount(kycStatus)) return undefined;

  const status = String(kycStatus ?? '').toLowerCase();
  if (status === 'under_review' || status === 'pending') {
    return 'Your verification is being reviewed. Virtual accounts unlock once it is approved.';
  }
  if (status === 'rejected') {
    return 'Verification was not approved. Contact support to try again.';
  }
  // A Nigerian user reaching here has done the bank check, which is NOT the
  // same evidence - Bridge issues these accounts and requires its own.
  return path === 'ngn_bank'
    ? 'USD, GBP and EUR accounts need identity verification with our partner Bridge.'
    : 'Complete identity verification to unlock virtual accounts.';
}

/**
 * Which plan the modal should render.
 *
 * The server owns the routing rule, so its plan wins - but only while it still
 * describes the country the user has selected. The instant they pick a
 * different one the server's plan is STALE: it would show a US user the
 * Nigerian bank form until the refetch lands, which is a check their account
 * cannot pass. So a mismatch falls back to the local mirror of the same rule.
 *
 * Extracted from the component rather than left inline because this is the one
 * piece of the modal that can be wrong in a way the user pays for, and logic
 * inside a useMemo cannot be tested.
 */
export function planToRender(
  serverPlan: VerificationPathPlan,
  chosenCountry: string | undefined | null
): VerificationPathPlan {
  const chosen = normalizeCountry(chosenCountry);
  // No selection yet: nothing to be stale against.
  if (!chosen) return serverPlan;
  // Same country: the server's copy is richer and authoritative.
  if (normalizeCountry(serverPlan.country) === chosen) return serverPlan;
  return localVerificationPlan(chosen);
}

/**
 * Should a detected country be auto-selected, or only offered?
 *
 * Auto-selecting is the right default: asking someone to confirm a country we
 * already know is a step that exists only to be clicked through, and the
 * choice is shown and reversible on the very next screen.
 *
 * But ONLY for countries we serve. Detecting Japan and silently selecting
 * nothing - or worse, defaulting to a neighbour - would put the user on a
 * path they never chose. An unserved country must fall through to the picker,
 * where "not listed" is at least visible and they can pick the country on
 * their ID.
 */
export function shouldAutoSelectCountry(detected: string | undefined | null): boolean {
  const code = normalizeCountry(detected);
  if (!code) return false;
  return SIGNUP_COUNTRIES.some((item) => item.code === code);
}

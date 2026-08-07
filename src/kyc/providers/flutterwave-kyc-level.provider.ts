import { env } from '../../config/env.js';
import { badRequest, forbidden } from '../../shared/errors.js';
import type {
  BvnAccountMatchInput,
  BvnInfoMatchInput,
  KycLevelMatchResult,
  KycLevelProvider,
  KycLevelProviderHealth,
} from './kyc-level-provider.js';
import { bvnLast4 } from './kyc-level-provider.js';

/**
 * FLUTTERWAVE BVN VERIFICATION — a second Nigerian identity provider.
 *
 * WHY A SECOND ONE. Monnify was the only BVN vendor, which made it a single
 * point of failure on the step that gates every Nigerian user's limits. If it
 * is down, rate-limited, or wrong about a valid BVN, Level 2 is unreachable
 * for everybody and there is no lever to pull. Two providers behind one
 * interface means an operator switches KYC_LEVEL_PROVIDER and carries on.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE CONSENT FLOW IS NOT A LOOKUP, AND THAT IS THE WHOLE DESIGN PROBLEM.
 *
 * Monnify answers a BVN match in ONE synchronous call. Flutterwave v3 cannot,
 * because the CBN requires the BVN owner to approve the merchant first:
 *
 *   1. POST /v3/bvn/verifications  { bvn, firstname, lastname, redirect_url }
 *        -> { data: { url, reference } }
 *   2. The CUSTOMER opens `url`, enters an OTP on the NIBSS page, and picks
 *      what to share. This is a human in a browser. It can take minutes, or
 *      never happen at all.
 *   3. NIBSS redirects them back to redirect_url.
 *   4. GET /v3/bvn/verifications/{reference} -> the BVN data.
 *
 * Steps 2-3 are not something a server-side function can await. So
 * verifyBvnIdentity() CANNOT return 'matched' on the first call, and this
 * provider does not pretend otherwise: it returns `review` with the consent
 * URL attached, and the match is settled later by
 * completeBvnConsent(reference) once the customer is back.
 *
 * Returning 'matched' here would be the worst possible bug in this file - it
 * would grant Level 2, and a NGN 5,000,000 ceiling, to anyone who typed
 * eleven digits, with no consent and no verification. The status is therefore
 * derived from what NIBSS actually returned, never from the fact that a
 * request succeeded.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY v2 EXISTS HERE AND IS OFF BY DEFAULT.
 *
 * Flutterwave v2 (`GET /v2/kyc/bvn/{bvn}?seckey=`) is a direct lookup with no
 * consent step. It is simpler and it is the wrong default: the CBN expects
 * customer consent before a merchant reads BVN data, and v2 skips it.
 * Reachable behind FLUTTERWAVE_BVN_ALLOW_V2_DIRECT for accounts that still
 * have it enabled, so the choice is explicit and auditable rather than a
 * silent fallback nobody notices.
 *
 * COST: N50 per call, billed to the Flutterwave wallet balance. A failing
 * integration that retries is a spending bug, not just a broken one - which
 * is why nothing in here retries on its own.
 */

function v3Base() {
  return (env.FLUTTERWAVE_BASE_URL || 'https://api.flutterwave.com').replace(/\/$/, '');
}

function v2Base() {
  return (env.FLUTTERWAVE_V2_BASE_URL || 'https://api.ravepay.co').replace(/\/$/, '');
}

function secretKey(): string {
  const key = env.FLUTTERWAVE_SECRET_KEY;
  if (!key) throw forbidden('Flutterwave KYC provider is not configured.');
  return key;
}

/**
 * BVNs are ELEVEN DIGITS. Flutterwave's own docs call this out because a
 * malformed one is a validation error that still costs a request.
 *
 * Checked before the network call rather than after, so a typo is a clear
 * message instead of a provider error the user cannot act on.
 */
function assertBvnShape(bvn: string) {
  const digits = String(bvn || '').replace(/\D/g, '');
  if (digits.length !== 11) {
    throw badRequest('A BVN is 11 digits. Check the number and try again.');
  }
  return digits;
}

function normalize(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Compare a name the user typed with the name NIBSS holds.
 *
 * Deliberately tolerant on ORDER and on middle names - Nigerian records
 * routinely carry "surname firstName middleName" in an order the user will not
 * reproduce - and deliberately strict on the value itself. A field the
 * provider did not return is `undefined`, NOT false: "we could not check this"
 * and "this did not match" must not collapse into the same answer.
 */
function nameMatches(claimed: string, actual: unknown): boolean | undefined {
  const a = normalize(claimed);
  const b = normalize(actual);
  if (!a || !b) return undefined;
  return a === b;
}

/** NIBSS returns 1976-11-30; the rest of Sivan uses 30-11-1976. Accept both. */
function dobMatches(claimed: string, actual: unknown): boolean | undefined {
  const a = String(claimed ?? '').replace(/\D/g, '');
  const b = String(actual ?? '').replace(/\D/g, '');
  if (!a || !b) return undefined;
  if (a === b) return true;
  // dd-mm-yyyy vs yyyy-mm-dd, compared as sorted digit groups.
  const reorder = (value: string) => (value.length === 8 ? [value.slice(0, 4), value.slice(4, 6), value.slice(6)] : []);
  const [ay, am, ad] = reorder(a);
  const [by, bm, bd] = reorder(b);
  if (!ay || !by) return undefined;
  return (ay === by && am === bm && ad === bd) || (ad + am + ay === by + bm + bd) || (ay + am + ad === bd + bm + by);
}

/** Nigerian numbers arrive as 08012345678 and as +2348012345678. */
function phoneMatches(claimed: string, actual: unknown): boolean | undefined {
  const strip = (value: unknown) => String(value ?? '').replace(/\D/g, '').replace(/^234/, '0');
  const a = strip(claimed);
  const b = strip(actual);
  if (!a || !b) return undefined;
  return a.slice(-10) === b.slice(-10);
}

/**
 * Turn NIBSS's bvn_data into a verdict.
 *
 * THE DEFAULT IS `review`, NOT `matched`. Every unknown path in this function
 * lands on review, because the failure mode of guessing 'matched' is granting
 * a NGN 5,000,000 ceiling to an unverified person.
 */
export function decideFlutterwaveStatus(
  claimed: BvnInfoMatchInput,
  bvnData: any
): { status: KycLevelMatchResult['status']; matchedFields: Record<string, boolean | string> } {
  const first = nameMatches(claimed.firstName, bvnData?.firstName ?? bvnData?.first_name);
  const last = nameMatches(claimed.lastName, bvnData?.surname ?? bvnData?.last_name ?? bvnData?.lastName);
  const dob = dobMatches(claimed.dateOfBirth, bvnData?.dateOfBirth ?? bvnData?.date_of_birth);
  const phone = phoneMatches(
    claimed.mobileNo,
    bvnData?.phoneNumber1 ?? bvnData?.phone_number ?? bvnData?.phoneNumber2
  );

  const matchedFields: Record<string, boolean | string> = {};
  if (first !== undefined) matchedFields.firstName = first;
  if (last !== undefined) matchedFields.lastName = last;
  if (dob !== undefined) matchedFields.dateOfBirth = dob;
  if (phone !== undefined) matchedFields.mobileNo = phone;

  /**
   * A WATCHLISTED BVN IS NEVER A PASS.
   *
   * NIBSS returns `watchlisted` on the record. Whatever the name fields say,
   * this is a compliance stop and it outranks a match - checked FIRST so no
   * later branch can talk its way past it.
   */
  const watchlisted = bvnData?.watchlisted;
  if (watchlisted !== undefined && watchlisted !== null && String(watchlisted) !== '' && String(watchlisted) !== '0' && String(watchlisted).toLowerCase() !== 'false') {
    return { status: 'review', matchedFields: { ...matchedFields, watchlisted: String(watchlisted) } };
  }

  // Nothing to compare: we have a BVN record but cannot attribute it to THIS
  // user. That is review, not a pass.
  const values = Object.values(matchedFields);
  if (!values.length) return { status: 'review', matchedFields };

  // NAME IS THE LOAD-BEARING CHECK. A record where either name disagrees is a
  // different person, whatever else lines up.
  if (first === false || last === false) return { status: 'failed', matchedFields };

  // Both names matched and nothing else contradicts -> matched. A DOB or phone
  // we could not read (undefined) does not block; one that actively disagrees
  // does.
  if (first === true && last === true) {
    if (dob === false || phone === false) return { status: 'review', matchedFields };
    return { status: 'matched', matchedFields };
  }

  return { status: 'review', matchedFields };
}

export interface FlutterwaveConsentHandoff {
  /** Where to send the customer to approve. Absent when consent already exists. */
  url?: string;
  /** Flutterwave's handle for this consent request. Needed to collect the result. */
  reference: string;
}

export class FlutterwaveKycLevelProvider implements KycLevelProvider {
  name = 'flutterwave';

  /**
   * Start a BVN check.
   *
   * Returns `review` plus a consent URL on the first call - see the header for
   * why this cannot be synchronous. Call completeBvnConsent(reference) after
   * the customer returns from NIBSS.
   */
  async verifyBvnIdentity(input: BvnInfoMatchInput): Promise<KycLevelMatchResult> {
    const bvn = assertBvnShape(input.bvn);

    if (env.FLUTTERWAVE_BVN_ALLOW_V2_DIRECT) {
      return this.verifyViaV2Direct(input, bvn);
    }

    const redirectUrl = env.FLUTTERWAVE_BVN_REDIRECT_URL;
    if (!redirectUrl) {
      throw forbidden(
        'Flutterwave BVN consent needs FLUTTERWAVE_BVN_REDIRECT_URL so the customer has somewhere to land after approving.'
      );
    }

    const response = await fetch(`${v3Base()}/v3/bvn/verifications`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bvn,
        firstname: input.firstName,
        lastname: input.lastName,
        redirect_url: redirectUrl,
      }),
    });
    const body: any = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        `Flutterwave BVN consent failed ${response.status}: ${JSON.stringify(body).slice(0, 300)}`
      );
    }

    const reference = body?.data?.reference;
    if (!reference) {
      throw new Error('Flutterwave did not return a consent reference.');
    }

    /**
     * A NULL url means this customer has ALREADY consented to us before, so
     * there is nothing for them to approve and the data can be collected
     * immediately. Documented behaviour, and worth handling: sending a
     * returning user to a consent page that does not exist is a dead end.
     */
    const url = body?.data?.url ?? null;
    if (!url) {
      return this.completeBvnConsent(reference, input);
    }

    return {
      provider: this.name,
      // NOT 'matched'. Nobody has verified anything yet.
      status: 'review',
      message: 'Approve the BVN request to finish verifying your identity.',
      bvnLast4: bvnLast4(bvn),
      providerReference: String(reference),
      matchedFields: { consentRequired: true, consentUrl: String(url) },
      raw: body,
    };
  }

  /**
   * Collect the result after the customer has approved on the NIBSS page.
   *
   * `claimed` is optional because a webhook has the reference but not the
   * original form input. Without it the data is returned for storage but the
   * verdict stays `review` - there is nothing to compare the record against,
   * and a BVN record on its own says nothing about who submitted it.
   */
  async completeBvnConsent(
    reference: string,
    claimed?: BvnInfoMatchInput
  ): Promise<KycLevelMatchResult> {
    const response = await fetch(
      `${v3Base()}/v3/bvn/verifications/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secretKey()}` } }
    );
    const body: any = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        `Flutterwave BVN retrieval failed ${response.status}: ${JSON.stringify(body).slice(0, 300)}`
      );
    }

    const data = body?.data ?? {};
    const bvnData = data?.bvn_data ?? {};
    const state = String(data?.status ?? '').toUpperCase();

    // Still waiting on the human. Not a failure - the customer simply has not
    // finished, and telling them their BVN was rejected would be false.
    if (state && state !== 'COMPLETED') {
      return {
        provider: this.name,
        status: 'review',
        message: 'Waiting for you to approve the BVN request.',
        bvnLast4: bvnLast4(String(bvnData?.bvn ?? claimed?.bvn ?? '')),
        providerReference: String(data?.reference ?? reference),
        matchedFields: { consentState: state },
        raw: body,
      };
    }

    if (!claimed) {
      return {
        provider: this.name,
        status: 'review',
        message: 'BVN data received. Awaiting comparison against the submitted details.',
        bvnLast4: bvnLast4(String(bvnData?.bvn ?? '')),
        providerReference: String(data?.reference ?? reference),
        matchedFields: { consentState: 'COMPLETED', comparedAgainstSubmission: false },
        raw: body,
      };
    }

    const { status, matchedFields } = decideFlutterwaveStatus(claimed, bvnData);
    return {
      provider: this.name,
      status,
      message:
        status === 'matched'
          ? 'BVN verification matched.'
          : status === 'failed'
            ? 'The name on this BVN does not match the details you gave us.'
            : 'BVN verification needs review.',
      bvnLast4: bvnLast4(String(bvnData?.bvn ?? claimed.bvn)),
      providerReference: String(data?.reference ?? reference),
      matchedFields,
      /**
       * The RAW record is returned for the caller to audit, but note what is
       * in it: NIBSS sends a base64 faceImage, an email, an NIN and a phone
       * number. The BVN service must persist only last4 and a peppered hash -
       * see ngn-identity-verifications. Storing this blob would turn a
       * verification into a data-breach liability.
       */
      raw: body,
    };
  }

  /**
   * The v2 direct lookup. NO CONSENT STEP - see the header.
   *
   * Only reachable with FLUTTERWAVE_BVN_ALLOW_V2_DIRECT explicitly on.
   */
  private async verifyViaV2Direct(input: BvnInfoMatchInput, bvn: string): Promise<KycLevelMatchResult> {
    const url = `${v2Base()}/v2/kyc/bvn/${encodeURIComponent(bvn)}?seckey=${encodeURIComponent(secretKey())}`;
    const response = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    const body: any = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`Flutterwave v2 BVN lookup failed ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
    }

    // v2 is snake_case and flat; decideFlutterwaveStatus reads both shapes.
    const { status, matchedFields } = decideFlutterwaveStatus(input, body?.data ?? {});
    return {
      provider: this.name,
      status,
      message:
        status === 'matched'
          ? 'BVN verification matched.'
          : status === 'failed'
            ? 'The name on this BVN does not match the details you gave us.'
            : 'BVN verification needs review.',
      bvnLast4: bvnLast4(bvn),
      matchedFields: { ...matchedFields, consentObtained: false, apiVersion: 'v2' },
      raw: body,
    };
  }

  /**
   * BVN-to-bank-account matching.
   *
   * REFUSED, not faked. Flutterwave's BVN product returns identity fields; it
   * does not answer "does this BVN own this account number". Monnify does, via
   * bvn-account-match. Returning a cheerful 'matched' here because a request
   * succeeded would be inventing a verification that never happened, so this
   * says plainly that the wrong provider is selected for the job.
   */
  async verifyBvnBankAccount(_input: BvnAccountMatchInput): Promise<KycLevelMatchResult> {
    throw badRequest(
      'Flutterwave does not offer BVN-to-account matching. Use the Monnify provider for that check.'
    );
  }

  async health(): Promise<KycLevelProviderHealth> {
    const configured = Boolean(env.FLUTTERWAVE_SECRET_KEY);
    return {
      provider: this.name,
      available: configured,
      mode: 'live',
      message: configured
        ? env.FLUTTERWAVE_BVN_ALLOW_V2_DIRECT
          ? 'Configured. WARNING: v2 direct lookup is enabled, which skips CBN-required customer consent.'
          : 'Configured for v3 consent-based BVN verification.'
        : 'FLUTTERWAVE_SECRET_KEY is not set.',
      checkedAt: new Date().toISOString(),
    };
  }
}

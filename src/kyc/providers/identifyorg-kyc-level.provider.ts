import { env } from '../../config/env.js';
import { badRequest } from '../../shared/errors.js';
import type {
  BvnAccountMatchInput,
  BvnInfoMatchInput,
  KycLevelMatchResult,
  KycLevelProvider,
  KycLevelProviderHealth,
} from './kyc-level-provider.js';
import { bvnLast4 } from './kyc-level-provider.js';

/**
 * IDENTIFYORG - a synchronous Nigerian identity provider.
 *
 * WHY THIS ONE, AND WHY NOW. Neither incumbent can carry Level 2:
 *
 *   - Monnify: no live API key has been issued to this account. The provider
 *     exists and is correct, but it cannot answer a single request.
 *   - Flutterwave: the path that works is v2 - a direct BVN lookup with NO
 *     consent step, which is the thing the CBN expects a merchant not to do.
 *     Its compliant v3 flow requires a human on a NIBSS page entering an OTP,
 *     so it cannot settle inside one request and returns `review` by design.
 *
 * IdentifyOrg answers in ONE synchronous call and accepts first_name,
 * last_name and date_of_birth for cross-matching - which is exactly the shape
 * BvnInfoMatchInput already carries. That is the whole reason it drops into
 * this interface without changing it.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE INTEGRATION IS DIRECT HTTP, NOT THEIR SDK. DELIBERATELY.
 *
 * @identifyorg/node-sdk is at 0.1.0, a single published version, one
 * maintainer, first published 2026-07-06. Taking a two-month-old package as a
 * dependency in the KYC path means an SDK breaking change can stop Nigerian
 * users verifying. Every other provider in this directory calls its vendor
 * with fetch(); this one matches, and the surface we depend on is three
 * documented endpoints rather than someone else's release cadence.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHAT IT CANNOT DO, STATED UP FRONT.
 *
 * There is no BVN-to-bank-account endpoint in their API. verifyBvnBankAccount
 * therefore refuses, exactly as the Flutterwave provider already does for the
 * same missing capability. This is NOT a silent gap: capabilities() below
 * declares it, so the failover chain can skip this provider for that operation
 * instead of discovering it by exception.
 *
 * ─────────────────────────────────────────────────────────────────────
 * A `match: true` IS NOT AUTOMATICALLY A PASS.
 *
 * Their BVN response carries BOTH `match` (boolean) and `confidence_score`
 * (0-100). Trusting the boolean alone would let a weak cross-match grant
 * Level 2 - and Level 2 raises a user's ceiling to NGN 5,000,000. So a match
 * below IDENTIFYORG_MIN_CONFIDENCE is downgraded to `review` for a human,
 * never to `matched`. The failure direction matters: over-refusing costs a
 * support ticket, over-accepting costs money that is already gone.
 *
 * NOTHING HERE RETRIES. Their responses carry a `cost` in NGN, so a retry loop
 * against this API is a spending bug as much as a correctness one. The
 * failover chain above may try a DIFFERENT provider on an error; it must never
 * re-ask this one.
 */

const PROVIDER_NAME = 'identifyorg';

/**
 * How long to wait before giving up on a single call.
 *
 * Their documentation quotes under 3s for BVN and under 4s for NIN. 12s is
 * generous enough to absorb a slow upstream without being long enough to hold
 * the caller past the Cloudflare worker's own 12s abort, which would surface
 * to the user as a gateway 503 rather than an honest provider error.
 */
const REQUEST_TIMEOUT_MS = 12_000;

function baseUrl() {
  return env.IDENTIFYORG_BASE_URL.replace(/\/$/, '');
}

function apiKey() {
  const key = env.IDENTIFYORG_API_KEY;
  if (!key) {
    /**
     * A missing key is a misconfiguration, not a verification failure.
     *
     * Thrown rather than returned as `failed`, because the failover chain
     * treats a thrown error as "this provider could not answer" and moves on,
     * while a `failed` verdict is final and would deny a user who has done
     * nothing wrong.
     */
    throw badRequest('IdentifyOrg is not configured. Set IDENTIFYORG_API_KEY.');
  }
  return key;
}

/** True when this provider can actually be called at all. */
export function isIdentifyOrgConfigured() {
  return Boolean(env.IDENTIFYORG_API_KEY);
}

type IdentifyOrgVerifyResponse = {
  id?: string;
  type?: string;
  status?: string;
  match?: boolean | null;
  confidence_score?: number | null;
  data?: Record<string, unknown> | null;
  cost?: number;
  currency?: string;
  is_test?: boolean;
  message?: string;
  error?: string;
  detail?: string;
};

async function postJson(path: string, body: Record<string, unknown>): Promise<IdentifyOrgVerifyResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-IdentifyOrg-Key': apiKey(),
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json().catch(() => ({}))) as IdentifyOrgVerifyResponse;

    if (!response.ok) {
      /**
       * A NON-2xx IS AN ERROR, NEVER A VERDICT.
       *
       * Returning `failed` here would tell the chain "this BVN does not
       * match", which is a statement about the customer. A 401 from a bad key
       * or a 402 from an empty balance says nothing whatsoever about them, and
       * must not deny their verification. Thrown, so the chain can try another
       * provider or surface a real outage.
       */
      const detail = payload.message || payload.error || payload.detail || `HTTP ${response.status}`;
      throw badRequest(`IdentifyOrg ${path} failed: ${detail}`);
    }

    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw badRequest(`IdentifyOrg did not respond within ${REQUEST_TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Turn their answer into one of our three verdicts.
 *
 * The rules, in order, and each is a deliberate refusal to be generous:
 *
 *   status !== 'success'  -> review. Their pipeline did not complete; that is
 *                            not evidence against the customer.
 *   match === false       -> failed. An explicit negative from the vendor.
 *   match === true, score
 *     below threshold     -> review. See the header: a weak cross-match must
 *                            not grant a NGN 5,000,000 ceiling.
 *   match === true, score
 *     at/above threshold  -> matched.
 *   match null/absent     -> review. Absence of an answer is not an answer.
 */
function toVerdict(payload: IdentifyOrgVerifyResponse): { status: KycLevelMatchResult['status']; message: string } {
  const minConfidence = env.IDENTIFYORG_MIN_CONFIDENCE;
  const score = typeof payload.confidence_score === 'number' ? payload.confidence_score : undefined;

  if (payload.status && payload.status !== 'success') {
    return { status: 'review', message: `IdentifyOrg returned status "${payload.status}". Sent for manual review.` };
  }
  if (payload.match === false) {
    return { status: 'failed', message: 'The details provided do not match the record on file.' };
  }
  if (payload.match === true) {
    if (score !== undefined && score < minConfidence) {
      return {
        status: 'review',
        message: `Matched at ${score}% confidence, below the ${minConfidence}% threshold. Sent for manual review.`,
      };
    }
    return { status: 'matched', message: score !== undefined ? `Verified at ${score}% confidence.` : 'Verified.' };
  }
  return { status: 'review', message: 'IdentifyOrg did not return a match decision. Sent for manual review.' };
}

/**
 * Which of the returned fields actually agreed.
 *
 * Recorded so a `review` is auditable: an operator looking at a held
 * verification can see WHICH field disagreed rather than re-running the check.
 * Compared case- and whitespace-insensitively because vendors return
 * "OKAFOR ADAEZE N" where the user typed "Adaeze Okafor".
 */
function matchedFields(input: BvnInfoMatchInput, data: Record<string, unknown> | null | undefined) {
  if (!data) return undefined;
  const norm = (value: unknown) => String(value ?? '').trim().toLowerCase();
  const fields: Record<string, boolean | string> = {};

  if (data.date_of_birth) fields.dateOfBirth = norm(data.date_of_birth) === norm(input.dateOfBirth);
  if (data.first_name) fields.firstName = norm(data.first_name) === norm(input.firstName);
  if (data.last_name) fields.lastName = norm(data.last_name) === norm(input.lastName);
  /**
   * Phone is compared on the last 10 digits.
   *
   * They return +2348012345678 where the user typed 08012345678 - the same
   * number in two national formats. A string compare would report a mismatch
   * on every single verification.
   */
  if (data.phone_number) {
    const tail = (value: unknown) => String(value ?? '').replace(/\D/g, '').slice(-10);
    fields.mobileNo = tail(data.phone_number) === tail(input.mobileNo);
  }
  return Object.keys(fields).length ? fields : undefined;
}

export class IdentifyOrgKycLevelProvider implements KycLevelProvider {
  name = PROVIDER_NAME;

  /**
   * What this vendor can actually answer.
   *
   * Declared rather than discovered by exception, so the failover chain can
   * SKIP this provider for an operation it structurally cannot perform. Before
   * this existed, an unsupported call threw, the chain read that as a
   * transient error, and moved to the next provider - which is right when a
   * vendor is down and wrong when it simply does not offer the endpoint.
   */
  capabilities() {
    return { bvnIdentity: true, bvnBankAccount: false };
  }

  async verifyBvnIdentity(input: BvnInfoMatchInput): Promise<KycLevelMatchResult> {
    /**
     * phone_number is REQUIRED on live keys - their upstream rejects requests
     * without it. Checked here so the failure is a clear message rather than
     * an opaque 4xx from the vendor, and so we do not spend a metered call
     * discovering something we already know.
     */
    if (!input.mobileNo) {
      throw badRequest('A phone number is required for IdentifyOrg BVN verification.');
    }

    const payload = await postJson('/v1/verify/bvn', {
      bvn: input.bvn,
      phone_number: input.mobileNo,
      first_name: input.firstName,
      last_name: input.lastName,
      date_of_birth: input.dateOfBirth,
    });

    const verdict = toVerdict(payload);

    return {
      provider: this.name,
      status: verdict.status,
      message: verdict.message,
      bvnLast4: bvnLast4(input.bvn),
      matchedFields: matchedFields(input, payload.data),
      providerReference: payload.id,
      /**
       * The raw body is kept for the audit trail, MINUS the echoed BVN.
       *
       * They return the full 11-digit BVN in `data.bvn`. Storing it would put
       * a complete BVN in an audit log for every verification - migration 047
       * exists precisely because a BVN links every bank account a person owns
       * and must never be stored. Last four only, which is what the rest of
       * the system already records.
       */
      raw: redactBvn(payload),
    };
  }

  async verifyBvnBankAccount(_input: BvnAccountMatchInput): Promise<KycLevelMatchResult> {
    /**
     * Not supported, and said plainly.
     *
     * Their API has no BVN-to-account endpoint. The Flutterwave provider
     * refuses the same way for the same reason; capabilities() above is what
     * lets the chain avoid reaching this line at all.
     */
    throw badRequest(
      'IdentifyOrg does not offer BVN-to-account matching. Use the Monnify provider for that check.'
    );
  }

  async health(): Promise<KycLevelProviderHealth> {
    const checkedAt = new Date().toISOString();

    if (!isIdentifyOrgConfigured()) {
      return {
        provider: this.name,
        available: false,
        mode: 'live',
        message: 'IDENTIFYORG_API_KEY is not set.',
        checkedAt,
      };
    }

    /**
     * GET /v1/balance is the honest health check.
     *
     * It proves three things at once that a ping cannot: the service is up,
     * the key is valid, and there is credit to pay for a verification. A
     * provider with an expired key or a zero balance is not "available" - it
     * will fail the first real customer - so both are reported as unavailable
     * rather than as a green light.
     */
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${baseUrl()}/v1/balance`, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'X-IdentifyOrg-Key': env.IDENTIFYORG_API_KEY, Accept: 'application/json' },
      });
      const payload = (await response.json().catch(() => ({}))) as {
        balance?: number;
        currency?: string;
        low_balance?: boolean;
        free_tier_remaining?: number;
      };

      if (!response.ok) {
        return {
          provider: this.name,
          available: false,
          mode: 'live',
          message: `IdentifyOrg balance check returned ${response.status}.`,
          checkedAt,
        };
      }

      const balance = typeof payload.balance === 'number' ? payload.balance : undefined;
      const freeTier = typeof payload.free_tier_remaining === 'number' ? payload.free_tier_remaining : 0;
      /**
       * Out of money AND out of free calls is unavailable, not degraded. The
       * next verification would fail, and reporting "available" would keep the
       * Level 2 button on screen for a check that cannot run.
       */
      const spendable = (balance ?? 0) > 0 || freeTier > 0;

      return {
        provider: this.name,
        available: spendable,
        mode: 'live',
        message: spendable
          ? `IdentifyOrg reachable. Balance ${balance ?? 'unknown'} ${payload.currency ?? ''}`.trim() +
            (payload.low_balance ? ' (low balance).' : '.')
          : 'IdentifyOrg has no remaining balance or free-tier calls.',
        checkedAt,
      };
    } catch (error) {
      return {
        provider: this.name,
        available: false,
        mode: 'live',
        message: error instanceof Error ? error.message : String(error),
        checkedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Strip the echoed full BVN before anything is persisted. See migration 047. */
function redactBvn(payload: IdentifyOrgVerifyResponse): IdentifyOrgVerifyResponse {
  if (!payload?.data || typeof payload.data !== 'object') return payload;
  const data = { ...(payload.data as Record<string, unknown>) };
  if (data.bvn) data.bvn = `***${bvnLast4(String(data.bvn))}`;
  if (data.nin) data.nin = `***${String(data.nin).slice(-4)}`;
  return { ...payload, data };
}

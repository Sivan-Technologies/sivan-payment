/**
 * PAYSTACK DEDICATED VIRTUAL ACCOUNT PROVIDER.
 *
 * The transport layer for the three-step DVA flow. This file talks to
 * Paystack and nothing else: no database, no ledger, no user model. That
 * belongs in paystackDvaService.ts, so this stays testable against the live
 * sandbox without touching state.
 *
 *   createCustomer()          POST /customer
 *   validateCustomerBvnNin()  POST /customer/{code}/identification
 *   assignDedicatedAccount()  POST /dedicated_account
 *   fetchProviders()          GET  /dedicated_account/available_providers
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG, ALL VERIFIED AGAINST PAYSTACK DOCS
 *
 * 1. TEST MODE USES A DIFFERENT BANK. With an sk_test_ key, preferred_bank
 *    MUST be 'test-bank'. Passing 'wema-bank' fails. The bank is therefore
 *    derived from the key mode rather than passed in, so staging cannot
 *    accidentally request a production bank.
 *
 * 2. HTTP 200 IS NOT SUCCESS. Paystack returns 200 with {status:false} on
 *    business failures. Checking response.ok alone treats a declined
 *    identity check as a successful one.
 *
 * 3. IDENTIFICATION IS ASYNCHRONOUS. POST /identification returns 202 with no
 *    verdict. The result arrives later as customeridentification.success or
 *    .failed. Returning "verified" from this call would assign an account to
 *    an unverified customer, which is the exact CBN requirement the step
 *    exists to satisfy.
 *
 * NDPR: the raw BVN passes through validateCustomerBvnNin() and is never
 * returned, logged, or attached to an error. See redactIdentifier().
 */

import {
  paystackBaseUrl,
  paystackHeaders,
  paystackMode,
} from '../../config/paystackConfig.js';
import {
  type CustomerPayload,
  type CustomerData,
  type CustomerResponse,
  type IdentificationPayload,
  type IdentificationResponse,
  type DvaRequest,
  type DvaAssignedAccount,
  type DvaResponse,
  type PreferredBank,
  type PaystackEnvelope,
  PREFERRED_BANK_BY_MODE,
  isPaystackSuccess,
} from '../types/paystackDvaTypes.js';

/** Raised when Paystack answers with status:false, carrying their message. */
export class PaystackApiError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly httpStatus: number,
    readonly paystackMessage?: string,
    readonly fieldErrors?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'PaystackApiError';
  }
}

/**
 * Never let an identifier reach a log, an error, or a stack trace.
 *
 * Keeps the last two digits only, which is enough for a support agent to
 * confirm the user typed what they meant without the value being recoverable.
 */
export function redactIdentifier(value: string): string {
  const v = String(value ?? '');
  if (v.length <= 2) return '**';
  return `${'*'.repeat(v.length - 2)}${v.slice(-2)}`;
}

const DEFAULT_TIMEOUT_MS = 20_000;

interface RequestOptions {
  timeoutMs?: number;
  /** Paystack honours idempotency on customer creation via a stable email. */
  signal?: AbortSignal;
}

/**
 * One Paystack REST call.
 *
 * Deliberately NOT retried here. A retry on POST /customer or
 * POST /dedicated_account risks creating a duplicate customer or a second
 * bank account for one user, and Paystack does not accept an idempotency key
 * on these endpoints. Retry policy belongs to the service layer, which can
 * first check whether the resource already exists.
 */
async function paystackRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  options: RequestOptions = {}
): Promise<PaystackEnvelope<T>> {
  const url = `${paystackBaseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: paystackHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal ?? controller.signal,
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new PaystackApiError(
        `Paystack ${method} ${path} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms. ` +
          'The request may still have been processed: check before retrying, or a duplicate customer or account may be created.',
        path,
        0
      );
    }
    throw new PaystackApiError(`Paystack ${method} ${path} failed: ${String(error?.message ?? error)}`, path, 0);
  } finally {
    clearTimeout(timer);
  }

  let parsed: any;
  try {
    parsed = await response.json();
  } catch {
    throw new PaystackApiError(
      `Paystack ${method} ${path} returned a non-JSON body with HTTP ${response.status}.`,
      path,
      response.status
    );
  }

  /**
   * status:false on HTTP 200 is a real Paystack failure mode, so the envelope
   * is checked before the HTTP code. Their message is surfaced verbatim
   * because it is usually the actionable part ("Customer already has a
   * dedicated account", "Business not activated for this feature").
   */
  if (!isPaystackSuccess<T>(parsed)) {
    throw new PaystackApiError(
      `Paystack ${method} ${path} rejected the request: ${parsed?.message ?? 'no message'}`,
      path,
      response.status,
      parsed?.message,
      parsed?.errors
    );
  }

  return parsed as PaystackEnvelope<T>;
}

/**
 * STEP A. Create or fetch the Paystack customer record.
 *
 * `email` must be deterministic per user (Sivan derives it from the phone
 * number) because it is Paystack's unique key. Calling this twice with the
 * same email returns the EXISTING customer rather than creating a duplicate,
 * which is what makes the flow safe to re-enter after a dropped connection.
 */
export async function createCustomer(
  payload: CustomerPayload,
  options: RequestOptions = {}
): Promise<CustomerData> {
  if (!payload.email?.trim()) {
    throw new Error('createCustomer requires a deterministic email; it is Paystack\'s unique customer key.');
  }
  if (!payload.first_name?.trim() || !payload.last_name?.trim()) {
    throw new Error(
      'createCustomer requires first_name and last_name. Paystack uses them to name the bank account, ' +
        'and a DVA cannot be issued without them.'
    );
  }
  const res = await paystackRequest<CustomerData>('POST', '/customer', payload, options);
  return (res as CustomerResponse).data;
}

/**
 * STEP B. Submit the customer's BVN to NIBSS for validation.
 *
 * RETURNS ACCEPTANCE, NOT A VERDICT. Paystack answers 202 and validates
 * asynchronously; the outcome arrives as a webhook. The return type says
 * `accepted` rather than `verified` so no caller can mistake one for the
 * other.
 *
 * Only 'bvn' and 'bank_account' are supported by this endpoint. A NIN cannot
 * be validated here, despite the onboarding copy offering it.
 */
export async function validateCustomerBvnNin(
  customerCode: string,
  payload: IdentificationPayload,
  options: RequestOptions = {}
): Promise<{ accepted: true; message: string }> {
  if (!customerCode?.startsWith('CUS_')) {
    throw new Error(`Expected a Paystack customer code starting with CUS_, got: ${customerCode}`);
  }
  if (payload.type === 'bvn' && !/^\d{11}$/.test(payload.value ?? '')) {
    // Length checked before transmission so an obvious typo does not consume
    // a NIBSS lookup. The value itself is never echoed.
    throw new Error(
      `A BVN must be exactly 11 digits. Received a ${String(payload.value ?? '').length} character value.`
    );
  }

  try {
    const res = await paystackRequest<Record<string, unknown>>(
      'POST',
      `/customer/${encodeURIComponent(customerCode)}/identification`,
      payload,
      options
    );
    return { accepted: true, message: (res as IdentificationResponse).message };
  } catch (error) {
    /**
     * Re-thrown with the identifier redacted. A PaystackApiError can carry
     * field errors that echo the submitted value, and those propagate into
     * logs and error trackers.
     */
    if (error instanceof PaystackApiError) {
      throw new PaystackApiError(
        error.message.replace(payload.value, redactIdentifier(payload.value)),
        error.endpoint,
        error.httpStatus,
        error.paystackMessage?.replace(payload.value, redactIdentifier(payload.value)),
        error.fieldErrors
      );
    }
    throw error;
  }
}

/**
 * The bank slug to request, derived from the key mode.
 *
 * Not a parameter by default: with an sk_test_ key Paystack requires
 * 'test-bank', and a staging deployment asking for 'wema-bank' simply fails.
 * Deriving it removes an entire class of environment mismatch.
 */
export function preferredBankForMode(): PreferredBank {
  return PREFERRED_BANK_BY_MODE[paystackMode()];
}

/**
 * STEP C. Assign a dedicated NUBAN to the customer.
 *
 * Refuses an explicit bank that contradicts the key mode, rather than letting
 * Paystack return an opaque failure.
 */
export async function assignDedicatedAccount(
  request: Omit<DvaRequest, 'preferred_bank'> & { preferred_bank?: PreferredBank },
  options: RequestOptions = {}
): Promise<DvaAssignedAccount> {
  if (!request.customer?.startsWith('CUS_')) {
    throw new Error(`Expected a Paystack customer code starting with CUS_, got: ${request.customer}`);
  }

  const expected = preferredBankForMode();
  const bank = request.preferred_bank ?? expected;

  if (bank !== expected) {
    const mode = paystackMode();
    throw new Error(
      `preferred_bank '${bank}' does not match the ${mode} key in use, which requires '${expected}'. ` +
        (mode === 'test'
          ? 'Paystack only issues test DVAs through test-bank.'
          : 'test-bank cannot be used with a live key.')
    );
  }

  const res = await paystackRequest<DvaAssignedAccount>(
    'POST',
    '/dedicated_account',
    { ...request, preferred_bank: bank },
    options
  );

  const account = (res as DvaResponse).data;

  /**
   * An assigned but inactive account takes deposits nowhere. Surfacing it as
   * a normal result would have the chat interface hand a user an account
   * number that silently swallows their money.
   */
  if (!account?.account_number) {
    throw new PaystackApiError(
      'Paystack reported success but returned no account number.',
      '/dedicated_account',
      200
    );
  }

  return account;
}

/**
 * Supported DVA banks for THIS integration, straight from Paystack.
 *
 * Preferred over trusting a hardcoded slug: availability differs per
 * business and changes without notice, and this is the cheapest way to find
 * out before a user is waiting in a chat window.
 */
export async function fetchProviders(
  options: RequestOptions = {}
): Promise<Array<{ provider_slug: string; bank_id: number; bank_name: string; id: number }>> {
  const res = await paystackRequest<Array<{ provider_slug: string; bank_id: number; bank_name: string; id: number }>>(
    'GET',
    '/dedicated_account/available_providers',
    undefined,
    options
  );
  return res.data;
}

/**
 * Cheap liveness and credential check.
 *
 * Hits a harmless authenticated endpoint so a readiness probe can tell
 * "Paystack is reachable and our key works" from "our key is wrong", which
 * otherwise both present as a failed DVA creation to the user.
 */
export async function pingPaystack(options: RequestOptions = {}): Promise<{
  reachable: boolean;
  authenticated: boolean;
  mode: 'live' | 'test';
  message?: string;
}> {
  const mode = paystackMode();
  try {
    await paystackRequest('GET', '/customer?perPage=1', undefined, { timeoutMs: 8_000, ...options });
    return { reachable: true, authenticated: true, mode };
  } catch (error) {
    if (error instanceof PaystackApiError) {
      const unauthenticated = error.httpStatus === 401;
      return {
        reachable: error.httpStatus !== 0,
        authenticated: !unauthenticated && error.httpStatus !== 0,
        mode,
        message: error.paystackMessage ?? error.message,
      };
    }
    return { reachable: false, authenticated: false, mode, message: String(error) };
  }
}

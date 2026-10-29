/**
 * A vocabulary for the ways a utility provider can refuse us.
 *
 * WHY THIS EXISTS
 *
 * Every provider failure used to surface the same way: the adapter threw a
 * bare Error carrying the vendor's own sentence, nothing caught it, and the
 * global error handler turned it into a 500 with the body "Internal server
 * error". That is wrong in three separate directions at once.
 *
 *   1. The customer is told nothing they can act on. A mistyped phone number
 *      and our own float running dry produced the identical message.
 *   2. Every ordinary business decline was reported as a server crash, so
 *      Sentry and the ops Telegram alert fired on events that are not bugs.
 *   3. The one case that genuinely needs an operator - our float being empty -
 *      was indistinguishable from noise.
 *
 * THE TRAP THIS IS MOSTLY HERE TO PREVENT
 *
 * When SME API says "insufficient balance" it is talking about OUR wallet with
 * them, never about the customer's Sivan balance. Those two conditions are
 * unrelated and must never share wording: a customer holding 51,400 NGN who is
 * told they have insufficient funds will not try again, they will lose trust in
 * the ledger. So no message produced for a provider-side shortfall mentions the
 * customer's balance at all, and the two live phrasings SME API uses for it
 * ("Your wallet balance is insufficient for this purchase..." on data,
 * "Insufficient balance fund your wallet and try again" on airtime) both map
 * here rather than anywhere near the customer-funds path.
 */

/** Who can actually fix this, and is it safe to try another provider. */
export type UtilityFailureReason =
  /** Our wallet with the provider is empty. Declined before delivery. */
  | 'provider_float_exhausted'
  /** Our API key is wrong, expired or disabled. Declined before delivery. */
  | 'provider_auth_failed'
  /** We could not reach the provider at all. Nothing was sent. */
  | 'provider_unavailable'
  /** We sent the request and never learned the outcome. AMBIGUOUS. */
  | 'provider_timeout'
  /** The recipient details are wrong. The customer can fix this. */
  | 'invalid_recipient'
  /** The plan code is unknown upstream. An administrator can fix this. */
  | 'invalid_plan'
  /** The provider declined for a reason we do not recognise. */
  | 'upstream_declined';

export class UtilityProviderError extends Error {
  readonly reason: UtilityFailureReason;
  readonly provider: string;
  /** The vendor's own words. For logs and support only - never shown to a customer. */
  readonly upstreamMessage: string;
  readonly context: string;

  constructor(input: {
    reason: UtilityFailureReason;
    provider: string;
    context: string;
    upstreamMessage: string;
  }) {
    super(`${input.provider} ${input.context} failed (${input.reason}): ${input.upstreamMessage}`);
    this.name = 'UtilityProviderError';
    this.reason = input.reason;
    this.provider = input.provider;
    this.context = input.context;
    this.upstreamMessage = input.upstreamMessage;
  }
}

/**
 * Is it safe to retry this on a different provider?
 *
 * The question is not "might the next provider succeed" but "do we KNOW the
 * first one delivered nothing". Retrying a request that may already have put
 * airtime on someone's phone means paying twice for one sale.
 *
 * A provider that answered us, even to say no, has told us it did not deliver,
 * so those are all safe. A provider that never answered has told us nothing:
 * a timeout is the one case where the purchase may have gone through, so we
 * stop and let a human reconcile rather than guess.
 *
 * Deterministic faults - a malformed phone number, a plan code that does not
 * exist - are excluded for a different reason: the second provider would reject
 * them too, so failing over only doubles the customer's wait before the same
 * answer.
 */
export function canFailOver(reason: UtilityFailureReason): boolean {
  switch (reason) {
    case 'provider_float_exhausted':
    case 'provider_auth_failed':
    case 'provider_unavailable':
    case 'upstream_declined':
      return true;
    case 'provider_timeout':
    case 'invalid_recipient':
    case 'invalid_plan':
      return false;
  }
}

/** Ours to fix, as opposed to the customer's. Drives alerting, not wording. */
export function isOperatorFault(reason: UtilityFailureReason): boolean {
  return reason !== 'invalid_recipient';
}

/** HTTP status. Note that none of these are 500: none of them are bugs. */
export function statusForReason(reason: UtilityFailureReason): number {
  switch (reason) {
    case 'invalid_recipient':
      return 400;
    case 'invalid_plan':
      return 409;
    case 'provider_float_exhausted':
    case 'provider_auth_failed':
    case 'provider_unavailable':
      return 503;
    case 'provider_timeout':
    case 'upstream_declined':
      return 502;
  }
}

/**
 * What the customer is told.
 *
 * The provider-side cases deliberately say "nothing was deducted" and stop
 * there. They do not name the provider, do not repeat the vendor's sentence,
 * and do not use the word balance - see the file header for why that last one
 * matters more than it looks.
 *
 * This is only safe to state because the ledger debit is recorded AFTER the
 * provider call returns success, so a failure genuinely leaves the customer's
 * money untouched. If that ordering is ever changed, this wording becomes a
 * lie and must change with it.
 */
export function customerMessageForReason(reason: UtilityFailureReason): string {
  switch (reason) {
    case 'invalid_recipient':
      return "That doesn't look like a valid 11-digit number. Check it and try again.";
    case 'invalid_plan':
      return "That bundle isn't available right now. Please pick another one.";
    case 'provider_timeout':
      return 'This is taking longer than expected to confirm. Do not retry yet - we are checking it and will update you shortly.';
    default:
      return "We couldn't complete this right now. Nothing was deducted. Please try again shortly.";
  }
}

/** A stable code the WhatsApp and Telegram bots can switch on. */
export function codeForReason(reason: UtilityFailureReason): string {
  return reason.toUpperCase();
}

/**
 * Read SME API's prose and decide which of the cases above it is.
 *
 * Matched against the live API rather than its documentation: every string
 * below was produced by probing the real endpoint. SME API reports business
 * failures as HTTP 200 with { status: 'fail', msg }, so this text is the only
 * signal available - there is no error code to key off.
 */
export function classifySmeApiMessage(raw: string): UtilityFailureReason {
  const text = String(raw ?? '').toLowerCase();

  // Both live phrasings of our own float running dry. "Insufficient" from an
  // upstream aggregator is always about our wallet, never the customer's.
  if (text.includes('insufficient') || (text.includes('fund your wallet') && text.includes('balance'))) {
    return 'provider_float_exhausted';
  }
  if (text.includes('authorization token') || text.includes('unauthorized') || text.includes('invalid token')) {
    return 'provider_auth_failed';
  }
  if (text.includes('phone number') || text.includes('11 digit')) {
    return 'invalid_recipient';
  }
  if (text.includes('plan id') || text.includes('invalid plan')) {
    return 'invalid_plan';
  }
  return 'upstream_declined';
}

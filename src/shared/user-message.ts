/**
 * WHAT A USER IS ALLOWED TO BE TOLD.
 *
 * Caught on production, on a phone, by a real person entering a bank account:
 *
 *   "Bank verification is unavailable right now (provider: breet).
 *    Breet: failed to validate bank account."
 *
 * Three separate failures in one red box:
 *
 *   1. IT NAMES OUR PROVIDER. "breet" is a commercial relationship, not the
 *      user's business. It tells an attacker exactly which upstream to probe,
 *      it tells a competitor how the rails are wired, and it makes Sivan look
 *      like a thin wrapper. Naming Bridge, Privy, PajRamp or Resend is the
 *      same mistake.
 *
 *   2. IT SAYS "unavailable" WHEN THE SERVICE IS FINE. The upstream answered
 *      perfectly well; it declined that particular account. Blaming an outage
 *      for a rejected input tells the user to come back later, when the thing
 *      that would actually help is re-checking the digits.
 *
 *   3. IT DOES NOT SAY WHAT TO DO. The one thing the user can act on - "check
 *      the number and the bank" - is the one thing missing.
 *
 * The rule this file enforces: an upstream's own words never reach a user
 * verbatim. They are mapped to a sentence that is true, actionable and says
 * nothing about our supply chain. The raw text is preserved for logs and
 * Sentry, where it belongs.
 */

/**
 * Every name that must never appear in a user-facing string.
 *
 * Deliberately a denylist over a stricter allowlist because messages are
 * written freehand all over the service; a scan that catches the known names
 * is enforceable today, and the test asserts every route's output against it.
 */
export const PROVIDER_NAMES = [
  'breet',
  'bridge',
  'pajramp',
  'paj ramp',
  'privy',
  'resend',
  'nomba',
  'eversend',
  'linkio',
  'alchemy',
  'neon',
  'render',
  'sumsub',
  'persona',
] as const;

/** Internals that are equally not a user's business. */
const LEAKY_FRAGMENTS = [
  'provider:',
  'api key',
  'apikey',
  'app_secret',
  'app secret',
  'x-app-',
  'unauthorized',
  'econnrefused',
  'enotfound',
  'etimedout',
  'stack trace',
  'sql',
  'postgres',
  'undefined is not',
  'cannot read properties',
  'internal server error',
];

/**
 * Does this string leak something a user should not see?
 *
 * Word-boundary matched, so "bridge" catches the provider but not a legitimate
 * word that merely contains those letters. Used by the guard test to sweep
 * every response the API can produce.
 */
export function leaksInternals(message: string): string | undefined {
  const text = String(message ?? '').toLowerCase();
  for (const name of PROVIDER_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return name;
  }
  for (const fragment of LEAKY_FRAGMENTS) {
    if (text.includes(fragment)) return fragment;
  }
  return undefined;
}

/**
 * Turn an upstream bank-resolution failure into something a user can act on.
 *
 * THE DISTINCTION THAT MATTERS: is this the user's input, or is it us?
 *
 * An upstream that says "failed to validate", "not found", "invalid account"
 * has done its job and declined the account. That is the user's input, and the
 * honest, useful answer names the two fields they can change.
 *
 * An upstream that is unreachable, unauthenticated or timing out is OUR
 * problem. The user cannot fix it by retyping, so telling them to check their
 * digits would send them round a loop they can never exit. That case says so
 * plainly and points at support.
 */
export function bankResolutionMessage(rawError: unknown): string {
  const raw = String((rawError as any)?.message ?? rawError ?? '').toLowerCase();

  // OURS. Credentials, connectivity, rate limits, upstream 5xx.
  const isOurFault =
    /wrong app id|app id and secret|unauthor|forbidden|expired|invalid key|credential/.test(raw) ||
    /econnrefused|enotfound|etimedout|socket|network|timeout|fetch failed/.test(raw) ||
    /rate limit|too many requests|429/.test(raw) ||
    /50\d\b|internal server|bad gateway|service unavailable/.test(raw);

  if (isOurFault) {
    return (
      'We could not check that bank account right now. This is on our side, not yours - ' +
      'please try again in a few minutes, and contact support if it keeps happening.'
    );
  }

  // THEIRS-ABOUT-THE-USER. The upstream answered and declined the account.
  return (
    'We could not confirm that account. Check the account number and that you picked the ' +
    'right bank, then try again.'
  );
}

/**
 * Last line of defence, applied in the Fastify error handler.
 *
 * Anything that still carries a provider name or an internal fragment by the
 * time it is about to be serialised is replaced wholesale. Deliberately a
 * generic sentence: a message that reaches here was not written to be read by
 * a user, so no amount of trimming makes it a good one.
 *
 * This is a NET, not the primary mechanism. Call sites should produce a good
 * message themselves; this exists so that the one nobody thought about is
 * still safe.
 */
export function safeUserMessage(message: string, statusCode: number): string {
  if (!leaksInternals(message)) return message;

  if (statusCode >= 500 || statusCode === 503) {
    return 'Something went wrong on our side. Please try again shortly.';
  }
  return 'We could not complete that request. Please check your details and try again.';
}

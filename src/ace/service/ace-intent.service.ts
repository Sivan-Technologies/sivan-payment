import type { AceIntent, AceResourceType } from '../types/ace.types.js';

/**
 * WHAT THE USER IS ACTUALLY ASKING ABOUT.
 *
 * The previous version of this file was two regexes and a fallthrough. Every
 * real question landed on 'general':
 *
 *   "I need help with verification."  -> general
 *   "What is my verification status?" -> general
 *   "kyc"                             -> general
 *   "ngnt_f17c5017-..."               -> general
 *
 * There was no verification intent at all, and 'general' meant "attach the
 * user's newest transaction" downstream - so asking about KYC returned a buy
 * order status report the user never asked for, at confidence: high. Measured
 * against the real service, that produced this, verbatim:
 *
 *   USER ASKED: "I need help with verification."
 *   > Your buy order is currently awaiting payment with bridge.
 *   > Request ID: or_17f19d8b-6385-4e14-a491-8f616c7a02df
 *
 * Intent is now a FIRST-CLASS value rather than a side effect of which
 * resource happened to be found, because "which transaction is this about"
 * and "what is being asked" are different questions. A user can ask about
 * verification while holding three open withdrawals.
 */

/**
 * A pasted request ID is the least ambiguous signal there is.
 *
 * Users paste these constantly - it is the first thing every support flow asks
 * for - and before this they were worthless: `ngnt_...` matched no keyword, fell
 * to 'general', and resolved to whatever transaction happened to be newest.
 * The user's own reference was ignored while a DIFFERENT transaction's status
 * was reported back to them.
 *
 * Prefixes come from the id() calls that mint them, not from guesswork:
 *   src/ngn/service/ngn-transfers.service.ts   id('ngnt')
 *   src/offramp/service/withdrawals.service.ts id('wd')
 *   src/onramp/service/onramp-orders.service.ts id('or')
 *
 * `va` is included because virtual_account_transaction is already a declared
 * resource type. Matching is anchored on a word boundary and requires the
 * underscore, so prose like "or" or "wd" in a sentence cannot trigger it.
 */
const REFERENCE_PATTERNS: Array<{ prefix: string; resourceType: AceResourceType }> = [
  { prefix: 'ngnt', resourceType: 'ngn_transfer' },
  { prefix: 'wd', resourceType: 'withdrawal' },
  { prefix: 'or', resourceType: 'onramp_order' },
  { prefix: 'va', resourceType: 'virtual_account_transaction' },
];

export interface AceIntentResult {
  intent: AceIntent;
  resourceType: AceResourceType;
  /** Set only when the user pasted a reference we recognise. */
  resourceId?: string;
  /** True when the id came from the message rather than the caller. */
  referenceDetected: boolean;
}

/**
 * Pull a Sivan request ID out of free text.
 *
 * Returns the FIRST match rather than all of them: a message containing two
 * references is a human asking a comparison question, and picking one at
 * random to report on is exactly the confidently-wrong behaviour this whole
 * change exists to remove. One reference is actionable; the caller treats the
 * rest as ordinary prose.
 */
export function detectReference(message: string): { resourceType: AceResourceType; resourceId: string } | undefined {
  const text = String(message ?? '');
  for (const { prefix, resourceType } of REFERENCE_PATTERNS) {
    /**
     * Deliberately tolerant of the shapes ids really take. id() emits a uuid
     * suffix, but users paste truncated and copy-pasted-with-punctuation
     * versions constantly, so the tail is "word characters and dashes" rather
     * than a strict uuid. A minimum length keeps "or_" alone from matching.
     */
    const match = text.match(new RegExp(`\\b(${prefix}_[A-Za-z0-9][A-Za-z0-9-]{5,})`, 'i'));
    if (match) return { resourceType, resourceId: match[1] };
  }
  return undefined;
}

/**
 * KEYWORD ORDER IS THE RULE, NOT AN ACCIDENT.
 *
 * These are checked most-specific first. "verification" must beat the money
 * words, because "I can't withdraw until my verification is done" is a
 * verification question that happens to contain "withdraw" - answering it with
 * a withdrawal status report is the original bug wearing a different hat.
 */
const INTENT_RULES: Array<{ intent: AceIntent; pattern: RegExp }> = [
  {
    intent: 'account_recovery',
    pattern: /\b(2fa|two.?factor|authenticator|locked out|lock(ed)? me out|reset my password|forgot my password|recover(y)? (my )?(account|access)|can.?t (log ?in|sign ?in)|account access)\b/i,
  },
  {
    intent: 'verification',
    pattern: /\b(verification|verify|verified|unverified|kyc|know your customer|nin|bvn|proof of address|source of funds|identity (check|document|verification)|id (check|verification)|document(s)? (upload|review)|tier|level \d)\b/i,
  },
  {
    intent: 'deposit',
    pattern: /\b(virtual account|deposit(ed|s)? (not|isn.?t|hasn.?t)|not (showing|shown|reflect|credited)|didn.?t (show|arrive|reflect)|funded|top ?up|fund my account)\b/i,
  },
  {
    intent: 'transaction',
    pattern: /\b(withdraw(al|n)?|payout|transfer|transaction|my money|where is my|sent|sell|off.?ramp|buy|on.?ramp|order|purchase|settlement|payment)\b/i,
  },
];

/**
 * Classify one message.
 *
 * `provided` is the caller's own hint - the frontend sets it from the quick
 * chips and from the screen the drawer was opened on. It WINS over keywords
 * when it names a concrete resource, because a user who opened the assistant
 * from a specific transaction page has already told us what they mean more
 * reliably than any regex can infer.
 *
 * A detected reference beats both. It is the only signal the user typed
 * deliberately as an identifier.
 */
export function classifyAceMessage(
  message: string,
  provided?: AceResourceType,
  providedId?: string
): AceIntentResult {
  const reference = detectReference(message);
  if (reference) {
    return {
      intent: intentForResource(reference.resourceType),
      resourceType: reference.resourceType,
      resourceId: reference.resourceId,
      referenceDetected: true,
    };
  }

  const keywordIntent = INTENT_RULES.find((rule) => rule.pattern.test(message))?.intent;

  /**
   * An explicit non-general resourceType from the caller pins the lookup, but
   * it does NOT overrule a verification or recovery question. Opening the
   * assistant from the withdrawals screen and then asking "why is my KYC
   * pending" must answer the KYC question - the screen is context, not the
   * subject.
   */
  if (provided && provided !== 'general') {
    const overriding = keywordIntent === 'verification' || keywordIntent === 'account_recovery';
    return {
      intent: overriding ? keywordIntent : intentForResource(provided),
      resourceType: overriding ? 'general' : provided,
      resourceId: overriding ? undefined : providedId,
      referenceDetected: false,
    };
  }

  if (!keywordIntent) {
    return { intent: 'unknown', resourceType: 'general', resourceId: providedId, referenceDetected: false };
  }

  return {
    intent: keywordIntent,
    /**
     * ONLY a transaction question attaches a transaction.
     *
     * verification, deposit, recovery and unknown all stay on 'general', and
     * findTransaction() no longer guesses for 'general'. That pairing is what
     * stops the assistant reporting on a buy order when it was asked about
     * something else.
     */
    resourceType: keywordIntent === 'transaction' ? 'transaction_lookup' : 'general',
    resourceId: providedId,
    referenceDetected: false,
  };
}

function intentForResource(resourceType: AceResourceType): AceIntent {
  if (resourceType === 'virtual_account_transaction') return 'deposit';
  if (resourceType === 'general') return 'unknown';
  return 'transaction';
}

/**
 * Kept for callers that still pass a resource type around.
 *
 * Now delegates to the classifier so there is ONE set of rules. The old
 * implementation was a second, weaker copy of this logic and the two could
 * disagree about the same message.
 */
export function inferAceResourceType(message: string, provided?: AceResourceType): AceResourceType {
  return classifyAceMessage(message, provided).resourceType;
}

export function isIncidentQuestion(message: string) {
  return /incident|delayed|bridge|provider|down|status|problem|issue/.test(message.toLowerCase());
}

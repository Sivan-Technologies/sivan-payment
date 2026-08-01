/**
 * Does the bank account belong to the person who signed up?
 *
 * THE HOLE THIS CLOSES
 *
 * Sivan's Level 1 argument is that a resolved Nigerian account proves identity,
 * because since the CBN directive of 1 March 2024 an account cannot transact
 * without BVN/NIN linkage - so a licensed bank has already verified the holder.
 *
 * That argument only holds if the account belongs to THIS user. Until now the
 * resolved `accountName` was stored and never compared to anything, so anyone
 * could enter a stranger's account number - one from a forum, a screenshot, a
 * former employer's - and inherit their bank-verified identity. The strongest
 * evidence in the system was attached to the wrong person.
 *
 * WHY THIS IS NOT STRING EQUALITY
 *
 * Nigerian bank names come back in an order and form that rarely matches what
 * a user typed:
 *
 *   bank says   OGUNMEPON SHARAFA
 *   user typed  Sharafa Ogunmepon Adebayo
 *
 * Same person. Reversed order, an extra middle name, different case. Exact
 * comparison rejects almost everyone, and a system that rejects real users
 * gets switched off - which is worse than not having it.
 *
 * So: normalise, compare as token sets, and score. Strong matches pass, partial
 * matches go to a human, and only genuinely unrelated names are refused.
 */

export type NameMatchVerdict = 'match' | 'review' | 'mismatch';

export interface NameMatchResult {
  verdict: NameMatchVerdict;
  /** 0-1. Exposed so an operator can see how close a review case was. */
  score: number;
  matchedTokens: string[];
  unmatchedUserTokens: string[];
  unmatchedBankTokens: string[];
  /** Plain sentence for an admin queue and for support. */
  explanation: string;
}

/**
 * Titles and honorifics, stripped before comparison.
 *
 * A user typing "Mr Sharafa Ogunmepon" against a bank record of "OGUNMEPON
 * SHARAFA" is the same person, and counting "mr" as an unmatched token drags
 * a perfect match down into review for no reason.
 */
const TITLES = new Set([
  'mr', 'mrs', 'miss', 'ms', 'dr', 'prof', 'engr', 'barr', 'chief', 'alhaji',
  'alhaja', 'pastor', 'rev', 'sir', 'lady', 'hon', 'arc', 'mallam', 'evang',
]);

/**
 * Normalise a name to comparable tokens.
 *
 * Accents are folded because Nigerian names are routinely written both ways -
 * "Adéwálé" and "Adewale" are the same name, and a bank will not agree with a
 * user's keyboard on which to use.
 */
export function normalizeNameTokens(value: string): string[] {
  return String(value ?? '')
    .normalize('NFD')
    // Strip combining accents.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Hyphens and apostrophes are separators, not characters: "Ade-Bayo" and
    // "Ade Bayo" must tokenise identically, and O'Brien should not lose its
    // second half.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token) => !TITLES.has(token))
    // Single letters are initials. "S Ogunmepon" should match "Sharafa
    // Ogunmepon" on the surname rather than being dragged down by a token
    // that carries almost no information.
    .filter((token) => token.length > 1);
}

/**
 * Compare a user's declared name against the bank's record.
 *
 * THE TWO DIRECTIONS ARE NOT SYMMETRIC, AND THAT MATTERS.
 *
 *   user declared MORE than the bank holds
 *     "Sharafa Ogunmepon Adebayo" vs "OGUNMEPON SHARAFA"
 *     The bank does not store a middle name for this account. Everything the
 *     bank knows was declared, so there is nothing unaccounted for. SAFE.
 *
 *   the bank holds a name the user did NOT declare
 *     "Sharafa Ogunmepon" vs "OGUNMEPON SHARAFA ADEBAYO"
 *     Could be the user's own omitted middle name - or a DIFFERENT PERSON who
 *     happens to share two common Nigerian names. That is precisely the
 *     stranger's-account case this check exists to catch, so it goes to a
 *     human rather than being auto-approved.
 *
 * Scoring on the smaller set alone treats these identically and auto-approves
 * both, which is lenient in the one direction that carries the risk.
 */
export function matchAccountName(
  declaredName: string,
  bankAccountName: string,
  options: { minimumTokens?: number } = {}
): NameMatchResult {
  const userTokens = normalizeNameTokens(declaredName);
  const bankTokens = normalizeNameTokens(bankAccountName);

  if (!userTokens.length || !bankTokens.length) {
    return {
      verdict: 'review',
      score: 0,
      matchedTokens: [],
      unmatchedUserTokens: userTokens,
      unmatchedBankTokens: bankTokens,
      // NOT a mismatch. A missing name is missing evidence, not evidence of
      // fraud, and refusing it outright would block a user over a blank field.
      explanation: !userTokens.length
        ? 'No name on file to compare against the bank account.'
        : 'The bank did not return an account name to compare.',
    };
  }

  const userSet = new Set(userTokens);
  const bankSet = new Set(bankTokens);

  const matched = [...userSet].filter((token) => bankSet.has(token));
  const smaller = Math.min(userSet.size, bankSet.size);
  const score = smaller === 0 ? 0 : matched.length / smaller;

  const unmatchedUserTokens = [...userSet].filter((token) => !bankSet.has(token));
  const unmatchedBankTokens = [...bankSet].filter((token) => !userSet.has(token));

  // A single shared token is not identity. "Chinedu Okeke" and "Chinedu
  // Adeyemi" share a very common first name and are different people.
  //
  // Deliberately NOT clamped with Math.min(minimumTokens, smaller). That
  // clamp meant a one-token-each comparison - user "Chinedu" against bank
  // "CHINEDU" - satisfied the rule and auto-approved Level 1 on a single very
  // common Nigerian first name. A lone name is never enough evidence,
  // whichever side is short of tokens, so a single match always goes to a
  // human instead.
  const minimumTokens = options.minimumTokens ?? 2;
  const enoughTokens = matched.length >= minimumTokens;

  let verdict: NameMatchVerdict;
  let explanation: string;

  // An unexplained name on the BANK side is the risky direction - see above.
  const bankHasUnexplainedName = unmatchedBankTokens.length > 0;

  if (score === 1 && enoughTokens && bankHasUnexplainedName) {
    verdict = 'review';
    explanation =
      `The name on file matches, but the bank also holds ` +
      `"${unmatchedBankTokens.join(', ')}" which was not declared. This is usually an ` +
      `omitted middle name, but it can also be a different person who shares these names.`;
  } else if (score === 1 && enoughTokens) {
    verdict = 'match';
    explanation = `Every name the bank holds matches the name on file (${matched.join(', ')}).`;
  } else if (score >= 0.5 && enoughTokens) {
    // A real person with a middle name, a married name, or a transliteration
    // difference. Plausible, not certain - which is exactly what a human is
    // for.
    verdict = 'review';
    explanation =
      `Partial match: ${matched.join(', ')} matched, but the bank also has ` +
      `${unmatchedBankTokens.join(', ') || 'nothing else'}. A person should confirm this.`;
  } else if (matched.length === 0) {
    verdict = 'mismatch';
    explanation =
      `The account is held by "${bankAccountName}", which shares no part of the ` +
      `name on file. This account appears to belong to someone else.`;
  } else {
    verdict = 'review';
    explanation =
      `Weak match: only ${matched.join(', ')} matched. A person should confirm this.`;
  }

  return {
    verdict,
    score: Math.round(score * 100) / 100,
    matchedTokens: matched,
    unmatchedUserTokens,
    unmatchedBankTokens,
    explanation,
  };
}

/**
 * Does this verdict clear a payout account for Level 1?
 *
 * Only a full match. A review case is NOT verified - it is pending a decision,
 * and treating pending as verified would defeat the check entirely by letting
 * every partial through while looking like it was enforced.
 */
export function nameMatchGrantsVerification(verdict: NameMatchVerdict): boolean {
  return verdict === 'match';
}

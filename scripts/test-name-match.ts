/**
 * Does the bank account belong to the person who signed up?
 *
 * Level 1 rests on a resolved Nigerian account proving identity - the CBN
 * directive of 1 March 2024 means an account cannot transact without BVN/NIN
 * linkage, so a licensed bank has already verified the holder.
 *
 * That only holds if the account belongs to THIS user. The resolved
 * accountName was previously stored and never compared to anything, so anyone
 * could enter a stranger's account number and inherit their verified identity.
 *
 * The hard part is not catching strangers. It is NOT rejecting real users:
 * Nigerian names come back reordered, with middle names dropped, married names
 * changed, and accents folded. A check that rejects legitimate customers gets
 * switched off, which is worse than no check at all.
 *
 * Run: npm run test:name-match
 */

import {
  matchAccountName,
  normalizeNameTokens,
  nameMatchGrantsVerification,
} from '../src/kyc/service/name-match.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

console.log('\nTHE REAL CASE: BANKS REORDER NAMES');
{
  // Straight from Breet's live response format - surname first, all caps.
  const result = matchAccountName('Sharafa Ogunmepon', 'OGUNMEPON SHARAFA');
  check('reversed order is a full match', result.verdict === 'match', `${result.verdict} @ ${result.score}`);
  check('the score is 1', result.score === 1, String(result.score));
  check('it grants verification', nameMatchGrantsVerification(result.verdict));
}

console.log('\nA MIDDLE NAME THE BANK DOES NOT HAVE IS STILL A MATCH');
{
  // Scored on the SMALLER set. Every name the bank knows matched; penalising
  // the user for a middle name the bank omitted would fail a real account.
  const result = matchAccountName('Sharafa Ogunmepon Adebayo', 'OGUNMEPON SHARAFA');
  check('extra user tokens do not break it', result.verdict === 'match',
    `${result.verdict} @ ${result.score}`);
  check('the extra token is still reported', result.unmatchedUserTokens.includes('adebayo'),
    result.unmatchedUserTokens.join(','));
}

console.log('\nA MIDDLE NAME THE USER OMITTED GOES TO REVIEW');
{
  // The other direction is weaker: the bank knows something the user did not
  // declare, which is plausible but worth a human glance.
  const result = matchAccountName('Sharafa Ogunmepon', 'OGUNMEPON SHARAFA ADEBAYO');
  check('it is not auto-approved', result.verdict === 'review', result.verdict);
  check('and not rejected either', result.verdict !== 'mismatch');
  check('the unmatched bank token is named', result.unmatchedBankTokens.includes('adebayo'));
  check('it does not grant verification', !nameMatchGrantsVerification(result.verdict));
}

console.log('\nA DIFFERENT PERSON IS REFUSED');
{
  const result = matchAccountName('Sharafa Ogunmepon', 'CHINEDU OKEKE');
  check('no shared tokens is a mismatch', result.verdict === 'mismatch', result.verdict);
  check('the score is 0', result.score === 0);
  check('the explanation names the actual holder',
    result.explanation.includes('CHINEDU OKEKE'), result.explanation);
  check('it does not grant verification', !nameMatchGrantsVerification(result.verdict));
}

console.log('\nONE SHARED FIRST NAME IS NOT IDENTITY');
{
  // Chinedu is extremely common. Two people sharing it are not the same
  // person, and a single token must never auto-approve.
  const result = matchAccountName('Chinedu Okeke', 'CHINEDU ADEYEMI');
  check('a single shared token is not a full match', result.verdict !== 'match',
    `${result.verdict} @ ${result.score}`);
  check('it goes to review rather than being rejected', result.verdict === 'review');
  check('it does not grant verification', !nameMatchGrantsVerification(result.verdict));
}

console.log('\nA LONE NAME IS NEVER ENOUGH, EVEN IF IT MATCHES PERFECTLY');
{
  // The subtle one. Clamping the minimum against the smaller token set let a
  // one-name-each comparison satisfy the rule, so user "Chinedu" against bank
  // "CHINEDU" scored 1.0 and auto-approved Level 1 on a single extremely
  // common Nigerian first name.
  const result = matchAccountName('Chinedu', 'CHINEDU');
  check('a single matching token does NOT auto-approve', result.verdict !== 'match',
    `${result.verdict} @ ${result.score} - one common name is not identity`);
  check('it goes to a human instead', result.verdict === 'review', result.verdict);
  check('and does not grant verification', !nameMatchGrantsVerification(result.verdict));

  // Two tokens is the threshold, and it must still work.
  check('two matching tokens DO auto-approve',
    matchAccountName('Chinedu Okeke', 'CHINEDU OKEKE').verdict === 'match');
}

console.log('\nCASE, ACCENTS AND PUNCTUATION DO NOT MATTER');
{
  // A bank and a user's keyboard will not agree on accents.
  check('accents fold', matchAccountName('Adéwálé Ògúnsanya', 'ADEWALE OGUNSANYA').verdict === 'match');
  check('case is ignored', matchAccountName('adewale ogunsanya', 'ADEWALE OGUNSANYA').verdict === 'match');
  // "Ade-Bayo" and "Ade Bayo" must tokenise identically.
  check('hyphens are separators', matchAccountName('Ade-Bayo Okonkwo', 'ADE BAYO OKONKWO').verdict === 'match');
  check('apostrophes do not swallow a name',
    normalizeNameTokens("O'Brien Chukwu").includes('brien'),
    normalizeNameTokens("O'Brien Chukwu").join(','));
  check('extra whitespace is ignored',
    matchAccountName('  Sharafa   Ogunmepon  ', 'OGUNMEPON SHARAFA').verdict === 'match');
}

console.log('\nTITLES ARE STRIPPED, NOT COUNTED AGAINST THE USER');
{
  // Counting "mr" as an unmatched token would drag a perfect match into
  // review for no reason.
  check('Mr is ignored', matchAccountName('Mr Sharafa Ogunmepon', 'OGUNMEPON SHARAFA').verdict === 'match');
  check('Alhaji is ignored', matchAccountName('Alhaji Sharafa Ogunmepon', 'OGUNMEPON SHARAFA').verdict === 'match');
  check('Engr is ignored', matchAccountName('Engr. Adewale Okonkwo', 'ADEWALE OKONKWO').verdict === 'match');
  check('a title on the BANK side is ignored too',
    matchAccountName('Adewale Okonkwo', 'MRS ADEWALE OKONKWO').verdict === 'match');
  check('titles do not survive normalisation', !normalizeNameTokens('Dr Chinedu').includes('dr'));
}

console.log('\nINITIALS DO NOT DRAG A MATCH DOWN');
{
  // "S Ogunmepon" should match on the surname rather than being penalised for
  // a single letter that carries almost no information.
  check('a single-letter initial is dropped',
    !normalizeNameTokens('S Ogunmepon').includes('s'),
    normalizeNameTokens('S Ogunmepon').join(','));
}

console.log('\nMISSING DATA IS REVIEW, NOT REJECTION');
{
  // A blank field is missing evidence, not evidence of fraud. Rejecting would
  // block a user over an empty input.
  const noUser = matchAccountName('', 'OGUNMEPON SHARAFA');
  check('no name on file goes to review', noUser.verdict === 'review', noUser.verdict);
  check('and says so plainly', /no name on file/i.test(noUser.explanation), noUser.explanation);

  const noBank = matchAccountName('Sharafa Ogunmepon', '');
  check('no bank name goes to review', noBank.verdict === 'review', noBank.verdict);
  check('and says which side is missing',
    /bank did not return/i.test(noBank.explanation), noBank.explanation);

  check('neither grants verification',
    !nameMatchGrantsVerification(noUser.verdict) && !nameMatchGrantsVerification(noBank.verdict));
}

console.log('\nONLY A FULL MATCH GRANTS LEVEL 1');
{
  // Treating review as verified would defeat the whole check: every partial
  // would pass while the system looked like it was enforcing something.
  check('match grants', nameMatchGrantsVerification('match'));
  check('review does NOT grant', !nameMatchGrantsVerification('review'));
  check('mismatch does NOT grant', !nameMatchGrantsVerification('mismatch'));
}

console.log('\nA HUMAN CAN UNDERSTAND EVERY VERDICT');
{
  // These land in a review queue that somebody has to work.
  for (const [declared, bank] of [
    ['Sharafa Ogunmepon', 'OGUNMEPON SHARAFA'],
    ['Sharafa Ogunmepon', 'OGUNMEPON SHARAFA ADEBAYO'],
    ['Sharafa Ogunmepon', 'CHINEDU OKEKE'],
  ] as const) {
    const result = matchAccountName(declared, bank);
    check(`"${bank}" has a usable explanation`,
      result.explanation.length > 25 && !result.explanation.includes('undefined'),
      result.explanation);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Bank picker and quote step.
 *
 * These are the two things the NGN off-ramp could not work without. A Nigerian
 * user had no way to say where the naira goes - Bridge external accounts are
 * routing numbers, sort codes and IBANs, and a NUBAN is none of those - and
 * nothing produced the quote that POST /api/ngn/offramp/orders settles.
 *
 * Run: npm run test:ngn-bank
 */

import {
  filterBanks,
  isValidNuban,
  shouldResolveAccount,
  isQuoteExpired,
  quoteSecondsRemaining,
  maskAccountNumber,
  type NgnBank,
  type NgnQuote,
} from '../src/ngnBank';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const BANKS: NgnBank[] = [
  { id: '1', name: 'Access Bank', slug: 'access-bank' },
  { id: '39', name: 'United Bank For Africa', slug: 'united-bank-for-africa' },
  { id: '20', name: 'Guaranty Trust Bank', slug: 'guaranty-trust-bank' },
  { id: '55', name: 'First City Monument Bank', slug: 'fcmb' },
  { id: '70', name: 'Zenith Bank', slug: 'zenith-bank' },
];

console.log('\nA NUBAN IS EXACTLY TEN DIGITS');
{
  check('a valid NUBAN passes', isValidNuban('3154021148'));
  check('nine digits is rejected', !isValidNuban('315402114'));
  check('eleven digits is rejected', !isValidNuban('31540211480'));
  check('letters are rejected', !isValidNuban('31540A1148'));
  check('an empty string is rejected', !isValidNuban(''));
  check('surrounding whitespace is tolerated', isValidNuban('  3154021148  '));
}

console.log('\nRESOLUTION ONLY FIRES WHEN IT CAN SUCCEED');
{
  // Resolution is a paid, rate-limited provider call. Firing per keystroke
  // spends a request per digit and shows the user failures for a number they
  // are still typing.
  check('no bank chosen -> do not resolve', !shouldResolveAccount('', '3154021148'));
  check('partial number -> do not resolve', !shouldResolveAccount('39', '31540'));
  check('bank and full NUBAN -> resolve', shouldResolveAccount('39', '3154021148'));
}

console.log('\nBANK SEARCH MATCHES HOW NIGERIANS NAME THEIR BANKS');
{
  check('exact name matches', filterBanks(BANKS, 'Zenith').length === 1);
  check('partial name matches', filterBanks(BANKS, 'access').length === 1);
  check('case is ignored', filterBanks(BANKS, 'ZENITH').length === 1);

  // The abbreviations people actually use.
  const gtb = filterBanks(BANKS, 'gtb');
  check('GTB finds Guaranty Trust Bank',
    gtb.length === 1 && gtb[0]?.name === 'Guaranty Trust Bank',
    gtb.map((b) => b.name).join(','));

  const uba = filterBanks(BANKS, 'uba');
  check('UBA finds United Bank For Africa',
    uba.some((b) => b.name === 'United Bank For Africa'),
    uba.map((b) => b.name).join(','));

  const fcmb = filterBanks(BANKS, 'fcmb');
  check('FCMB finds First City Monument Bank via its slug',
    fcmb.some((b) => b.name === 'First City Monument Bank'),
    fcmb.map((b) => b.name).join(','));

  check('an empty query returns everything', filterBanks(BANKS, '').length === BANKS.length);
  check('nonsense returns nothing', filterBanks(BANKS, 'zzzz').length === 0);
}

console.log('\nA QUOTE EXPIRES, VISIBLY');
{
  // Quotes are priced against a moving rate. A stale one must expire rather
  // than silently settling at a number the user was never shown.
  const fresh: NgnQuote = {
    id: 'q1', direction: 'offramp', sourceCurrency: 'usdc', destinationCurrency: 'ngn',
    sourceAmount: '20', destinationAmount: '32100', rate: '1605', feeAmount: '0.30',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const stale: NgnQuote = { ...fresh, id: 'q2', expiresAt: new Date(Date.now() - 1_000).toISOString() };

  check('a fresh quote is not expired', !isQuoteExpired(fresh));
  check('a past expiry is expired', isQuoteExpired(stale));
  check('a quote with no expiry never expires', !isQuoteExpired({ ...fresh, expiresAt: undefined }));
  check('null is not expired', !isQuoteExpired(null));

  check('seconds remaining is roughly right',
    Math.abs(quoteSecondsRemaining(fresh) - 60) <= 1, String(quoteSecondsRemaining(fresh)));
  check('an expired quote floors at zero, never negative',
    quoteSecondsRemaining(stale) === 0, String(quoteSecondsRemaining(stale)));
}

console.log('\nTHE ACCOUNT NUMBER IS MASKED ONCE CONFIRMED');
{
  check('the last four remain visible', maskAccountNumber('3154021148').endsWith('1148'));
  check('the rest is hidden', !maskAccountNumber('3154021148').includes('3154'));
  check('length is preserved', maskAccountNumber('3154021148').length === 10);
  check('a short string is left alone', maskAccountNumber('1148') === '1148');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

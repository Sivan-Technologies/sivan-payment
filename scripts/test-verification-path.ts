/**
 * Country decides the verification path, and the two paths are not variants.
 *
 *   NIGERIA -> bank account name resolution. Free, seconds, no documents.
 *              Works because the CBN directive of 1 March 2024 means a
 *              Nigerian account cannot transact without BVN/NIN linkage.
 *
 *   ELSEWHERE -> Bridge KYC. Costs $2 per customer, takes minutes, and is the
 *              only thing that unlocks USD/GBP/EUR virtual accounts.
 *
 * A US user has NO Nigerian path available - the resolver only understands
 * NUBANs, so their account number cannot resolve at all. Showing them the
 * Nigerian form is not a cosmetic error: it is a check that cannot succeed,
 * with no action they can take to fix it.
 *
 * Run: npm run test:verification-path
 */

import { detectCountryFromHeaders, normalizeCountryHeader } from '../src/kyc/service/geo-country.js';
import {
  verificationPathFor,
  verificationPlanFor,
  normalizeCountry,
  isNigerianUser,
} from '../src/kyc/service/verification-path.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

console.log('\nNIGERIA GETS THE BANK PATH');
{
  check('NG routes to the bank check', verificationPathFor('NG') === 'ngn_bank');
  check('lowercase still works', verificationPathFor('ng') === 'ngn_bank');
  check('whitespace is tolerated', verificationPathFor('  ng  ') === 'ngn_bank');
  check('isNigerianUser agrees', isNigerianUser('NG') && isNigerianUser('ng'));
}

console.log('\nEVERYWHERE ELSE GETS BRIDGE');
{
  for (const country of ['US', 'GB', 'DE', 'FR', 'CA', 'ZA', 'KE']) {
    check(`${country} routes to Bridge`, verificationPathFor(country) === 'bridge_kyc',
      verificationPathFor(country));
  }
  check('a non-Nigerian is not treated as Nigerian', !isNigerianUser('US'));
}

console.log('\nGHANA IS NOT SILENTLY INCLUDED');
{
  // Breet settles GHS, so Ghana is the obvious next local rail - but the
  // Ghanaian resolver has never been tested. Routing GH to the bank check
  // would strand those users on a check that does not exist yet.
  check('GH goes to Bridge until its resolver is tested',
    verificationPathFor('GH') === 'bridge_kyc', verificationPathFor('GH'));
}

console.log('\nAN UNKNOWN COUNTRY FAILS TOWARDS THE PATH THAT CAN SUCCEED');
{
  // Defaulting to the Nigerian path would be cheaper for Sivan and worse for
  // the user: their account number will not resolve, and they are left with a
  // failure they cannot act on. Bridge is slower but always completable.
  check('no country routes to Bridge', verificationPathFor(undefined) === 'bridge_kyc');
  check('empty string routes to Bridge', verificationPathFor('') === 'bridge_kyc');
  check('null routes to Bridge', verificationPathFor(null) === 'bridge_kyc');
  check('nonsense routes to Bridge', verificationPathFor('XX!') === 'bridge_kyc');
  check('a full country name is not a code', verificationPathFor('Nigeria') === 'bridge_kyc',
    'only ISO alpha-2 is accepted, so "Nigeria" must not route as NG');
}

console.log('\nCOUNTRY CODES ARE NORMALISED, NOT GUESSED');
{
  check('ng becomes NG', normalizeCountry('ng') === 'NG');
  check('surrounding space is trimmed', normalizeCountry(' us ') === 'US');
  check('three letters is rejected', normalizeCountry('NGA') === undefined,
    'alpha-3 is a different standard and must not be silently accepted');
  check('one letter is rejected', normalizeCountry('N') === undefined);
  check('digits are rejected', normalizeCountry('12') === undefined);
  check('undefined stays undefined', normalizeCountry(undefined) === undefined);
}

console.log('\nTHE PLAN TELLS A UI WHAT TO RENDER');
{
  const nigeria = verificationPlanFor('NG');
  check('Nigeria gets the bank plan', nigeria.path === 'ngn_bank');
  check('it says no documents are needed',
    /no documents|no selfie/i.test(nigeria.description), nigeria.description);
  check('it costs Sivan nothing', nigeria.costsProviderFee === false);
  check('it is not a fallback', nigeria.isFallback === false);
  check('it says what the user gets',
    nigeria.unlocks.some((item) => /naira/i.test(item)), nigeria.unlocks.join(', '));

  const usa = verificationPlanFor('US');
  check('the US gets the Bridge plan', usa.path === 'bridge_kyc');
  check('it mentions ID and a selfie',
    /ID and a short selfie/i.test(usa.description), usa.description);
  // $2 per customer, so this should fire on intent rather than at signup.
  check('it is flagged as costing a provider fee', usa.costsProviderFee === true);
  check('it promises virtual accounts',
    usa.unlocks.some((item) => /virtual account/i.test(item)), usa.unlocks.join(', '));
}

console.log('\nA MISSING COUNTRY IS A FALLBACK, AND SAYS SO');
{
  // The UI needs to tell these two apart: "you are on Bridge because you are
  // American" reads very differently from "we do not know where you are".
  const unknown = verificationPlanFor(undefined);
  check('it still routes to Bridge', unknown.path === 'bridge_kyc');
  check('but is marked as a fallback', unknown.isFallback === true);
  check('and asks for the country instead of assuming',
    /where you are based/i.test(unknown.description), unknown.description);

  check('a known country is NOT a fallback', verificationPlanFor('US').isFallback === false);
}

console.log('\nGEO DETECTION IS A HINT, AND MUST FAIL SAFE');
{
  // Cloudflare fronts this API and sets CF-IPCountry on every request. It also
  // OVERWRITES any value a client sent, which is what makes it safe to
  // pre-select with - and it is still only a pre-selection.
  check('CF-IPCountry is read', detectCountryFromHeaders({ 'cf-ipcountry': 'NG' }) === 'NG');
  check('lowercase is normalised', detectCountryFromHeaders({ 'cf-ipcountry': 'gb' }) === 'GB');
  check('whitespace is tolerated', detectCountryFromHeaders({ 'cf-ipcountry': ' us ' }) === 'US');

  // Cloudflare returns XX for unknown and T1 for Tor. Neither is a place, and
  // handing either to a picker would default someone to a country that does
  // not exist.
  check('XX (unknown) is not a country', detectCountryFromHeaders({ 'cf-ipcountry': 'XX' }) === undefined);
  check('T1 (Tor) is not a country', detectCountryFromHeaders({ 'cf-ipcountry': 'T1' }) === undefined);
  check('EU is not a country', detectCountryFromHeaders({ 'cf-ipcountry': 'EU' }) === undefined);

  check('no headers at all is undefined, not a guess', detectCountryFromHeaders(undefined) === undefined);
  check('missing header is undefined', detectCountryFromHeaders({}) === undefined);
  check('rubbish is rejected', detectCountryFromHeaders({ 'cf-ipcountry': 'NGA' }) === undefined);
  check('a number is rejected', detectCountryFromHeaders({ 'cf-ipcountry': '12' }) === undefined);

  // Fallbacks for other edges, only consulted when Cloudflare's is absent.
  check('Vercel header is a fallback',
    detectCountryFromHeaders({ 'x-vercel-ip-country': 'GB' }) === 'GB');
  check('Cloudflare wins over the fallbacks',
    detectCountryFromHeaders({ 'cf-ipcountry': 'NG', 'x-vercel-ip-country': 'GB' }) === 'NG');

  // An array-valued header is what Node produces for a repeated header.
  check('a repeated header takes the first value',
    normalizeCountryHeader(['NG', 'GB']) === 'NG');

  // A VPN resolves the EXIT node, which cannot be fixed and does not need to
  // be: detection only orders a picker the user still chooses from, and the
  // stored country remains declared rather than proven.
  check('a VPN exit node is reported as that country, honestly',
    detectCountryFromHeaders({ 'cf-ipcountry': 'US' }) === 'US');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

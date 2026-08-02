/**
 * Country routing and virtual-account gating, client side.
 *
 * The client mirrors the server so the UI can render before the plan request
 * resolves. They must not disagree: a frontend that decides independently will
 * eventually show a Nigerian bank form to a US user, which is a check that
 * cannot succeed and that the user can do nothing about.
 *
 * Run: npm run test:verification-path
 */

import {
  verificationPathFor,
  localVerificationPlan,
  normalizeCountry,
  isNigerianUser,
  canRequestVirtualAccount,
  virtualAccountBlockedReason,
  SIGNUP_COUNTRIES,
  orderCountriesForDetected,
  shouldAutoSelectCountry,
  planToRender,
} from '../src/verificationPath';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

console.log('\nROUTING MATCHES THE SERVER');
{
  check('NG takes the bank path', verificationPathFor('NG') === 'ngn_bank');
  check('lowercase works', verificationPathFor('ng') === 'ngn_bank');
  for (const c of ['US', 'GB', 'DE', 'CA', 'GH']) {
    check(`${c} takes Bridge`, verificationPathFor(c) === 'bridge_kyc');
  }
  // Matching the server: defaulting to the Nigerian path would strand a
  // non-Nigerian on a check their account number cannot pass.
  check('unknown falls back to Bridge', verificationPathFor(undefined) === 'bridge_kyc');
  check('a full country name is not a code', verificationPathFor('Nigeria') === 'bridge_kyc');
}

console.log('\nCOUNTRY CODES ARE VALIDATED');
{
  check('ng normalises to NG', normalizeCountry('ng') === 'NG');
  check('alpha-3 is rejected', normalizeCountry('NGA') === undefined);
  check('digits are rejected', normalizeCountry('12') === undefined);
  check('isNigerianUser is case-insensitive', isNigerianUser('ng') && isNigerianUser('NG'));
  check('and rejects others', !isNigerianUser('US'));
}

console.log('\nTHE SIGNUP LIST IS USABLE');
{
  check('Nigeria is offered', SIGNUP_COUNTRIES.some((c) => c.code === 'NG'));
  check('the US is offered', SIGNUP_COUNTRIES.some((c) => c.code === 'US'));
  // A 200-entry dropdown buries the one country with a different flow.
  check('the list is short enough to scan', SIGNUP_COUNTRIES.length <= 12,
    String(SIGNUP_COUNTRIES.length));
  check('every code is valid ISO alpha-2',
    SIGNUP_COUNTRIES.every((c) => normalizeCountry(c.code) === c.code));
}

console.log('\nTHE PLAN DRIVES THE MODAL');
{
  const ng = localVerificationPlan('NG');
  check('Nigeria gets the bank plan', ng.path === 'ngn_bank');
  check('and is told no documents are needed', /no documents/i.test(ng.description));
  check('and it costs nothing', ng.costsProviderFee === false);

  const us = localVerificationPlan('US');
  check('the US gets Bridge', us.path === 'bridge_kyc');
  check('and is warned it costs a provider fee', us.costsProviderFee === true);
  check('and is not marked a fallback', us.isFallback === false);

  // "We don't know where you are" must read differently from "you're American".
  const unknown = localVerificationPlan(undefined);
  check('an unknown country IS a fallback', unknown.isFallback === true);
  check('and asks for the country', /where you are based/i.test(unknown.description));
}

console.log('\nVIRTUAL ACCOUNTS NEED BRIDGE APPROVAL, NOT JUST A BANK CHECK');
{
  check('approved unlocks', canRequestVirtualAccount('approved'));
  check('pending does not', !canRequestVirtualAccount('pending'));
  check('rejected does not', !canRequestVirtualAccount('rejected'));
  check('missing status does not', !canRequestVirtualAccount(undefined));

  // The important one: a Nigerian who passed the bank check has NOT done
  // Bridge KYC, and Bridge issues these accounts.
  const ngReason = virtualAccountBlockedReason(undefined, 'ngn_bank');
  check('a verified Nigerian is told they still need Bridge',
    /Bridge/i.test(ngReason ?? ''), ngReason);

  check('someone under review is told to wait',
    /reviewed/i.test(virtualAccountBlockedReason('under_review', 'bridge_kyc') ?? ''));
  check('a rejected user is pointed at support',
    /support/i.test(virtualAccountBlockedReason('rejected', 'bridge_kyc') ?? ''));
  check('an approved user has no blocker',
    virtualAccountBlockedReason('approved', 'bridge_kyc') === undefined);
}

console.log('\nTHE MODAL RENDERS THE RIGHT PLAN WHILE THE SERVER CATCHES UP');
{
  // The scenario: server said NG, user changes the dropdown to US, refetch has
  // not landed. Rendering the server plan here shows an American the Nigerian
  // bank form - a check their account number cannot pass.
  const serverNg = localVerificationPlan('NG');
  const serverUs = localVerificationPlan('US');

  check('no selection yet -> the server plan is used',
    planToRender(serverNg, undefined) === serverNg);
  check('selection matches the server -> the server plan wins',
    planToRender(serverNg, 'NG') === serverNg);
  check('an empty string counts as no selection',
    planToRender(serverNg, '') === serverNg);

  const switched = planToRender(serverNg, 'US');
  check('switching NG -> US immediately stops showing the bank form',
    switched.path === 'bridge_kyc', switched.path);
  check('and the stale server plan is discarded, not mutated',
    serverNg.path === 'ngn_bank');

  const back = planToRender(serverUs, 'NG');
  check('switching US -> NG immediately shows the bank form',
    back.path === 'ngn_bank', back.path);
  check('a locally chosen country is never a fallback',
    back.isFallback === false);

  // Case must not force a needless local plan: 'ng' and 'NG' are one country,
  // and treating them as different would throw away the server's richer copy.
  check('case differences do not make the server plan look stale',
    planToRender(serverNg, 'ng') === serverNg);

  // A server plan with no country (the user has none on file) is stale the
  // moment they pick one.
  const serverUnknown = localVerificationPlan(undefined);
  const picked = planToRender(serverUnknown, 'NG');
  check('picking a country replaces the no-country plan',
    picked.path === 'ngn_bank', picked.path);
  check('and it stops claiming to be a fallback',
    picked.isFallback === false);
}

console.log('\nTHE PICKER ORDER FOLLOWS DETECTION, NOT A HARDCODED COUNTRY');
{
  // Nigeria was pinned first with an "INSTANT" badge. To a US visitor that
  // reads as the default - and country decides their ENTIRE path, so a
  // mis-click sends them into a NUBAN check their account cannot pass.
  const us = orderCountriesForDetected(SIGNUP_COUNTRIES, 'US');
  check('a US visitor sees the United States first', us[0].code === 'US', us[0].code);
  check('Nigeria is still reachable', us.some((item) => item.code === 'NG'));
  check('nothing is lost when reordering', us.length === SIGNUP_COUNTRIES.length, String(us.length));
  check('and nothing is duplicated',
    new Set(us.map((item) => item.code)).size === us.length);

  const gb = orderCountriesForDetected(SIGNUP_COUNTRIES, 'gb');
  check('lowercase detection still reorders', gb[0].code === 'GB', gb[0].code);

  // No signal keeps the shipped order, which is Nigeria-first. That is correct
  // - it is most of the userbase. What was wrong was asserting it about a
  // specific visitor we DID have a signal for.
  const none = orderCountriesForDetected(SIGNUP_COUNTRIES, undefined);
  check('no detection keeps the shipped order', none[0].code === 'NG', none[0].code);
  check('and returns the list untouched', none === SIGNUP_COUNTRIES);
  check('an empty string is not a detection',
    orderCountriesForDetected(SIGNUP_COUNTRIES, '') === SIGNUP_COUNTRIES);

  // A country we do not serve must not blank the list.
  const jp = orderCountriesForDetected(SIGNUP_COUNTRIES, 'JP');
  check('an unlisted country leaves the list intact',
    jp.length === SIGNUP_COUNTRIES.length && jp[0].code === 'NG');

  // A VPN changes the ORDER and nothing else. Every country stays reachable
  // because the user is the one who chooses - which is exactly why detecting
  // the exit node is acceptable.
  check('a VPN cannot remove the real country from the list',
    orderCountriesForDetected(SIGNUP_COUNTRIES, 'US').some((item) => item.code === 'NG'));
  check('and a Nigerian on a US VPN can still pick Nigeria',
    orderCountriesForDetected(SIGNUP_COUNTRIES, 'US').find((item) => item.code === 'NG')?.name === 'Nigeria');
}

console.log('\nDETECTION AUTO-SELECTS, BUT ONLY A COUNTRY WE SERVE');
{
  // Asking someone to confirm a country we already know is a step that exists
  // only to be clicked through. The choice stays visible and reversible on the
  // next screen, so auto-selecting costs the user nothing and saves a tap.
  check('a served country auto-selects', shouldAutoSelectCountry('NG') === true);
  check('so does the US', shouldAutoSelectCountry('US') === true);
  check('lowercase still counts', shouldAutoSelectCountry('gb') === true);

  // THE EDGE CASE THAT MATTERS. Detecting a country we do not serve must fall
  // through to the picker. Selecting nothing silently, or defaulting to a
  // neighbour, puts the user on a verification path they never chose.
  check('an unserved country does NOT auto-select', shouldAutoSelectCountry('JP') === false);
  check('nor does Brazil', shouldAutoSelectCountry('BR') === false);

  // No signal, or a non-country like Tor's T1, must never auto-select.
  check('undefined does not auto-select', shouldAutoSelectCountry(undefined) === false);
  check('null does not auto-select', shouldAutoSelectCountry(null) === false);
  check('an empty string does not auto-select', shouldAutoSelectCountry('') === false);
  check('rubbish does not auto-select', shouldAutoSelectCountry('XX') === false);

  // Auto-selection must agree with routing, or a user is auto-put on a path
  // the server disagrees with.
  check('auto-selecting NG lands on the bank path',
    shouldAutoSelectCountry('NG') && verificationPathFor('NG') === 'ngn_bank');
  check('auto-selecting US lands on Bridge',
    shouldAutoSelectCountry('US') && verificationPathFor('US') === 'bridge_kyc');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

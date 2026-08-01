/**
 * Rail routing and the NGN off-ramp floor, in the frontend.
 *
 * The backend already refuses a naira withdrawal on the Bridge endpoint and a
 * dollar one on the NGN endpoint. This exists because the frontend previously
 * had no concept of the split at all: confirmWithdrawal() posted
 * /api/withdrawals unconditionally, so a Nigerian payout could never have
 * worked no matter what the UI offered.
 *
 * Run: npm run test:rails
 */

import {
  payoutRailFor,
  withdrawalEndpointFor,
  isBridgeCurrency,
  isNgnCurrency,
  formatPayoutAmount,
  BRIDGE_CURRENCIES,
  type PayoutCurrency,
} from '../src/rails';
import { minimumOfframpUsd, offrampClears, typicalGasUsd } from '../src/ngnMinimum';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) < tol;

console.log('\nNAIRA GOES TO BREET, EVERYTHING ELSE TO BRIDGE');
{
  check('ngn routes to breet', payoutRailFor('ngn') === 'breet');
  for (const currency of BRIDGE_CURRENCIES) {
    check(`${currency} routes to bridge`, payoutRailFor(currency) === 'bridge');
  }
}

console.log('\nTHE ENDPOINT FOLLOWS THE RAIL');
{
  // The bug this replaces: /api/withdrawals for everything, including naira,
  // which Bridge rejects outright because it has no NGN rail.
  check('ngn posts to the NGN endpoint',
    withdrawalEndpointFor('ngn') === '/api/ngn/offramp/orders',
    withdrawalEndpointFor('ngn'));
  check('usd posts to the Bridge endpoint',
    withdrawalEndpointFor('usd') === '/api/withdrawals');
  check('gbp posts to the Bridge endpoint',
    withdrawalEndpointFor('gbp') === '/api/withdrawals');
  check('eur posts to the Bridge endpoint',
    withdrawalEndpointFor('eur') === '/api/withdrawals');
  check('naira never reaches the Bridge endpoint',
    withdrawalEndpointFor('ngn') !== withdrawalEndpointFor('usd'));
}

console.log('\nTHE GUARDS NARROW, SO THE COMPILER CAN HELP');
{
  check('isNgnCurrency accepts ngn', isNgnCurrency('ngn'));
  check('isNgnCurrency rejects usd', !isNgnCurrency('usd'));
  check('isBridgeCurrency accepts usd/gbp/eur',
    isBridgeCurrency('usd') && isBridgeCurrency('gbp') && isBridgeCurrency('eur'));
  check('isBridgeCurrency rejects ngn', !isBridgeCurrency('ngn'),
    'naira must never be treated as a Bridge currency');
  check('unknown currencies belong to neither',
    !isBridgeCurrency('jpy') && !isNgnCurrency('jpy'));
}

console.log('\nNAIRA IS FORMATTED LIKE NAIRA');
{
  // At ~1605 to the dollar kobo is noise, and every Nigerian banking app the
  // user has seen omits it.
  check('ngn has no decimals', formatPayoutAmount(24075, 'ngn') === '₦24,075',
    formatPayoutAmount(24075, 'ngn'));
  check('usd keeps cents', formatPayoutAmount(15.5, 'usd') === '$15.50',
    formatPayoutAmount(15.5, 'usd'));
  check('a bad amount degrades rather than printing NaN',
    formatPayoutAmount('not-a-number', 'ngn') === '₦0',
    formatPayoutAmount('not-a-number', 'ngn'));
}

console.log('\nTHE FLOOR INCLUDES GAS, BECAUSE GAS COMES OUT OF THE AMOUNT');
{
  // The case that motivated all of this: what must clear the minimum is the
  // amount that ARRIVES, not the amount typed.
  const verdict = offrampClears({ amountUsd: 15.2, breetMinimumUsd: 15, estimatedGasUsd: 0.4 });
  check('15.20 against a 15 minimum is refused once gas is counted', !verdict.clears);
  check('it reports what would actually arrive', near(verdict.arrivesUsd, 14.8),
    String(verdict.arrivesUsd));
  check('the reason names the arriving amount', verdict.reason?.includes('14.80') === true,
    verdict.reason);
  check('the shortfall is actionable', verdict.shortfallUsd > 0, String(verdict.shortfallUsd));
}

console.log('\nCHEAPER NETWORKS HAVE A LOWER FLOOR');
{
  const base = minimumOfframpUsd({ breetMinimumUsd: 15, estimatedGasUsd: typicalGasUsd('base') });
  const ethereum = minimumOfframpUsd({ breetMinimumUsd: 15, estimatedGasUsd: typicalGasUsd('ethereum') });
  const solana = minimumOfframpUsd({ breetMinimumUsd: 15, estimatedGasUsd: typicalGasUsd('solana') });

  check('solana is the cheapest floor', solana.minimumUsd < base.minimumUsd);
  check('base is cheaper than ethereum', base.minimumUsd < ethereum.minimumUsd);
  check('ethereum is visibly dearer', ethereum.minimumUsd >= 20, String(ethereum.minimumUsd));
  console.log(`       solana $${solana.minimumUsd} | base $${base.minimumUsd} | ethereum $${ethereum.minimumUsd}`);
}

console.log('\nTHE BUFFER ABSORBS AN UNDER-ESTIMATE');
{
  // The paymaster collects the EXACT fee after execution, so the pre-flight
  // number is an estimate and a small miss must not flag the deposit.
  const { minimumUsd } = minimumOfframpUsd({ breetMinimumUsd: 15, estimatedGasUsd: 1 });
  check('the floor sits above minimum + gas', minimumUsd > 16, String(minimumUsd));

  const arrives = minimumUsd - 1.2; // actual gas 20% over estimate
  check('sending the floor still clears when gas overruns', arrives >= 15,
    `only ${arrives.toFixed(2)} would arrive`);
}

console.log('\nROUNDING NEVER FAVOURS A FLAGGED DEPOSIT');
{
  const { minimumUsd } = minimumOfframpUsd({ breetMinimumUsd: 15, estimatedGasUsd: 0.333 });
  check('the floor is rounded up', minimumUsd >= 15 + 0.333 + 0.5, String(minimumUsd));
}

console.log('\nA SUFFICIENT WITHDRAWAL IS NOT BLOCKED');
{
  const ok = offrampClears({ amountUsd: 100, breetMinimumUsd: 15, estimatedGasUsd: 0.02 });
  check('100 USD clears', ok.clears);
  check('no reason is attached', ok.reason === undefined);
  check('no shortfall', ok.shortfallUsd === 0);
}

console.log('\nEVERY PAYOUT CURRENCY HAS A RAIL');
{
  // Guards the exhaustiveness: a currency added to PayoutCurrency without a
  // rail fails to compile, and this catches the runtime half.
  const all: PayoutCurrency[] = ['usd', 'gbp', 'eur', 'ngn'];
  check('all four route somewhere',
    all.every((currency) => ['bridge', 'breet'].includes(payoutRailFor(currency))));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

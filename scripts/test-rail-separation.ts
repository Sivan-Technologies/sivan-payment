/**
 * Bridge does fiat. Breet does naira. Neither crosses.
 *
 * Bridge is licensed for USD, GBP and EUR payouts and has no naira rail at
 * all. Breet is the NGN rail and settles nothing else. That split is currently
 * enforced only by two zod enums sitting in different folders, and nothing
 * states the rule or fails when it is broken.
 *
 * The failure this prevents is not a type error, it is a payout attempted on a
 * rail that cannot settle it: a naira withdrawal handed to Bridge is money in
 * flight to a provider that will never deliver it, discovered by a user who
 * did not get paid.
 *
 * Run: npm run test:rail-separation
 */

import { createWithdrawalSchema } from '../src/offramp/service/withdrawals.service.js';
import { createExternalAccountSchema } from '../src/offramp/service/external-accounts.service.js';
import { createNgnQuoteSchema } from '../src/ngn/service/ngn-quotes.service.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

function rejects(schema: any, value: unknown): string | undefined {
  try { schema.parse(value); return undefined; }
  catch (e: any) { return e?.issues?.[0]?.message ?? e?.message ?? String(e); }
}

const withdrawal = (destinationCurrency: string) => ({
  userId: 'user_1', externalAccountId: 'ext_1', amount: '10',
  sourceCurrency: 'usdc', sourceChain: 'base', destinationCurrency,
});

const ngnQuote = (destinationCurrency: string) => ({
  userId: 'user_1', direction: 'offramp',
  sourceCurrency: 'usdc', destinationCurrency, sourceAmount: '10',
});

console.log('\nBRIDGE MUST NOT ACCEPT NAIRA');
{
  // The rule, stated where it can fail. Bridge has no NGN payout rail, so a
  // naira withdrawal must be impossible to construct, not merely discouraged.
  const err = rejects(createWithdrawalSchema, withdrawal('ngn'));
  check('withdrawal destinationCurrency=ngn is rejected', Boolean(err), 'ngn was ACCEPTED by the Bridge rail');
  check('rejection names the allowed currencies', /usd|gbp|eur/i.test(err ?? ''), err);

  const acct = rejects(createExternalAccountSchema, { userId: 'user_1', currency: 'ngn', accountNumber: '0123456789', bankName: 'GTB' });
  check('external account currency=ngn is rejected', Boolean(acct), 'an NGN payout account was ACCEPTED');
}

console.log('\nBRIDGE STILL DOES ITS OWN CURRENCIES');
{
  // Guard against "fixing" the above by narrowing Bridge into uselessness.
  for (const currency of ['usd', 'gbp', 'eur']) {
    check(`withdrawal ${currency} is accepted`, !rejects(createWithdrawalSchema, withdrawal(currency)),
      rejects(createWithdrawalSchema, withdrawal(currency)));
  }
}

console.log('\nTHE NGN RAIL MUST NOT ACCEPT BRIDGE CURRENCIES');
{
  // The mirror image. Breet settles naira; sending it a GBP leg would be the
  // same class of mistake in the other direction.
  for (const currency of ['usd', 'gbp', 'eur']) {
    const err = rejects(createNgnQuoteSchema, ngnQuote(currency));
    check(`ngn off-ramp destinationCurrency=${currency} is rejected`, Boolean(err),
      `${currency} was ACCEPTED by the NGN rail`);
  }
}

console.log('\nTHE NGN RAIL DOES NAIRA');
{
  check('ngn off-ramp destinationCurrency=ngn is accepted',
    !rejects(createNgnQuoteSchema, ngnQuote('ngn')), rejects(createNgnQuoteSchema, ngnQuote('ngn')));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

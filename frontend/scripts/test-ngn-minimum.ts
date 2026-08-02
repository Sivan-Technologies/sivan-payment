/**
 * The two numbers that decide whether an NGN withdrawal can proceed.
 *
 *   FLOOR    the provider minimum plus gas - below it the transfer cannot
 *            settle at all, and the user loses the deposit to fees.
 *   CEILING  the user's remaining 30-day verification headroom.
 *
 * Both are checked in the form before a quote is spent or a submission is
 * made, because the server refuses either case and a rejection at the end of
 * the flow costs the user a quote they were racing an expiry on.
 *
 * Run: npx tsx scripts/test-ngn-minimum.ts
 */

import { exceedsRemaining } from '../src/ngnMinimum';

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

console.log('\nTHE 30-DAY CEILING, CHECKED AT THE POINT OF QUOTING');
{
  // The limit is in naira and the input is in USD, so this compares the
  // QUOTED naira against the server's remaining headroom. Anything else would
  // be a guess at the rate and would disagree with what the server enforces.

  check('a quote under the headroom passes',
    exceedsRemaining(30_000, 50_000) === false);
  check('a quote over the headroom is caught',
    exceedsRemaining(60_000, 50_000) === true);

  // Spending the last naira of an allowance must be allowed - an off-by-one
  // here blocks a user from using the limit they were promised.
  check('exactly the remaining amount is allowed',
    exceedsRemaining(50_000, 50_000) === false);
  check('one naira over is not',
    exceedsRemaining(50_001, 50_000) === true);

  // NOT LOADED MUST NOT BLOCK. If the summary request failed, refusing every
  // withdrawal would turn a degraded read into a total outage for that user.
  check('undefined remaining never blocks',
    exceedsRemaining(9_999_999, undefined) === false);

  // null is genuinely uncapped, not zero. Confusing the two would close the
  // rails for the most verified users on the platform.
  check('null remaining is uncapped, not closed',
    exceedsRemaining(50_000_000, null) === false);

  // A zero allowance is a real state - foreign rails below IDENTITY sit here.
  check('a zero allowance blocks any amount', exceedsRemaining(1, 0) === true);

  // No quote yet means nothing to compare; the form must not warn early.
  check('no quote yet does not warn', exceedsRemaining(0, 50_000) === false);
  check('a NaN quote does not warn', exceedsRemaining(Number.NaN, 50_000) === false);
  check('a negative quote does not warn', exceedsRemaining(-100, 50_000) === false);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

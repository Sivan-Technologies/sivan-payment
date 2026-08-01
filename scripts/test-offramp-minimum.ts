/**
 * The off-ramp floor, derived rather than guessed.
 *
 * The failure being prevented, in the user's words:
 *
 *   "User withdraws $15.20 on Ethereum -> gas takes $0.40 -> $14.80 arrives
 *    -> below minimum -> Breet holds it -> user is not paid, and the money is
 *    not in their wallet either."
 *
 * Breet flags a sub-minimum deposit: confirmed on-chain, funds held, NOT
 * credited, and `flagFeeUSD` charged to recover it. So the amount that must
 * clear the minimum is the amount that ARRIVES, after gas - not the amount the
 * user typed.
 *
 * A fixed threshold cannot express that. It was going to be $17, chosen while
 * we believed Breet's minimum was $15. The live API says 50 for every USDC and
 * USDT asset (USDC_BSC_TEST is 10), so $17 would have put EVERY withdrawal
 * under the floor. Hence: read the minimum, add gas, add a buffer.
 *
 * Run: npm run test:offramp-minimum
 */

import {
  minimumOfframpUsd,
  offrampClears,
  cacheAssetIds,
  assetEconomics,
  clearAssetIdCache,
  breetMinimumDepositUsd,
} from '../src/ngn/provider/breet-networks.js';
import { typicalGasUsd } from '../src/ngn/service/ngn-quotes.service.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) < tol;

console.log('\nTHE $15.20 CASE - THE WHOLE REASON THIS EXISTS');
{
  // Numbers exactly as described, but against Breet's REAL minimum.
  const result = offrampClears({ amountUsd: 15.2, breetMinimumUsd: 50, estimatedGasUsd: 0.4 });
  check('a 15.20 withdrawal is refused', !result.clears);
  check('it says what would actually arrive', near(result.arrivesUsd, 14.8), String(result.arrivesUsd));
  check('the reason names the arriving amount, not the typed one',
    result.reason?.includes('14.80') === true, result.reason);
  check('the shortfall is actionable', result.shortfallUsd > 0, String(result.shortfallUsd));

  // Same case under the minimum we WRONGLY believed. Documents why a fixed
  // threshold was unsafe: 15.20 clears a 15 floor while still being flagged.
  const underOldBelief = offrampClears({ amountUsd: 15.2, breetMinimumUsd: 15, estimatedGasUsd: 0.4 });
  check('under the old hardcoded 15 the same withdrawal is STILL refused',
    !underOldBelief.clears,
    'a 15 minimum would have accepted 15.20 and let 14.80 arrive');
}

console.log('\nGAS COMES OUT OF THE AMOUNT, SO THE FLOOR MOVES WITH IT');
{
  // user-pays deducts gas from the USDC being sent, so a chain with expensive
  // gas has a higher entry price. This is the number the UI must show.
  const base = minimumOfframpUsd({ breetMinimumUsd: 50, estimatedGasUsd: 0.02 });
  const ethereum = minimumOfframpUsd({ breetMinimumUsd: 50, estimatedGasUsd: 5 });

  check('Base floor is a little over the Breet minimum', near(base.minimumUsd, 50.52), String(base.minimumUsd));
  check('Ethereum floor is visibly higher', near(ethereum.minimumUsd, 56), String(ethereum.minimumUsd));
  check('cheaper gas means a lower floor', base.minimumUsd < ethereum.minimumUsd);
  console.log(`       base ${base.minimumUsd} | ethereum ${ethereum.minimumUsd}`);
}

console.log('\nTHE BUFFER ABSORBS AN UNDER-ESTIMATE');
{
  // Privy's paymaster collects the EXACT fee after execution, so the estimate
  // can be low. The buffer is what stops a small miss becoming a flagged
  // deposit.
  const { minimumUsd } = minimumOfframpUsd({ breetMinimumUsd: 50, estimatedGasUsd: 1 });
  const atFloor = 50 + 1;

  check('the floor sits above bare minimum + gas', minimumUsd > atFloor, `${minimumUsd} vs ${atFloor}`);

  // Send exactly the floor, then let actual gas come in 20% over estimate.
  const actualGas = 1.2;
  const arrives = minimumUsd - actualGas;
  check('sending the floor still clears when gas overruns by 20%', arrives >= 50,
    `only ${arrives.toFixed(2)} would arrive`);
}

console.log('\nBUFFER HAS A FLOOR, FOR NEAR-ZERO GAS');
{
  // Solana gas is ~$0.001; 20% of that is nothing, so a percentage alone
  // would leave no headroom at all.
  const solana = minimumOfframpUsd({ breetMinimumUsd: 50, estimatedGasUsd: 0.001 });
  check('a flat buffer applies when gas is negligible',
    solana.breakdown.bufferUsd >= 0.5, String(solana.breakdown.bufferUsd));
  check('percentage wins when gas is large',
    minimumOfframpUsd({ breetMinimumUsd: 50, estimatedGasUsd: 10 }).breakdown.bufferUsd === 2,
    String(minimumOfframpUsd({ breetMinimumUsd: 50, estimatedGasUsd: 10 }).breakdown.bufferUsd));
}

console.log('\nROUNDING NEVER FAVOURS A FLAGGED DEPOSIT');
{
  // Rounding the floor DOWN would reintroduce the sub-minimum case.
  const { minimumUsd } = minimumOfframpUsd({ breetMinimumUsd: 50, estimatedGasUsd: 0.333 });
  check('the floor is rounded up to the cent',
    minimumUsd >= 50 + 0.333 + 0.5, String(minimumUsd));
  check('and is a clean cent value',
    Math.round(minimumUsd * 100) === minimumUsd * 100, String(minimumUsd));
}

console.log('\nA SUFFICIENT WITHDRAWAL IS NOT BLOCKED');
{
  const ok = offrampClears({ amountUsd: 100, breetMinimumUsd: 50, estimatedGasUsd: 0.4 });
  check('100 USD clears', ok.clears);
  check('no shortfall is reported', ok.shortfallUsd === 0);
  check('no reason is attached when it clears', ok.reason === undefined);
  check('the arriving amount is net of gas', near(ok.arrivesUsd, 99.6), String(ok.arrivesUsd));
}

console.log('\nLIVE MINIMUMS REPLACE THE HARDCODED TABLE');
{
  clearAssetIdCache();

  // Shape exactly as GET /trades/assets returns it, values as captured live.
  cacheAssetIds([
    { id: '69b3e33d5aef202395e800e8', identifier: 'SOL_USDC_JKVK', minimum: 50, flagFeeUSD: 1, confirmations: 20 },
    { id: 'aaa', identifier: 'USDC_BSC_TEST', minimum: 10, flagFeeUSD: 2, confirmations: 20 },
  ]);

  const solana = assetEconomics('SOL_USDC_JKVK');
  check('live minimum is read from the API', solana?.minimumUsd === 50, String(solana?.minimumUsd));
  check('the flag fee is captured too', solana?.flagFeeUsd === 1, String(solana?.flagFeeUsd));
  check('per-asset differences survive', assetEconomics('USDC_BSC_TEST')?.minimumUsd === 10);

  // The old code returned 1 in development regardless. Now the live 50 wins.
  const resolved = breetMinimumDepositUsd('solana', 'usdc', 'development');
  check('development no longer reports the docs\' fictional 1 USD', resolved === 50, String(resolved));

  clearAssetIdCache();
  check('with nothing loaded, development refuses to guess',
    breetMinimumDepositUsd('solana', 'usdc', 'development') === undefined,
    String(breetMinimumDepositUsd('solana', 'usdc', 'development')));
}

console.log('\nTHE QUOTE ACTUALLY CARRIES A GAS ESTIMATE');
{
  // The guard reads metadata.estimatedGasUsd, and nothing on the quote path
  // ever wrote it - the quote schema had no `network` field at all, so gas was
  // unknowable and the floor was computed with gas = 0. That is precisely the
  // input the buffer exists to account for.
  check('base has a real estimate', typicalGasUsd('base') === 0.02, String(typicalGasUsd('base')));
  check('solana is near-free', typicalGasUsd('solana') === 0.001);
  check('ethereum is visibly dearer', typicalGasUsd('ethereum') >= 1);
  check('an unknown network gets a cautious default, not zero',
    typicalGasUsd('nonsense-chain') > 0, String(typicalGasUsd('nonsense-chain')));

  // Zero gas understates what ARRIVES, which is the number Breet measures
  // against its minimum.
  const withGas = offrampClears({ amountUsd: 15.10, breetMinimumUsd: 15, estimatedGasUsd: typicalGasUsd('base') });
  const withoutGas = offrampClears({ amountUsd: 15.10, breetMinimumUsd: 15, estimatedGasUsd: 0 });
  check('gas changes the arriving amount', withGas.arrivesUsd < withoutGas.arrivesUsd,
    `${withGas.arrivesUsd} vs ${withoutGas.arrivesUsd}`);
  check('and raises the floor', withGas.minimumUsd > withoutGas.minimumUsd);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

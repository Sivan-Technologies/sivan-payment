/**
 * On-ramp fee policy: minimum fee and amount tiers.
 *
 * Why on-ramp only: Bridge accepts `developer_fee` on POST /transfers as a
 * fixed USD amount that Sivan computes per order, so any shape is expressible
 * and Bridge withholds exactly what is sent. Off-ramp and virtual accounts send
 * a flat percentage fixed BEFORE any amount exists, so a floor or tier is not
 * restricted there - it is impossible.
 *
 * The dangerous cases this locks down:
 *   - a tier table with a gap or overlap makes the fee depend on array order
 *   - a floor on a tiny amount can push the net under Bridge's transaction
 *     minimum, and Bridge neither credits nor returns dust
 *   - the displayed percentage must be what was CHARGED, not what was
 *     configured, or the user is misinformed
 *
 * Run: npm run test:onramp-fee-policy
 */

import {
  calculateOnrampFee,
  findTier,
  previewOnrampFees,
  validateTiers,
  type FeeTier,
} from '../src/admin/fee-policy.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`); }
}

const FLAT = { basePercent: 1.25, minimumFeeUsd: 0, tiers: [] as FeeTier[] };

function main() {
  console.log('\nOn-ramp fee policy\n');

  console.log('1. Flat percentage, no floor');
  let r = calculateOnrampFee({ ...FLAT, amount: 1000 });
  check('1.25% of $1000 is $12.50', r.feeAmount === '12.50', r.feeAmount);
  check('net is $987.50', r.netAmount === '987.50', r.netAmount);
  check('rule is base_percent', r.appliedRule === 'base_percent');

  console.log('\n2. Minimum fee of $1.30');
  const withFloor = { basePercent: 1.25, minimumFeeUsd: 1.3, tiers: [] as FeeTier[] };

  r = calculateOnrampFee({ ...withFloor, amount: 50 });
  check('$50 pays the $1.30 floor, not $0.62', r.feeAmount === '1.30', r.feeAmount);
  check('the rule is reported as minimum_fee', r.appliedRule === 'minimum_fee');
  check('the effective rate is stated honestly as 2.60%',
    r.effectivePercent === '2.60', r.effectivePercent);
  check('the explanation says what it would have been',
    r.explanation.includes('0.63') || r.explanation.includes('0.62'), r.explanation);

  r = calculateOnrampFee({ ...withFloor, amount: 104 });
  check('$104 is the crossover: 1.25% = $1.30', r.feeAmount === '1.30', r.feeAmount);

  r = calculateOnrampFee({ ...withFloor, amount: 200 });
  check('$200 pays 1.25% = $2.50, floor not applied', r.feeAmount === '2.50', r.feeAmount);
  check('and reports base_percent', r.appliedRule === 'base_percent');

  console.log('\n3. Amount tiers');
  const tiers: FeeTier[] = [
    { minAmount: 0, maxAmount: 100, percent: 1.5 },
    { minAmount: 100, maxAmount: 1000, percent: 1.25 },
    { minAmount: 1000, maxAmount: null, percent: 1.0 },
  ];
  const tiered = { basePercent: 1.25, minimumFeeUsd: 0, tiers };

  check('$50 is in the first tier', findTier(50, tiers)?.percent === 1.5);
  check('$100 falls in the SECOND tier, not the first',
    findTier(100, tiers)?.percent === 1.25,
    'boundaries are inclusive-lower, exclusive-upper');
  check('$999.99 is still the middle tier', findTier(999.99, tiers)?.percent === 1.25);
  check('$1000 is the top tier', findTier(1000, tiers)?.percent === 1.0);
  check('$1,000,000 is still the top tier', findTier(1_000_000, tiers)?.percent === 1.0);

  r = calculateOnrampFee({ ...tiered, amount: 50 });
  check('$50 charged at 1.5% = $0.75', r.feeAmount === '0.75', r.feeAmount);
  check('rule is tier', r.appliedRule === 'tier');

  r = calculateOnrampFee({ ...tiered, amount: 5000 });
  check('$5000 charged at 1.0% = $50.00', r.feeAmount === '50.00', r.feeAmount);

  console.log('\n4. Floor and tiers together');
  const both = { basePercent: 1.25, minimumFeeUsd: 1.3, tiers };
  r = calculateOnrampFee({ ...both, amount: 50 });
  check('floor beats the tier when the tier is lower', r.feeAmount === '1.30', r.feeAmount);
  r = calculateOnrampFee({ ...both, amount: 500 });
  check('tier applies when above the floor', r.feeAmount === '6.25', r.feeAmount);

  console.log("\n5. Bridge's transaction minimum protects the user");
  // Bridge: "minimums are enforced AFTER developer fees are deducted" and dust
  // below is "not credited or returned".
  r = calculateOnrampFee({ ...withFloor, amount: 2, transactionMinimumUsd: 1 });
  check('a $2 deposit is not charged the full $1.30 floor',
    Number(r.feeAmount) <= 1.0, r.feeAmount);
  check('the net stays at or above the $1 minimum',
    Number(r.netAmount) >= 1, r.netAmount);
  check('the rule says the fee was capped', r.appliedRule === 'capped_to_minimum_net');
  check('the explanation names the reason',
    /transaction minimum/i.test(r.explanation), r.explanation);

  r = calculateOnrampFee({ ...withFloor, amount: 1, transactionMinimumUsd: 1 });
  check('a $1 deposit is charged nothing rather than voided',
    r.feeAmount === '0.00', r.feeAmount);

  console.log('\n6. Tier validation rejects broken tables');
  check('a valid table passes', validateTiers(tiers).length === 0);

  check('a gap is caught', validateTiers([
    { minAmount: 0, maxAmount: 100, percent: 1.5 },
    { minAmount: 200, maxAmount: null, percent: 1.0 },
  ]).some((e) => /Gap/.test(e)));

  check('an overlap is caught', validateTiers([
    { minAmount: 0, maxAmount: 200, percent: 1.5 },
    { minAmount: 100, maxAmount: null, percent: 1.0 },
  ]).some((e) => /overlap/.test(e)));

  check('not starting at 0 is caught', validateTiers([
    { minAmount: 50, maxAmount: null, percent: 1.5 },
  ]).some((e) => /must start at 0/.test(e)));

  check('a closed final tier is caught', validateTiers([
    { minAmount: 0, maxAmount: 100, percent: 1.5 },
  ]).some((e) => /open-ended/.test(e)));

  check('a percent above 100 is caught', validateTiers([
    { minAmount: 0, maxAmount: null, percent: 150 },
  ]).some((e) => /between 0 and 100/.test(e)));

  check('an inverted tier is caught', validateTiers([
    { minAmount: 0, maxAmount: 100, percent: 1 },
    { minAmount: 100, maxAmount: 50, percent: 1 },
  ]).length > 0);

  console.log('\n7. Rounding and money safety');
  r = calculateOnrampFee({ ...FLAT, amount: 33.33 });
  check('fee has exactly 2 decimals', /^\d+\.\d{2}$/.test(r.feeAmount), r.feeAmount);
  check('fee plus net equals the amount',
    Math.abs(Number(r.feeAmount) + Number(r.netAmount) - 33.33) < 0.005,
    `${r.feeAmount} + ${r.netAmount}`);

  r = calculateOnrampFee({ ...FLAT, amount: 0 });
  check('a zero amount charges nothing', r.feeAmount === '0.00');
  r = calculateOnrampFee({ ...FLAT, amount: -100 });
  check('a negative amount charges nothing', r.feeAmount === '0.00');

  console.log('\n8. Preview for the Admin Hub');
  const rows = previewOnrampFees({ basePercent: 1.25, minimumFeeUsd: 1.3, tiers: [] });
  check('preview returns a row per amount', rows.length === 8);
  check('small amounts show the floor',
    rows.find((x) => x.amount === '10.00')?.rule === 'minimum_fee');
  check('large amounts show the percentage',
    rows.find((x) => x.amount === '5000.00')?.rule === 'base_percent');
  check('each row reports the effective rate',
    rows.every((x) => /^\d+\.\d{2}$/.test(x.effectivePercent)));

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  if (fail > 0) process.exit(1);
}

main();

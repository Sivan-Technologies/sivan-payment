/**
 * Fee settings and preview, exercised through the service layer.
 *
 * The unit tests cover the arithmetic. This covers the parts that only break
 * once settings are persisted and read back: that an invalid tier table is
 * rejected at the boundary rather than stored, that a saved floor actually
 * reaches the on-ramp quote, and that the quote reports the fee CHARGED rather
 * than the fee configured.
 *
 * That last one matters most. With a floor applied, the effective rate differs
 * from the configured percentage, and showing the configured one would tell a
 * user they paid 1.25% when they paid 2.60%.
 *
 * Run: npm run test:fee-api-e2e
 */

import { getAdminFeeSettings, updateAdminFeeSettings } from '../src/admin/admin-fees.service.js';
import { calculateOnrampQuote } from '../src/onramp/service/onramp-fees.service.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`); }
}

async function save(patch: Record<string, unknown>) {
  const current = await getAdminFeeSettings();
  return updateAdminFeeSettings(
    { ...current, ...patch, updatedBy: 'test.harness@sivantech.online', reason: 'fee api e2e' } as any,
    {}
  );
}

async function main() {
  console.log('\nFee settings and on-ramp quote\n');
  const original = await getAdminFeeSettings();

  try {
    console.log('1. Defaults are a flat percentage');
    await save({ onrampFeePercent: 1.25, onrampMinimumFeeUsd: 0, onrampFeeTiers: [] });
    let q = await calculateOnrampQuote(1000);
    check('$1000 pays 1.25% = $12.50', q.feeAmount === '12.50', q.feeAmount);
    check('the quote reports base_percent', q.feeRule === 'base_percent', q.feeRule);

    console.log('\n2. A saved minimum fee reaches the quote');
    await save({ onrampMinimumFeeUsd: 1.3 });
    q = await calculateOnrampQuote(50);
    check('$50 pays the $1.30 floor', q.feeAmount === '1.30', q.feeAmount);
    check('the rule is minimum_fee', q.feeRule === 'minimum_fee', q.feeRule);
    check('the quote reports the CHARGED rate, not the configured one',
      q.feePercent === '2.60',
      `got ${q.feePercent}, configured is 1.25 - showing 1.25 would misstate what the user pays`);
    check('the explanation is human-readable',
      typeof q.feeExplanation === 'string' && q.feeExplanation.length > 0,
      q.feeExplanation);

    q = await calculateOnrampQuote(500);
    check('$500 is above the floor and pays 1.25%', q.feeAmount === '6.25', q.feeAmount);
    check('and reports 1.25%', q.feePercent === '1.25', q.feePercent);

    console.log('\n3. Saved tiers reach the quote');
    await save({
      onrampMinimumFeeUsd: 1.3,
      onrampFeeTiers: [
        { minAmount: 0, maxAmount: 100, percent: 1.5 },
        { minAmount: 100, maxAmount: 1000, percent: 1.25 },
        { minAmount: 1000, maxAmount: null, percent: 1.0 },
      ],
    });
    q = await calculateOnrampQuote(5000);
    check('$5000 uses the top tier at 1.0% = $50', q.feeAmount === '50.00', q.feeAmount);
    check('rule is tier', q.feeRule === 'tier', q.feeRule);

    q = await calculateOnrampQuote(200);
    check('$200 uses the middle tier at 1.25% = $2.50', q.feeAmount === '2.50', q.feeAmount);

    q = await calculateOnrampQuote(50);
    check('$50 still hits the floor, since 1.5% is below it', q.feeAmount === '1.30', q.feeAmount);

    console.log('\n4. Invalid tier tables are rejected, not stored');
    const before = await getAdminFeeSettings();

    let rejected = false;
    try {
      await save({ onrampFeeTiers: [
        { minAmount: 0, maxAmount: 100, percent: 1.5 },
        { minAmount: 200, maxAmount: null, percent: 1.0 },
      ] });
    } catch { rejected = true; }
    check('a gap is rejected on save', rejected);

    rejected = false;
    try {
      await save({ onrampFeeTiers: [
        { minAmount: 0, maxAmount: 200, percent: 1.5 },
        { minAmount: 100, maxAmount: null, percent: 1.0 },
      ] });
    } catch { rejected = true; }
    check('an overlap is rejected on save', rejected);

    rejected = false;
    try {
      await save({ onrampFeeTiers: [{ minAmount: 0, maxAmount: 100, percent: 1.5 }] });
    } catch { rejected = true; }
    check('a closed final tier is rejected on save', rejected);

    const after = await getAdminFeeSettings();
    check('the stored tiers were not corrupted by the rejected saves',
      JSON.stringify(after.onrampFeeTiers) === JSON.stringify(before.onrampFeeTiers),
      'a rejected save must leave settings untouched');

    console.log('\n5. Off-ramp and virtual accounts stay independent');
    await save({ onrampFeePercent: 2.5, onrampMinimumFeeUsd: 5 });
    const s = await getAdminFeeSettings();
    check('off-ramp is unaffected by on-ramp changes', s.offrampFeePercent === original.offrampFeePercent,
      `${s.offrampFeePercent} vs ${original.offrampFeePercent}`);
    check('virtual account fee is unaffected',
      s.virtualAccountFeePercent === original.virtualAccountFeePercent);
    check('the VA fee_config flag is untouched',
      s.virtualAccountFeeConfigEnabled === original.virtualAccountFeeConfigEnabled);

    console.log('\n6. A tiny order cannot be destroyed by the fee');
    // Bridge enforces its transaction minimum AFTER the developer fee and does
    // not return dust, so a $5 floor on a $2 order must not void it.
    q = await calculateOnrampQuote(2);
    check('a $2 order is not charged the $5 floor', Number(q.feeAmount) < 5, q.feeAmount);
    check('the net stays at or above $1', Number(q.netAmount) >= 1, q.netAmount);
    check('and the reason is recorded', q.feeRule === 'capped_to_minimum_net', q.feeRule);
  } finally {
    await updateAdminFeeSettings(
      { ...original, updatedBy: 'test.harness@sivantech.online', reason: 'restore after fee api e2e' } as any,
      {}
    );
    const restored = await getAdminFeeSettings();
    check('settings restored to their original values',
      restored.onrampFeePercent === original.onrampFeePercent &&
      Number(restored.onrampMinimumFeeUsd ?? 0) === Number(original.onrampMinimumFeeUsd ?? 0));
  }

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

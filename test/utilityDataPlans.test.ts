import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getUtilityDataPlans,
  getUtilityDataPlanBySize,
  updateUtilityDataPlans,
  getActiveUtilityProviderInfo,
  setUtilityProvider,
  resolveProviderPlanCode,
  DEFAULT_DATA_PLANS,
} from '../src/ngn/service/utility-data-plans.service.js';

test('Utility Data Plans Service — ships no built-in catalogue, so no invented wholesale costs', async () => {
  // The old default list carried made-up costs (1GB at 350, 5GB at 1750).
  // Checked against the live SME API catalogue those were wrong in both
  // directions, which made the admin hub report margins that did not exist.
  assert.strictEqual(DEFAULT_DATA_PLANS.length, 0);

  const plans = await getUtilityDataPlans();
  assert.ok(Array.isArray(plans));
  for (const plan of plans) {
    // Cost is either a real synced figure or explicitly unknown, never a guess.
    assert.ok(plan.costPriceNgn === null || typeof plan.costPriceNgn === 'number');
    if (plan.costPriceNgn === null) {
      assert.strictEqual(plan.markupNgn, null, 'markup cannot be known while cost is unknown');
    } else {
      assert.strictEqual(plan.markupNgn, plan.amountNgn - plan.costPriceNgn);
    }
  }
});

test('Utility Data Plans Service — a retail price is required and margin is derived from real cost', async () => {
  const updated = await updateUtilityDataPlans(
    [
      // Real verified SME API rate for MTN 1GB SME2 30days.
      { bundleSize: '1GB', costPriceNgn: 395, amountNgn: 430, network: 'mtn', isActive: true },
      // Cost not yet synced: priced, but margin must stay unknown.
      { bundleSize: '2GB', amountNgn: 820, network: 'mtn', isActive: true },
    ],
    'admin_test_user'
  );

  const p1 = updated.find((p) => p.bundleSize === '1GB' && p.network === 'mtn');
  assert.ok(p1);
  assert.strictEqual(p1.costPriceNgn, 395);
  assert.strictEqual(p1.amountNgn, 430);
  assert.strictEqual(p1.markupNgn, 35, 'real margin on 1GB is 35, not the 80 previously displayed');
  assert.strictEqual(p1.updatedBy, 'admin_test_user');

  const p2 = updated.find((p) => p.bundleSize === '2GB' && p.network === 'mtn');
  assert.ok(p2);
  assert.strictEqual(p2.costPriceNgn, null);
  assert.strictEqual(p2.markupNgn, null);
  assert.strictEqual(p2.amountNgn, 820);

  const live = await getUtilityDataPlanBySize('1GB', 'mtn');
  assert.ok(live);
  assert.strictEqual(live.amountNgn, 430);
});

test('Utility Data Plans Service — a brand new plan with no price at all is refused', async () => {
  await assert.rejects(
    () => updateUtilityDataPlans([{ bundleSize: '77GB', network: 'glo', isActive: true }], 'admin_test_user'),
    /needs a retail price/i
  );
});

test('Utility Data Plans Service — per-provider plan codes are stored and merged, not overwritten', async () => {
  await updateUtilityDataPlans(
    [
      {
        bundleSize: '1GB',
        costPriceNgn: 395,
        amountNgn: 430,
        network: 'mtn',
        planType: 'SME2',
        validity: '30days',
        providerPlanCodes: { smeapi: '6' },
      },
    ],
    'admin_test_user'
  );

  let plan = await getUtilityDataPlanBySize('1GB', 'mtn');
  assert.ok(plan);
  assert.strictEqual(plan.planType, 'SME2');
  assert.strictEqual(resolveProviderPlanCode(plan, 'smeapi'), '6');

  // Adding a second provider must not drop the first.
  await updateUtilityDataPlans(
    [{ bundleSize: '1GB', network: 'mtn', providerPlanCodes: { vtu_ng: 'MTN-1GB-30' } }],
    'admin_test_user'
  );
  plan = await getUtilityDataPlanBySize('1GB', 'mtn');
  assert.ok(plan);
  assert.strictEqual(resolveProviderPlanCode(plan, 'smeapi'), '6');
  assert.strictEqual(resolveProviderPlanCode(plan, 'vtu_ng'), 'MTN-1GB-30');
});

test('Utility Data Plans Service — resolveProviderPlanCode refuses rather than inventing a code', () => {
  assert.strictEqual(resolveProviderPlanCode(null, 'smeapi'), null);
  assert.strictEqual(
    resolveProviderPlanCode(
      { providerPlanCodes: {} } as any,
      'smeapi'
    ),
    null,
    'an unmapped provider must return null so the caller can refuse'
  );
  assert.strictEqual(
    resolveProviderPlanCode({ providerPlanCodes: { smeapi: '   ' } } as any, 'smeapi'),
    null,
    'a blank mapping is not a usable plan code'
  );
});

test('Utility Provider Toggle — get and switch active provider between paystack and vtu_ng', async () => {
  const info = await getActiveUtilityProviderInfo();
  assert.ok(info.availableProviders.includes('paystack'));
  assert.ok(info.availableProviders.includes('vtu_ng'));

  const switched = await setUtilityProvider('vtu_ng', 'admin_test');
  assert.strictEqual(switched.activeProvider, 'vtu_ng');

  const check = await getActiveUtilityProviderInfo();
  assert.strictEqual(check.activeProvider, 'vtu_ng');

  // Switch back to paystack
  const restored = await setUtilityProvider('paystack', 'admin_test');
  assert.strictEqual(restored.activeProvider, 'paystack');
});

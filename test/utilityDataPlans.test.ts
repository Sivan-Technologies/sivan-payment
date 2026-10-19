import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getUtilityDataPlans,
  getUtilityDataPlanBySize,
  updateUtilityDataPlans,
  getActiveUtilityProviderInfo,
  setUtilityProvider,
  DEFAULT_DATA_PLANS,
} from '../src/ngn/service/utility-data-plans.service.js';

test('Utility Data Plans Service — returns default plans with 1GB, 2GB, 5GB, 10GB tiers', async () => {
  const plans = await getUtilityDataPlans();
  assert.ok(Array.isArray(plans));
  assert.ok(plans.length >= 4);

  const p1 = plans.find((p) => p.bundleSize === '1GB');
  assert.ok(p1);
  assert.strictEqual(p1.costPriceNgn, 350);
  assert.strictEqual(p1.markupNgn, 80);
  assert.strictEqual(p1.amountNgn, 430);
  assert.strictEqual(p1.isActive, true);

  const p2 = plans.find((p) => p.bundleSize === '2GB');
  assert.ok(p2);
  assert.strictEqual(p2.costPriceNgn, 700);
  assert.strictEqual(p2.amountNgn, p2.costPriceNgn + p2.markupNgn);

  const p5 = plans.find((p) => p.bundleSize === '5GB');
  assert.ok(p5);
  assert.strictEqual(p5.costPriceNgn, 1750);
  assert.strictEqual(p5.amountNgn, p5.costPriceNgn + p5.markupNgn);

  const p10 = plans.find((p) => p.bundleSize === '10GB');
  assert.ok(p10);
  assert.strictEqual(p10.costPriceNgn, 3500);
  assert.strictEqual(p10.amountNgn, p10.costPriceNgn + p10.markupNgn);
});

test('Utility Data Plans Service — getUtilityDataPlanBySize finds plan case-insensitively', async () => {
  const plan1 = await getUtilityDataPlanBySize('1gb');
  assert.ok(plan1);
  assert.strictEqual(plan1.bundleSize, '1GB');
  assert.strictEqual(plan1.amountNgn, plan1.costPriceNgn + plan1.markupNgn);

  const plan5 = await getUtilityDataPlanBySize('5GB');
  assert.ok(plan5);
  assert.strictEqual(plan5.bundleSize, '5GB');
  assert.strictEqual(plan5.amountNgn, plan5.costPriceNgn + plan5.markupNgn);
});

test('Utility Data Plans Service — updateUtilityDataPlans updates price dynamically with audit trail', async () => {
  // Test setting wholesale cost 350 + markup 80 = 430
  const updated = await updateUtilityDataPlans([
    { bundleSize: '1GB', costPriceNgn: 350, markupNgn: 80, network: 'all', isActive: true },
    { bundleSize: '2GB', costPriceNgn: 700, markupNgn: 150, network: 'all', isActive: true },
  ], 'admin_test_user');

  assert.ok(Array.isArray(updated));
  const p1 = updated.find((p) => p.bundleSize === '1GB');
  assert.ok(p1);
  assert.strictEqual(p1.costPriceNgn, 350);
  assert.strictEqual(p1.markupNgn, 80);
  assert.strictEqual(p1.amountNgn, 430);
  assert.strictEqual(p1.updatedBy, 'admin_test_user');

  const p2 = updated.find((p) => p.bundleSize === '2GB');
  assert.ok(p2);
  assert.strictEqual(p2.amountNgn, 850); // 700 + 150

  // Verify getUtilityDataPlanBySize returns the updated live price
  const live = await getUtilityDataPlanBySize('1GB');
  assert.ok(live);
  assert.strictEqual(live.amountNgn, 430);

  // Restore defaults
  await updateUtilityDataPlans([
    { bundleSize: '1GB', costPriceNgn: 350, markupNgn: 80, network: 'all', isActive: true },
    { bundleSize: '2GB', costPriceNgn: 700, markupNgn: 120, network: 'all', isActive: true },
  ], 'admin_test_restore');
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

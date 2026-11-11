import assert from 'node:assert/strict';
import {
  getComplianceThresholds,
  updateComplianceThresholds,
  evaluateComplianceStepUp,
  DEFAULT_COMPLIANCE_LIMITS_NG,
  DEFAULT_COMPLIANCE_LIMITS_GLOBAL,
} from '../src/compliance/compliance-thresholds.service.js';

async function runTests() {
  console.log('--- Testing Compliance & Step-Up KYC Thresholds ---');

  // Test 1: Defaults
  const initial = await getComplianceThresholds();
  assert.ok(initial.nigeria, 'Nigeria settings exist');
  assert.ok(initial.global, 'Global settings exist');
  assert.equal(initial.nigeria.corridor, 'nigeria');
  assert.equal(initial.nigeria.currency, 'NGN');
  assert.equal(initial.nigeria.tier2Enforced, false, 'Nigeria corridor defaults to Growth Mode (OFF)');
  assert.equal(initial.global.corridor, 'global');
  assert.equal(initial.global.currency, 'USD');
  assert.equal(initial.global.tier2Enforced, false, 'Global corridor defaults to Growth Mode (OFF)');
  console.log('✓ Default settings initialized with Growth Mode (Bypass) for both corridors');

  // Test 2: Growth Mode allows high-value transactions friction-free
  const evalGrowth = await evaluateComplianceStepUp({
    userId: 'usr_test_compliance_123',
    amountNgn: 15000000, // ₦15,000,000 (well above ₦2,000,000)
    corridor: 'nigeria',
  });
  assert.equal(evalGrowth.stepUpRequired, false, 'Growth mode does not require step-up');
  assert.equal(evalGrowth.growthMode, true, 'Growth mode is active');
  console.log('✓ Growth Mode allows high-value transactions friction-free without blocking user');

  // Test 3: Updating Nigeria corridor thresholds & enabling Compliance Mode
  const updatedNg = await updateComplianceThresholds(
    {
      corridor: 'nigeria',
      singleTxLimit: 3000000,
      monthlyCap: 10000000,
      tier2Enforced: true,
      autoPromptEnabled: true,
    },
    'samswitchy'
  );
  assert.equal(updatedNg.nigeria.singleTxLimitNgn, 3000000);
  assert.equal(updatedNg.nigeria.monthlyCapNgn, 10000000);
  assert.equal(updatedNg.nigeria.tier2Enforced, true);
  console.log('✓ Successfully updated Nigeria compliance thresholds and switched to Compliance Mode');

  // Test 4: Compliance Mode active - within limit proceeds
  const evalWithinLimit = await evaluateComplianceStepUp({
    userId: 'usr_test_compliance_123',
    amountNgn: 1500000, // ₦1.5M is below ₦3M threshold
    corridor: 'nigeria',
  });
  assert.equal(evalWithinLimit.stepUpRequired, false, 'Within single transaction limit proceeds');
  console.log('✓ Transaction within compliance threshold proceeds without step-up');

  // Test 5: Compliance Mode active - above limit requires Step-Up
  const evalOverLimit = await evaluateComplianceStepUp({
    userId: 'usr_test_compliance_123',
    amountNgn: 5000000, // ₦5M exceeds ₦3M threshold
    corridor: 'nigeria',
  });
  assert.equal(evalOverLimit.stepUpRequired, true, 'Exceeding threshold requires step-up');
  assert.equal(evalOverLimit.enforced, true);
  assert.ok(evalOverLimit.reason?.includes('exceeds'), 'Provides clear compliance reason');
  console.log('✓ High-value transaction above threshold correctly triggers Step-Up KYC challenge');

  // Test 6: Global corridor update & evaluation
  const updatedGlobal = await updateComplianceThresholds(
    {
      corridor: 'global',
      singleTxLimit: 5000,
      monthlyCap: 20000,
      tier2Enforced: true,
      autoPromptEnabled: true,
    },
    'samswitchy'
  );
  assert.equal(updatedGlobal.global.singleTxLimitUsd, 5000);
  assert.equal(updatedGlobal.global.monthlyCapUsd, 20000);
  assert.equal(updatedGlobal.global.tier2Enforced, true);

  const evalGlobalOver = await evaluateComplianceStepUp({
    userId: 'usr_test_compliance_123',
    amountUsd: 7500, // $7,500 exceeds $5,000 threshold
    corridor: 'global',
  });
  assert.equal(evalGlobalOver.stepUpRequired, true);
  console.log('✓ Global corridor compliance enforcement verified for USD rails');

  // Test 7: Resetting back to Growth Mode (Bypass)
  await updateComplianceThresholds(
    {
      corridor: 'nigeria',
      singleTxLimit: 2000000,
      monthlyCap: 7500000,
      tier2Enforced: false,
      autoPromptEnabled: true,
    },
    'samswitchy'
  );
  await updateComplianceThresholds(
    {
      corridor: 'global',
      singleTxLimit: 2500,
      monthlyCap: 10000,
      tier2Enforced: false,
      autoPromptEnabled: true,
    },
    'samswitchy'
  );
  const resetCheck = await getComplianceThresholds();
  assert.equal(resetCheck.nigeria.tier2Enforced, false);
  assert.equal(resetCheck.global.tier2Enforced, false);
  console.log('✓ Successfully reset corridors back to default Growth Mode');

  console.log('All compliance threshold tests passed successfully! 🚀');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

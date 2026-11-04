// Unit Test: Community Partner and Admin Revenue Share Engine
// Verifies group registration, partner code linking, zero-loss double-entry revshare, and admin toggles.

import assert from 'node:assert/strict';
import { communityRevshareService } from '../src/ngn/service/community-revshare.service.js';

async function run() {
  console.log('🧪 Starting Community Partner Revshare Test Suite...\n');

  // 1. Group Registration
  console.log('1. Testing Community Group Registration...');
  const refCode = `TEST_REF_${Date.now()}`;
  const group = await communityRevshareService.registerGroup({
    groupName: 'Lagos Tech Traders',
    adminActorId: 'usr_admin_test_123',
    adminPhone: '+2348011223344',
    referralCode: refCode,
    revsharePercent: 20.0,
    isEarningEnabled: true,
  });

  assert.ok(group.id, 'Group ID must be generated');
  assert.strictEqual(group.groupName, 'Lagos Tech Traders');
  assert.strictEqual(group.referralCode, refCode);
  assert.strictEqual(group.revsharePercent, 20.0);
  assert.strictEqual(group.isEarningEnabled, true);
  assert.strictEqual(group.status, 'ACTIVE');
  console.log('   ✅ Group registration verified.\n');

  // 2. Linking Group JID
  console.log('2. Testing WhatsApp Group Linking via Partner Code...');
  const testJid = `120363${Date.now()}@g.us`;
  const linkRes = await communityRevshareService.linkGroup({
    groupJid: testJid,
    groupName: 'Lagos Tech Traders Official',
    partnerCode: refCode,
  });

  assert.strictEqual(linkRes.success, true);
  assert.strictEqual(linkRes.group?.groupJid, testJid);
  assert.strictEqual(linkRes.group?.groupName, 'Lagos Tech Traders Official');

  // Test invalid partner code
  const invalidLink = await communityRevshareService.linkGroup({
    groupJid: 'invalid@g.us',
    groupName: 'Fake Group',
    partnerCode: 'NON_EXISTENT_CODE_99',
  });
  assert.strictEqual(invalidLink.success, false);
  console.log('   ✅ Group linking and validation verified.\n');

  // 3. Revshare Allocation: Standard Macro Deal (₦100,000, ₦2,000 fee)
  console.log('3. Testing Revshare Allocation on Standard Deal...');
  const allocRes = await communityRevshareService.allocateRevshare({
    agreementId: 'SIV-TEST-MACRO-01',
    originatingGroupId: testJid,
    dealAmountNgn: 100000,
    platformFeeNgn: 2000,
  });

  assert.strictEqual(allocRes.allocated, true);
  assert.strictEqual(allocRes.allocationStatus, 'CREDITED');
  assert.strictEqual(allocRes.dealAmountNgn, 100000);
  assert.strictEqual(allocRes.platformFeeNgn, 2000);
  assert.strictEqual(allocRes.revsharePercentApplied, 20.0);
  assert.strictEqual(allocRes.revshareAmountNgn, 400); // 20% of 2000 = 400
  assert.ok(allocRes.revshareAmountNgn <= allocRes.platformFeeNgn, 'Zero-loss: Revshare must not exceed platform fee');
  console.log('   ✅ Standard revshare calculation verified (₦400 credited from ₦2,000 fee).\n');

  // 4. Revshare Allocation: Micro Deal (₦2,500, ₦50 fee)
  console.log('4. Testing Revshare Allocation on Micro Deal Bracket...');
  const microRes = await communityRevshareService.allocateRevshare({
    agreementId: 'SIV-TEST-MICRO-02',
    originatingGroupId: testJid,
    dealAmountNgn: 2500,
    platformFeeNgn: 50,
  });

  assert.strictEqual(microRes.allocated, true);
  assert.strictEqual(microRes.allocationStatus, 'CREDITED');
  assert.strictEqual(microRes.revshareAmountNgn, 10); // 20% of 50 = 10
  assert.ok(microRes.revshareAmountNgn > 0, 'Revshare must be strictly positive');
  console.log('   ✅ Micro deal bracket verified (₦10 credited from ₦50 fee).\n');

  // 5. Zero-Fee Handling
  console.log('5. Testing Zero-Fee Scenarios...');
  const zeroRes = await communityRevshareService.allocateRevshare({
    agreementId: 'SIV-TEST-ZERO-03',
    originatingGroupId: testJid,
    dealAmountNgn: 5000,
    platformFeeNgn: 0,
  });

  assert.strictEqual(zeroRes.allocated, false);
  assert.strictEqual(zeroRes.allocationStatus, 'ZERO_FEE');
  assert.strictEqual(zeroRes.revshareAmountNgn, 0);
  console.log('   ✅ Zero-fee bypass verified without ledger drift.\n');

  // 6. Admin Earnings Toggle: Disabled
  console.log('6. Testing Admin Earnings Disabled Toggle...');
  await communityRevshareService.updateAdminControls({
    groupId: group.id,
    isEarningEnabled: false,
  });

  const disabledRes = await communityRevshareService.allocateRevshare({
    agreementId: 'SIV-TEST-DISABLED-04',
    originatingGroupId: testJid,
    dealAmountNgn: 50000,
    platformFeeNgn: 1000,
  });

  assert.strictEqual(disabledRes.allocated, false);
  assert.strictEqual(disabledRes.allocationStatus, 'SKIPPED_DISABLED');
  assert.strictEqual(disabledRes.revshareAmountNgn, 0);
  console.log('   ✅ Earnings disabled toggle verified (recorded in ledger as SKIPPED_DISABLED).\n');

  // 7. Custom VIP Rate & Reactivation (25%)
  console.log('7. Testing Custom Revshare Rate (VIP 25%)...');
  await communityRevshareService.updateAdminControls({
    groupId: group.id,
    isEarningEnabled: true,
    revsharePercent: 25.0,
  });

  const vipRes = await communityRevshareService.allocateRevshare({
    agreementId: 'SIV-TEST-VIP-05',
    originatingGroupId: testJid,
    dealAmountNgn: 80000,
    platformFeeNgn: 1600,
  });

  assert.strictEqual(vipRes.allocated, true);
  assert.strictEqual(vipRes.revsharePercentApplied, 25.0);
  assert.strictEqual(vipRes.revshareAmountNgn, 400); // 25% of 1600 = 400
  console.log('   ✅ Custom 25% VIP revshare verified.\n');

  // 8. Verify Aggregate Group Metrics
  console.log('8. Verifying Aggregate Group Metrics in Database...');
  const groups = await communityRevshareService.listGroups();
  const updatedGroup = groups.find((g) => g.id === group.id);
  assert.ok(updatedGroup);
  assert.strictEqual(updatedGroup.totalDealsCount, 3); // 3 successful allocations
  assert.strictEqual(updatedGroup.totalVolumeNgn, 100000 + 2500 + 80000); // 182,500
  assert.strictEqual(updatedGroup.totalRevenueEarnedNgn, 400 + 10 + 400); // 810
  console.log(`   ✅ Aggregate volume verified: ₦${updatedGroup.totalVolumeNgn.toLocaleString()} across ${updatedGroup.totalDealsCount} deals.`);
  console.log(`   ✅ Total admin earnings: ₦${updatedGroup.totalRevenueEarnedNgn.toLocaleString()}\n`);

  console.log('🎉 All Community Revshare Unit Tests Passed Successfully!');
}

run().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});

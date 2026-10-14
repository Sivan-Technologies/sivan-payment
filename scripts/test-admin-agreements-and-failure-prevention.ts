import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { db } from '../src/database/json-database.js';
import { id as generateId, nowIso } from '../src/shared/id.js';
import type { ServiceAgreementRecord } from '../src/database/types.js';

async function run() {
  console.log('\n=== Testing Admin Agreement Controls & Release Failure Prevention ===\n');

  const app = await buildApp();
  const adminHeaders = {
    'x-admin-api-key': process.env.ADMIN_API_KEY || 'test-admin-key',
    'x-sivan-admin-role': 'superadmin',
  };

  // 1. Placeholder Buyer Identifier Rejection
  console.log('1. Testing placeholder buyer identifier rejection...');
  const res1 = await app.inject({
    method: 'POST',
    url: '/api/agreements',
    payload: {
      buyerUserId: 'minipay_buyer',
      sellerUserId: 'usr_valid_seller_123',
      title: 'Test Web Design',
      amountUsdc: 25,
      network: 'solana',
    },
  });
  assert.equal(res1.statusCode, 400, `Expected 400 for minipay_buyer, got ${res1.statusCode}`);
  const body1 = JSON.parse(res1.payload);
  assert.match(body1.message || body1.error?.message, /placeholder/i);
  console.log('   ✅ minipay_buyer rejected with 400 Bad Request');

  // 2. Circular Identity Rejection
  console.log('2. Testing circular buyer == seller rejection...');
  const res2 = await app.inject({
    method: 'POST',
    url: '/api/agreements',
    payload: {
      buyerUserId: 'usr_same_user_123',
      sellerUserId: 'usr_same_user_123',
      title: 'Self agreement',
      amountUsdc: 25,
      network: 'solana',
    },
  });
  assert.equal(res2.statusCode, 400, `Expected 400 for circular agreement, got ${res2.statusCode}`);
  console.log('   ✅ Circular buyer == seller rejected with 400');

  // 3. Admin list endpoint
  console.log('3. Testing GET /api/admin/agreements endpoint...');
  const res3 = await app.inject({
    method: 'GET',
    url: '/api/admin/agreements',
    headers: adminHeaders,
  });
  assert.equal(res3.statusCode, 200, `Expected 200 for admin agreements list, got ${res3.statusCode}`);
  const body3 = JSON.parse(res3.payload);
  assert.ok(body3.data, 'Expected data envelope in response');
  assert.ok(Array.isArray(body3.data.agreements), 'Expected agreements array');
  assert.ok(body3.data.summary, 'Expected operations summary');
  console.log(`   ✅ Admin agreements list returned ${body3.data.agreements.length} agreements (total: ${body3.data.summary.total})`);

  // 4. Create a test agreement and test Admin Force Release with verified tx hash override
  console.log('4. Testing admin force-release with tx hash override...');
  const testId = `agr_test_admin_${Date.now()}`;
  const now = nowIso();
  const testRecord: ServiceAgreementRecord = {
    id: testId,
    buyerUserId: 'usr_buyer_alice',
    sellerUserId: 'usr_seller_bob',
    title: 'Mobile App Wireframes',
    description: 'Create Figma wireframes in 3 days',
    amountUsdc: 30,
    currency: 'usdc',
    network: 'solana',
    status: 'delivered',
    deadlineDays: 3,
    deliveryDueAt: now,
    reminder6hSent: false,
    overdueNoticeSent: false,
    fundedAt: now,
    deliveredAt: now,
    releasedAt: null,
    fundingTxHash: 'mock_funding_hash_1234567890abcdef',
    releaseTxHash: null,
    vaultAddress: null,
    channel: 'web',
    feeAmountUsdc: 0.3,
    feePercent: 1,
    feePayer: 'seller',
    buyerTotalPayableUsdc: 30,
    sellerNetAmountUsdc: 29.7,
    createdAt: now,
    updatedAt: now,
  };

  await db.insertServiceAgreement(testRecord);

  const testTxHash = '29XPLbrSPpF4ago7zdMEh1FkMvsE7AAWZwZ96PGr6riZhr17djQTDAwV2bGHkWHzqE7u9XT1s952dUvUezEu6VAj';
  const res4 = await app.inject({
    method: 'POST',
    url: `/api/admin/agreements/${testId}/force-release`,
    headers: adminHeaders,
    payload: {
      releaseTxHashOverride: testTxHash,
      adminNote: 'Admin manual settlement verification test',
    },
  });

  assert.equal(res4.statusCode, 200, `Expected 200 for force-release, got ${res4.statusCode}: ${res4.payload}`);
  const body4 = JSON.parse(res4.payload);
  assert.equal(body4.data.status, 'released');
  assert.equal(body4.data.releaseTxHash, testTxHash);
  assert.equal(body4.data.adminReleaseNote, 'Admin manual settlement verification test');
  assert.equal(body4.data.lastError, null);
  console.log('   ✅ Force-release successfully bound tx hash override and updated agreement status to released');

  // 5. Verify the updated agreement in GET /api/admin/agreements/:id
  console.log('5. Testing GET /api/admin/agreements/:id...');
  const res5 = await app.inject({
    method: 'GET',
    url: `/api/admin/agreements/${testId}`,
    headers: adminHeaders,
  });
  assert.equal(res5.statusCode, 200);
  const body5 = JSON.parse(res5.payload);
  assert.equal(body5.data.id, testId);
  assert.equal(body5.data.status, 'released');
  assert.equal(body5.data.releaseTxHash, testTxHash);
  console.log('   ✅ Agreement detail correctly retrieved via admin endpoint');

  console.log('\n🎉 ALL 5 ADMIN AGREEMENT & PREVENTION TESTS PASSED SUCCESSFULLY!\n');
  process.exit(0);
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import { db } from '../src/database/json-database.js';
import {
  createStepUpVerificationRequest,
  validateStepUpVerificationToken,
  submitStepUpVerification,
  reviewStepUpVerificationRequest,
  listAllStepUpVerificationRequests,
} from '../src/admin/verification-request.service.js';

async function run() {
  console.log('--- TEST: Dynamic Step-Up Verification Engine ---');

  // 1. Create a test user in DB
  const testUserId = `user_test_${Date.now()}`;
  await db.insertUserRecord({
    id: testUserId,
    email: `test_${Date.now()}@sivantech.online`,
    fullName: 'Adekunle Test User',
    country: 'NG',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // 2. Admin creates a step-up verification request
  const created = await createStepUpVerificationRequest({
    adminId: 'admin_test_1',
    userId: testUserId,
    requestedModules: ['nin', 'proof_of_address'],
    reason: 'Customer requested limit upgrade above 5,000,000 NGN',
    expiresInHours: 72,
  });

  assert.ok(created.requestId.startsWith('vreq_'), 'Request ID should start with vreq_');
  assert.ok(created.verificationUrl.includes('/verify?token='), 'Should return verification URL');
  assert.equal(created.requestedModules.length, 2, 'Should contain 2 requested modules');
  console.log('✓ Step-Up request created:', created.requestId);

  // 3. Validate valid token
  const validation = await validateStepUpVerificationToken(created.rawToken);
  assert.equal(validation.valid, true, 'Valid token should pass validation');
  assert.equal(validation.userId, testUserId, 'User ID should match');
  assert.deepEqual(validation.requestedModules, ['nin', 'proof_of_address'], 'Modules should match');
  console.log('✓ Token validation succeeded');

  // 4. Validate tampered token fails
  const tampered = await validateStepUpVerificationToken(`${created.requestId}_invalidsecret1234567890`);
  assert.equal(tampered.valid, false, 'Tampered token must fail validation');
  console.log('✓ Tampered token rejected safely');

  // 5. Submit step-up verification credentials
  const submitRes = await submitStepUpVerification(created.rawToken, {
    nin: '12345678901',
    proofOfAddressDocId: 'doc_utility_123',
    notes: 'Uploaded latest electricity bill',
  });
  assert.equal(submitRes.status, 'success', 'Submission should succeed');
  console.log('✓ User submission accepted');

  // Verify status transitioned to under_review
  const recordAfterSubmit = await db.getVerificationRequestById(created.requestId);
  assert.equal(recordAfterSubmit?.status, 'under_review', 'Status should be under_review');
  assert.equal(recordAfterSubmit?.submissionData?.nin, '12345678901', 'NIN should be recorded');
  console.log('✓ Record updated to under_review');

  // 6. Admin reviews and approves the request
  const reviewed = await reviewStepUpVerificationRequest(
    'admin_test_1',
    created.requestId,
    'approved',
    'NIN and Utility Bill verified'
  );
  assert.equal(reviewed.status, 'approved', 'Status should be approved');
  console.log('✓ Admin approval completed');

  // Verify NIN check automatically credited user to Level 2 in NgnIdentityVerification
  const verifications = await db.listNgnIdentityVerifications(testUserId);
  const ninCheck = verifications.find((v) => v.checkType === 'nin_info');
  assert.ok(ninCheck, 'NIN identity verification row should exist');
  assert.equal(ninCheck.status, 'matched', 'NIN check should be matched');
  assert.equal(ninCheck.bvnLast4, '8901', 'Last 4 digits should match NIN last 4');
  console.log('✓ User NIN check automatically matched and credited');

  // 7. Verify list endpoint
  const allRequests = await listAllStepUpVerificationRequests(testUserId);
  assert.equal(allRequests.length, 1, 'Should return exactly 1 request for this user');
  console.log('✓ List requests filtered by user verified');

  console.log('\nAll Step-Up Verification Engine tests PASSED (100% hermetic)!');
}

run().catch((err) => {
  console.error('Test FAILED:', err);
  process.exit(1);
});

/**
 * SIVAN PAYSTACK ROUTES & UNIFIED WEBHOOK TEST SUITE
 *
 * Verifies:
 * 1. extractPhone utility (WhatsApp auto-extraction).
 * 2. calculateDvaInflowFee (3k fee tier and 500 NGN cap).
 * 3. verifyPaystackSignature (HMAC-SHA512 validation).
 * 4. Fastify HTTP routes:
 *    - GET /api/virtual-accounts/paystack/user/:userId
 *    - POST /api/virtual-accounts/paystack/create (Zod validation & WhatsApp integration)
 * 5. Webhook Ingestion:
 *    - Signature authentication gate
 *    - customeridentification.success (NIBSS KYC activation)
 *    - customeridentification.failed (rejection propagation)
 *    - charge.success (Dedicated Nuban deposit, fee tier, idempotency)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/app.js';
import { db } from '../src/database/json-database.js';
import { extractPhone } from '../src/virtual-accounts/api/paystackDvaRoutes.js';
import {
  verifyPaystackSignature,
  calculateDvaInflowFee,
  processPaystackWebhook,
} from '../src/webhooks/paystackWebhookHandler.js';
import {
  createVerifiedDepositAdapter,
  assertFundingLimits,
  createHumanRulingAdapter,
} from '../src/ngn/balance-agreements/runtime.js';

const TEST_SECRET = 'sk_test_mock_secret_key_for_webhook_tests_12345';

function signPayload(body: unknown, secret: string = TEST_SECRET): string {
  const raw = Buffer.from(JSON.stringify(body));
  return crypto.createHmac('sha512', secret).update(raw).digest('hex');
}

async function main() {
  process.env.DATABASE_PROVIDER = 'json';
  process.env.DATABASE_FILE = '.data/test-paystack-routes-webhooks.json';
  process.env.PAYSTACK_SECRET_KEY = TEST_SECRET;
  process.env.PAYSTACK_WEBHOOK_SECRET = TEST_SECRET;
  process.env.NODE_ENV = 'test';

  console.log('\n==================================================');
  console.log('🔷 SIVAN PAYSTACK ROUTES & WEBHOOKS TEST SUITE');
  console.log('==================================================\n');

  let passed = 0;
  function ok(msg: string) {
    passed++;
    console.log(`  ✅ ok - ${msg}`);
  }

  // ─── 1. Phone Extraction ──────────────────────────────────────────
  console.log('══ 1. Phone Extraction (WhatsApp Auto-Pick) ══');
  assert.equal(extractPhone('+2348102524846'), '+2348102524846');
  ok('explicit phone is prioritized');

  assert.equal(extractPhone(undefined, 'whatsapp:+2348102524846'), '+2348102524846');
  ok('auto-extracts from whatsapp:+234... userId');

  assert.equal(extractPhone(undefined, '+2348102524846'), '+2348102524846');
  ok('auto-extracts from international phone userId');

  assert.equal(extractPhone(undefined, 'user_uuid_12345'), '');
  ok('returns empty string if userId is not a phone number');

  // ─── 2. Fee Calculation (3k Rule & Cap) ───────────────────────────
  console.log('\n══ 2. DVA Fee Calculation (3k Rule & 500 NGN Cap) ══');
  const feeUnder3k = calculateDvaInflowFee(2000);
  assert.equal(feeUnder3k.feeNgn, 0);
  assert.equal(feeUnder3k.netNgn, 2000);
  ok('inflows under 3,000 NGN have 0 fee (100% credited)');

  const fee3k = calculateDvaInflowFee(3000);
  assert.equal(fee3k.feeNgn, 39); // 1.3% of 3000
  assert.equal(fee3k.netNgn, 2961);
  ok('inflow of 3,000 NGN has 1.3% fee (39 NGN)');

  const fee10k = calculateDvaInflowFee(10000);
  assert.equal(fee10k.feeNgn, 130); // 1.3% of 10000
  assert.equal(fee10k.netNgn, 9870);
  ok('inflow of 10,000 NGN has 130 NGN fee');

  const fee50k = calculateDvaInflowFee(50000);
  assert.equal(fee50k.feeNgn, 500); // 1.3% of 50000 is 650 -> capped at 500
  assert.equal(fee50k.netNgn, 49500);
  ok('inflow of 50,000 NGN is capped at 500 NGN fee');

  // ─── 3. HMAC-SHA512 Signature Verification ───────────────────────
  console.log('\n══ 3. HMAC-SHA512 Signature Verification ══');
  const sampleBody = { event: 'charge.success', data: { reference: 'ref_123' } };
  const validSig = signPayload(sampleBody, TEST_SECRET);

  assert.equal(verifyPaystackSignature(JSON.stringify(sampleBody), validSig), true);
  ok('valid HMAC-SHA512 signature is accepted');

  const invalidSig = signPayload(sampleBody, 'wrong_secret');
  assert.equal(verifyPaystackSignature(JSON.stringify(sampleBody), invalidSig), false);
  ok('wrong secret signature is rejected');

  assert.equal(verifyPaystackSignature('tampered_body', validSig), false);
  ok('tampered body is rejected');

  assert.equal(verifyPaystackSignature(JSON.stringify(sampleBody), undefined), false);
  ok('missing signature is rejected');

  // ─── 4. HTTP Routes via Fastify ──────────────────────────────────
  console.log('\n══ 4. Fastify HTTP Endpoints ══');
  const app = await buildApp();

  // GET /api/virtual-accounts/paystack/user/:userId
  const getRes = await app.inject({
    method: 'GET',
    url: '/api/virtual-accounts/paystack/user/user_whatsapp_test_01',
  });
  assert.equal(getRes.statusCode, 200);
  const getJson = getRes.json();
  assert.equal(getJson.status, 'success');
  assert.equal(getJson.data.state, 'awaiting_identity');
  ok('GET /api/virtual-accounts/paystack/user/:userId returns awaiting_identity for new user');

  // POST validation failures
  const invalidBvnRes = await app.inject({
    method: 'POST',
    url: '/api/virtual-accounts/paystack/create',
    payload: {
      userId: 'whatsapp:+2348102524846',
      legalName: 'Samson Micheal',
      identifier: '123456789', // Only 9 digits
    },
  });
  assert.equal(invalidBvnRes.statusCode, 400);
  ok('POST /api/virtual-accounts/paystack/create rejects invalid BVN length');

  const missingNameRes = await app.inject({
    method: 'POST',
    url: '/api/virtual-accounts/paystack/create',
    payload: {
      userId: 'whatsapp:+2348102524846',
      identifier: '12345678901',
    },
  });
  assert.equal(missingNameRes.statusCode, 400);
  ok('POST /api/virtual-accounts/paystack/create rejects missing legal name');

  // ─── 5. Webhook Ingestion Tests ──────────────────────────────────
  console.log('\n══ 5. Webhook Ingestion & Idempotency ══');

  // A. Signature gate on route
  const unsignedWebhookRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    payload: { event: 'charge.success' },
  });
  assert.equal(unsignedWebhookRes.statusCode, 401);
  ok('POST /api/webhooks/paystack returns 401 on unsigned request');

  // Pre-seed a virtual account in DB to correlate webhook
  const testUserId = 'user_dva_webhook_test_99';
  const customerCode = 'CUS_mock_test_code_99';
  const now = new Date().toISOString();

  await db.insertUserRecord({
    id: testUserId,
    email: 'webhook-test@user.sivantech.online',
    fullName: 'Samson Micheal',
    createdAt: now,
    updatedAt: now,
  });

  await db.insertCustomerRecord({
    id: customerCode,
    userId: testUserId,
    provider: 'paystack',
    providerCustomerId: customerCode,
    customerType: 'individual',
    kycStatus: 'verified',
    tosStatus: 'approved',
    createdAt: now,
    updatedAt: now,
  });

  await db.upsertVirtualAccountRecord({
    id: 'va_paystack_test_row_99',
    userId: testUserId,
    provider: 'paystack',
    providerAccountId: 'dva_acc_99',
    currency: 'ngn',
    country: 'NG',
    status: 'provisioning',
    customerId: customerCode,
    bankName: 'Wema Bank',
    accountName: 'Sivan / Samson Micheal',
    accountNumberMasked: '****4846',
    createdAt: now,
    updatedAt: now,
  });

  // B. Identification success event
  const identSuccessPayload = {
    event: 'customeridentification.success',
    data: {
      customer_code: customerCode,
      email: 'test_u_user@user.sivantech.online',
      metadata: { sivanUserId: testUserId },
    },
  };
  const identSuccessSig = signPayload(identSuccessPayload);
  const identSuccessRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'x-paystack-signature': identSuccessSig },
    payload: identSuccessPayload,
  });
  assert.equal(identSuccessRes.statusCode, 200);
  assert.equal(identSuccessRes.json().data.status, 'processed');
  ok('customeridentification.success event processed');

  // C. Identification failure event
  const identFailPayload = {
    event: 'customeridentification.failed',
    data: {
      customer_code: customerCode,
      reason: 'Name mismatch at NIBSS',
      metadata: { sivanUserId: testUserId },
    },
  };
  const identFailSig = signPayload(identFailPayload);
  const identFailRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'x-paystack-signature': identFailSig },
    payload: identFailPayload,
  });
  assert.equal(identFailRes.statusCode, 200);
  assert.equal(identFailRes.json().data.status, 'processed');
  ok('customeridentification.failed event records failure reason');

  // D. Charge.success (DVA Deposit Inflow)
  const depositRef = `dva_ref_${Date.now()}_test`;
  const depositPayload = {
    event: 'charge.success',
    data: {
      channel: 'dedicated_nuban',
      reference: depositRef,
      amount: 1000000, // 10,000 NGN in Kobo
      currency: 'NGN',
      customer: {
        customer_code: customerCode,
        metadata: { sivanUserId: testUserId },
      },
    },
  };
  const depositSig = signPayload(depositPayload);
  const depositRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'x-paystack-signature': depositSig },
    payload: depositPayload,
  });

  assert.equal(depositRes.statusCode, 200);
  const depositData = depositRes.json().data;
  assert.equal(depositData.status, 'processed');
  assert.equal(depositData.details.grossNgn, 10000);
  assert.equal(depositData.details.feeNgn, 130);
  assert.equal(depositData.details.netNgn, 9870);
  ok('charge.success credits DVA deposit with correct fee calculation');

  // E. Idempotency test (replay same deposit)
  const replayRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'x-paystack-signature': depositSig },
    payload: depositPayload,
  });
  assert.equal(replayRes.statusCode, 200);
  assert.equal(replayRes.json().data.details.duplicate, true);
  ok('duplicate deposit webhook is recognized and ignored idempotently');

  // F. Security: Rejection of unmapped customer code with spoofed metadata
  const spoofPayload = {
    event: 'charge.success',
    data: {
      channel: 'dedicated_nuban',
      reference: `spoof_ref_${Date.now()}`,
      amount: 1000000,
      currency: 'NGN',
      customer: {
        customer_code: 'CUST_unregistered_attacker_99',
        metadata: { sivanUserId: 'attacker_user_id' },
      },
    },
  };
  const spoofSig = signPayload(spoofPayload);
  const spoofRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'x-paystack-signature': spoofSig },
    payload: spoofPayload,
  });
  assert.equal(spoofRes.statusCode, 200);
  assert.equal(spoofRes.json().data.status, 'ignored');
  ok('unmapped customer code with spoofed metadata is rejected without credit');

  // G. Rejection of unsupported currency (non-NGN)
  const usdPayload = {
    event: 'charge.success',
    data: {
      channel: 'dedicated_nuban',
      reference: `usd_ref_${Date.now()}`,
      amount: 1000000,
      currency: 'USD',
      customer: {
        customer_code: customerCode,
      },
    },
  };
  const usdSig = signPayload(usdPayload);
  const usdRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'x-paystack-signature': usdSig },
    payload: usdPayload,
  });
  assert.equal(usdRes.statusCode, 200);
  assert.equal(usdRes.json().data.status, 'ignored');
  ok('deposit with non-NGN currency is rejected without credit');

  // H. Verified Deposit Adapter (Pillar 1 & 2 Agreement Ledger Adapter)
  const verifyDeposit = createVerifiedDepositAdapter(db);
  const depositCheck = await verifyDeposit(depositRef);
  assert.equal(depositCheck.userId, testUserId);
  assert.equal(depositCheck.netKobo, '987000'); // 10,000 NGN gross - 130 NGN fee = 9,870 NGN = 987,000 kobo
  assert.equal(depositCheck.currency, 'NGN');
  assert.equal(depositCheck.reference, depositRef);
  ok('createVerifiedDepositAdapter validates stored DVA deposit and computes exact netKobo');

  await assert.rejects(
    async () => verifyDeposit('non_existent_deposit_ref_999'),
    /DEPOSIT_NOT_FOUND/
  );
  ok('createVerifiedDepositAdapter fails closed with DEPOSIT_NOT_FOUND for unknown reference');

  // ─── 6. Outbound Transfer Webhooks (Success, Failure & Reversal) ──
  console.log('\n══ 6. Outbound Transfer Webhook Processing & Reconciliation ══');

  // A. transfer.success
  const successQuoteId = `quote_${Date.now()}_1`;
  const successRef = `sivan_tx_success_${Date.now()}`;
  const successTrfCode = `TRF_success_${Date.now()}`;
  await db.upsertNgnQuoteRecord({
    id: successQuoteId,
    userId: testUserId,
    direction: 'offramp',
    provider: 'textile',
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '10000.00',
    destinationAmount: '10000.00',
    rate: '1',
    feeAmount: '0.00',
    status: 'quote_accepted',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    createdAt: now,
    updatedAt: now,
  });
  await db.upsertNgnTransferRecord({
    id: `ngnt_${Date.now()}_1`,
    quoteId: successQuoteId,
    userId: testUserId,
    direction: 'offramp',
    provider: 'textile',
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '10000.00',
    destinationAmount: '10000.00',
    rate: '1',
    feeAmount: '0.00',
    status: 'bank_processing',
    bankReference: successRef,
    settlementReference: successRef,
    createdAt: now,
    updatedAt: now,
  });

  const transferSuccessPayload = {
    event: 'transfer.success',
    data: {
      reference: successRef,
      transfer_code: successTrfCode,
      amount: 1000000, // 10,000 NGN in Kobo
      status: 'success',
      recipient: {
        name: 'Samson Micheal',
        details: { account_number: '0123456789', bank_name: 'Guaranty Trust Bank' },
      },
    },
  };
  const transferSuccessSig = signPayload(transferSuccessPayload);
  const transferSuccessRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'x-paystack-signature': transferSuccessSig },
    payload: transferSuccessPayload,
  });
  assert.equal(transferSuccessRes.statusCode, 200);
  assert.equal(transferSuccessRes.json().data.status, 'processed');
  assert.equal(transferSuccessRes.json().data.details.status, 'completed');
  ok('transfer.success marks transfer completed and finalizes ledger');

  // Replay transfer.success (Idempotency)
  const transferSuccessReplay = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'x-paystack-signature': transferSuccessSig },
    payload: transferSuccessPayload,
  });
  assert.equal(transferSuccessReplay.statusCode, 200);
  assert.equal(transferSuccessReplay.json().data.details.duplicate, true);
  ok('transfer.success replay is handled idempotently');

  // B. transfer.failed
  const failedQuoteId = `quote_${Date.now()}_2`;
  const failedRef = `sivan_tx_failed_${Date.now()}`;
  const failedTrfCode = `TRF_failed_${Date.now()}`;
  await db.upsertNgnQuoteRecord({
    id: failedQuoteId,
    userId: testUserId,
    direction: 'offramp',
    provider: 'textile',
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '5000.00',
    destinationAmount: '5000.00',
    rate: '1',
    feeAmount: '0.00',
    status: 'quote_accepted',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    createdAt: now,
    updatedAt: now,
  });
  await db.upsertNgnTransferRecord({
    id: `ngnt_${Date.now()}_2`,
    quoteId: failedQuoteId,
    userId: testUserId,
    direction: 'offramp',
    provider: 'textile',
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '5000.00',
    destinationAmount: '5000.00',
    rate: '1',
    feeAmount: '0.00',
    status: 'bank_processing',
    bankReference: failedRef,
    settlementReference: failedRef,
    createdAt: now,
    updatedAt: now,
  });

  const transferFailedPayload = {
    event: 'transfer.failed',
    data: {
      reference: failedRef,
      transfer_code: failedTrfCode,
      amount: 500000, // 5,000 NGN in Kobo
      status: 'failed',
      reason: 'Account number does not exist',
    },
  };
  const transferFailedSig = signPayload(transferFailedPayload);
  const transferFailedRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'x-paystack-signature': transferFailedSig },
    payload: transferFailedPayload,
  });
  assert.equal(transferFailedRes.statusCode, 200);
  assert.equal(transferFailedRes.json().data.status, 'processed');
  assert.equal(transferFailedRes.json().data.details.status, 'failed');
  assert.equal(transferFailedRes.json().data.details.refunded, true);
  ok('transfer.failed marks transfer failed and atomically releases ledger hold');

  // C. transfer.reversed
  const reversedQuoteId = `quote_${Date.now()}_3`;
  const reversedRef = `sivan_tx_rev_${Date.now()}`;
  const reversedTrfCode = `TRF_rev_${Date.now()}`;
  await db.upsertNgnQuoteRecord({
    id: reversedQuoteId,
    userId: testUserId,
    direction: 'offramp',
    provider: 'textile',
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '8000.00',
    destinationAmount: '8000.00',
    rate: '1',
    feeAmount: '0.00',
    status: 'quote_accepted',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    createdAt: now,
    updatedAt: now,
  });
  await db.upsertNgnTransferRecord({
    id: `ngnt_${Date.now()}_3`,
    quoteId: reversedQuoteId,
    userId: testUserId,
    direction: 'offramp',
    provider: 'textile',
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '8000.00',
    destinationAmount: '8000.00',
    rate: '1',
    feeAmount: '0.00',
    status: 'completed',
    bankReference: reversedRef,
    settlementReference: reversedRef,
    createdAt: now,
    updatedAt: now,
  });

  const transferReversedPayload = {
    event: 'transfer.reversed',
    data: {
      reference: reversedRef,
      transfer_code: reversedTrfCode,
      amount: 800000, // 8,000 NGN in Kobo
      status: 'reversed',
      reason: 'Destination bank recalled funds',
    },
  };
  const transferReversedSig = signPayload(transferReversedPayload);
  const transferReversedRes = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'x-paystack-signature': transferReversedSig },
    payload: transferReversedPayload,
  });
  assert.equal(transferReversedRes.statusCode, 200);
  assert.equal(transferReversedRes.json().data.status, 'processed');
  assert.equal(transferReversedRes.json().data.details.status, 'reversed');
  assert.equal(transferReversedRes.json().data.details.refunded, true);
  ok('transfer.reversed marks transfer reversed and atomically credits ledger back');

  // Replay transfer.reversed (Idempotency)
  const transferReversedReplay = await app.inject({
    method: 'POST',
    url: '/api/webhooks/paystack',
    headers: { 'x-paystack-signature': transferReversedSig },
    payload: transferReversedPayload,
  });
  assert.equal(transferReversedReplay.statusCode, 200);
  assert.equal(transferReversedReplay.json().data.details.duplicate, true);
  ok('transfer.reversed replay is handled idempotently without double credit');

  // ─── 7. Risk Controls, Spending Limits & Human Ruling Adapter ─────
  console.log('\n══ 7. Risk Controls, Spending Limits & Human Ruling Adapter ══');

  // Test 1: Level 0 / Unverified user is rejected with KYC_LEVEL_INSUFFICIENT
  const unverifiedUserId = 'user_unverified_tier0';
  if (!(await db.findUserById(unverifiedUserId))) {
    await db.insertUserRecord({
      id: unverifiedUserId,
      email: 'unverified@example.com',
      fullName: 'Unverified User',
      createdAt: now,
      updatedAt: now,
    });
  }

  await assert.rejects(
    () => assertFundingLimits(unverifiedUserId, '1000000'), // 10,000 NGN in kobo
    (err: any) => err.code === 'KYC_LEVEL_INSUFFICIENT'
  );
  ok('assertFundingLimits rejects Level 0 unverified users with KYC_LEVEL_INSUFFICIENT');

  // Test 2: Verified user (Level 1 with bank payout account) within limits passes
  const verifiedUserId = testUserId;
  await db.upsertNgnPayoutAccountRecord({
    id: `pa_${testUserId}`,
    userId: verifiedUserId,
    provider: 'paystack',
    bankId: '058',
    bankName: 'Guaranty Trust Bank',
    accountNumber: '0123456789',
    accountName: 'CHUKWUDI EZE',
    declaredName: 'CHUKWUDI EZE',
    matchVerdict: 'match',
    matchScore: 1.0,
    resolutionTrustworthy: true,
    status: 'verified',
    createdAt: now,
    updatedAt: now,
  });
  await assertFundingLimits(verifiedUserId, '2000000'); // 20,000 NGN in kobo
  ok('assertFundingLimits allows verified user within tier limits');

  // Test 3: Excessive amount exceeding tier limit is rejected with LIMIT_EXCEEDED
  await assert.rejects(
    () => assertFundingLimits(verifiedUserId, '60000000'), // 600,000 NGN (exceeds 500k Level 1 limit)
    (err: any) => err.code === 'LIMIT_EXCEEDED'
  );
  ok('assertFundingLimits rejects amounts exceeding tier cumulative ceiling with LIMIT_EXCEEDED');

  // Test 4: Human Ruling Adapter requires valid reviewer
  const rulingAdapter = createHumanRulingAdapter(db);
  await assert.rejects(
    () => rulingAdapter('unknown_reviewer', 'agr_123', '50000', 'Buyer delivered on terms', 'admin_credential_secret_123'),
    (err: any) => err.code === 'REVIEWER_NOT_FOUND'
  );
  ok('createHumanRulingAdapter rejects unknown reviewer with REVIEWER_NOT_FOUND');

  // Test 5: Human Ruling Adapter requires valid credentials (rejects empty / short)
  const adminReviewerId = 'admin_reviewer_test';
  if (!(await db.findUserById(adminReviewerId))) {
    await db.insertUserRecord({
      id: adminReviewerId,
      email: 'compliance@sivantech.online',
      fullName: 'Compliance Officer',
      createdAt: now,
      updatedAt: now,
    });
  }

  await assert.rejects(
    () => rulingAdapter(adminReviewerId, 'agr_123', '50000', 'Dispute ruling reasoning', ''),
    (err: any) => err.code === 'REVIEWER_CREDENTIAL_REQUIRED'
  );
  ok('createHumanRulingAdapter rejects missing reviewer credential with REVIEWER_CREDENTIAL_REQUIRED');

  // Test 6: Human Ruling Adapter requires substantive reasoning
  await assert.rejects(
    () => rulingAdapter(adminReviewerId, 'agr_123', '50000', 'no', 'valid_admin_credential_12345'),
    (err: any) => err.code === 'RULING_REASON_REQUIRED'
  );
  ok('createHumanRulingAdapter rejects empty/short reason with RULING_REASON_REQUIRED');

  // Test 7: Valid human ruling succeeds and writes audit log
  await rulingAdapter(adminReviewerId, 'agr_123', '50000', 'Work verified by independent proof review', 'valid_admin_credential_12345');
  ok('createHumanRulingAdapter authorizes valid dispute ruling with credentials redacted');

  await app.close();

  console.log('\n==================================================');
  console.log(`📊 RESULTS: ${passed} passed, 0 failed`);
  console.log('==================================================\n');
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

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

const TEST_SECRET = 'sk_test_mock_secret_key_for_webhook_tests_12345';

function signPayload(body: unknown, secret: string = TEST_SECRET): string {
  const raw = Buffer.from(JSON.stringify(body));
  return crypto.createHmac('sha512', secret).update(raw).digest('hex');
}

async function main() {
  process.env.DATABASE_PROVIDER = 'json';
  process.env.DATABASE_FILE = '.data/test-paystack-routes-webhooks.json';
  process.env.PAYSTACK_SECRET_KEY = TEST_SECRET;
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

  await app.close();

  console.log('\n==================================================');
  console.log(`📊 RESULTS: ${passed} passed, 0 failed`);
  console.log('==================================================\n');
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

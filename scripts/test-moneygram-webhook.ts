import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import {
  verifyMoneyGramSignature,
  processMoneyGramWebhook,
  type MoneyGramWebhookPayload,
} from '../src/webhooks/moneygramWebhookHandler.js';
import { webhooksRoutes } from '../src/webhooks/webhooks.routes.js';
import { moneygramRoutes } from '../src/moneygram/routes/moneygram.routes.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  FAIL ${name}: ${err.message}`);
    failed++;
  }
}

async function asyncTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  FAIL ${name}: ${err.message}`);
    failed++;
  }
}

console.log('\nMONEYGRAM WEBHOOK RSA-SHA256 SIGNATURE VERIFICATION');

// Generate test RSA-2048 keypair for cryptographic testing
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

process.env.MONEYGRAM_WEBHOOK_PUBLIC_KEY = publicKey;
process.env.MONEYGRAM_WEBHOOK_HOST = 'api.sivantech.online';

test('valid RSA-SHA256 signature passes verification', () => {
  const now = Math.floor(Date.now() / 1000);
  const host = 'api.sivantech.online';
  const rawBody = JSON.stringify({
    event_type: 'TRANSACTION_STATUS_EVENT',
    transaction: {
      id: 'mg_tx_12345',
      status: 'pending_user_transfer_complete',
      external_transaction_id: '48291049',
    },
  });

  const digest = `${now}.${host}.${rawBody}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(digest, 'utf8'), privateKey).toString('base64');

  const res = verifyMoneyGramSignature({
    rawBody: Buffer.from(rawBody),
    signatureHeader: signature,
    timestampHeader: String(now),
    host,
  });

  assert.equal(res.valid, true);
});

test('tampered body is strictly rejected', () => {
  const now = Math.floor(Date.now() / 1000);
  const host = 'api.sivantech.online';
  const originalBody = '{"amount": "25.00"}';
  const tamperedBody = '{"amount": "50.00"}';

  const digest = `${now}.${host}.${originalBody}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(digest, 'utf8'), privateKey).toString('base64');

  const res = verifyMoneyGramSignature({
    rawBody: Buffer.from(tamperedBody),
    signatureHeader: signature,
    timestampHeader: String(now),
    host,
  });

  assert.equal(res.valid, false);
  assert.equal(res.reason, 'signature mismatch');
});

test('timestamp outside replay window (skew > 300s) is strictly rejected', () => {
  const staleTimestamp = Math.floor(Date.now() / 1000) - 360; // 6 minutes ago
  const host = 'api.sivantech.online';
  const rawBody = '{"test": true}';

  const digest = `${staleTimestamp}.${host}.${rawBody}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(digest, 'utf8'), privateKey).toString('base64');

  const res = verifyMoneyGramSignature({
    rawBody: Buffer.from(rawBody),
    signatureHeader: signature,
    timestampHeader: String(staleTimestamp),
    host,
  });

  assert.equal(res.valid, false);
  assert.match(res.reason || '', /exceeds 300s window/);
});

console.log('\nWEBHOOK EVENT PROCESSING & PICKUP PIN EXTRACTION');

await asyncTest('processes pending_user_transfer_complete and extracts 8-digit pickup PIN', async () => {
  const now = Math.floor(Date.now() / 1000);
  const host = 'api.sivantech.online';
  const payload: MoneyGramWebhookPayload = {
    event_type: 'TRANSACTION_STATUS_EVENT',
    transaction: {
      id: 'mg_tx_998877',
      status: 'pending_user_transfer_complete',
      external_transaction_id: '78291044',
      amount_in: '25.00',
      amount_out: '40500',
      more_info_url: 'https://extmgxanchor.moneygram.com/sep24/more_info?id=mg_tx_998877',
    },
  };
  const rawBody = JSON.stringify(payload);
  const digest = `${now}.${host}.${rawBody}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(digest, 'utf8'), privateKey).toString('base64');

  const result = await processMoneyGramWebhook(payload, Buffer.from(rawBody), {
    'x-mg-signature': signature,
    'x-mg-timestamp': String(now),
    'x-forwarded-host': host,
  });

  assert.equal(result.status, 'processed');
  assert.equal(result.transactionId, 'mg_tx_998877');
  assert.equal(result.referencePin, '78291044');
});

console.log('\nFASTIFY HTTP API & WEBHOOK ROUTE INVOCATION');

const app = Fastify();
await webhooksRoutes(app);
await moneygramRoutes(app);

await asyncTest('POST /api/webhooks/moneygram returns HTTP 200 with EMPTY text body', async () => {
  const now = Math.floor(Date.now() / 1000);
  const host = 'api.sivantech.online';
  const payload = {
    event_type: 'TRANSACTION_STATUS_EVENT',
    transaction: {
      id: 'mg_live_test_01',
      status: 'ready_for_pickup',
      external_transaction_id: '48291049',
    },
  };
  const rawBody = JSON.stringify(payload);
  const digest = `${now}.${host}.${rawBody}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(digest, 'utf8'), privateKey).toString('base64');

  const response = await app.inject({
    method: 'POST',
    url: '/api/webhooks/moneygram',
    headers: {
      'content-type': 'application/json',
      'x-mg-signature': signature,
      'x-mg-timestamp': String(now),
      'x-forwarded-host': host,
    },
    payload: rawBody,
  });

  assert.equal(response.statusCode, 200);
  // MoneyGram specification strictly requires an empty body
  assert.equal(response.body, '');
});

await asyncTest('GET /api/webhooks/moneygram returns health probe', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/webhooks/moneygram',
  });
  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);
  assert.equal(data.status, 'ok');
  assert.equal(data.service, 'moneygram-webhook-receiver');
});

await asyncTest('GET /api/moneygram/health returns protocol info', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/moneygram/health',
  });
  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);
  assert.equal(data.status, 'healthy');
  assert.equal(data.network, 'Stellar USDC');
});

await asyncTest('GET /api/moneygram/corridors returns supported corridors', async () => {
  const response = await app.inject({
    method: 'GET',
    url: '/api/moneygram/corridors',
  });
  assert.equal(response.statusCode, 200);
  const json = JSON.parse(response.body);
  assert.ok(json.data.corridors.length >= 8);
  const currencies = json.data.corridors.map((c: any) => c.currency);
  assert.ok(currencies.includes('NGN'));
  assert.ok(currencies.includes('KES'));
  assert.ok(currencies.includes('GHS'));
});

await asyncTest('POST /api/moneygram/quote calculates exact conversion with 0% platform fee', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/moneygram/quote',
    payload: {
      amount: '25.00', // Realistic test amount (15 to 50 USDC)
      targetCurrency: 'NGN',
      mode: 'withdraw',
    },
  });
  assert.equal(response.statusCode, 200);
  const json = JSON.parse(response.body);
  assert.equal(json.data.amountIn, '25.00');
  assert.equal(json.data.targetCurrency, 'NGN');
  assert.equal(json.data.platformFeeUsd, '0.00');
});

await asyncTest('POST /api/moneygram/session generates valid SEP-24 interactive URL', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/moneygram/session',
    payload: {
      amount: '25.00',
      targetCurrency: 'NGN',
      mode: 'withdraw',
      recipientName: 'Samson Micheal',
    },
  });
  assert.equal(response.statusCode, 200);
  const json = JSON.parse(response.body);
  assert.ok(json.data.interactiveUrl.includes('moneygram.com'));
  assert.ok(json.data.interactiveUrl.includes('transaction_id='));
  assert.ok(json.data.moreInfoUrl.includes('transaction/more_info'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

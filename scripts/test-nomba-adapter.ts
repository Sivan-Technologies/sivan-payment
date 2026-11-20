import assert from 'node:assert';
import crypto from 'node:crypto';
import { getBankingRailAdapter, listRegisteredRails } from '../src/banking-rail/banking-rail-registry.js';
import { NombaBankingRailAdapter } from '../src/banking-rail/adapters/nomba.adapter.js';

async function run() {
  console.log('--- Step 1: Verify Adapter Registration ---');
  const rails = listRegisteredRails();
  console.log('Registered rails:', rails);
  assert(rails.includes('nomba'), 'Nomba must be registered in banking rail registry');

  const adapter = getBankingRailAdapter('nomba');
  assert.strictEqual(adapter.name, 'nomba', 'Adapter name must be nomba');
  assert(adapter instanceof NombaBankingRailAdapter, 'Adapter must be instance of NombaBankingRailAdapter');

  console.log('--- Step 2: Test HMAC Signature Verification ---');
  const testSecret = 'nomba_test_webhook_secret_key_12345';
  process.env.NOMBA_WEBHOOK_SECRET = testSecret;

  const testPayload = JSON.stringify({
    event_type: 'order_payment_successful',
    data: {
      accountRef: 'sivan_testuser123_456',
      transaction: {
        id: 'tx_nomba_mock_001',
        amount: 25000,
        merchantTxRef: 'ref_nomba_001',
      },
    },
  });

  const rawBuffer = Buffer.from(testPayload, 'utf8');
  const validSignature = crypto.createHmac('sha512', testSecret).update(rawBuffer).digest('hex');

  const verified = adapter.verifyWebhookSignature(rawBuffer, {
    'x-nomba-signature': validSignature,
  });
  assert.strictEqual(verified, true, 'Valid signature must verify as true');

  const tamperedPayload = Buffer.from(testPayload.replace('25000', '99999'), 'utf8');
  const invalidVerified = adapter.verifyWebhookSignature(tamperedPayload, {
    'x-nomba-signature': validSignature,
  });
  assert.strictEqual(invalidVerified, false, 'Tampered payload must verify as false');

  const wrongSecretVerified = adapter.verifyWebhookSignature(rawBuffer, {
    'x-nomba-signature': '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  });
  assert.strictEqual(wrongSecretVerified, false, 'Invalid signature must verify as false');

  console.log('--- Step 3: Test Webhook Event Normalization ---');
  // Deposit event
  const depositEvent = adapter.parseWebhookEvent(rawBuffer);
  assert.strictEqual(depositEvent.type, 'deposit.received', 'Event type must be deposit.received');
  if (depositEvent.type === 'deposit.received') {
    assert.strictEqual(depositEvent.userId, 'testuser123', 'Extracted userId must be testuser123');
    assert.strictEqual(depositEvent.amountKobo, 2500000, '25,000 NGN must be 2,500,000 kobo');
    assert.strictEqual(depositEvent.reference, 'ref_nomba_001', 'Reference must match');
  }

  // Transfer success event
  const transferSuccessPayload = Buffer.from(
    JSON.stringify({
      event_type: 'transfer_successful',
      data: {
        transaction: {
          merchantTxRef: 'payout_siv_001',
          status: 'SUCCESS',
          amount: 5000,
        },
      },
    }),
    'utf8'
  );

  const transferSuccessEvent = adapter.parseWebhookEvent(transferSuccessPayload);
  assert.strictEqual(transferSuccessEvent.type, 'transfer.success', 'Transfer event must be transfer.success');
  if (transferSuccessEvent.type === 'transfer.success') {
    assert.strictEqual(transferSuccessEvent.providerRef, 'payout_siv_001');
    assert.strictEqual(transferSuccessEvent.amountKobo, 500000);
  }

  // Transfer failed event
  const transferFailedPayload = Buffer.from(
    JSON.stringify({
      event_type: 'transfer_failed',
      data: {
        transaction: {
          merchantTxRef: 'payout_siv_002',
          status: 'FAILED',
          failureReason: 'Invalid account number',
        },
      },
    }),
    'utf8'
  );

  const transferFailedEvent = adapter.parseWebhookEvent(transferFailedPayload);
  assert.strictEqual(transferFailedEvent.type, 'transfer.failed', 'Transfer event must be transfer.failed');

  console.log('--- Step 4: Test Customer Record Generation ---');
  const customer = await adapter.createCustomer({
    userId: 'usr_84920',
    legalName: 'Samson Micheal',
    email: 'samson@example.com',
  });
  assert.strictEqual(customer.providerCustomerId, 'NOMBA_CUS_usr_84920');
  assert.strictEqual(customer.legalName, 'Samson Micheal');

  console.log('\nAll NombaBankingRailAdapter verification assertions PASSED successfully!');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

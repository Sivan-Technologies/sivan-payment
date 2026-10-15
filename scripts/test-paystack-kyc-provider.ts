import crypto from 'node:crypto';
import { PaystackKycLevelProvider } from '../src/kyc/providers/paystack-kyc-level.provider.js';
import { buildKycProviderChain, FailoverKycLevelProvider } from '../src/kyc/providers/failover-kyc-level.provider.js';
import { getKycLevelProvider } from '../src/kyc/providers/kyc-level-provider-registry.js';
import { db } from '../src/database/json-database.js';
import { processPaystackWebhook } from '../src/webhooks/paystackWebhookHandler.js';
import { paystackWebhookSecret } from '../src/config/paystackConfig.js';
import type { KycLevelProvider, BvnInfoMatchInput, NinInfoMatchInput, KycLevelMatchResult } from '../src/kyc/providers/kyc-level-provider.js';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
  console.log('PASS:', msg);
}

async function run() {
  console.log('\n--- 1. Testing PaystackKycLevelProvider capabilities ---');
  const provider = new PaystackKycLevelProvider();
  assert(provider.name === 'paystack', 'Provider name is paystack');
  const caps = provider.capabilities();
  assert(caps.bvnIdentity === true, 'Paystack supports bvnIdentity');
  assert(caps.bvnBankAccount === false, 'Paystack does not support bvnBankAccount');
  assert(caps.ninIdentity === false, 'Paystack does not support ninIdentity (routes to IdentifyOrg)');

  console.log('\n--- 2. Testing Provider Registry resolution ---');
  const explicit = getKycLevelProvider('paystack');
  assert(explicit instanceof PaystackKycLevelProvider, 'getKycLevelProvider(paystack) returns PaystackKycLevelProvider');

  console.log('\n--- 3. Testing Provider Chain Ordering ---');
  // Temporarily set PAYSTACK_SECRET_KEY so it registers as configured in test
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_fake_paystack_secret_key_for_test';
  process.env.IDENTIFYORG_API_KEY = 'test_identifyorg_key';

  const chain = buildKycProviderChain();
  assert(chain.length >= 2, 'Chain contains multiple providers');
  assert(chain[0].name === 'paystack', 'Paystack is the PRIMARY provider in the chain');
  assert(chain[1].name === 'identifyorg', 'IdentifyOrg is the SECONDARY failover in the chain');

  console.log('\n--- 4. Testing Failover from Paystack to IdentifyOrg on Error ---');
  // Mock failing Paystack provider and succeeding IdentifyOrg provider
  class MockFailingPaystack implements KycLevelProvider {
    name = 'paystack';
    capabilities() {
      return { bvnIdentity: true, bvnBankAccount: false, ninIdentity: false };
    }
    async verifyBvnIdentity(_input: BvnInfoMatchInput): Promise<KycLevelMatchResult> {
      const err: any = new Error('Paystack connection timeout (upstream NIBSS down)');
      err.statusCode = 503;
      throw err;
    }
    async verifyBvnBankAccount(_input: any): Promise<KycLevelMatchResult> {
      throw new Error('unsupported');
    }
    async health(): Promise<any> {
      return { provider: 'paystack', available: false, mode: 'test', checkedAt: new Date().toISOString() };
    }
  }

  class MockSuccessIdentifyOrg implements KycLevelProvider {
    name = 'identifyorg';
    capabilities() {
      return { bvnIdentity: true, bvnBankAccount: false, ninIdentity: true };
    }
    async verifyBvnIdentity(input: BvnInfoMatchInput): Promise<KycLevelMatchResult> {
      return {
        provider: 'identifyorg',
        status: 'matched',
        message: 'IdentifyOrg verified BVN synchronously',
        bvnLast4: input.bvn.slice(-4),
      };
    }
    async verifyNinIdentity(input: NinInfoMatchInput): Promise<KycLevelMatchResult> {
      return {
        provider: 'identifyorg',
        status: 'matched',
        message: 'IdentifyOrg verified NIN synchronously',
        bvnLast4: input.nin.slice(-4),
      };
    }
    async verifyBvnBankAccount(_input: any): Promise<KycLevelMatchResult> {
      throw new Error('unsupported');
    }
    async health(): Promise<any> {
      return { provider: 'identifyorg', available: true, mode: 'live', checkedAt: new Date().toISOString() };
    }
  }

  const testFailover = new FailoverKycLevelProvider([
    { name: 'paystack', provider: new MockFailingPaystack() },
    { name: 'identifyorg', provider: new MockSuccessIdentifyOrg() },
  ]);

  const bvnResult = await testFailover.verifyBvnIdentity({
    bvn: '22222222222',
    firstName: 'SAMSON',
    lastName: 'MICHEAL',
    dateOfBirth: '01-01-1995',
    mobileNo: '08012345678',
  });

  assert(bvnResult.status === 'matched', 'Failover succeeded in matching BVN');
  assert(bvnResult.provider === 'identifyorg', 'IdentifyOrg successfully answered after Paystack timeout');
  assert(bvnResult.bvnLast4 === '2222', 'BVN last 4 preserved correctly');

  console.log('\n--- 5. Testing NIN Routing Skips Paystack Directly to IdentifyOrg ---');
  const ninResult = await testFailover.verifyNinIdentity({
    nin: '11111111111',
    firstName: 'SAMSON',
    lastName: 'MICHEAL',
  });

  assert(ninResult.status === 'matched', 'NIN successfully verified');
  assert(ninResult.provider === 'identifyorg', 'NIN routed directly to IdentifyOrg without invoking Paystack');

  console.log('\n--- 6. Testing Webhook Upgrades NgnIdentityVerification Atomically ---');
  const testUserId = `usr_test_paystack_kyc_${Date.now()}`;
  const testCustomerCode = `CUS_test_kyc_${Date.now()}`;

  // Seed pending KYC row
  await db.upsertNgnIdentityVerification({
    id: `ngnkyc_${testUserId}_bvn`,
    userId: testUserId,
    checkType: 'bvn_info',
    status: 'review',
    provider: 'paystack',
    providerReference: testCustomerCode,
    bvnLast4: '2222',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Call webhook handler with signed payload
  const webhookPayload = {
    event: 'customeridentification.success',
    data: {
      customer_code: testCustomerCode,
      metadata: { sivanUserId: testUserId },
      identification: { bvn: '22222222222' },
    },
  };
  const rawBody = Buffer.from(JSON.stringify(webhookPayload), 'utf8');
  const signature = crypto.createHmac('sha512', paystackWebhookSecret()).update(rawBody).digest('hex');

  const webhookRes = await processPaystackWebhook(webhookPayload, rawBody, signature);

  assert(webhookRes.status === 'processed', 'Webhook processed customeridentification.success');
  const updatedVerifications = await db.listNgnIdentityVerifications(testUserId);
  const updatedBvn = updatedVerifications.find((v) => v.checkType === 'bvn_info');
  assert(updatedBvn?.status === 'matched', 'NgnIdentityVerification status updated to matched');
  assert(Boolean(updatedBvn?.verifiedAt), 'verifiedAt timestamp is set on identity record');

  console.log('\nAll Paystack Primary KYC & Failover tests PASSED successfully!\n');
}

run().catch((err) => {
  console.error('Unexpected test error:', err);
  process.exit(1);
});

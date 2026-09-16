import { defaultMetaMapProvider, MetaMapKycProvider } from '../src/kyc/providers/metamap-kyc.provider.js';

async function run() {
  console.log('Testing MetaMap (Incode) Global eKYC Integration...');

  const provider = new MetaMapKycProvider();

  // 1. Test OAuth token generation
  const token = await provider.getAccessToken();
  if (!token) throw new Error('Failed to get MetaMap access token');
  console.log('✓ MetaMap OAuth Access Token retrieved successfully');

  // 2. Test Verification Session Creation
  const session = await provider.createVerificationSession({
    userId: 'usr_test_global_123',
    phone: '+14155552671',
    email: 'client@global.test',
  });

  if (!session.verificationUrl || !session.verificationUrl.includes('metamap.com')) {
    throw new Error(`Invalid verification URL: ${session.verificationUrl}`);
  }
  console.log('✓ MetaMap Verification Session created successfully:', session.verificationUrl);

  // 3. Test Webhook parsing
  const mockWebhookEvent = {
    eventName: 'verification_completed' as const,
    identity: {
      status: 'verified',
    },
    metadata: {
      userId: 'usr_test_global_123',
    },
  };

  const parsed = provider.parseWebhookResult(mockWebhookEvent);
  if (!parsed.isApproved || parsed.userId !== 'usr_test_global_123') {
    throw new Error('Failed to parse approved MetaMap webhook event');
  }
  console.log('✓ MetaMap Webhook Event parsed and verified successfully');

  console.log('\nAll MetaMap eKYC Provider tests PASSED! 🌍✅');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

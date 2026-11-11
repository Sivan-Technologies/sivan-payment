import assert from 'node:assert/strict';
import { b2bMerchantService } from '../src/business/service/b2b-merchant.service.js';

async function runEndToEndTests() {
  console.log('====================================================');
  console.log('--- Self-Serve Developer API & Live Approval Gate E2E Test ---');
  console.log('====================================================');

  const testEmail = `dev_${Date.now()}@testdeveloper.com`;
  const testSlug = `dev-test-${Date.now()}`;

  // 1. Developer Signup Flow
  console.log('Step 1: Third-party developer registers via Developer Portal...');
  const registration = await b2bMerchantService.createMerchant({
    name: 'Acme Global Fintech Ltd',
    email: testEmail,
    slug: testSlug,
    phone: '+2348123456789',
    webhookUrl: 'https://webhook.acmefintech.com/live',
    sandboxWebhookUrl: 'https://webhook.acmefintech.com/sandbox',
    password: 'SecurePassword123!',
  });

  assert.ok(registration.merchant, 'Merchant profile created');
  assert.equal(registration.merchant.isSandboxEnabled, true, 'Sandbox mode enabled by default');
  assert.equal(registration.merchant.isLiveEnabled, false, 'Live mode blocked by default');
  assert.ok(registration.sandboxSecretKey.startsWith('sk_test_'), 'Valid test secret key issued');
  assert.ok(registration.secretKey.startsWith('sk_live_'), 'Live secret key pre-generated');
  console.log('✓ Developer registered. Sandbox enabled immediately; Live credentials locked.');

  const merchantId = registration.merchant.id;
  const testSecretKey = registration.sandboxSecretKey;
  const liveSecretKey = registration.secretKey;

  // 2. Immediate Sandbox Key Usability
  console.log('Step 2: Authenticating with Sandbox Key...');
  const sandboxAuth = await b2bMerchantService.authenticateApiKey(testSecretKey);
  assert.ok(sandboxAuth, 'Sandbox key authenticated');
  assert.equal(sandboxAuth.apiKey.mode, 'test', 'Auth mode is test');
  assert.equal(sandboxAuth.merchant.id, merchantId, 'Matched registered merchant');
  console.log('✓ Sandbox key sk_test_... works immediately for development and webhook testing.');

  // 3. Live Key Gate Enforcement (Must be blocked with 403 error)
  console.log('Step 3: Attempting to use Live Key before admin approval...');
  let liveBlocked = false;
  try {
    await b2bMerchantService.authenticateApiKey(liveSecretKey);
  } catch (err: any) {
    liveBlocked = true;
    assert.match(
      err.message,
      /Live API access/i,
      'Threw expected Live API access not enabled error'
    );
  }
  assert.equal(liveBlocked, true, 'Live key strictly rejected before admin review');
  console.log('✓ Live key sk_live_... is strictly blocked before admin approval (403 Forbidden).');

  // 4. Developer Submits Live Activation Request
  console.log('Step 4: Developer submits in-portal Live Production Access application...');
  const liveApplication = await b2bMerchantService.submitLiveAccessRequest(merchantId, {
    websiteUrl: 'https://acmefintech.com',
    useCase: 'Autonomous Payment Clearing & Service Agreement Settlement',
    estimatedMonthlyVolume: '₦10,000,000 - ₦25,000,000 NGN',
    businessDescription: 'Cross-border B2B supply chain payments',
    targetLaunchDate: '2026-12-01',
  });

  assert.equal(liveApplication.status, 'PENDING_REVIEW', 'Application recorded in PENDING_REVIEW status');
  assert.equal(liveApplication.websiteUrl, 'https://acmefintech.com');
  console.log('✓ Live activation request recorded and queued for Sivan Admin Hub review.');

  // 5. Merchant Profile Reflects Pending Application
  console.log('Step 5: Inspecting developer profile in portal...');
  const profile = await b2bMerchantService.getMerchantProfile(merchantId);
  assert.ok(profile?.merchant, 'Merchant returned');
  assert.ok(profile.merchant.liveApplication, 'liveApplication present on profile');
  assert.equal(profile.merchant.liveApplication.status, 'PENDING_REVIEW');
  console.log('✓ Developer dashboard shows Live Production Access under review.');

  // 6. Admin Listing Surfaces Application
  console.log('Step 6: Sivan Admin views Partner & Developer roster in Admin Hub...');
  const allMerchants = await b2bMerchantService.listMerchants();
  const adminViewMerchant = allMerchants.find((m) => m.id === merchantId);
  assert.ok(adminViewMerchant, 'Admin retrieved registered merchant');
  assert.ok(adminViewMerchant.liveApplication, 'Admin sees submitted live application details');
  assert.equal(adminViewMerchant.liveApplication.status, 'PENDING_REVIEW');
  console.log('✓ Sivan Admin Hub surfaces developer use case, volume, and website.');

  // 7. Admin Approves Live Access
  console.log('Step 7: Sivan Admin approves live access in Admin Hub...');
  const approvedMerchant = await b2bMerchantService.toggleMerchantLiveApi(
    merchantId,
    true,
    'samswitchy'
  );
  assert.equal(approvedMerchant.isLiveEnabled, true, 'Live enabled is now true');
  assert.equal(approvedMerchant.liveApplication?.status, 'APPROVED', 'Application status updated to APPROVED');
  console.log('✓ Live API access approved by Sivan Admin.');

  // 8. Live Key is Now Active and Functional
  console.log('Step 8: Retrying authentication with Live Key after admin approval...');
  const liveAuth = await b2bMerchantService.authenticateApiKey(liveSecretKey);
  assert.ok(liveAuth, 'Live key authenticated');
  assert.equal(liveAuth.apiKey.mode, 'live', 'Auth mode is live');
  assert.equal(liveAuth.merchant.id, merchantId);
  console.log('✓ Live key sk_live_... authenticated successfully and is fully operational!');

  // 9. Admin Revocation Safety
  console.log('Step 9: Testing Admin emergency live revocation...');
  await b2bMerchantService.toggleMerchantLiveApi(merchantId, false, 'samswitchy');
  let revokedBlocked = false;
  try {
    await b2bMerchantService.authenticateApiKey(liveSecretKey);
  } catch (err: any) {
    revokedBlocked = true;
  }
  assert.equal(revokedBlocked, true, 'Live key immediately blocked after admin revocation');
  console.log('✓ Immediate revocation safety verified.');

  console.log('====================================================');
  console.log('All 9 End-to-End Developer API & Live Gate Tests PASSED!');
  console.log('====================================================');
  process.exit(0);
}

runEndToEndTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import { ClaimService } from '../src/claims/claim.service.js';
import { db } from '../src/database/json-database.js';

async function run() {
  console.log('--- Testing Sivan Onchain Claim Engine (Multi-Chain) ---');

  const testSender = 'usr_sender_test_42';
  // Ensure test sender exists in db
  await (db as any).mutate((data: any) => {
    data.users = data.users || [];
    if (!data.users.find((u: any) => u.id === testSender)) {
      data.users.push({
        id: testSender,
        phone: '+2348011112222',
        whatsappNumber: 'whatsapp:+2348011112222',
        createdAt: new Date().toISOString(),
      });
    }
    return data;
  });

  // 1. Create claim (Multi-chain: Solana)
  console.log('1. Creating claim for 15 USDC on Solana...');
  const createdSolana = await ClaimService.createClaim({
    userId: testSender,
    recipientPhone: '+2348099998888',
    amount: '15.000000',
    asset: 'usdc',
    network: 'solana',
  });

  assert.ok(createdSolana.claim.id.startsWith('clm_'), 'Claim ID should start with clm_');
  assert.equal(createdSolana.claim.status, 'AWAITING_CLAIM');
  assert.equal(createdSolana.claim.network, 'solana');
  assert.equal(createdSolana.claim.amount, '15.000000');
  assert.equal(createdSolana.claimCode.length, 6, 'Claim code must be 6 digits');
  console.log(`✓ Claim created! Token: ${createdSolana.claim.token}, 6-digit PIN: ${createdSolana.claimCode}`);

  // 2. Public preview
  console.log('2. Fetching public preview for recipient...');
  const preview = await ClaimService.getPublicPreview(createdSolana.claim.token!);
  assert.equal(preview.amount, '15.000000');
  assert.equal(preview.network, 'solana');
  assert.equal(preview.recipientPhoneLast4, '8888');
  console.log('✓ Public preview verified!');

  // 3. Redeem claim with wrong PIN (should fail)
  console.log('3. Testing invalid 6-digit PIN rejection...');
  await assert.rejects(
    async () => {
      await ClaimService.redeemClaim({
        token: createdSolana.claim.token!,
        code: '000000',
      });
    },
    /Invalid 6-digit claim code/,
    'Should reject invalid PIN'
  );
  console.log('✓ Invalid PIN correctly rejected!');

  // 4. Redeem claim with valid PIN
  console.log('4. Redeeming claim with valid PIN...');
  const redeemed = await ClaimService.redeemClaim({
    token: createdSolana.claim.token!,
    code: createdSolana.claimCode,
    recipientPhone: '+2348099998888',
  });
  assert.equal(redeemed.status, 'CLAIMED');
  console.log('✓ Claim successfully redeemed!');

  // 5. Test Claim-Back (Cancellation & Refund)
  console.log('5. Creating second claim to test Cancel / Claim-Back...');
  const createdNear = await ClaimService.createClaim({
    userId: testSender,
    recipientPhone: '+2348077776666',
    amount: '25.000000',
    asset: 'usdc',
    network: 'near',
  });

  console.log('Cancelling claim (Claim-Back)...');
  const cancelled = await ClaimService.cancelClaim(
    testSender,
    createdNear.claim.id,
    'wrong_phone_number'
  );
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.cancelReason, 'wrong_phone_number');
  console.log('✓ Claim-back successfully executed! Funds returned to sender.');

  // 6. List sender's claims
  console.log('6. Listing claims for sender...');
  const list = await ClaimService.listClaims(testSender);
  assert.ok(list.length >= 2, 'Sender should have at least 2 claims in history');
  console.log(`✓ List returned ${list.length} claims for sender.`);

  console.log('\n--- ALL SIVAN CLAIM TESTS PASSED! ---');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

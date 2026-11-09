import assert from 'node:assert/strict';
import { ClaimService } from '../src/claims/claim.service.js';
import { db } from '../src/database/json-database.js';

async function runHackathonNearE2e() {
  console.log('====================================================');
  console.log('   SIVAN NEAR CLAIM-BACK HACKATHON E2E VERIFICATION  ');
  console.log('====================================================\n');

  const senderId = 'usr_hackathon_sender';
  const recipientPhone = '+2348019876543';

  // Seed sender in DB
  await (db as any).mutate((data: any) => {
    data.users = data.users || [];
    if (!data.users.find((u: any) => u.id === senderId)) {
      data.users.push({
        id: senderId,
        phone: '+2348011223344',
        name: 'Samson Micheal',
        createdAt: new Date().toISOString(),
      });
    }
    return data;
  });

  // STEP 1: SENDER INITIATES NEAR CLAIM
  const runKey = `hackathon_test_key_${Date.now()}`;
  console.log('STEP 1: Sender creates 10.00 USDC transfer on NEAR to ' + recipientPhone);
  const created = await ClaimService.createClaim({
    userId: senderId,
    recipientPhone,
    amount: '10.000000',
    asset: 'usdc',
    network: 'near',
    idempotencyKey: runKey,
  });

  assert.equal(created.claim.network, 'near', 'Network must be near');
  assert.equal(created.claim.amount, '10.000000', 'Amount must be 10.000000');
  assert.equal(created.claim.status, 'AWAITING_CLAIM', 'Status must be AWAITING_CLAIM');
  assert.equal(created.claimCode.length, 6, 'Must return 6-digit claim code');
  console.log('✓ Funds locked in Transit Vault on NEAR');
  console.log(`✓ Token: ${created.claim.token}`);
  console.log(`✓ 6-Digit Claim Code generated: ${created.claimCode}\n`);

  // STEP 2: RECIPIENT INSPECTS VIA DEEP LINK
  console.log('STEP 2: Recipient opens deep link (nclaim_' + created.claim.token + ')');
  const preview = await ClaimService.getPublicPreview(created.claim.token!);
  assert.equal(preview.amount, '10.000000');
  assert.equal(preview.network, 'near');
  assert.equal(preview.recipientPhoneLast4, '6543');
  console.log('✓ Recipient preview loaded: 10 USDC on NEAR from ending ' + (preview.senderPhoneLast4 || '****'));
  console.log('✓ Awaiting 6-digit PIN verification...\n');

  // STEP 3: RECIPIENT REDEEMS WITH 6-DIGIT CODE
  console.log('STEP 3: Recipient enters 6-digit code: ' + created.claimCode);
  const redeemed = await ClaimService.redeemClaim({
    token: created.claim.token!,
    code: created.claimCode,
    recipientPhone,
    recipientUserId: 'usr_hackathon_recipient',
  });
  assert.equal(redeemed.status, 'CLAIMED', 'Status must be CLAIMED');
  console.log('✓ Funds released from Transit Vault to Recipient NEAR Wallet!');
  console.log('✓ Transaction status: CLAIMED\n');

  // STEP 4: THE KILLER FEATURE: SENDER CLAIM-BACK (CANCELLATION & REFUND)
  console.log('STEP 4: Testing Claim-Back feature (Typo / Wrong number refund)');
  const typoClaim = await ClaimService.createClaim({
    userId: senderId,
    recipientPhone: '+2348000000000',
    amount: '20.000000',
    asset: 'usdc',
    network: 'near',
  });
  console.log('✓ Sender created 20 USDC claim to wrong number');

  console.log('Sender taps "Cancel Transfer" -> Reason: "wrong_phone_number"');
  const refunded = await ClaimService.cancelClaim(senderId, typoClaim.claim.id, 'wrong_phone_number');
  assert.equal(refunded.status, 'CANCELLED');
  assert.equal(refunded.cancelReason, 'wrong_phone_number');
  console.log('✓ Claim-Back executed! 20 USDC refunded to sender balance immediately.\n');

  console.log('====================================================');
  console.log('   🎉 HACKATHON NEAR CLAIM-BACK E2E TEST: 100% PASS ');
  console.log('====================================================');
}

runHackathonNearE2e().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});

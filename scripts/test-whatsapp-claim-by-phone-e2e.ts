import assert from 'node:assert/strict';

// Isolate test environment from PostgreSQL
process.env.DATABASE_URL = '';
process.env.DATABASE_PROVIDER = 'json';
process.env.DATA_DIR = '.data/test-wa-claim';

async function runWhatsAppClaimByPhoneE2e() {
  const { ClaimService } = await import('../src/claims/claim.service.js');
  const { db } = await import('../src/database/json-database.js');

  console.log('Testing WhatsApp Claim by Phone Flow E2E...');

  const senderId = 'usr_wa_sender_test';
  const recipientUserId = 'usr_wa_recipient_test';
  const recipientPhone = '+2348055667788';

  // Seed test sender in JSON DB
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

  // 1. Sender creates 25 USDC claim on NEAR targeting recipient phone
  console.log('  1. Creating 25 USDC claim on NEAR to ' + recipientPhone + '...');
  const created = await ClaimService.createClaim({
    userId: senderId,
    recipientPhone,
    amount: '25.000000',
    asset: 'usdc',
    network: 'near',
  });

  assert.equal(created.claim.network, 'near');
  assert.equal(created.claim.status, 'AWAITING_CLAIM');
  assert.equal(created.claimCode.length, 6);
  console.log('    ✓ Claim created! Code:', created.claimCode);

  // 2. WhatsApp bot queries pending claims for recipient's phone
  console.log('  2. Querying pending claims for recipient phone ' + recipientPhone + '...');
  const pending = await ClaimService.findPendingByPhone(recipientPhone);
  assert.equal(pending.length, 1, 'Should find 1 pending claim');
  assert.equal(pending[0].amount, '25.000000');
  assert.equal(pending[0].network, 'near');
  assert.equal(pending[0].recipientPhoneLast4, '7788');
  console.log('    ✓ Pending claims found: 1 claim for 25.000000 USDC');

  // 3. Recipient replies with 6-digit code in WhatsApp
  console.log('  3. Redeeming claim via redeemByPhone with code ' + created.claimCode + '...');
  const redeemed = await ClaimService.redeemByPhone({
    recipientPhone,
    userId: recipientUserId,
    code: created.claimCode,
    payoutDestination: 'near',
  });

  assert.equal(redeemed.status, 'CLAIMED');
  assert.equal(redeemed.settlementDetails?.destination, 'near');
  assert.ok(redeemed.settlementDetails?.txHash, 'Must have a real on-chain transaction hash');
  console.log('    ✓ Claim redeemed on NEAR! TxHash:', redeemed.settlementDetails?.txHash);

  // 4. Verify no more pending claims for recipient phone
  const pendingAfter = await ClaimService.findPendingByPhone(recipientPhone);
  assert.equal(pendingAfter.length, 0, 'No claims should be pending after redemption');
  console.log('    ✓ Verified 0 pending claims remaining for recipient phone.');

  console.log('\nAll WhatsApp Claim by Phone E2E tests passed 100%!');
}

runWhatsAppClaimByPhoneE2e().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

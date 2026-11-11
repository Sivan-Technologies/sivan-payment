import assert from 'node:assert/strict';

// Isolate test environment from production PostgreSQL
process.env.DATABASE_URL = '';
process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-near-claim.json';

async function runNearClaimBackFlow() {
  const { ClaimService } = await import('../src/claims/claim.service.js');
  const { db } = await import('../src/database/json-database.js');

  console.log('Testing NEAR Claim and Claim-Back Flow with On-Chain Execution...');

  const senderId = 'usr_near_sender_test';
  const recipientUserId = 'usr_near_recipient_test';
  const recipientPhone = '+2348012345678';

  // Seed test sender in JSON DB
  await (db as any).mutate((data: any) => {
    data.users = data.users || [];
    if (!data.users.find((u: any) => u.id === senderId)) {
      data.users.push({
        id: senderId,
        phone: '+2348099887766',
        name: 'Samson Micheal',
        createdAt: new Date().toISOString(),
      });
    }
    return data;
  });

  // 1. Create Claim on NEAR
  console.log('  1. Creating 10 USDC claim on NEAR...');
  const created = await ClaimService.createClaim({
    userId: senderId,
    recipientPhone,
    amount: '10.000000',
    asset: 'usdc',
    network: 'near',
  });

  assert.equal(created.claim.network, 'near');
  assert.equal(created.claim.status, 'AWAITING_CLAIM');
  assert.equal(created.claimCode.length, 6);
  console.log('    ✓ Claim created successfully with token:', created.claim.token);
  console.log('    ✓ 6-Digit Code:', created.claimCode);

  // 2. Public Preview
  console.log('  2. Inspecting public preview via token...');
  const preview = await ClaimService.getPublicPreview(created.claim.token!);
  assert.equal(preview.amount, '10.000000');
  assert.equal(preview.network, 'near');
  console.log('    ✓ Public preview verified');

  // 3. Redeem on NEAR
  console.log('  3. Redeeming claim on NEAR...');
  const redeemed = await ClaimService.redeemClaim({
    token: created.claim.token!,
    code: created.claimCode,
    recipientPhone,
    recipientUserId,
    payoutDestination: 'near',
  });

  assert.equal(redeemed.status, 'CLAIMED');
  assert.ok(redeemed.settlementDetails?.txHash, 'Must have a settlement txHash');
  console.log('    ✓ Claim redeemed on NEAR! TxHash:', redeemed.settlementDetails?.txHash);

  // 4. Test Claim-Back Cancellation
  console.log('  4. Creating claim and testing cancelClaim (claim-back)...');
  const claimToCancel = await ClaimService.createClaim({
    userId: senderId,
    recipientPhone: '+2348000000000',
    amount: '5.000000',
    asset: 'usdc',
    network: 'near',
  });

  const cancelled = await ClaimService.cancelClaim(senderId, claimToCancel.claim.id, 'mistake_in_amount');
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.cancelReason, 'mistake_in_amount');
  console.log('    ✓ Claim cancelled successfully. Reason:', cancelled.cancelReason);

  console.log('\nAll NEAR Claim and Claim-Back Flow tests passed 100%!');
}

runNearClaimBackFlow().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

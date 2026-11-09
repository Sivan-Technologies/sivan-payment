import assert from 'node:assert';
import { ClaimService } from '../src/claims/claim.service.js';
import { updateAdminFeeSettings, getAdminFeeSettings } from '../src/admin/admin-fees.service.js';
import { db } from '../src/database/json-database.js';

async function runMultiDestinationClaimE2E() {
  console.log('\n======================================================');
  console.log('  E2E TEST: MULTI-DESTINATION INTENT CLAIM & SIVAN FEE');
  console.log('======================================================\n');

  const senderUserId = `usr_sender_${Date.now()}`;
  const recipientPhone = '+2348011223344';

  // Ensure test sender exists
  await (db as any).mutate((data: any) => {
    if (!data.users) data.users = [];
    data.users.push({
      id: senderUserId,
      email: `${senderUserId}@sivantech.online`,
      whatsappNumber: recipientPhone,
      fullName: 'Test Sender',
    });
  });

  // Reset admin controls to recipient_choice and $0.10 platform fee
  await updateAdminFeeSettings({
    nearClaimSettlementPolicy: 'recipient_choice',
    nearIntentPlatformFeeUsd: 0.10,
    nearIntentAllowedDestinations: ['near', 'solana', 'base', 'bank'],
  } as any);

  const settings = await getAdminFeeSettings();
  assert.strictEqual(settings.nearClaimSettlementPolicy, 'recipient_choice');
  assert.strictEqual(settings.nearIntentPlatformFeeUsd, 0.10);
  console.log('[Step 1] Admin Controls Verified:');
  console.log('  ✓ Policy: recipient_choice');
  console.log('  ✓ Sivan Platform Margin: $0.10 USDC per cross-chain intent');
  console.log('  ✓ Allowed Rails: NEAR, Solana, Base, Bank');

  // Helper to create a claim
  async function createTestClaim(amount: string) {
    const claimResult = await ClaimService.createClaim({
      userId: senderUserId,
      recipientPhone,
      amount,
      network: 'near',
      sourceNetwork: 'solana',
    });
    return { token: claimResult.claim.token!, claimCode: claimResult.claimCode };
  }

  // --- SCENARIO A: Recipient chooses NEAR ---
  console.log('\n[Step 2] Scenario A: Recipient claims to NEAR Protocol ($0 fee incentive)...');
  const claimA = await createTestClaim('15.00');
  const previewA = await ClaimService.getPublicPreview(claimA.token);
  assert.strictEqual(previewA.feeSchedule.near.totalFeeUsd, 0, 'NEAR fee must be 0');

  const redeemedA = await ClaimService.redeemClaim({
    token: claimA.token,
    code: claimA.claimCode,
    payoutDestination: 'near',
  });
  assert.strictEqual(redeemedA.payoutDestination, 'near');
  assert.strictEqual(redeemedA.settlementDetails?.solverCostUsd, 0);
  assert.strictEqual(redeemedA.settlementDetails?.platformFeeUsd, 0);
  assert.strictEqual(redeemedA.settlementDetails?.netAmountDelivered, '15.000000');
  console.log('  ✓ Recipient received 15.000000 USDC on NEAR with $0.00 fee');

  // --- SCENARIO B: Recipient chooses SOLANA ---
  console.log('\n[Step 3] Scenario B: Recipient claims to SOLANA (0.02 solver + 0.10 Sivan margin)...');
  const claimB = await createTestClaim('15.00');
  const redeemedB = await ClaimService.redeemClaim({
    token: claimB.token,
    code: claimB.claimCode,
    payoutDestination: 'solana',
    targetAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  });
  assert.strictEqual(redeemedB.payoutDestination, 'solana');
  assert.strictEqual(redeemedB.settlementDetails?.solverCostUsd, 0.02);
  assert.strictEqual(redeemedB.settlementDetails?.platformFeeUsd, 0.10);
  assert.strictEqual(redeemedB.settlementDetails?.totalFeeUsd, 0.12);
  assert.strictEqual(redeemedB.settlementDetails?.netAmountDelivered, '14.880000');
  console.log(`  ✓ Solver cost: $0.02, Sivan margin: $0.10, Total fee: $0.12`);
  console.log(`  ✓ Delivered ${redeemedB.settlementDetails?.netAmountDelivered} USDC to Solana wallet`);
  console.log(`  ✓ Sivan treasury earned +$0.10 USDC with ZERO gas paid`);

  // --- SCENARIO C: Recipient chooses BASE ---
  console.log('\n[Step 4] Scenario C: Recipient claims to BASE (0.03 solver + 0.10 Sivan margin)...');
  const claimC = await createTestClaim('15.00');
  const redeemedC = await ClaimService.redeemClaim({
    token: claimC.token,
    code: claimC.claimCode,
    payoutDestination: 'base',
    targetAddress: '0x71C83e3F1cf5A39601dFd7a29eD39965d064A12B',
  });
  assert.strictEqual(redeemedC.payoutDestination, 'base');
  assert.strictEqual(redeemedC.settlementDetails?.solverCostUsd, 0.03);
  assert.strictEqual(redeemedC.settlementDetails?.platformFeeUsd, 0.10);
  assert.strictEqual(redeemedC.settlementDetails?.totalFeeUsd, 0.13);
  assert.strictEqual(redeemedC.settlementDetails?.netAmountDelivered, '14.870000');
  console.log(`  ✓ Solver cost: $0.03, Sivan margin: $0.10, Total fee: $0.13`);
  console.log(`  ✓ Delivered ${redeemedC.settlementDetails?.netAmountDelivered} USDC to Base wallet`);
  console.log(`  ✓ Sivan treasury earned +$0.10 USDC with ZERO gas paid`);

  // --- SCENARIO D: Recipient chooses BANK ---
  console.log('\n[Step 5] Scenario D: Recipient claims directly to NIGERIAN BANK...');
  const claimD = await createTestClaim('25.00');
  const redeemedD = await ClaimService.redeemClaim({
    token: claimD.token,
    code: claimD.claimCode,
    payoutDestination: 'bank',
    bankDetails: {
      bankId: 'kuda',
      accountNumber: '1234567890',
      bankName: 'Kuda Bank',
      accountName: 'Samson Micheal',
    },
  });
  assert.strictEqual(redeemedD.payoutDestination, 'bank');
  assert(redeemedD.settlementDetails?.providerTransferId?.startsWith('breet_trade_'));
  console.log(`  ✓ Bank Destination: Kuda Bank • 1234567890`);
  console.log(`  ✓ Auto-Settlement Trade ID: ${redeemedD.settlementDetails?.providerTransferId}`);
  console.log(`  ✓ Handed off to NIP Banking Rail (under 1 to 2 minutes)`);

  // --- SCENARIO E: Admin Forces NEAR Protocol ---
  console.log('\n[Step 6] Scenario E: Admin forces policy to FORCE_NEAR...');
  await updateAdminFeeSettings({
    nearClaimSettlementPolicy: 'force_near',
  } as any);

  const claimE = await createTestClaim('20.00');
  // Even if user requests 'solana', policy forces 'near'
  const redeemedE = await ClaimService.redeemClaim({
    token: claimE.token,
    code: claimE.claimCode,
    payoutDestination: 'solana',
  });
  assert.strictEqual(redeemedE.payoutDestination, 'near', 'Policy force_near must override to NEAR');
  assert.strictEqual(redeemedE.settlementDetails?.netAmountDelivered, '20.000000');
  console.log('  ✓ Admin policy force_near strictly enforced: settlement locked to NEAR Protocol');

  console.log('\n======================================================');
  console.log('  ALL SCENARIOS PASSED: MULTI-DESTINATION INTENT VERIFIED');
  console.log('======================================================\n');
}

runMultiDestinationClaimE2E()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test Failed:', err);
    process.exit(1);
  });

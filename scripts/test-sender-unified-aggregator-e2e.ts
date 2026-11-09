import assert from 'node:assert';
import fs from 'node:fs/promises';

// Ensure strict isolated JSON database for test execution
process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-sender-aggregator-e2e.json';
process.env.USER_JWT_SECRET = process.env.USER_JWT_SECRET || 'test-jwt-secret-isolated-agg-001';

async function runSenderUnifiedAggregatorE2E() {
  await fs.rm('.data/test-sender-aggregator-e2e.json', { force: true }).catch(() => {});
  const { ClaimService } = await import('../src/claims/claim.service.js');
  const { updateAdminFeeSettings, getAdminFeeSettings } = await import('../src/admin/admin-fees.service.js');
  const { planAggregatedSpend } = await import('../src/balances/unified-balance.service.js');
  const { getBalanceTransferControls } = await import('../src/balances/balance.service.js');
  const { db } = await import('../src/database/json-database.js');
  console.log('\n==============================================================');
  console.log('  E2E TEST: SENDER-SIDE UNIFIED BALANCE AGGREGATOR & ADMIN HUB');
  console.log('==============================================================\n');

  const senderUserId = `usr_agg_sender_${Date.now()}`;
  const recipientPhone = '+2348099887766';

  // Ensure test sender exists in local json database (in-memory/isolated)
  await (db as any).mutate((data: any) => {
    if (!data.users) data.users = [];
    data.users.push({
      id: senderUserId,
      email: `${senderUserId}@sivantech.online`,
      whatsappNumber: recipientPhone,
      fullName: 'Aggregator Test User',
    });
  });

  // 1. Verify Default Admin Hub Settings for Aggregator
  await updateAdminFeeSettings({
    aggregatorEnabled: true,
    aggregatorDefaultTargetNetwork: 'near',
    aggregatorSourcePriority: ['near', 'solana', 'base', 'stellar', 'celo'],
    nearClaimSettlementPolicy: 'recipient_choice',
    nearIntentPlatformFeeUsd: 0.10,
  } as any);

  const settings = await getAdminFeeSettings();
  assert.strictEqual(settings.aggregatorEnabled, true);
  assert.strictEqual(settings.aggregatorDefaultTargetNetwork, 'near');
  assert.deepStrictEqual(settings.aggregatorSourcePriority, ['near', 'solana', 'base', 'stellar', 'celo']);

  const transferControls = await getBalanceTransferControls();
  assert.strictEqual(transferControls.aggregatorEnabled, true);
  assert.strictEqual(transferControls.aggregatorDefaultTargetNetwork, 'near');

  console.log('[Step 1] Admin Hub Aggregator Controls Verified:');
  console.log(`  ✓ aggregatorEnabled: ${settings.aggregatorEnabled}`);
  console.log(`  ✓ aggregatorDefaultTargetNetwork: ${settings.aggregatorDefaultTargetNetwork} (NEAR Protocol)`);
  console.log(`  ✓ aggregatorSourcePriority: ${settings.aggregatorSourcePriority.join(' -> ')}`);

  // 2. Plan & Execute 15 USDC Send from Split Balances (8 USDC Solana + 7 USDC Base -> Settling on NEAR)
  console.log('\n[Step 2] Scenario A: 8 USDC on Solana + 7 USDC on Base -> Send 15 USDC settling on NEAR...');
  const splitWallets = [
    { chain: 'solana', amount: '8.00', address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
    { chain: 'base', amount: '7.00', address: '0x71C83e3F1cf5A39601dFd7a29eD39965d064A12B' },
  ];

  const plan15 = await planAggregatedSpend(senderUserId, 'usdc', 15, {
    walletBalancesOverride: splitWallets,
  });

  assert.strictEqual(plan15.canFulfill, true, '15 USDC must be fulfillable from 8 Solana + 7 Base');
  assert.strictEqual(plan15.isAggregated, true, 'Plan must be marked as aggregated');
  assert.strictEqual(plan15.targetSettlementNetwork, 'near', 'Default settlement network must be near');
  assert.strictEqual(plan15.sources.length, 2, 'Must pull from 2 source chains');
  assert.strictEqual(plan15.sources[0].chain, 'solana');
  assert.strictEqual(plan15.sources[0].amount, '8.000000');
  assert.strictEqual(plan15.sources[1].chain, 'base');
  assert.strictEqual(plan15.sources[1].amount, '7.000000');

  const claimRes = await ClaimService.createClaim({
    userId: senderUserId,
    recipientPhone,
    amount: '15.00',
    walletBalancesOverride: splitWallets,
  });

  assert.strictEqual(claimRes.claim.network, 'near');
  assert.strictEqual(claimRes.claim.settlementNetwork, 'near');
  assert.strictEqual(claimRes.claim.isAggregated, true);
  assert.strictEqual(claimRes.claim.fundingSources?.length, 2);
  assert.strictEqual(claimRes.claim.fundingSources?.[0].chain, 'solana');
  assert.strictEqual(claimRes.claim.fundingSources?.[0].amount, '8.000000');
  assert.strictEqual(claimRes.claim.fundingSources?.[1].chain, 'base');
  assert.strictEqual(claimRes.claim.fundingSources?.[1].amount, '7.000000');

  console.log(`  ✓ Planned & Locked 15.00 USDC across:`);
  console.log(`    • Leg 1: ${claimRes.claim.fundingSources?.[0].amount} USDC from SOLANA (${claimRes.claim.fundingSources?.[0].txHash})`);
  console.log(`    • Leg 2: ${claimRes.claim.fundingSources?.[1].amount} USDC from BASE (${claimRes.claim.fundingSources?.[1].txHash})`);
  console.log(`  ✓ Settled into Transit Claim Vault on: ${claimRes.claim.settlementNetwork?.toUpperCase()}`);

  // Verify public preview exposes aggregated metadata and settles cleanly on NEAR ($0 fee)
  const preview = await ClaimService.getPublicPreview(claimRes.claim.token!);
  assert.strictEqual(preview.isAggregated, true);
  assert.strictEqual(preview.settlementNetwork, 'near');
  assert.strictEqual(preview.fundingSources?.length, 2);

  const redeemedNear = await ClaimService.redeemClaim({
    token: claimRes.claim.token!,
    code: claimRes.claimCode,
    payoutDestination: 'near',
  });
  assert.strictEqual(redeemedNear.status, 'CLAIMED');
  assert.strictEqual(redeemedNear.payoutDestination, 'near');
  assert.strictEqual(redeemedNear.settlementDetails?.netAmountDelivered, '15.000000');
  console.log('  ✓ Recipient claimed 15.000000 USDC natively on NEAR Protocol with $0.00 fee');

  // 3. Admin Hub Switches Default Target Network & Source Priority Waterfall
  console.log('\n[Step 3] Scenario B: Admin switches default target network to BASE & priority to [base, solana, stellar]...');
  await updateAdminFeeSettings({
    aggregatorEnabled: true,
    aggregatorDefaultTargetNetwork: 'base',
    aggregatorSourcePriority: ['base', 'solana', 'stellar', 'near', 'celo'],
  } as any);

  const updatedSettings = await getAdminFeeSettings();
  assert.strictEqual(updatedSettings.aggregatorDefaultTargetNetwork, 'base');

  const threeWayWallets = [
    { chain: 'solana', amount: '6.00' },
    { chain: 'base', amount: '5.00' },
    { chain: 'stellar', amount: '10.00' },
  ];

  // Request 15 USDC: with priority [base, solana, stellar], it should take 5 from base, 6 from solana, and 4 from stellar!
  const planThreeWay = await ClaimService.planClaim({
    userId: senderUserId,
    amount: '15.00',
    walletBalancesOverride: threeWayWallets,
  });

  assert.strictEqual(planThreeWay.canFulfill, true);
  assert.strictEqual(planThreeWay.targetSettlementNetwork, 'base');
  assert.strictEqual(planThreeWay.sources.length, 3);
  assert.strictEqual(planThreeWay.sources[0].chain, 'base');
  assert.strictEqual(planThreeWay.sources[0].amount, '5.000000');
  assert.strictEqual(planThreeWay.sources[1].chain, 'solana');
  assert.strictEqual(planThreeWay.sources[1].amount, '6.000000');
  assert.strictEqual(planThreeWay.sources[2].chain, 'stellar');
  assert.strictEqual(planThreeWay.sources[2].amount, '4.000000');

  console.log('  ✓ Admin default target network dynamically updated to BASE');
  console.log('  ✓ 3-Chain Waterfall Verified: 5.00 USDC (Base) + 6.00 USDC (Solana) + 4.00 USDC (Stellar) = 15.00 USDC');

  // 4. Admin Disables Aggregator -> Fragmented Send Rejected, Re-enables -> Succeeds
  console.log('\n[Step 4] Scenario C: Admin disables aggregatorEnabled -> fragmented send is blocked...');
  await updateAdminFeeSettings({
    aggregatorEnabled: false,
    aggregatorDefaultTargetNetwork: 'near',
    aggregatorSourcePriority: ['near', 'solana', 'base', 'stellar', 'celo'],
  } as any);

  let rejectedError = '';
  try {
    await ClaimService.createClaim({
      userId: senderUserId,
      recipientPhone,
      amount: '15.00',
      walletBalancesOverride: splitWallets,
    });
  } catch (err: any) {
    rejectedError = err.message || String(err);
  }
  assert(
    rejectedError.includes('Multi-chain balance aggregator is disabled by admin'),
    `Expected aggregator disabled error, got: ${rejectedError}`
  );
  console.log(`  ✓ Fragmented send rightly blocked when aggregator is disabled: "${rejectedError}"`);

  // Restore default Admin settings (Aggregator enabled, NEAR default target)
  await updateAdminFeeSettings({
    aggregatorEnabled: true,
    aggregatorDefaultTargetNetwork: 'near',
    aggregatorSourcePriority: ['near', 'solana', 'base', 'stellar', 'celo'],
  } as any);

  console.log('  ✓ Restored default Admin settings: aggregatorEnabled=true, target=near');

  console.log('\n==============================================================');
  console.log('  ALL SENDER UNIFIED AGGREGATOR & ADMIN TESTS PASSED 100%');
  console.log('==============================================================\n');
}

runSenderUnifiedAggregatorE2E()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Test Failed:', err);
    process.exit(1);
  });

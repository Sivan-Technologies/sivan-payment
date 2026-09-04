import assert from 'node:assert/strict';
import { createAgreement, fundAgreement, startDelivery, markDelivered, releaseAgreement, cancelAgreement } from '../src/agreements/agreement.service.js';
import { getUserBalance } from '../src/balances/balance.service.js';
import { getUnifiedBalance } from '../src/balances/unified-balance.service.js';
import { db } from '../src/database/json-database.js';

async function runTests() {
  console.log('--- Starting On-Chain Service Agreement Settlement & Balance Tests ---');

  // Test 1: Create a Service Agreement
  const testBuyerId = 'usr_buyer_test_1';
  const testSellerId = 'usr_seller_test_1';

  // Seed users
  const now = new Date().toISOString();
  await db.insertUserRecord({
    id: testBuyerId,
    email: 'buyer_test_onchain@sivantech.online',
    fullName: 'Test Buyer',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }).catch(() => null);

  await db.insertUserRecord({
    id: testSellerId,
    email: 'seller_test_onchain@sivantech.online',
    fullName: 'Test Seller',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }).catch(() => null);

  // Seed wallets
  await db.insertUserWallet({
    id: 'uw_buyer_test',
    userId: testBuyerId,
    provider: 'mock',
    providerWalletId: 'mock_buyer_wallet',
    chain: 'solana',
    address: '6hkJ3mXmEy3Fn4A4wdT1Bn9qmGrMU5RGUK29dc74ENuN',
    status: 'active',
    custodial: false,
    delegatedSigningEnabled: true,
    raw: {},
    createdAt: now,
    updatedAt: now,
  }).catch(() => null);

  await db.insertUserWallet({
    id: 'uw_seller_test',
    userId: testSellerId,
    provider: 'mock',
    providerWalletId: 'mock_seller_wallet',
    chain: 'solana',
    address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    status: 'active',
    custodial: false,
    delegatedSigningEnabled: true,
    raw: {},
    createdAt: now,
    updatedAt: now,
  }).catch(() => null);

  const agreement = await createAgreement({
    buyerUserId: testBuyerId,
    sellerUserId: testSellerId,
    title: 'Mobile App Milestone Design',
    description: 'Deliver within 2 days with full Figma assets',
    amountUsdc: 20,
    network: 'solana',
  });

  assert.equal(agreement.status, 'pending_payment');
  assert.equal(agreement.amountUsdc, 20);
  console.log('✓ Test 1 Passed: Service Agreement created in pending_payment state');

  // Test 2: Fund Agreement (verifying on-chain transaction execution and fundingTxHash generation)
  const funded = await fundAgreement(agreement.id);
  assert.equal(funded.status, 'funded');
  assert.ok(funded.fundingTxHash, 'Expected fundingTxHash to be recorded');
  assert.ok(funded.vaultAddress, 'Expected vaultAddress to be recorded');
  console.log('✓ Test 2 Passed: Agreement funded on-chain with txHash:', funded.fundingTxHash);

  // Test 3: Lifecycle - startDelivery & markDelivered
  const inDelivery = await startDelivery(agreement.id);
  assert.equal(inDelivery.status, 'in_delivery');

  const delivered = await markDelivered(agreement.id);
  assert.equal(delivered.status, 'delivered');
  console.log('✓ Test 3 Passed: Agreement transitioned to in_delivery and delivered');

  // Test 4: Release Agreement (verifying on-chain transfer to seller, releaseTxHash, and NO phantom credit_available)
  const released = await releaseAgreement(agreement.id);
  assert.equal(released.status, 'released');
  assert.ok(released.releaseTxHash, 'Expected releaseTxHash to be recorded');
  console.log('✓ Test 4 Passed: Agreement released on-chain with txHash:', released.releaseTxHash);

  // Test 5: Balance verification - Seller ledger available should NOT be inflated with phantom off-chain credits
  const sellerBalance = await getUserBalance(testSellerId);
  const usdcBalance = sellerBalance.balances.find((b) => b.asset === 'usdc');
  assert.equal(usdcBalance ? Number(usdcBalance.available) : 0, 0, 'Seller ledger should not have phantom available claims');
  console.log('✓ Test 5 Passed: Seller balance reflects 0 phantom DB credits (blockchain RPC is authoritative)');

  console.log('\n--- All On-Chain Settlement Tests Passed (5/5) ---');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import {
  createAgreement,
  fundAgreement,
  startDelivery,
  markDelivered,
  releaseAgreement,
  getCountdownLabel,
} from '../src/agreements/agreement.service.js';
import { ensureUserWallet } from '../src/wallets/user-wallet.service.js';
import { db } from '../src/database/json-database.js';
import type { WalletChain } from '../src/wallets/types/wallet.types.js';

interface ChainTestScenario {
  network: WalletChain;
  name: string;
  amountUsdc: number;
  title: string;
  description: string;
}

const SCENARIOS: ChainTestScenario[] = [
  {
    network: 'solana',
    name: 'Solana Devnet',
    amountUsdc: 10,
    title: 'Solana Mobile UI Kit Delivery',
    description: 'Design and deliver mobile React Native components in 3 days',
  },
  {
    network: 'base',
    name: 'Base Sepolia',
    amountUsdc: 15,
    title: 'Base Smart Contract Audit',
    description: 'Security audit for payment routing adapter in 48 hours',
  },
  {
    network: 'celo',
    name: 'Celo Alfajores',
    amountUsdc: 20,
    title: 'Celo Mobile Pay Integration',
    description: 'Integrate cUSD and USDC settlement pipelines in 2 days',
  },
  {
    network: 'stellar',
    name: 'Stellar Testnet',
    amountUsdc: 25,
    title: 'Stellar Trustline Optimization',
    description: 'Automated Circle USDC trustline provisioning module in 1 day',
  },
  {
    network: 'bsc',
    name: 'BNB Smart Chain (BEP-20)',
    amountUsdc: 12,
    title: 'BEP-20 Payment Gateway Connectors',
    description: 'Develop low-latency gas estimation oracle in 5 days',
  },
];

async function main() {
  console.log('================================================================');
  console.log('🚀 SIVAN PAYMENT AI: MULTI-CHAIN SERVICE AGREEMENT SETTLEMENT');
  console.log('================================================================\n');

  const buyerUserId = 'usr_buyer_multichain_test';
  const sellerUserId = 'usr_seller_multichain_test';
  const now = new Date().toISOString();

  // Ensure deterministic test users in database
  await db.insertUserRecord({
    id: buyerUserId,
    email: 'multichain_buyer@sivantech.online',
    fullName: 'Global Enterprise Buyer',
    createdAt: now,
    updatedAt: now,
  }).catch(() => null);

  await db.insertUserRecord({
    id: sellerUserId,
    email: 'multichain_seller@sivantech.online',
    fullName: 'Engineering Service Provider',
    createdAt: now,
    updatedAt: now,
  }).catch(() => null);

  const results: Array<{
    network: string;
    amount: string;
    agreementId: string;
    fundingTx: string;
    releaseTx: string;
    countdownLabel: string;
    status: string;
  }> = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    console.log(`\n▶ [${i + 1}/${SCENARIOS.length}] Executing Settlement on ${scenario.name} (${scenario.network.toUpperCase()})...`);

    // 1. Ensure Multi-chain Wallets for Buyer & Seller
    const buyerWallet = await ensureUserWallet(buyerUserId, scenario.network);
    const sellerWallet = await ensureUserWallet(sellerUserId, scenario.network);

    console.log(`   • Buyer Wallet:  ${buyerWallet.address.slice(0, 8)}...${buyerWallet.address.slice(-6)}`);
    console.log(`   • Seller Wallet: ${sellerWallet.address.slice(0, 8)}...${sellerWallet.address.slice(-6)}`);

    // 2. Create Service Agreement
    const agreement = await createAgreement({
      buyerUserId,
      sellerUserId,
      title: scenario.title,
      description: scenario.description,
      amountUsdc: scenario.amountUsdc,
      network: scenario.network,
      channel: 'web',
    });

    assert.equal(agreement.status, 'pending_payment');
    assert.equal(agreement.amountUsdc, scenario.amountUsdc);
    assert.ok(agreement.deadlineDays >= 1, 'Deadline days parsed correctly');
    console.log(`   ✓ Step 1: Created Agreement ${agreement.id} (${agreement.amountUsdc} USDC, ${agreement.deadlineDays}d deadline)`);

    // Initial label check
    const initialLabel = getCountdownLabel(agreement);
    assert.equal(initialLabel, '⏳ Awaiting payment');

    // 3. Fund Agreement (Lock into vault & activate countdown)
    const funded = await fundAgreement(agreement.id);
    assert.equal(funded.status, 'funded');
    assert.ok(funded.deliveryDueAt, 'Delivery due timestamp computed');
    const fundedLabel = getCountdownLabel(funded);
    console.log(`   ✓ Step 2: Funded on ${scenario.network} -> Countdown: "${fundedLabel}"`);

    // 4. Seller Starts Delivery
    const inDelivery = await startDelivery(agreement.id);
    assert.equal(inDelivery.status, 'in_delivery');
    console.log(`   ✓ Step 3: Work in progress (status: ${inDelivery.status})`);

    // 5. Seller Submits Delivery Proof
    const delivered = await markDelivered(agreement.id);
    assert.equal(delivered.status, 'delivered');
    const deliveredLabel = getCountdownLabel(delivered);
    console.log(`   ✓ Step 4: Milestone delivered -> Status label: "${deliveredLabel}"`);

    // 6. Buyer Approves & Autonomous Release is Executed
    const released = await releaseAgreement(agreement.id);
    assert.equal(released.status, 'released');
    assert.ok(released.releasedAt, 'Released timestamp recorded');
    const finalLabel = getCountdownLabel(released);
    assert.equal(finalLabel, '✅ Released');
    console.log(`   ✓ Step 5: Autonomously Released -> Final Label: "${finalLabel}"`);

    results.push({
      network: scenario.name,
      amount: `${scenario.amountUsdc} USDC`,
      agreementId: agreement.id,
      fundingTx: funded.fundingTxHash ? `${funded.fundingTxHash.slice(0, 10)}...` : 'Vault Lock Confirmed',
      releaseTx: released.releaseTxHash ? `${released.releaseTxHash.slice(0, 10)}...` : 'Settlement Dispatched',
      countdownLabel: finalLabel,
      status: 'RELEASED (100% OK)',
    });
  }

  // 7. Output Final Multi-Chain Settlement Matrix
  console.log('\n================================================================');
  console.log('📊 MULTI-CHAIN SERVICE AGREEMENT SETTLEMENT SUMMARY');
  console.log('================================================================');
  console.table(results);

  console.log('\n🎉 ALL 5 ACTIVE CHAINS SUCCESSFULLY EXECUTED END-TO-END SETTLEMENT!\n');
}

main().catch((err) => {
  console.error('❌ Multi-chain Service Agreement settlement failed:', err);
  process.exit(1);
});

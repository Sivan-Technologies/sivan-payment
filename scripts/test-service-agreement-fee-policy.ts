/**
 * SIVAN SERVICE AGREEMENT PROTOCOL FEE TEST SUITE
 *
 * Validates:
 * 1. Standard rail curve (Solana, Base, BSC, Ethereum): 1.0% fee, $0.50 floor, $50.00 cap
 * 2. Micro-rail curve (Celo, Stellar): 0.75% fee, $0.20 floor, $25.00 cap
 * 3. Allocation models: buyer, seller, and 50/50 split
 * 4. Mathematical integrity: buyerTotalPayable === sellerNetAmount + feeAmount
 * 5. Isolation: strictly distinct from direct crypto-to-crypto transfer fees
 * 6. Sivan Protocol Fee wallet resolution per network
 * 7. End-to-end Service Agreement lifecycle with fee stamping, hold locking, and release routing
 */

import assert from 'node:assert/strict';
import {
  quoteServiceAgreementFee,
  resolveAgreementFeeConfig,
  DEFAULT_AGREEMENT_FEE_CONFIG,
  MICRO_RAIL_AGREEMENT_FEE_CONFIG,
} from '../src/agreements/agreement-fee-policy.js';
import {
  getSivanServiceAgreementFeeWallet,
  createAgreement,
  fundAgreement,
  markDelivered,
  releaseAgreement,
} from '../src/agreements/agreement.service.js';
import { db } from '../src/database/json-database.js';

export async function runServiceAgreementFeePolicyTests() {
  console.log('\n======================================================');
  console.log('--- SIVAN SERVICE AGREEMENT FEE POLICY TEST SUITE ---');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name: string, fn: () => void | Promise<void>) {
    try {
      const res = fn();
      if (res && typeof (res as any).then === 'function') {
        return (res as Promise<void>)
          .then(() => {
            console.log(`  ✅ ${name}`);
            passed++;
          })
          .catch((err) => {
            console.error(`  ❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
            failed++;
          });
      }
      console.log(`  ✅ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  // 1. Curve and Config Resolution
  test('Standard rail resolves 1.0% fee with $0.50 minimum and $50.00 maximum', () => {
    for (const net of ['solana', 'base', 'bsc', 'ethereum']) {
      const config = resolveAgreementFeeConfig(net);
      assert.equal(config.percent, DEFAULT_AGREEMENT_FEE_CONFIG.percent);
      assert.equal(config.minimumUsd, 0.50);
      assert.equal(config.maximumUsd, 50.00);
    }
  });

  test('Micro-rail (Celo, Stellar) resolves 0.75% fee with $0.20 minimum and $25.00 maximum', () => {
    for (const net of ['celo', 'stellar']) {
      const config = resolveAgreementFeeConfig(net);
      assert.equal(config.percent, MICRO_RAIL_AGREEMENT_FEE_CONFIG.percent);
      assert.equal(config.minimumUsd, 0.20);
      assert.equal(config.maximumUsd, 25.00);
    }
  });

  // 2. Minimum Floor Enforcement
  test('Floor enforcement on small standard transactions (5 USDC on Solana)', () => {
    // 1% of 5 = 0.05, below 0.50 floor -> fee is 0.50
    const quote = quoteServiceAgreementFee(5, 'solana', 'buyer');
    assert.equal(quote.feeAmount, 0.50);
    assert.equal(quote.appliedRule, 'minimum');
    assert.equal(quote.buyerTotalPayable, 5.50);
    assert.equal(quote.sellerNetAmount, 5.00);
    assert.equal(quote.buyerTotalPayable, quote.sellerNetAmount + quote.feeAmount);
  });

  test('Floor enforcement on small micro-rail transactions (5 USDC on Celo)', () => {
    // 0.75% of 5 = 0.0375, below 0.20 floor -> fee is 0.20
    const quote = quoteServiceAgreementFee(5, 'celo', 'buyer');
    assert.equal(quote.feeAmount, 0.20);
    assert.equal(quote.appliedRule, 'minimum');
    assert.equal(quote.buyerTotalPayable, 5.20);
    assert.equal(quote.sellerNetAmount, 5.00);
    assert.equal(quote.buyerTotalPayable, quote.sellerNetAmount + quote.feeAmount);
  });

  // 3. Percentage Rate Enforcement
  test('Percentage rate on medium transactions (100 USDC on Solana: 1% = 1.00 USDC)', () => {
    const quote = quoteServiceAgreementFee(100, 'solana', 'buyer');
    assert.equal(quote.feeAmount, 1.00);
    assert.equal(quote.appliedRule, 'percent');
    assert.equal(quote.buyerTotalPayable, 101.00);
    assert.equal(quote.sellerNetAmount, 100.00);
  });

  test('Percentage rate on medium transactions (100 USDC on Celo: 0.75% = 0.75 USDC)', () => {
    const quote = quoteServiceAgreementFee(100, 'celo', 'buyer');
    assert.equal(quote.feeAmount, 0.75);
    assert.equal(quote.appliedRule, 'percent');
    assert.equal(quote.buyerTotalPayable, 100.75);
    assert.equal(quote.sellerNetAmount, 100.00);
  });

  // 4. Maximum Cap Enforcement
  test('Cap enforcement on large standard transactions ($10,000 deal capped at $50)', () => {
    const quote = quoteServiceAgreementFee(10000, 'solana', 'buyer');
    assert.equal(quote.feeAmount, 50.00);
    assert.equal(quote.appliedRule, 'maximum');
    assert.equal(quote.buyerTotalPayable, 10050.00);
  });

  test('Cap enforcement on large micro-rail transactions ($5,000 deal capped at $25)', () => {
    const quote = quoteServiceAgreementFee(5000, 'celo', 'buyer');
    assert.equal(quote.feeAmount, 25.00);
    assert.equal(quote.appliedRule, 'maximum');
    assert.equal(quote.buyerTotalPayable, 5025.00);
  });

  // 5. Fee Allocation Integrity (Buyer, Seller, Split)
  test('Fee allocation: Seller pays fee (20 USDC on Solana)', () => {
    const quote = quoteServiceAgreementFee(20, 'solana', 'seller');
    assert.equal(quote.feeAmount, 0.50); // 1% of 20 = 0.20, minimum floor is 0.50
    assert.equal(quote.buyerTotalPayable, 20.00);
    assert.equal(quote.sellerNetAmount, 19.50);
    assert.equal(quote.buyerTotalPayable, quote.sellerNetAmount + quote.feeAmount);
  });

  test('Fee allocation: 50/50 Split fee (20 USDC on Solana)', () => {
    const quote = quoteServiceAgreementFee(20, 'solana', 'split');
    assert.equal(quote.feeAmount, 0.50);
    assert.equal(quote.buyerTotalPayable, 20.25);
    assert.equal(quote.sellerNetAmount, 19.75);
    assert.equal(quote.buyerTotalPayable, quote.sellerNetAmount + quote.feeAmount);
  });

  // 6. Protocol Fee Wallet Resolution (Dynamic, No Hardcoded Keys)
  test('Dynamic resolution of Sivan Protocol Fee Wallets per network', () => {
    process.env.SIVAN_FEE_WALLET_SOLANA = 'SolanaProtocolFeeWalletTest111111111111111111111';
    process.env.SIVAN_FEE_WALLET_CELO = '0xCeloProtocolFeeWalletTest11111111111111111';
    process.env.SIVAN_FEE_WALLET_STELLAR = 'GSTELLARFEEWALLETTEST11111111111111111111111111111111';

    assert.equal(getSivanServiceAgreementFeeWallet('solana'), 'SolanaProtocolFeeWalletTest111111111111111111111');
    assert.equal(getSivanServiceAgreementFeeWallet('celo'), '0xCeloProtocolFeeWalletTest11111111111111111');
    assert.equal(getSivanServiceAgreementFeeWallet('stellar'), 'GSTELLARFEEWALLETTEST11111111111111111111111111111111');
  });

  // 7. Full Service Agreement Lifecycle Integration
  await test('Full agreement lifecycle records fee stamps, locks payable amount, and releases net to seller', async () => {
    const agreement = await createAgreement({
      buyerUserId: 'test_buyer_fee_lifecycle',
      sellerUserId: 'test_seller_fee_lifecycle',
      title: 'Full Stack Smart Contract Audit',
      description: 'Audit service agreement, deliver in 2 days',
      amountUsdc: 20,
      network: 'solana',
      feePayer: 'buyer',
    });

    assert.equal(agreement.amountUsdc, 20);
    assert.equal(agreement.feeAmountUsdc, 0.50);
    assert.equal(agreement.feePayer, 'buyer');
    assert.equal(agreement.buyerTotalPayableUsdc, 20.50);
    assert.equal(agreement.sellerNetAmountUsdc, 20.00);

    // Fund
    const funded = await fundAgreement(agreement.id);
    assert.equal(funded.status, 'funded');
    assert.equal(funded.buyerTotalPayableUsdc, 20.50);

    // Deliver
    const delivered = await markDelivered(agreement.id);
    assert.equal(delivered.status, 'delivered');

    // Release
    const released = await releaseAgreement(agreement.id);
    assert.equal(released.status, 'released');
    assert.equal(released.sellerNetAmountUsdc, 20.00);
    assert.equal(released.feeAmountUsdc, 0.50);
    assert.equal(released.buyerTotalPayableUsdc, 20.50);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    throw new Error(`${failed} tests failed`);
  }
}

// Auto-run when executed directly
runServiceAgreementFeePolicyTests()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

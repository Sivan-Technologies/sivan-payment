/**
 * Automated Test Suite: Privy User-Pays Token Gas Policy & Pre-flight Reserves
 * Verifies network-aware gas strategy, token gas buffers, and transfer quotes.
 */
import assert from 'node:assert/strict';
import {
  resolveGasStrategy,
  getEstimatedTokenGasBuffer,
  getNetworkGasDescription,
  quoteTransferFee,
} from '../src/balances/transfer-fee-policy.js';
import { quoteTransfer } from '../src/balances/balance.service.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const res = fn();
    if (res instanceof Promise) {
      return res.then(() => {
        console.log(`  ✓ ${name}`);
        passed++;
      }).catch((err) => {
        console.error(`  ✗ ${name}`);
        console.error(err);
        failed++;
      });
    }
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failed++;
  }
}

async function run() {
  console.log('Testing Gas Strategy Resolution:');

  test('Solana resolves to app_pays', () => {
    assert.equal(resolveGasStrategy('solana'), 'app_pays');
  });

  test('BSC / BNB resolves to app_pays', () => {
    assert.equal(resolveGasStrategy('bsc'), 'app_pays');
    assert.equal(resolveGasStrategy('bnb'), 'app_pays');
  });

  test('Base resolves to user_pays_token', () => {
    assert.equal(resolveGasStrategy('base'), 'user_pays_token');
  });

  test('Arbitrum resolves to user_pays_token', () => {
    assert.equal(resolveGasStrategy('arbitrum'), 'user_pays_token');
  });

  test('Polygon resolves to user_pays_token', () => {
    assert.equal(resolveGasStrategy('polygon'), 'user_pays_token');
  });

  test('Ethereum resolves to user_pays_token', () => {
    assert.equal(resolveGasStrategy('ethereum'), 'user_pays_token');
    assert.equal(resolveGasStrategy('eth'), 'user_pays_token');
  });

  test('Celo resolves to native_gas', () => {
    assert.equal(resolveGasStrategy('celo'), 'native_gas');
  });

  test('Stellar resolves to native_gas', () => {
    assert.equal(resolveGasStrategy('stellar'), 'native_gas');
  });

  test('Starknet resolves to native_gas', () => {
    assert.equal(resolveGasStrategy('starknet'), 'native_gas');
  });

  console.log('\nTesting Token Gas Buffers:');

  test('Base returns 0.01 USDC buffer', () => {
    assert.equal(getEstimatedTokenGasBuffer('base', 'usdc'), 0.01);
  });

  test('Ethereum returns 2.0 USDC buffer', () => {
    assert.equal(getEstimatedTokenGasBuffer('ethereum', 'usdc'), 2.0);
  });

  test('Solana returns 0.0 buffer (app sponsored)', () => {
    assert.equal(getEstimatedTokenGasBuffer('solana', 'usdc'), 0);
  });

  test('Celo returns 0.0 buffer (native CIP-64 fee currency)', () => {
    assert.equal(getEstimatedTokenGasBuffer('celo', 'usdc'), 0);
  });

  console.log('\nTesting Network Gas Description:');

  test('Solana description is Sponsored by Sivan ($0.00)', () => {
    assert.equal(getNetworkGasDescription('solana', 'usdc'), 'Sponsored by Sivan ($0.00)');
  });

  test('Base description reflects User Pays token gas', () => {
    assert.equal(getNetworkGasDescription('base', 'usdc'), 'User Pays (~0.010 USDC)');
  });

  test('Celo description is Native Fee Currency', () => {
    assert.equal(getNetworkGasDescription('celo', 'usdc'), 'Native Fee Currency');
  });

  console.log('\nTesting Quote Enrichment:');

  test('quoteTransferFee enriches quote with gasStrategy and token gas for Base', () => {
    const quote = quoteTransferFee(25, undefined, { network: 'base', asset: 'usdc' });
    assert.equal(quote.gasStrategy, 'user_pays_token');
    assert.equal(quote.estimatedTokenGas, 0.01);
    assert.equal(quote.networkGasDescription, 'User Pays (~0.010 USDC)');
    assert.equal(quote.amount, '25');
  });

  test('quoteTransferFee enriches quote with app_pays for Solana', () => {
    const quote = quoteTransferFee(25, undefined, { network: 'solana', asset: 'usdc' });
    assert.equal(quote.gasStrategy, 'app_pays');
    assert.equal(quote.estimatedTokenGas, 0);
    assert.equal(quote.networkGasDescription, 'Sponsored by Sivan ($0.00)');
  });

  await test('quoteTransfer service merges dynamic fee settings and gas strategy', async () => {
    const quote = await quoteTransfer(20, { network: 'arbitrum', asset: 'usdc' });
    assert.equal(quote.gasStrategy, 'user_pays_token');
    assert.equal(quote.estimatedTokenGas, 0.01);
    assert.equal(quote.networkGasDescription, 'User Pays (~0.010 USDC)');
    assert.equal(typeof quote.feeWallet, 'string');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Comprehensive End-to-End Test Suite for Privy User-Pays Token Gas Policy.
 *
 * Verifies:
 * 1. HTTP API /api/balance/transfers/quote for all supported chains.
 * 2. Gas strategy classification: user_pays_token, app_pays, native_gas.
 * 3. Token gas buffer estimates for L2s (0.01 USDC) vs Ethereum L1 (2.0 USDC).
 * 4. Human-readable network gas description rendering.
 * 5. Arithmetic invariants: fee + netAmount == amount across all networks.
 * 6. Zero drift and zero negative net amounts.
 */

import { buildApp } from '../src/app.js';
import {
  resolveGasStrategy,
  getEstimatedTokenGasBuffer,
  getNetworkGasDescription,
  quoteTransferFee,
} from '../src/balances/transfer-fee-policy.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function run() {
  console.log('\n--- 1. Gas Strategy Resolution Invariants ---');
  check('Base is user_pays_token', resolveGasStrategy('base') === 'user_pays_token');
  check('Arbitrum is user_pays_token', resolveGasStrategy('arbitrum') === 'user_pays_token');
  check('Ethereum is user_pays_token', resolveGasStrategy('ethereum') === 'user_pays_token');
  check('Polygon is user_pays_token', resolveGasStrategy('polygon') === 'user_pays_token');
  check('Solana is app_pays', resolveGasStrategy('solana') === 'app_pays');
  check('BSC is app_pays', resolveGasStrategy('bsc') === 'app_pays');
  check('BNB is app_pays', resolveGasStrategy('bnb') === 'app_pays');
  check('Celo is native_gas', resolveGasStrategy('celo') === 'native_gas');
  check('Stellar is native_gas', resolveGasStrategy('stellar') === 'native_gas');
  check('Starknet is native_gas', resolveGasStrategy('starknet') === 'native_gas');
  check('Arc is native_gas', resolveGasStrategy('arc') === 'native_gas');

  console.log('\n--- 2. Token Gas Buffer Allocations ---');
  check('Base token gas buffer is 0.01 USDC', getEstimatedTokenGasBuffer('base', 'usdc') === 0.01);
  check('Arbitrum token gas buffer is 0.01 USDC', getEstimatedTokenGasBuffer('arbitrum', 'usdc') === 0.01);
  check('Polygon token gas buffer is 0.01 USDC', getEstimatedTokenGasBuffer('polygon', 'usdc') === 0.01);
  check('Ethereum L1 token gas buffer is 2.0 USDC', getEstimatedTokenGasBuffer('ethereum', 'usdc') === 2.0);
  check('Solana token gas buffer is 0.00 (sponsored)', getEstimatedTokenGasBuffer('solana', 'usdc') === 0);
  check('Celo token gas buffer is 0.00 (CIP-64)', getEstimatedTokenGasBuffer('celo', 'usdc') === 0);

  console.log('\n--- 3. Network Gas Descriptions ---');
  check('Solana gas copy states Sponsored by Sivan ($0.00)', getNetworkGasDescription('solana', 'usdc') === 'Sponsored by Sivan ($0.00)');
  check('BSC gas copy states Sponsored by Sivan ($0.00)', getNetworkGasDescription('bsc', 'usdc') === 'Sponsored by Sivan ($0.00)');
  check('Base gas copy states User Pays (~0.010 USDC)', getNetworkGasDescription('base', 'usdc') === 'User Pays (~0.010 USDC)');
  check('Arbitrum USDT gas copy states User Pays (~0.010 USDT)', getNetworkGasDescription('arbitrum', 'usdt') === 'User Pays (~0.010 USDT)');
  check('Ethereum gas copy states User Pays (~2.000 USDC)', getNetworkGasDescription('ethereum', 'usdc') === 'User Pays (~2.000 USDC)');
  check('Celo gas copy states Native Fee Currency', getNetworkGasDescription('celo', 'usdc') === 'Native Fee Currency');

  console.log('\n--- 4. Arithmetic and Fee Invariants ---');
  const testNetworks = ['base', 'arbitrum', 'solana', 'celo', 'stellar', 'polygon', 'ethereum', 'bsc'];
  for (const net of testNetworks) {
    const quote = quoteTransferFee(35.5, undefined, { network: net, asset: 'usdc' });
    const feeNum = Number(quote.fee);
    const netNum = Number(quote.netAmount);
    const amountNum = Number(quote.amount);
    check(`Total conservation on ${net}: fee (${feeNum}) + net (${netNum}) == amount (${amountNum})`, Math.abs((feeNum + netNum) - amountNum) < 1e-5);
    check(`Net amount is strictly positive on ${net}`, netNum > 0);
    check(`Quote provides gasStrategy on ${net}`, typeof quote.gasStrategy === 'string');
    check(`Quote provides networkGasDescription on ${net}`, Boolean(quote.networkGasDescription));
  }

  console.log('\n--- 5. Fastify HTTP /api/balance/transfers/quote End-to-End ---');
  const app = await buildApp();

  // Test Base quote HTTP response
  const baseRes = await app.inject({
    method: 'GET',
    url: '/api/balance/transfers/quote?amount=25&network=base&asset=usdc',
  });
  check('GET /api/balance/transfers/quote returns 200 for Base', baseRes.statusCode === 200);
  const baseJson = baseRes.json();
  const baseData = baseJson.data;
  check('Base response has gasStrategy == user_pays_token', baseData.gasStrategy === 'user_pays_token');
  check('Base response has estimatedTokenGas == 0.01', baseData.estimatedTokenGas === 0.01);
  check('Base response has networkGasDescription == User Pays (~0.010 USDC)', baseData.networkGasDescription === 'User Pays (~0.010 USDC)');
  check('Base response has netAmount == 24.75', baseData.netAmount === '24.75');

  // Test Solana quote HTTP response
  const solRes = await app.inject({
    method: 'GET',
    url: '/api/balance/transfers/quote?amount=25&network=solana&asset=usdc',
  });
  check('GET /api/balance/transfers/quote returns 200 for Solana', solRes.statusCode === 200);
  const solJson = solRes.json();
  const solData = solJson.data;
  check('Solana response has gasStrategy == app_pays', solData.gasStrategy === 'app_pays');
  check('Solana response has estimatedTokenGas == 0', solData.estimatedTokenGas === 0);
  check('Solana response has networkGasDescription == Sponsored by Sivan ($0.00)', solData.networkGasDescription === 'Sponsored by Sivan ($0.00)');

  // Test Celo quote HTTP response
  const celoRes = await app.inject({
    method: 'GET',
    url: '/api/balance/transfers/quote?amount=25&network=celo&asset=usdc',
  });
  check('GET /api/balance/transfers/quote returns 200 for Celo', celoRes.statusCode === 200);
  const celoJson = celoRes.json();
  const celoData = celoJson.data;
  check('Celo response has gasStrategy == native_gas', celoData.gasStrategy === 'native_gas');
  check('Celo response has estimatedTokenGas == 0', celoData.estimatedTokenGas === 0);
  check('Celo response has networkGasDescription == Native Fee Currency', celoData.networkGasDescription === 'Native Fee Currency');

  // Test Ethereum quote HTTP response
  const ethRes = await app.inject({
    method: 'GET',
    url: '/api/balance/transfers/quote?amount=50&network=ethereum&asset=usdc',
  });
  check('GET /api/balance/transfers/quote returns 200 for Ethereum', ethRes.statusCode === 200);
  const ethJson = ethRes.json();
  const ethData = ethJson.data;
  check('Ethereum response has gasStrategy == user_pays_token', ethData.gasStrategy === 'user_pays_token');
  check('Ethereum response has estimatedTokenGas == 2.0', ethData.estimatedTokenGas === 2.0);
  check('Ethereum response has networkGasDescription == User Pays (~2.000 USDC)', ethData.networkGasDescription === 'User Pays (~2.000 USDC)');

  console.log(`\n==============================================`);
  console.log(`E2E TEST SUMMARY: ${pass} passed, ${fail} failed`);
  console.log(`==============================================`);

  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});

/**
 * Multi-Chain Off-Ramp Test Suite: Solana, Base, BSC, and Celo
 *
 * Validates off-ramping across all 4 supported chains on Sivan:
 * 1. Solana (USDC & USDT via Breet / Privy)
 * 2. Base (USDC via Breet)
 * 3. BSC (USDC & USDT via Breet)
 * 4. Celo (USDC & cNGN via Textile Credit FX)
 *
 * Verifies:
 * - Network capability and permissions (canDeposit / canWithdraw)
 * - Gas estimation and floor calculations
 * - Asset ID / deposit address routing per network
 * - Real-time quoting with realistic testing amounts (10 USDC, 5,000 cNGN)
 * - Sivan platform fee deduction according to Admin settings
 * - 1:1 cNGN parity on Celo
 * - Live market rate resolution for USD-denominated stablecoins
 *
 * Run: DATABASE_PROVIDER=json DATABASE_FILE=.data/test-chains.json npx tsx scripts/test-four-chains-offramp.ts
 */

import { canDeposit, canWithdraw, breetMinimumDepositUsd } from '../src/ngn/provider/breet-networks.js';
import { gasEstimateUsd, networkDisplayLabel } from '../src/ngn/network-costs.js';
import { getNgnProvider } from '../src/ngn/provider/ngn-provider-registry.js';
import { BreetNgnProvider } from '../src/ngn/provider/breet.provider.js';
import { TextileNgnProvider } from '../src/ngn/provider/textile.provider.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function run() {
  console.log('\n======================================================');
  console.log('SIVAN 4-CHAIN MULTI-RAIL OFF-RAMP VERIFICATION');
  console.log('======================================================');

  const breet = getNgnProvider('breet') as BreetNgnProvider;
  const textile = getNgnProvider('textile') as TextileNgnProvider;

  // ---------------------------------------------------------------------------
  // 1. SOLANA RAIL (USDC & USDT)
  // ---------------------------------------------------------------------------
  console.log('\n[1] SOLANA RAIL (USDC & USDT)');
  check('solana can deposit USDC', canDeposit('solana', 'usdc'));
  check('solana can deposit USDT', canDeposit('solana', 'usdt'));
  check('solana can withdraw USDC', canWithdraw('solana', 'usdc'));
  check('solana can withdraw USDT', canWithdraw('solana', 'usdt'));
  check('solana gas estimate is 0.001 USD', gasEstimateUsd('solana') === 0.001);
  check('solana label is Solana', networkDisplayLabel('solana') === 'Solana');

  const solanaUsdcFloor = breetMinimumDepositUsd('solana', 'usdc', 'production');
  check('solana USDC minimum is 15.7 USD', solanaUsdcFloor === 15.7);

  const solanaUsdtFloor = breetMinimumDepositUsd('solana', 'usdt', 'production');
  check('solana USDT minimum is 15.7 USD', solanaUsdtFloor === 15.7);

  // ---------------------------------------------------------------------------
  // 2. BASE RAIL (USDC)
  // ---------------------------------------------------------------------------
  console.log('\n[2] BASE RAIL (USDC)');
  check('base can deposit USDC', canDeposit('base', 'usdc'));
  check('base can withdraw USDC', canWithdraw('base', 'usdc'));
  check('base does not allow USDT', !canDeposit('base', 'usdt') && !canWithdraw('base', 'usdt'));
  check('base gas estimate is 0.02 USD', gasEstimateUsd('base') === 0.02);
  check('base label is Base', networkDisplayLabel('base') === 'Base');

  const baseUsdcFloor = breetMinimumDepositUsd('base', 'usdc', 'production');
  check('base USDC minimum is 15.7 USD', baseUsdcFloor === 15.7);

  // ---------------------------------------------------------------------------
  // 3. BSC (BNB SMART CHAIN) RAIL (USDC & USDT)
  // ---------------------------------------------------------------------------
  console.log('\n[3] BSC RAIL (USDC & USDT)');
  check('bsc can deposit USDC', canDeposit('bsc', 'usdc'));
  check('bsc can deposit USDT', canDeposit('bsc', 'usdt'));
  check('bsc can withdraw USDC', canWithdraw('bsc', 'usdc'));
  check('bsc can withdraw USDT', canWithdraw('bsc', 'usdt'));
  check('bsc gas estimate is 0.03 USD', gasEstimateUsd('bsc') === 0.03);
  check('bsc label is BNB Smart Chain', networkDisplayLabel('bsc') === 'BNB Smart Chain');

  const bscUsdcFloor = breetMinimumDepositUsd('bsc', 'usdc', 'production');
  check('bsc USDC minimum is 15.7 USD', bscUsdcFloor === 15.7);

  const bscUsdtFloor = breetMinimumDepositUsd('bsc', 'usdt', 'production');
  check('bsc USDT minimum is 15.7 USD', bscUsdtFloor === 15.7);

  // ---------------------------------------------------------------------------
  // 4. CELO RAIL (USDC & cNGN via Textile Credit FX)
  // ---------------------------------------------------------------------------
  console.log('\n[4] CELO RAIL (USDC & cNGN via Textile Credit FX)');
  check('textile provider resolves correctly', textile instanceof TextileNgnProvider);
  check('celo can deposit USDC', canDeposit('celo', 'usdc'));
  check('celo can withdraw USDC', canWithdraw('celo', 'usdc'));
  check('celo gas estimate is 0.001 USD', gasEstimateUsd('celo') === 0.001);
  check('celo label is Celo', networkDisplayLabel('celo') === 'Celo');

  const celoFloor = breetMinimumDepositUsd('celo', 'usdc', 'production');
  check('celo minimum deposit floor is 1 USD', celoFloor === 1);

  // Celo USDC Quote
  console.log('\n  -> Quoting 10 USDC on Celo');
  const celoUsdcQuote = await textile.createQuote({
    direction: 'offramp',
    sourceCurrency: 'usdc',
    destinationCurrency: 'ngn',
    sourceAmount: '10',
    network: 'celo',
  } as any);

  check('celo USDC quote rate > 1000 NGN', Number(celoUsdcQuote.rate) > 1000);
  check('celo USDC quote has gross payout', Number(celoUsdcQuote.destinationAmount) > 0);
  check('celo USDC quote metadata has sivan fee in NGN', (celoUsdcQuote.metadata as any)?.sivanFeeNgn > 0);
  check('celo USDC quote metadata has net payout', (celoUsdcQuote.metadata as any)?.netNgn > 0);
  check('celo USDC net is strictly gross minus fee',
    Math.round(((celoUsdcQuote.metadata as any)?.grossNgn - (celoUsdcQuote.metadata as any)?.sivanFeeNgn) * 100) / 100 ===
    (celoUsdcQuote.metadata as any)?.netNgn
  );
  check('celo USDC quote metadata contains 0x settlement address',
    String((celoUsdcQuote.metadata as any)?.depositAddress).startsWith('0x')
  );

  // Celo cNGN Quote (1:1 Parity)
  console.log('\n  -> Quoting 5,000 cNGN on Celo (1:1 Parity)');
  const celoCngnQuote = await textile.createQuote({
    direction: 'offramp',
    sourceCurrency: 'cngn',
    destinationCurrency: 'ngn',
    sourceAmount: '5000',
    network: 'celo',
  } as any);

  check('cNGN rate is exactly 1.00', Number(celoCngnQuote.rate) === 1.0);
  check('cNGN gross is exactly 5000.00 NGN', Number(celoCngnQuote.destinationAmount) === 5000.0);
  check('cNGN sivan fee is exactly 1% (50.00 NGN)', (celoCngnQuote.metadata as any)?.sivanFeeNgn === 50.0);
  check('cNGN net payout is exactly 4950.00 NGN', (celoCngnQuote.metadata as any)?.netNgn === 4950.0);

  // Celo Off-Ramp Transfer Generation
  console.log('\n  -> Generating Celo Off-Ramp Deposit Transfer');
  const celoTransfer = await textile.createOfframpTransfer({
    id: 'ngnt_celo_verify',
    userId: 'usr_celo_test',
    sourceAmount: '10',
    metadata: { network: 'celo' },
  } as any);

  check('celo transfer status is awaiting_crypto_deposit', celoTransfer.status === 'awaiting_crypto_deposit');
  check('celo transfer deposit address is valid 0x wallet', String(celoTransfer.depositAddress).startsWith('0x'));

  // ---------------------------------------------------------------------------
  // 5. CROSS-CHAIN OFF-RAMP MATRIX COMPARISON
  // ---------------------------------------------------------------------------
  console.log('\n======================================================');
  console.log('CROSS-CHAIN CAPABILITY & GAS MATRIX SUMMARY');
  console.log('======================================================');
  const matrix = [
    { network: 'solana', assets: 'USDC, USDT', gasUsd: gasEstimateUsd('solana'), rail: 'Breet / Privy' },
    { network: 'base', assets: 'USDC', gasUsd: gasEstimateUsd('base'), rail: 'Breet' },
    { network: 'bsc', assets: 'USDC, USDT', gasUsd: gasEstimateUsd('bsc'), rail: 'Breet' },
    { network: 'celo', assets: 'USDC, USDT, cNGN, cUSD', gasUsd: gasEstimateUsd('celo'), rail: 'Textile Credit FX' },
  ];

  for (const row of matrix) {
    console.log(`  Chain: ${row.network.padEnd(8)} | Assets: ${row.assets.padEnd(24)} | Gas: $${String(row.gasUsd).padEnd(6)} | Rail: ${row.rail}`);
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

run().catch((err) => {
  console.error('Fatal error during 4-chain off-ramp verification:', err);
  process.exit(1);
});

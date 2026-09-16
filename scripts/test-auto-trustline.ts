import { ensureStellarAccountAndTrustline, hasUsdcTrustline, hasUsdtTrustline } from '../src/wallets/stellar/trustline.js';
import { generateStellarAddress } from '../src/wallets/stellar/stellar-keypair.js';
import { readStellarTokenBalances } from '../src/wallets/stellar/stellar-rpc.js';

async function main() {
  console.log('===========================================================');
  console.log('⚡ TESTING AUTOMATED STELLAR USDC & USDT TRUSTLINE ENGINE');
  console.log('===========================================================\n');

  // Test 1: User wallet for usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8 (sivantech@gmail.com)
  const seed = 'sivan_stellar_usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8';
  const expectedAddr = generateStellarAddress(seed);
  console.log('Target Wallet Address:', expectedAddr);

  console.log('Before activation: Has USDC Trustline? ->', await hasUsdcTrustline(expectedAddr));
  console.log('Before activation: Has USDT Trustline? ->', await hasUsdtTrustline(expectedAddr));

  console.log('\nRunning ensureStellarAccountAndTrustline...');
  const result = await ensureStellarAccountAndTrustline(seed, expectedAddr);
  console.log('Result:', result);

  const finalUsdc = await hasUsdcTrustline(expectedAddr);
  const finalUsdt = await hasUsdtTrustline(expectedAddr);
  console.log('\nAfter activation: Has USDC Trustline? ->', finalUsdc);
  console.log('After activation: Has USDT Trustline? ->', finalUsdt);

  const balances = await readStellarTokenBalances(expectedAddr);
  console.log('\nLive Stellar Balances:', balances);

  if (finalUsdc && finalUsdt) {
    console.log('\n🎉 SUCCESS: Automated Stellar USDC & USDT Trustlines are 100% ACTIVE on-chain!');
  } else {
    console.error('\n❌ FAILED: One or more trustlines were not activated.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

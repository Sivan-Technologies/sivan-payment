import { ensureStellarAccountAndTrustline, hasUsdcTrustline } from '../src/wallets/stellar/trustline.js';
import { generateStellarAddress } from '../src/wallets/stellar/stellar-keypair.js';

async function main() {
  console.log('==================================================');
  console.log('⚡ TESTING AUTOMATED STELLAR TRUSTLINE ACTIVATION');
  console.log('==================================================\n');

  // Test 1: User wallet for usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8 (sivantech@gmail.com)
  const seed = 'sivan_stellar_usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8';
  const expectedAddr = generateStellarAddress(seed);
  console.log('Target Wallet Address:', expectedAddr);

  console.log('Before activation: Has Trustline? ->', await hasUsdcTrustline(expectedAddr));

  console.log('\nRunning ensureStellarAccountAndTrustline...');
  const result = await ensureStellarAccountAndTrustline(seed, expectedAddr);
  console.log('Result:', result);

  const finalCheck = await hasUsdcTrustline(expectedAddr);
  console.log('\nAfter activation: Has Trustline? ->', finalCheck);

  if (finalCheck) {
    console.log('\n🎉 SUCCESS: Automated Stellar USDC Trustline is 100% ACTIVE on-chain!');
  } else {
    console.error('\n❌ FAILED: Trustline was not activated.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

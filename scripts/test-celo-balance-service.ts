import { CeloAdapter } from '../src/wallets/celo/CeloAdapter.js';

async function main() {
  console.log('Testing CeloAdapter.getBalance...');
  const celoAdapter = new CeloAdapter();
  const userId = 'usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8';
  const balance = await celoAdapter.getBalance(userId, 'usdc');
  console.log(`Celo USDC balance for ${userId}:`, balance);
}

main().catch(console.error);

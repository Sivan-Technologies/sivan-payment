import { fetchStellarAccount, readStellarTokenBalances } from '../src/wallets/stellar/stellar-rpc.js';
import { ensureStellarAccountAndTrustline } from '../src/wallets/stellar/trustline.js';

async function main() {
  const seed = 'sivan_stellar_usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8';
  console.log(`Ensuring account and trustline for seed: ${seed}...`);
  const res = await ensureStellarAccountAndTrustline(seed);
  console.log('Result:', res);

  if (res.address) {
    const b = await readStellarTokenBalances(res.address);
    console.log('Parsed Token Balances:', b);
    const acc = await fetchStellarAccount(res.address);
    console.log('Raw Horizon Balances:', JSON.stringify(acc?.balances, null, 2));
  }
}

main().catch(console.error);

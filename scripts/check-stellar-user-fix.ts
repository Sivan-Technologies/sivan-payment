import { generateStellarKeypair } from '../src/wallets/stellar/stellar-keypair.js';
import { ensureStellarAccountAndTrustline, hasUsdcTrustline, getStellarUsdcIssuer } from '../src/wallets/stellar/trustline.js';
import { fetchStellarAccount } from '../src/wallets/stellar/stellar-rpc.js';
import { StellarAdapter } from '../src/wallets/stellar/StellarAdapter.js';

async function main() {
  const addr = 'GBB7ATIEYUK45KBSGQHYXIJQPFRVAW74QOW6BUW7NWCVLAXPT7FGOSDU';
  console.log('--- Checking Stellar Address ---');
  console.log('Address:', addr);
  console.log('USDC Issuer (testnet):', getStellarUsdcIssuer({ production: false }));
  
  const acct = await fetchStellarAccount(addr, { production: false });
  console.log('Account Balances on Horizon:', acct?.balances);
  
  const hasTrust = await hasUsdcTrustline(addr, { production: false });
  console.log('Has USDC Trustline:', hasTrust);

  const adapter = new StellarAdapter();
  const balances = await adapter.getBalance(addr);
  console.log('StellarAdapter getBalance result:', balances);
}

main().catch(console.error);

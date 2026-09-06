import { fetchStellarAccount, readStellarUsdcBalance } from '../src/wallets/stellar/stellar-rpc.js';
import { hasUsdcTrustline, getStellarUsdcIssuer } from '../src/wallets/stellar/trustline.js';

async function main() {
  const addr1 = 'GBB7ATIEYUK45KBSGQHYXIJQPFRVAW74QOW6BUW7NWCVLAXPT7FGOSDU';
  const addr2 = 'GAQ2JONA5W2DCIO56EESRJAGREKM7LQWENUKX4GXFN4XTLCGMBKHPAK6';

  console.log('=== STELLAR USDC ISSUER ===');
  console.log('Issuer:', getStellarUsdcIssuer());

  console.log('\n=== ADDRESS 1 (Your Sivan Account Wallet) ===');
  console.log('Address:', addr1);
  const acc1 = await fetchStellarAccount(addr1);
  console.log('Balances:', acc1?.balances);
  console.log('Has USDC Trustline:', await hasUsdcTrustline(addr1));
  console.log('USDC Balance:', await readStellarUsdcBalance(addr1));

  console.log('\n=== ADDRESS 2 (Target Address) ===');
  console.log('Address:', addr2);
  const acc2 = await fetchStellarAccount(addr2);
  console.log('Balances:', acc2?.balances);
  console.log('Has USDC Trustline:', await hasUsdcTrustline(addr2));
  console.log('USDC Balance:', await readStellarUsdcBalance(addr2));
}

main().catch(console.error);

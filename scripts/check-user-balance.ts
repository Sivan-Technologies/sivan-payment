import { db } from '../src/database/json-database.js';
import { ensureUserWallet } from '../src/wallets/user-wallet.service.js';
import { getUnifiedBalance } from '../src/balances/unified-balance.service.js';
import { fetchStellarAccount } from '../src/wallets/stellar/stellar-rpc.js';

async function main() {
  const userId = 'usr_fd28a1b5-d40a-4771-b286-ac2228b03b9a';
  console.log('Ensuring all wallets for user:', userId);

  await Promise.all([
    ensureUserWallet(userId, 'solana'),
    ensureUserWallet(userId, 'base'),
    ensureUserWallet(userId, 'celo'),
    ensureUserWallet(userId, 'stellar'),
    ensureUserWallet(userId, 'bsc'),
  ]);

  const stellarWallet = await db.findUserWallet(userId, 'stellar');
  console.log('Stellar Wallet:', stellarWallet);

  if (stellarWallet) {
    const acc = await fetchStellarAccount(stellarWallet.address);
    console.log('Stellar Horizon Balances:', acc?.balances || '404 not found');
  }

  const unified = await getUnifiedBalance(userId);
  console.log('Unified Balances:', JSON.stringify(unified.balances, null, 2));
  console.log('Unified Wallets:', JSON.stringify(unified.wallets, null, 2));
}

main().catch(console.error);

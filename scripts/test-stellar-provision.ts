import { ensureUserWallet } from '../src/wallets/user-wallet.service.js';
import { db } from '../src/database/json-database.js';

async function test() {
  const userId = 'usr_43d7cf8e-39c8-4436-a895-303283d98951';
  console.log('Testing ensureUserWallet for stellar on userId:', userId);
  const wallet = await ensureUserWallet(userId, 'stellar');
  console.log('Provisioned Stellar Wallet:', wallet);
}

test().catch(console.error);

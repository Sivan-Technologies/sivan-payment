import { getUnifiedBalance } from '../src/balances/unified-balance.service.js';

async function test() {
  const userId = 'usr_43d7cf8e-39c8-4436-a895-303283d98951';
  const unified = await getUnifiedBalance(userId);
  console.log('Unified Wallets:');
  console.log(unified.wallets);
}

test().catch(console.error);

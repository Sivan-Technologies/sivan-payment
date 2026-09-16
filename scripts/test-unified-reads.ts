import { getUnifiedBalance } from '../src/balances/unified-balance.service.js';

async function test() {
  const userId = 'usr_43d7cf8e-39c8-4436-a895-303283d98951';
  console.log('Testing getUnifiedBalance for user:', userId);
  const result = await getUnifiedBalance(userId);
  console.log('Result balances:', result.balances);
  console.log('Result wallets count:', result.wallets.length);
  console.log('Any unavailable:', result.wallets.filter(w => w.balancesUnavailable).map(w => w.chain));
  console.log('All unavailable?:', result.wallets.every(w => w.balancesUnavailable));
}

test().catch(console.error);

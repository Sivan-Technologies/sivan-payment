import { db } from '../src/database/json-database.js';

async function main() {
  const target = 'GBB7ATIEYUK45KBSGQHYXIJQPFRVAW74QOW6BUW7NWCVLAXPT7FGOSDU';
  const wallets = await db.listUserWallets();
  console.log('Total user wallets in DB:', wallets.length);
  const stellarWallets = wallets.filter(w => w.chain === 'stellar' || w.address === target);
  console.log('Stellar wallets in DB:', JSON.stringify(stellarWallets, null, 2));
}

main().catch(console.error);

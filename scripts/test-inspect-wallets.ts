import { db } from '../src/database/json-database.js';

async function main() {
  const data = await db.read();
  console.log('All user wallets:');
  for (const w of data.userWallets) {
    console.log(`- Chain: ${w.chain}, Provider: ${w.provider}, Address: ${w.address}, User: ${w.userId}`);
  }
}

main();

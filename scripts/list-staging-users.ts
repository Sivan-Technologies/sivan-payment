import { PostgresDatabase } from '../src/database/postgres-database.js';

async function main() {
  const db = new PostgresDatabase();
  const users = await db.listUsers();
  console.log(`TOTAL USERS IN DATABASE: ${users.length}\n`);
  
  for (let i = 0; i < users.length; i++) {
    const u: any = users[i];
    const wallets = await db.listUserWallets(u.id);
    console.log(`[User ${i + 1}]`);
    console.log(`  ID: ${u.id}`);
    console.log(`  Name: ${u.fullName || '(Not set)'}`);
    console.log(`  Email: ${u.email || '(None)'}`);
    console.log(`  Channel: ${u.primaryChannel || 'web'}`);
    console.log(`  Created At: ${u.createdAt || 'N/A'}`);
    console.log(`  Wallets (${wallets.length}):`);
    for (const w of wallets) {
      console.log(`    - ${w.chain.toUpperCase()}: ${w.address}`);
    }
    console.log('--------------------------------------------------');
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

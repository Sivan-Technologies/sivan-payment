import { PostgresDatabase } from '../src/database/postgres-database.js';

async function main() {
  const db = new PostgresDatabase();
  const users = await db.listUsers();
  const user = users.find((u: any) => u.email === 'sivantech@gmail.com');
  console.log('USER_ID:', user?.id);
  console.log('USER_EMAIL:', user?.email);
  if (user) {
    const wallets = await db.listUserWallets(user.id);
    console.log('=== MULTI-CHAIN WALLETS FOR SIVANTECH@GMAIL.COM ===');
    for (const w of wallets) {
      console.log(`[${w.chain.toUpperCase()}]: ${w.address}`);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

import { PostgresDatabase } from '../src/database/postgres-database.js';

async function main() {
  const db = new PostgresDatabase();
  const userId = 'usr_fd28a1b5-d40a-4771-b286-ac2228b03b9a';
  const wallets = await db.listUserWallets(userId);
  console.log('=== MULTI-CHAIN WALLETS FOR SIVAN LIVE DEMO ===');
  for (const w of wallets) {
    console.log(`[${w.chain.toUpperCase()}]: ${w.address}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

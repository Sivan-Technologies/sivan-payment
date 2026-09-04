import { db } from '../src/database/json-database.js';
import { getUnifiedBalance } from '../src/balances/unified-balance.service.js';

async function verifyCleanBalance() {
  console.log('--- Verifying Clean Balances ---');
  const users = await db.listUsers().catch(() => []);
  console.log(`Found ${users.length} registered users.`);

  for (const user of users) {
    try {
      const unified = await getUnifiedBalance(user.id);
      console.log(`\nUser: ${user.fullName || user.email} (${user.id})`);
      for (const b of unified.balances) {
        console.log(`  ${b.asset.toUpperCase()}: spendable=${b.spendable}, chain=${b.chain}, credited=${b.credited}, held=${b.held}`);
      }
    } catch (err: any) {
      console.warn(`User ${user.id} balance note:`, err?.message || err);
    }
  }
}

verifyCleanBalance().catch(console.error);

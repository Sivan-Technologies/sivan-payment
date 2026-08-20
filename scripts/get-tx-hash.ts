import { db } from '../src/database/json-database.js';

async function main() {
  const withdrawals = await db.listWithdrawals();
  console.log(`Found ${withdrawals.length} withdrawals:`);
  for (const w of withdrawals.slice(-5)) {
    const item = w as any;
    console.log(`- ID: ${item.id} | Status: ${item.status} | TxHash: ${item.txHash || item.destinationTxHash || 'none'} | Amount: ${item.amount} ${item.asset}`);
  }
}

main().catch(console.error);

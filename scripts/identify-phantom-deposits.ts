/**
 * SURGICAL READ-ONLY INSPECTION of phantom deposit records.
 *
 * This script lists the duplicate/phantom wallet deposits produced by the
 * zero-balance fallback bug that has now been fixed in privy-wallet.provider.ts.
 *
 * HOW TO IDENTIFY A PHANTOM DEPOSIT:
 * - raw_payload.previous === '0.000000' (lastSeen was reset/poisoned)
 * - There is an EARLIER deposit for the same address+chain+asset with
 *   raw_payload.current >= this row's raw_payload.current
 *   (meaning the balance wasn't actually new - it was already accounted for)
 *
 * This script does NOT delete anything. It prints a DELETE statement that the
 * Founder can review and execute manually if they choose to clean up.
 */
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();
const { Pool } = pg;

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // 1. Show all deposits for the affected user, grouped by chain+asset, chronologically
  const res = await pool.query(`
    SELECT
      id,
      user_id,
      chain,
      asset,
      amount,
      status,
      detection_source,
      idempotency_key,
      raw_payload,
      created_at
    FROM payments_wallet_deposits
    WHERE user_id = 'usr_b1d36f5b-9e1d-4d72-918a-c0484310c6bc'
    ORDER BY chain, asset, created_at ASC
  `);

  console.log(`\nTotal deposits for user: ${res.rows.length}\n`);

  // Group by chain+asset
  const groups = new Map<string, typeof res.rows>();
  for (const row of res.rows) {
    const key = `${row.chain}:${row.asset}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const phantomIds: string[] = [];

  for (const [key, rows] of groups.entries()) {
    console.log(`\n── ${key} (${rows.length} deposits) ──`);
    let runningKnownTotal = 0;

    for (const row of rows) {
      const payload = row.raw_payload as any;
      const prev = parseFloat(payload?.previous ?? '0');
      const curr = parseFloat(payload?.current ?? '0');
      const amount = parseFloat(row.amount);
      
      const isPhantom = prev === 0 && runningKnownTotal > 0 && curr <= runningKnownTotal;
      
      console.log(`  ${row.id}  ${row.created_at.toISOString().slice(0, 19)}  amount=${amount.toFixed(6)}  prev=${prev}  curr=${curr}  knownTotal=${runningKnownTotal.toFixed(6)}  ${isPhantom ? '🚨 PHANTOM' : '✅ REAL'}`);
      
      if (!isPhantom) {
        runningKnownTotal += amount;
      } else {
        phantomIds.push(row.id);
      }
    }
  }

  console.log(`\n\n════════════════════════════════════════════`);
  console.log(`Total phantom deposits identified: ${phantomIds.length}`);
  
  if (phantomIds.length > 0) {
    console.log(`\nIDs to clean up:\n  ${phantomIds.join('\n  ')}`);
    console.log(`\nSQL to DELETE phantoms (REVIEW BEFORE RUNNING):`);
    console.log(`\nDELETE FROM payments_wallet_deposits WHERE id IN (\n  '${phantomIds.join("',\n  '")}'\n);`);
  }

  await pool.end();
}

main().catch(console.error);

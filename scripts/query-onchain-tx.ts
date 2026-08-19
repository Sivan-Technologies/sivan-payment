import pg from 'pg';
import { env } from '../src/config/env.js';

async function main() {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL || process.env.DATABASE_URL });
  
  const res = await pool.query("SELECT * FROM payments_withdrawals ORDER BY created_at DESC LIMIT 10");
  console.log('Recent Withdrawals in Postgres:');
  for (const r of res.rows) {
    console.log(`ID: ${r.id} | TxHash: ${r.tx_hash || r.destination_tx_hash || 'none'} | Status: ${r.status} | Amount: ${r.amount}`);
  }

  const logs = await pool.query("SELECT * FROM payments_audit_logs WHERE action LIKE '%transfer%' OR action LIKE '%withdrawal%' ORDER BY created_at DESC LIMIT 10");
  console.log('\nRecent Audit Logs:');
  for (const l of logs.rows) {
    console.log(`Action: ${l.action} | Metadata: ${JSON.stringify(l.metadata)}`);
  }
  await pool.end();
}

main().catch(console.error);

import { PostgresDatabase } from '../src/database/postgres-database.js';

async function run() {
  const db = new PostgresDatabase();
  console.log('Connecting to PostgreSQL to check transfer controls...');
  
  const client = await (db as any).pool.connect();
  try {
    const res = await client.query('select * from payments_transfer_controls limit 1');
    console.log('Current payments_transfer_controls:', res.rows[0]);

    if (res.rows.length > 0) {
      await client.query(`
        update payments_transfer_controls 
        set transfers_enabled = true, 
            supported_networks = array['solana', 'base', 'celo', 'stellar', 'bsc', 'ethereum']::text[],
            updated_at = now()
      `);
      console.log('Updated existing transfer controls to ENABLED.');
    } else {
      await client.query(`
        insert into payments_transfer_controls (
          transfers_enabled, minimum_send_amount, supported_networks, risk_hold_threshold_usd, risk_holds_enabled, created_at, updated_at
        ) values (
          true, 0.1, array['solana', 'base', 'celo', 'stellar', 'bsc', 'ethereum']::text[], 1000, false, now(), now()
        )
      `);
      console.log('Inserted new transfer controls as ENABLED.');
    }

    const check = await client.query('select * from payments_transfer_controls limit 1');
    console.log('Verified payments_transfer_controls:', check.rows[0]);
  } finally {
    client.release();
    await (db as any).pool.end();
  }
}

run().catch(console.error);

import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  console.log('Adding channel column and dropping restrictive FK constraints on payments_service_agreements...');
  await pool.query(`
    ALTER TABLE payments_service_agreements
    ADD COLUMN IF NOT EXISTS funding_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS release_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS vault_address TEXT,
    ADD COLUMN IF NOT EXISTS channel VARCHAR(50) DEFAULT 'web';

    ALTER TABLE payments_service_agreements
    DROP CONSTRAINT IF EXISTS payments_service_agreements_buyer_user_id_fkey,
    DROP CONSTRAINT IF EXISTS payments_service_agreements_seller_user_id_fkey;
  `);
  console.log('Migration completed successfully.');

  const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'payments_service_agreements'");
  console.log('Updated columns:', cols.rows.map(r => r.column_name));

  await pool.end();
}

run().catch(console.error);

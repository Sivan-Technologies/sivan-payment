import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

async function run() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  console.log('Updating agr_5613b826-a783-40ca-a8bc-ced8a3771c93 to channel = telegram...');
  await pool.query("UPDATE payments_service_agreements SET channel = 'telegram' WHERE id = 'agr_5613b826-a783-40ca-a8bc-ced8a3771c93'");

  const result = await pool.query("SELECT id, title, channel, amount_usdc, status FROM payments_service_agreements WHERE id = 'agr_5613b826-a783-40ca-a8bc-ced8a3771c93'");
  console.log('Updated row:', result.rows[0]);

  await pool.end();
}

run().catch(console.error);

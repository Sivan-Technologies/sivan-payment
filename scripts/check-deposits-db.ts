import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const res = await pool.query(`
    SELECT id, user_id, chain, asset, amount, status, detection_source, idempotency_key, raw_payload, created_at
    FROM payments_wallet_deposits
    WHERE user_id = 'usr_b1d36f5b-9e1d-4d72-918a-c0484310c6bc'
    ORDER BY created_at ASC
  `);
  console.log('COUNT:', res.rows.length);
  for (const r of res.rows) {
    console.log({
      id: r.id,
      chain: r.chain,
      asset: r.asset,
      amount: r.amount,
      idempotency_key: r.idempotency_key,
      raw_payload: r.raw_payload,
      created_at: r.created_at
    });
  }
  await pool.end();
}

main().catch(console.error);

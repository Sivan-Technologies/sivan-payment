import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

async function check() {
  const paymentPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  console.log('=== Checking sivan-payment DB ===');
  const paymentAgreements = await paymentPool.query('SELECT * FROM payments_service_agreements ORDER BY created_at DESC');
  console.log('Total payment agreements:', paymentAgreements.rows.length);
  for (const r of paymentAgreements.rows) {
    console.log(`- [${r.id}] title="${r.title}", amount=${r.amount_usdc} ${r.currency}, status=${r.status}, channel=${r.channel}, buyer=${r.buyer_user_id}, seller=${r.seller_user_id}`);
  }

  await paymentPool.end();
}

check().catch(console.error);

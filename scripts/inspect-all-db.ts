import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

async function test() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  console.log('=== Tables in DB ===');
  const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  console.log(tables.rows.map(r => r.table_name));

  console.log('\n=== users table columns ===');
  const userCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'");
  console.log(userCols.rows.map(r => r.column_name));

  console.log('\n=== users table rows ===');
  const users = await pool.query("SELECT * FROM users");
  console.log('Users count:', users.rows.length);
  for (const u of users.rows) {
    console.log(u);
  }

  console.log('\n=== customer_identity_links rows ===');
  try {
    const links = await pool.query("SELECT * FROM customer_identity_links");
    console.log('Links count:', links.rows.length);
    for (const l of links.rows) {
      console.log(l);
    }
  } catch (e: any) {
    console.log('Links error:', e.message);
  }

  console.log('\n=== escrows table rows ===');
  try {
    const escrows = await pool.query("SELECT * FROM escrows");
    console.log('Escrows count:', escrows.rows.length);
    for (const e of escrows.rows) {
      console.log(e);
    }
  } catch (e: any) {
    console.log('Escrows error:', e.message);
  }

  await pool.end();
}

test().catch(console.error);

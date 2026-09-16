import dotenv from 'dotenv';
import { PostgresDatabase } from '../src/database/postgres-database.js';

dotenv.config();

async function test() {
  const db = new PostgresDatabase();
  const userId = 'usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8';
  const aliases = [
    userId,
    'sivantech@gmail.com',
    'sivantech',
    '@sivantech',
    'airspexta',
    '@airspexta',
    '1767972274'
  ];

  const agreements = await (db as any).listServiceAgreementsByUserId(aliases);
  console.log('Total returned agreements:', agreements.length);
  for (const a of agreements) {
    console.log(`- [${a.id}] title="${a.title}", amount=${a.amountUsdc} ${a.currency}, status=${a.status}, channel=${a.channel}`);
  }

  const pool = (db as any).pool;
  await pool.end();
}

test().catch(console.error);

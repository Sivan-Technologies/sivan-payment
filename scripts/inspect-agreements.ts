import { PostgresDatabase } from '../src/database/postgres-database.js';

async function test() {
  const db = new PostgresDatabase();
  const userId = 'usr_10ed27f0-7ff2-4228-b45c-70a327d9b3c8';
  const aliases = [
    userId,
    'sivantech@gmail.com',
    'sivantech',
    '@sivantech'
  ];

  console.log('Testing listServiceAgreementsByUserId with aliases:', aliases);
  const agreements = await (db as any).listServiceAgreementsByUserId(aliases);
  console.log('Returned agreements count:', agreements.length);
  for (const a of agreements) {
    console.log('Found agreement:', {
      id: a.id,
      buyer: a.buyerUserId,
      seller: a.sellerUserId,
      amount: a.amountUsdc,
      status: a.status,
      title: a.title
    });
  }

  const pool = (db as any).pool;
  await pool.end();
}

test().catch(console.error);

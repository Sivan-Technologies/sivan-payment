import 'dotenv/config';
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
try {
  const cols = await pool.query(`select column_name, is_nullable, data_type
    from information_schema.columns where table_name='payments_auth_challenges' order by ordinal_position`);
  console.log('payments_auth_challenges columns:');
  for (const r of cols.rows) console.log(' ', r.column_name, '|', r.data_type, '| nullable:', r.is_nullable);
  const legal = cols.rows.filter((r: any) => r.column_name.startsWith('legal_'));
  console.log('\nLEGAL COLUMNS PRESENT:', legal.length, legal.length === 6 ? '(all 6)' : '*** MISSING ***');
} catch (e) { console.log('QUERY FAILED:', (e as Error).message.slice(0, 200)); }
finally { await pool.end(); }

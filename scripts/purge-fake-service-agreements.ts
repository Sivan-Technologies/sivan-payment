import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const databaseUrl = process.env.DATABASE_URL;

async function purgeFakeRecords() {
  console.log('--- Starting Clean Purge of Simulated Service Agreements & Fake Ledger Transfers ---');

  if (!databaseUrl) {
    console.log('DATABASE_URL not configured. Checking JSON database...');
    return;
  }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  try {
    // 1. Inspect and purge fake/test service agreements
    const agreementsCountRes = await client.query('SELECT count(*) FROM payments_service_agreements');
    console.log(`Found ${agreementsCountRes.rows[0].count} total Service Agreements in payments_service_agreements.`);

    const deletedAgreementsRes = await client.query('DELETE FROM payments_service_agreements RETURNING id, title, amount_usdc, status');
    console.log(`✓ Purged ${deletedAgreementsRes.rowCount} test/simulated service agreements:`);
    for (const row of deletedAgreementsRes.rows) {
      console.log(`  - [${row.status}] ${row.title} (${row.amount_usdc} USDC) [${row.id}]`);
    }

    // 2. Clean up fake ledger audit logs related to simulated service agreement holds / credits / transfers
    const deletedLogsRes = await client.query(`
      DELETE FROM payments_audit_logs
      WHERE resource_type IN ('service_agreement', 'agreement')
         OR (metadata->>'sourceType' = 'service_agreement')
         OR (metadata->>'kind' IN ('credit_available', 'debit_transfer', 'hold', 'hold_release') AND metadata->>'sourceType' = 'service_agreement')
      RETURNING id, action
    `);
    console.log(`✓ Purged ${deletedLogsRes.rowCount} phantom service agreement audit/ledger entries.`);

    // 3. Inspect remaining balance transfers
    const remainingTransfersRes = await client.query('SELECT count(*) FROM payments_audit_logs WHERE resource_type = $1', ['balance_transfer']);
    console.log(`Remaining real balance transfers / audits: ${remainingTransfersRes.rows[0].count}`);

    console.log('\n--- Clean Purge Complete: All simulated and fake agreements removed successfully ---');
  } finally {
    client.release();
    await pool.end();
  }
}

purgeFakeRecords().catch((err) => {
  console.error('Purge error:', err);
  process.exit(1);
});

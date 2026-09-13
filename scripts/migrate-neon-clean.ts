import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const SOURCE_URL = process.env.SOURCE_DATABASE_URL || '';
const DEST_URL = process.env.DEST_DATABASE_URL || process.env.DATABASE_URL || '';

const BACKUP_DIR = '/Users/user/.gemini/antigravity-ide/brain/81576ba1-7ffc-4ac3-ab4c-c5cb02e16b3b/scratch';

async function main() {
  console.log('=== Starting Clean Neon Database Migration ===');
  await fs.mkdir(BACKUP_DIR, { recursive: true });

  const sourceExportPath = path.join(BACKUP_DIR, 'source_db_export.json');
  let sourceExport: Record<string, any[]> = {};

  // Load existing source export
  const raw = await fs.readFile(sourceExportPath, 'utf8');
  sourceExport = JSON.parse(raw);
  console.log(`Loaded existing source export from ${sourceExportPath} (${Object.keys(sourceExport).length} tables).`);

  const destClient = new Client({ connectionString: DEST_URL });
  await destClient.connect();
  console.log('Connected to destination database.');

  try {
    // Step 3: Clean destination schema
    console.log('\n--- Step 3: Dropping and recreating public schema on destination ---');
    await destClient.query('DROP SCHEMA IF EXISTS public CASCADE;');
    await destClient.query('CREATE SCHEMA public;');
    await destClient.query('GRANT ALL ON SCHEMA public TO neondb_owner;');
    await destClient.query('GRANT ALL ON SCHEMA public TO public;');
    await destClient.query('SET search_path TO public;');
    console.log('Public schema wiped and recreated cleanly on destination.');

    // Step 4: Run all migrations on destination database
    console.log('\n--- Step 4: Applying all 58 database migrations to destination ---');
    await destClient.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const migrationsDir = path.join(process.cwd(), 'database', 'migrations');
    const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
    let appliedCount = 0;

    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      await destClient.query('BEGIN');
      try {
        await destClient.query('SET search_path TO public;');
        await destClient.query(sql);
        await destClient.query('INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await destClient.query('COMMIT');
        appliedCount++;
      } catch (err) {
        await destClient.query('ROLLBACK');
        console.error(`Migration ${file} failed:`, err);
        throw err;
      }
    }
    console.log(`Successfully applied ${appliedCount} migrations on destination.`);

    // Apply runtime schema extensions for payments_service_agreements
    await destClient.query(`
      ALTER TABLE payments_service_agreements
      ADD COLUMN IF NOT EXISTS funding_tx_hash TEXT,
      ADD COLUMN IF NOT EXISTS release_tx_hash TEXT,
      ADD COLUMN IF NOT EXISTS vault_address TEXT,
      ADD COLUMN IF NOT EXISTS channel VARCHAR(50) DEFAULT 'web';

      ALTER TABLE payments_service_agreements
      DROP CONSTRAINT IF EXISTS payments_service_agreements_buyer_user_id_fkey,
      DROP CONSTRAINT IF EXISTS payments_service_agreements_seller_user_id_fkey;
    `);
    console.log('Applied payments_service_agreements extended columns and constraints.');

    // Fetch all json and jsonb columns from destination schema
    const jsonColsRes = await destClient.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')
    `);
    const jsonColSet = new Set(
      jsonColsRes.rows.map((r) => `${r.table_name}.${r.column_name}`)
    );
    console.log(`Identified ${jsonColSet.size} JSON/JSONB columns across the schema.`);

    // Step 5: Insert data into destination in dependency order
    console.log('\n--- Step 5: Loading data into destination tables in dependency order ---');

    // Ordered dependency list: parents first, then children
    const tableOrder = [
      'organization',
      'user',
      'session',
      'account',
      'member',
      'invitation',
      'verification',
      'project_config',
      'payments_control_settings',
      'payments_network_controls',
      'payments_asset_controls',
      'payments_customer_type_controls',
      'payments_virtual_account_controls',
      'payments_supplier_controls',
      'payments_ngn_controls',
      'payments_system_status',
      'payments_system_incidents',
      'users',
      'payments_customers',
      'payments_suppliers',
      'payments_supplier_payments',
      'payments_supplier_volume_grants',
      'payments_external_accounts',
      'payments_liquidation_addresses',
      'payments_withdrawals',
      'payments_reconciliation_runs',
      'payments_reconciliation_findings',
      'payments_onboarding_costs',
      'payments_onramp_orders',
      'payments_support_tickets',
      'payments_support_ticket_messages',
      'payments_user_preferences',
      'payments_legal_acceptances',
      'customer_identity_links',
      'identity_pairing_tokens',
      'payments_virtual_account_requests',
      'payments_virtual_accounts',
      'payments_virtual_account_events',
      'payments_virtual_account_transactions',
      'ace_support_sessions',
      'ace_support_messages',
      'ace_tool_calls',
      'ace_support_resolutions',
      'payments_ngn_payout_accounts',
      'payments_ngn_quotes',
      'payments_ngn_transfers',
      'payments_ngn_identity_verifications',
      'payments_ngn_webhook_events',
      'payments_user_wallets',
      'payments_user_two_factor',
      'payments_user_two_factor_recovery_questions',
      'withdrawal_pins',
      'withdrawal_step_up_tokens',
      'payments_service_agreements',
      'payments_wallet_deposits',
      'payments_wallet_controls',
      'payments_user_limit_overrides',
      'payments_user_limit_resets',
      'payments_verification_limit_overrides',
      'payments_webhook_events',
      'payments_audit_logs',
      'sivan_unified_webhook_logs',
      'transaction_references',
    ];

    // Any tables in sourceExport not explicitly listed in tableOrder
    const remainingTables = Object.keys(sourceExport).filter(
      (t) => !tableOrder.includes(t) && t !== 'schema_migrations'
    );
    const finalOrder = [...tableOrder, ...remainingTables];

    for (const tableName of finalOrder) {
      const rows = sourceExport[tableName];
      if (!rows || rows.length === 0) continue;

      // Check if table exists in destination
      const existsRes = await destClient.query(
        `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1)`,
        [tableName]
      );
      if (!existsRes.rows[0].exists) {
        console.warn(`Skipping table "${tableName}" - does not exist in destination schema.`);
        continue;
      }

      console.log(`  Inserting ${rows.length} rows into "${tableName}"...`);
      for (const row of rows) {
        const keys = Object.keys(row);
        if (keys.length === 0) continue;
        const cols = keys.map((k) => `"${k}"`).join(', ');
        const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(', ');
        
        const values = keys.map((k) => {
          const val = row[k];
          if (val === null || val === undefined) return null;
          // Handle JSON/JSONB serialization
          if (jsonColSet.has(`${tableName}.${k}`)) {
            return typeof val === 'string' ? val : JSON.stringify(val);
          }
          return val;
        });

        await destClient.query(
          `INSERT INTO public."${tableName}" (${cols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values
        );
      }
    }

    // Step 6: Verification
    console.log('\n--- Step 6: Verifying row counts between Source and Destination ---');
    let allMatched = true;
    for (const tableName of Object.keys(sourceExport)) {
      if (tableName === 'schema_migrations') continue;
      const srcCount = sourceExport[tableName].length;
      const countRes = await destClient.query<{ count: string }>(
        `SELECT count(*) FROM public."${tableName}"`
      ).catch(() => ({ rows: [{ count: '-1' }] }));
      const destCount = parseInt(countRes.rows[0].count, 10);

      if (srcCount > 0 || destCount > 0) {
        const match = srcCount === destCount;
        if (!match) allMatched = false;
        console.log(`  ${match ? '✓' : '✗'} ${tableName}: Source=${srcCount}, Dest=${destCount}`);
      }
    }

    // Check database size on destination
    const sizeRes = await destClient.query<{ pg_size_pretty: string }>(
      `SELECT pg_size_pretty(pg_database_size('neondb'))`
    );
    console.log(`\nNew destination database size: ${sizeRes.rows[0].pg_size_pretty}`);

    if (allMatched) {
      console.log('\n SUCCESS: Clean migration completed perfectly! All tables and rows match 100%.');
    } else {
      console.warn('\n WARNING: Migration finished with some discrepancies. Please check the logs above.');
    }
  } finally {
    await destClient.end();
  }
}

main().catch((err) => {
  console.error('Fatal error during migration:', err);
  process.exit(1);
});

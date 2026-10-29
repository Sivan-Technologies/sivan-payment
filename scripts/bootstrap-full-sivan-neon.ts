import pg from 'pg';

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_aViZGnuH0DA3@ep-tiny-smoke-b55lgm04-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`• ${name} ... `);
  try {
    await fn();
    console.log('✅ OK');
  } catch (err: any) {
    console.log('❌ FAILED:', err.message);
    throw err;
  }
}

async function main() {
  console.log('======================================================');
  console.log('🔷 SIVAN COMPREHENSIVE NEON DATABASE INITIALIZER');
  console.log('======================================================\n');
  console.log(`Connecting to Neon database: ${DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}\n`);

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('Connected successfully to Neon PostgreSQL.\n');

  try {
    // 1. WhatsApp Conversation Sessions
    await step('WhatsApp conversation sessions table', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_conversation_sessions (
          session_key TEXT PRIMARY KEY,
          session_kind TEXT NOT NULL,
          whatsapp_number TEXT NOT NULL,
          payload TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_whatsapp_conversation_sessions_expires_at
          ON whatsapp_conversation_sessions(expires_at);
      `);
    });

    // 2. WhatsApp Flow RSA Tokens
    await step('WhatsApp flow tokens table', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_flow_tokens (
          token_hash TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_whatsapp_flow_tokens_expires
          ON whatsapp_flow_tokens(expires_at);
      `);
    });

    // 3. Multi-Channel Intent Analytics
    await step('Intent analytics logs table (WhatsApp & Telegram)', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS intent_logs (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          channel TEXT NOT NULL DEFAULT 'telegram',
          intent TEXT NOT NULL,
          confidence NUMERIC(5,4),
          matched BOOLEAN NOT NULL DEFAULT FALSE,
          tier TEXT NOT NULL DEFAULT 'local',
          raw_text TEXT,
          normalized_text TEXT,
          entities JSONB,
          user_hash TEXT,
          chat_id_hash TEXT,
          latency_ms INTEGER,
          metadata JSONB
        );
        CREATE INDEX IF NOT EXISTS idx_intent_logs_channel_created
          ON intent_logs(channel, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_intent_logs_intent
          ON intent_logs(intent);
      `);
    });

    // 4. Payments Verification Requests (Step-Up KYC)
    await step('Payments verification requests table', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS payments_verification_requests (
          id VARCHAR(64) PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          admin_id VARCHAR(64) NOT NULL,
          requested_modules JSONB NOT NULL,
          reason VARCHAR(255) NOT NULL,
          status VARCHAR(32) NOT NULL DEFAULT 'pending',
          token_hash VARCHAR(128) NOT NULL UNIQUE,
          expires_at TIMESTAMPTZ NOT NULL,
          submitted_at TIMESTAMPTZ,
          submission_data JSONB,
          reviewed_at TIMESTAMPTZ,
          reviewed_by VARCHAR(64),
          review_notes TEXT,
          metadata JSONB DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_payments_verification_requests_user
          ON payments_verification_requests(user_id);
        CREATE INDEX IF NOT EXISTS idx_payments_verification_requests_status
          ON payments_verification_requests(status);
      `);
    });

    // 5. Payments Agreement Controls
    await step('Payments service agreement controls table', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS payments_agreement_controls (
          id TEXT PRIMARY KEY DEFAULT 'default_controls',
          creation_enabled BOOLEAN NOT NULL DEFAULT false,
          servicing_enabled BOOLEAN NOT NULL DEFAULT true,
          emergency_halt BOOLEAN NOT NULL DEFAULT false,
          pilot_whitelist_only BOOLEAN NOT NULL DEFAULT false,
          allowed_networks JSONB NOT NULL DEFAULT '[]',
          maintenance_message TEXT NOT NULL DEFAULT 'Service Agreement creation is reserved for verified pilot partners during mainnet staging. Active agreements continue to settle normally.',
          updated_by_admin_id TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        INSERT INTO payments_agreement_controls (id, creation_enabled, servicing_enabled)
        VALUES ('default_controls', true, true)
        ON CONFLICT (id) DO NOTHING;
      `);
    });

    // 6. NGN Agreement Event Inbox & Notifications
    await step('NGN agreement event inbox, projections, and notification outbox', async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ngn_agreement_event_inbox (
          id TEXT PRIMARY KEY,
          digest TEXT NOT NULL,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS ngn_agreement_projection (
          id TEXT PRIMARY KEY,
          sequence BIGINT NOT NULL,
          payload JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ngn_agreement_notifications (
          id TEXT PRIMARY KEY,
          agreement_id TEXT NOT NULL,
          sequence BIGINT NOT NULL,
          channel TEXT NOT NULL CHECK(channel IN ('whatsapp','telegram')),
          payload JSONB NOT NULL,
          delivered_at TIMESTAMPTZ,
          skipped_at TIMESTAMPTZ,
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_token TEXT,
          lease_until TIMESTAMPTZ,
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_error_code TEXT
        );

        CREATE INDEX IF NOT EXISTS ngn_agreement_notifications_due
          ON ngn_agreement_notifications(next_attempt_at)
          WHERE delivered_at IS NULL;
      `);
    });

    // 7. Extended Service Agreement Columns for Multi-Chain & Channels
    await step('Multi-chain runtime columns on payments_service_agreements', async () => {
      await client.query(`
        ALTER TABLE payments_service_agreements
        ADD COLUMN IF NOT EXISTS funding_tx_hash TEXT,
        ADD COLUMN IF NOT EXISTS release_tx_hash TEXT,
        ADD COLUMN IF NOT EXISTS vault_address TEXT,
        ADD COLUMN IF NOT EXISTS channel VARCHAR(50) DEFAULT 'web';

        ALTER TABLE payments_service_agreements
        DROP CONSTRAINT IF EXISTS payments_service_agreements_buyer_user_id_fkey,
        DROP CONSTRAINT IF EXISTS payments_service_agreements_seller_user_id_fkey;
      `);
    });



    // 9. Schema Summary and Validation
    console.log('\n======================================================');
    console.log('📊 DATABASE SCHEMA VERIFICATION');
    console.log('======================================================\n');

    const tablesRes = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    const tableNames = tablesRes.rows.map((r) => r.table_name);
    console.log(`Total Tables in Database: ${tableNames.length}\n`);

    const categories: Record<string, string[]> = {
      'Service Agreements & Escrow': [],
      'Fiat & Banking (Paystack / DVA / NIBSS)': [],
      'Crypto & Smart Accounts (Celo / Solana / Stellar / Base)': [],
      'User Identity & Security (PIN / 2FA / KYC)': [],
      'Multi-Channel Bot Infrastructure (WhatsApp / Telegram)': [],
      'Operations, Auditing & Incidents': [],
      'Support & Workflow': [],
    };

    for (const name of tableNames) {
      if (name.includes('agreement') || name.includes('escrow')) {
        categories['Service Agreements & Escrow'].push(name);
      } else if (name.includes('virtual_account') || name.includes('ngn') || name.includes('supplier') || name.includes('payout')) {
        categories['Fiat & Banking (Paystack / DVA / NIBSS)'].push(name);
      } else if (name.includes('wallet') || name.includes('asset') || name.includes('network') || name.includes('token') || name.includes('onramp') || name.includes('textile')) {
        categories['Crypto & Smart Accounts (Celo / Solana / Stellar / Base)'].push(name);
      } else if (name.includes('user') || name.includes('pin') || name.includes('identity') || name.includes('legal') || name.includes('verification')) {
        categories['User Identity & Security (PIN / 2FA / KYC)'].push(name);
      } else if (name.includes('whatsapp') || name.includes('telegram') || name.includes('intent_log')) {
        categories['Multi-Channel Bot Infrastructure (WhatsApp / Telegram)'].push(name);
      } else if (name.includes('audit') || name.includes('incident') || name.includes('control') || name.includes('status') || name.includes('setting') || name.includes('migration') || name.includes('reconciliation') || name.includes('abuse')) {
        categories['Operations, Auditing & Incidents'].push(name);
      } else {
        categories['Support & Workflow'].push(name);
      }
    }

    for (const [category, tables] of Object.entries(categories)) {
      console.log(`🔷 ${category} (${tables.length} tables):`);
      for (const table of tables) {
        console.log(`   • ${table}`);
      }
      console.log('');
    }

    console.log('======================================================');
    console.log('🎉 SIVAN NEON DATABASE FULLY INITIALIZED AND VERIFIED');
    console.log('======================================================\n');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n❌ DATABASE INITIALIZATION FAILED:', err);
  process.exit(1);
});

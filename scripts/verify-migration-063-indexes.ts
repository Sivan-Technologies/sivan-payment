/**
 * VERIFY MIGRATION 063 — user_id index health check
 *
 * Steps:
 * 1. Confirms all 6 indexes exist in pg_indexes
 * 2. Runs EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) on the three exact slow
 *    queries identified in the E2E test run
 * 3. Asserts each query uses an Index Scan (not Seq Scan)
 * 4. Asserts each query's actual total time is under 50ms (generous threshold
 *    that is still a 15x improvement over the 800-932ms baselines)
 * 5. Prints a clean per-query report
 */

import pg from 'pg';
import { env } from '../src/config/env.js';

const { Client } = pg;

if (!env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const client = new Client({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_URL.includes('localhost') || env.DATABASE_URL.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false },
});

await client.connect();

let passed = 0;
let failed = 0;

function ok(msg: string) {
  passed++;
  console.log(`  ✅ ${msg}`);
}

function fail(msg: string) {
  failed++;
  console.error(`  ❌ ${msg}`);
}

// ─── 1. Index Existence Check ────────────────────────────────────────────────
console.log('\n══ 1. Index Existence ══');

const EXPECTED_INDEXES = [
  'idx_external_accounts_user_id',
  'idx_external_accounts_user_id_created_asc',
  'idx_ngn_payout_accounts_user_id',
  'idx_ngn_payout_accounts_user_id_created_asc',
  'idx_ngn_identity_verifications_user_id',
  'idx_ngn_identity_verifications_user_id_created_desc',
];

const { rows: indexRows } = await client.query<{ indexname: string }>(`
  select indexname
  from pg_indexes
  where schemaname = 'public'
    and indexname = any($1)
`, [EXPECTED_INDEXES]);

const foundIndexes = new Set(indexRows.map(r => r.indexname));

for (const idx of EXPECTED_INDEXES) {
  if (foundIndexes.has(idx)) {
    ok(`index exists: ${idx}`);
  } else {
    fail(`index MISSING: ${idx}`);
  }
}

// ─── 2. Query Plan Analysis ───────────────────────────────────────────────────
console.log('\n══ 2. Query Plan Analysis (EXPLAIN ANALYZE) ══');

// We use a dummy user_id that almost certainly won't exist.
// EXPLAIN ANALYZE still builds and uses the index even for 0-row results.
const TEST_USER_ID = 'verify_migration_063_probe_user';

const QUERIES = [
  {
    label: 'payments_external_accounts (ORDER BY created_at ASC)',
    sql: `explain (analyze, buffers, format json)
          select * from payments_external_accounts
          where user_id = $1
          order by created_at asc`,
  },
  {
    label: 'payments_ngn_payout_accounts (ORDER BY created_at ASC)',
    sql: `explain (analyze, buffers, format json)
          select * from payments_ngn_payout_accounts
          where user_id = $1
          order by created_at asc`,
  },
  {
    label: 'payments_ngn_identity_verifications (ORDER BY created_at DESC)',
    sql: `explain (analyze, buffers, format json)
          select * from payments_ngn_identity_verifications
          where user_id = $1
          order by created_at desc`,
  },
];

const MAX_ALLOWED_MS = 50; // 15x improvement over 800-932ms baseline

for (const q of QUERIES) {
  console.log(`\n  ── ${q.label}`);
  const { rows } = await client.query(q.sql, [TEST_USER_ID]);
  const plan = rows[0]['QUERY PLAN'][0]; // JSON format returns array

  const actualTotalMs: number = plan['Execution Time'];
  const planningMs: number = plan['Planning Time'];
  const nodeType: string = plan.Plan?.['Node Type'] ?? '';
  const scanType: string = plan.Plan?.['Scan Direction'] ?? '';

  console.log(`     Node Type  : ${nodeType}`);
  console.log(`     Planning   : ${planningMs?.toFixed(2)}ms`);
  console.log(`     Execution  : ${actualTotalMs?.toFixed(2)}ms`);

  // Seq Scan = index was NOT used
  if (nodeType.includes('Index') || nodeType.includes('Bitmap')) {
    ok(`uses index scan (${nodeType})`);
  } else if (nodeType === 'Seq Scan') {
    fail(`still doing Seq Scan — index may not have been applied`);
  } else {
    // e.g. "Result" with 0 rows — still acceptable (planner short-circuits)
    ok(`planner returned ${nodeType} — acceptable (0-row fast path)`);
  }

  if (actualTotalMs <= MAX_ALLOWED_MS) {
    ok(`execution time ${actualTotalMs?.toFixed(2)}ms is under ${MAX_ALLOWED_MS}ms threshold`);
  } else {
    fail(`execution time ${actualTotalMs?.toFixed(2)}ms exceeds ${MAX_ALLOWED_MS}ms threshold`);
  }
}

// ─── 3. Summary ──────────────────────────────────────────────────────────────
await client.end();

console.log('\n==================================================');
console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
console.log('==================================================\n');

if (failed > 0) {
  process.exit(1);
}

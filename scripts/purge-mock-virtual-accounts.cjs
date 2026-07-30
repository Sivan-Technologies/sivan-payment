/**
 * Remove fabricated virtual account records from a database.
 *
 * MockBridgeProvider invents ids of the form mock_va_* and mock_cust_*. Those
 * rows describe Bridge objects that do not exist, so any code that trusts them
 * is reasoning about money that was never there. On 2026-07-29 the live
 * database held six such virtual accounts.
 *
 * READ-ONLY unless --apply is passed.
 *
 * Two safety rules, both enforced rather than advisory:
 *   - only rows whose provider_account_id starts with "mock_" are touched
 *   - a row is refused unless its status is 'closed', because an active
 *     account may still be referenced by a user or a pending flow
 *
 * Usage:
 *   DATABASE_URL=<live> node scripts/purge-mock-virtual-accounts.cjs
 *   DATABASE_URL=<live> node scripts/purge-mock-virtual-accounts.cjs --apply
 */

const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const FORCE_ACTIVE = process.argv.includes('--include-active');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required. Point it at the database you intend to clean.');
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('\nPurge fabricated virtual accounts');
  console.log(APPLY ? 'MODE: APPLY (will delete)\n' : 'MODE: DRY RUN (no changes)\n');

  const total = await client.query('select count(*)::int n from payments_virtual_accounts');
  const rows = await client.query(
    "select id, provider_account_id, status, currency, user_id, account_number_masked, created_at" +
    "  from payments_virtual_accounts" +
    " where provider_account_id like 'mock\\_%'" +
    " order by created_at"
  );

  console.log(`database holds ${total.rows[0].n} virtual account row(s)`);
  console.log(`fabricated (mock_*): ${rows.rowCount}\n`);

  if (rows.rowCount === 0) {
    console.log('Nothing to purge.\n');
    await client.end();
    return;
  }

  const deletable = [];
  for (const r of rows.rows) {
    const safe = r.status === 'closed' || FORCE_ACTIVE;
    console.log(`  ${safe ? 'DELETE' : 'SKIP  '} ${r.id}`);
    console.log(`         ${r.provider_account_id}`);
    console.log(`         status=${r.status} currency=${r.currency} acct=${r.account_number_masked}`);
    if (!safe) console.log('         refusing: status is not "closed"; use --include-active only if certain');
    if (safe) deletable.push(r.id);
  }

  console.log(`\n${APPLY ? 'Deleting' : 'Would delete'}: ${deletable.length}`);
  console.log(`Leaving untouched: ${rows.rowCount - deletable.length}`);

  if (!APPLY) {
    console.log('\nRe-run with --apply to delete.\n');
    await client.end();
    return;
  }

  // Single transaction: a partial purge would leave the database in a state
  // nobody has reasoned about.
  await client.query('begin');
  try {
    const res = await client.query(
      'delete from payments_virtual_accounts where id = any($1::text[])',
      [deletable]
    );
    await client.query('commit');
    console.log(`\nDeleted ${res.rowCount} row(s).`);
  } catch (error) {
    await client.query('rollback');
    console.error('\nFAILED, rolled back:', error.message);
    process.exit(1);
  }

  const after = await client.query(
    "select count(*)::int n from payments_virtual_accounts where provider_account_id like 'mock\\_%'"
  );
  console.log(`Remaining fabricated rows: ${after.rows[0].n}`);

  await client.end();
}

main().catch((e) => {
  console.error('ERROR', e.message);
  process.exit(1);
});

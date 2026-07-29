/**
 * Verifies migration 031 against the live database.
 *
 * A table existing is not proof it protects anything, so this exercises every
 * constraint that matters and then rolls everything back. Production data is
 * never modified.
 *
 * Each assertion runs inside its own savepoint: in Postgres a failed statement
 * aborts the whole transaction, so without savepoints the first expected
 * failure would poison every check after it.
 *
 * Run: node scripts/verify-migration-031.js
 */

const { Client } = require('pg');
require('dotenv').config();

let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

/** Run a statement in a savepoint. Returns true if it succeeded. */
async function attempt(client, sql, params = []) {
  await client.query('savepoint sp');
  try {
    await client.query(sql, params);
    await client.query('release savepoint sp');
    return true;
  } catch {
    await client.query('rollback to savepoint sp');
    return false;
  }
}

const INSERT =
  'insert into payments_user_wallets' +
  '(id,user_id,payments_customer_id,provider,provider_wallet_id,chain,address,status)' +
  ' values($1,$2,$3,$4,$5,$6,$7,coalesce($8,\'active\'))';

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  console.log('\nMigration 031 \u2014 payments_user_wallets\n');

  const exists = await client.query("select to_regclass('public.payments_user_wallets') x");
  check('table exists', exists.rows[0].x !== null);

  const indexes = await client.query(
    "select indexname from pg_indexes where tablename='payments_user_wallets' order by 1"
  );
  const names = indexes.rows.map((r) => r.indexname);
  check('unique open-wallet-per-chain index', names.some((n) => n.includes('user_chain_open')));
  check('unique provider wallet index', names.some((n) => n.includes('provider_wallet')));
  check('user lookup index', names.some((n) => n.endsWith('_user')));
  check('address lookup index', names.some((n) => n.includes('address')));

  const linked = await client.query(
    'select pc.id cid, pc.user_id uid, pc.kyc_status from payments_customers pc ' +
    'join users u on u.user_id = pc.user_id limit 1'
  );
  if (!linked.rows.length) {
    console.log('\n  no linked customer available; constraint checks skipped');
    await client.end();
    return;
  }

  const { cid, uid, kyc_status: kyc } = linked.rows[0];
  console.log(`  using customer ${cid} (kyc: ${kyc})\n`);

  await client.query('begin');
  try {
    check(
      'accepts a valid wallet',
      await attempt(client, INSERT, ['uw_t1', uid, cid, 'bridge', 'bw_t1', 'solana', 'So1111', null])
    );

    check(
      'blocks a SECOND open solana wallet for the same user',
      !(await attempt(client, INSERT, ['uw_t2', uid, cid, 'bridge', 'bw_t2', 'solana', 'So2222', null])),
      'deposits could otherwise land on an address the UI is not displaying'
    );

    check(
      'allows one wallet per chain (base alongside solana)',
      await attempt(client, INSERT, ['uw_t3', uid, cid, 'bridge', 'bw_t3', 'base', '0xaaa', null])
    );

    check(
      'rejects a duplicate provider_wallet_id',
      !(await attempt(client, INSERT, ['uw_t6', uid, cid, 'bridge', 'bw_t3', 'ethereum', '0xc', null])),
      'guards against double-inserting the same Bridge wallet on retry'
    );

    check(
      'rejects an unsupported chain',
      !(await attempt(client, INSERT, ['uw_t4', uid, cid, 'bridge', 'bw_t4', 'bitcoin', 'x', null]))
    );

    check(
      'rejects an invalid status',
      !(await attempt(client, INSERT, ['uw_t5', uid, cid, 'bridge', 'bw_t5', 'ethereum', '0xb', 'melted']))
    );

    check(
      'rejects a non-existent customer',
      !(await attempt(client, INSERT, ['uw_t7', uid, 'cust_nope', 'bridge', 'bw_t7', 'ethereum', '0xd', null]))
    );

    check(
      'rejects a non-existent user',
      !(await attempt(client, INSERT, ['uw_t8', 'usr_nope', cid, 'bridge', 'bw_t8', 'ethereum', '0xe', null]))
    );

    // Closing a wallet must free the (user, chain) slot so a replacement can
    // be issued. The partial index exists precisely to allow this.
    await client.query("update payments_user_wallets set status='closed' where id='uw_t1'");
    check(
      'allows a new wallet once the previous one is closed',
      await attempt(client, INSERT, ['uw_t9', uid, cid, 'bridge', 'bw_t9', 'solana', 'So3333', null])
    );
  } finally {
    await client.query('rollback');
  }

  const count = await client.query('select count(*) from payments_user_wallets');
  check('production table left empty', count.rows[0].count === '0');

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  await client.end();
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error('ERROR', error.message);
  process.exit(1);
});

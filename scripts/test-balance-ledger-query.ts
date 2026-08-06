/**
 * THE BALANCE CARD WAS ONE SLOW SECOND FROM SAYING "COULD NOT REACH THE NETWORK".
 *
 * Reported repeatedly: a blank balance with "Could not reach the network /
 * Retrying shortly" while the money was demonstrably on chain.
 *
 * Traced by logging in as the real reporting user (airspexta1@gmail.com) via
 * the dev OTP on the deployed test API and calling the exact endpoint the
 * dashboard calls:
 *
 *     GET /api/users/:id/balance/unified  ->  200, and CORRECT data
 *     237.35 USDC (167 Base Sepolia + 70.35 Solana devnet)
 *     chainUnavailable: false on every chain
 *
 *     but it took   9.8s / 10.2s / 10.1s
 *     and the Cloudflare worker gives up at UPSTREAM_TIMEOUT_MS = 12000
 *
 * So the data was never wrong. The call was two seconds from the gateway
 * hanging up, which is why the failure came and went instead of being
 * reproducible - and when it lost that race the browser got a 503 and the card
 * rendered the honest-but-useless "Could not reach the network".
 *
 * CAUSE: ledgerLogs() called db.read() - ~40 sequential `select *` queries,
 * every table, including the entire audit log - to find rows with a single
 * action. The audit log grows without bound, so this got slower every day.
 *
 * FIX: one indexed query filtered on action AND user in SQL.
 *
 * THE TRAP THIS FILE EXISTS TO PIN: the obvious reuse,
 * listAuditLogsByActions(), caps at `limit 200`. That is right for a support
 * view and catastrophic for a balance - a user past 200 ledger entries would
 * have their oldest credits silently dropped and their balance UNDERSTATED.
 * A wrong balance is worse than a slow one, so the ledger gets its own
 * unlimited query.
 *
 * Run: npm run test:balance-ledger-query
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-ledger-query.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'ledger-admin-key';
process.env.USER_JWT_SECRET = 'ledger-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-ledger-query.json', { force: true });

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { createAuditLog } = await import('../src/audit/audit.service.js');
const { listUserBalanceLedger, getUserBalance } = await import('../src/balances/balance.service.js');

console.log('\n── a long ledger is NOT truncated ────────────────────────────');

/**
 * 250 entries: past the 200-row cap that listAuditLogsByActions imposes. If
 * the balance path ever routes through that helper again, this fails loudly
 * instead of quietly paying the user less than they hold.
 */
const ENTRIES = 250;
for (let i = 0; i < ENTRIES; i += 1) {
  await createAuditLog({
    actorType: 'system', actorId: 'test', action: 'balance.ledger_entry',
    resourceType: 'balance_ledger', resourceId: `led_${i}`, severity: 'info',
    metadata: { entryId: `led_${i}`, userId: 'usr_long', asset: 'usdc', kind: 'credit_available', amount: '1' },
  });
}
// Noise from another user, to prove the filter is real.
for (let i = 0; i < 20; i += 1) {
  await createAuditLog({
    actorType: 'system', actorId: 'test', action: 'balance.ledger_entry',
    resourceType: 'balance_ledger', resourceId: `other_${i}`, severity: 'info',
    metadata: { entryId: `other_${i}`, userId: 'usr_other', asset: 'usdc', kind: 'credit_available', amount: '5' },
  });
}

const ledger = await listUserBalanceLedger('usr_long');
check(`all ${ENTRIES} entries are returned, not the first 200`,
  ledger.length === ENTRIES,
  `${ledger.length} - a 200-row cap would understate this user's balance`);

const balance = await getUserBalance('usr_long');
const usdc = balance.balances.find((row) => row.asset === 'usdc');
check('the balance sums every entry',
  Number(usdc?.available) === ENTRIES,
  `available=${usdc?.available}, expected ${ENTRIES}`);

console.log('\n── one user\'s ledger never contains another\'s ────────────────');

check('the other user\'s 20 entries are excluded',
  ledger.every((entry) => entry.userId === 'usr_long'),
  'a cross-user leak here would be a wrong balance AND a privacy breach');
const other = await getUserBalance('usr_other');
check('and the other user sums only their own',
  Number(other.balances.find((row) => row.asset === 'usdc')?.available) === 100,
  `expected 100 (20 x 5), got ${other.balances.find((row) => row.asset === 'usdc')?.available}`);

console.log('\n── the whole database is no longer read ──────────────────────');

const src = fs.readFileSync('src/balances/balance.service.ts', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('ledgerLogs no longer calls db.read()',
  !/function ledgerLogs[\s\S]{0,200}db\.read\(\)/.test(code),
  '~40 sequential select * queries, measured at ~10s against a 12s gateway timeout');
check('it uses the dedicated ledger query',
  /db\.listBalanceLedgerLogs\(/.test(code));
check('and it does NOT use the 200-capped helper',
  !/listAuditLogsByActions\(\['balance\.ledger_entry'\]\)/.test(code),
  'that helper caps at 200 rows and would silently understate a long ledger');

const pg = fs.readFileSync('src/database/postgres-database.ts', 'utf8');
const pgLedger = pg.slice(pg.indexOf('async listBalanceLedgerLogs'), pg.indexOf('async latestAuditLogByAction'));
check('the SQL filters on action in the database',
  /action = 'balance\.ledger_entry'/.test(pgLedger));
check('the SQL filters on user in the database too',
  /metadata->>'userId' = \$1/.test(pgLedger),
  'filtering in Node means fetching every user\'s ledger to serve one');
check('the ledger query has NO limit clause',
  !/limit/i.test(pgLedger),
  'a truncated ledger is a wrong balance, which is worse than a slow one');

await db.read();

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

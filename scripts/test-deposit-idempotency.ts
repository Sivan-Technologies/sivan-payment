/**
 * THE SUITE THAT MATTERS MOST IN THE DEPOSIT FEATURE.
 *
 * Every deposit detector delivers AT LEAST ONCE. Privy documents it explicitly
 * with an eight-step retry schedule; RPC webhook vendors re-fire; a balance
 * poller re-reads the same balance on every tick. And during the planned
 * poll -> webhook migration, two detectors run deliberately at the same time
 * against the same wallets.
 *
 * A duplicate deposit row is not cosmetic. It is a second "you received money"
 * message for money received once, which a user reads as either a double credit
 * or a phishing attempt. Both are worse than saying nothing.
 *
 * So these tests RUN THE CODE rather than grepping it. A regex proving the
 * string "idempotencyKey" appears somewhere would pass against an
 * implementation that does nothing with it.
 *
 * Run: npm run test:deposit-idempotency
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Seed the JSON store BEFORE importing anything that reads it: the database
// caches in memory on first read, so an out-of-process write afterwards is
// invisible to the running module.
const dbFile = path.join(root, '.data', 'test-deposit-idempotency.json');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
fs.writeFileSync(dbFile, JSON.stringify({
  users: [{ id: 'user_dep', email: 'dep@example.com', createdAt: new Date().toISOString() }],
  userWallets: [{
    id: 'wal_1', userId: 'user_dep', provider: 'privy', providerWalletId: 'privy_1',
    chain: 'base', address: '0xAbCdEf0000000000000000000000000000000001',
    status: 'active', custodial: false, createdAt: new Date().toISOString()
  }],
  walletDeposits: []
}));
process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = dbFile;
process.env.EMAIL_PROVIDER = 'console';
process.env.BRIDGE_MOCK_MODE = 'true';

const { recordDeposit, depositIdempotencyKey } = await import('../src/deposits/deposit.service.js');
const { db } = await import('../src/database/json-database.js');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const base = {
  userId: 'user_dep',
  walletId: 'wal_1',
  address: '0xAbCdEf0000000000000000000000000000000001',
  chain: 'base',
  asset: 'USDC',
  amount: '50.000000',
  detectionSource: 'rpc_webhook' as const,
};

console.log('\n── the same observation, delivered twice ──────────────────────');

const first = await recordDeposit({ ...base, txHash: '0xdeadbeef' });
check('the first delivery creates a record', first.created === true);

const second = await recordDeposit({ ...base, txHash: '0xdeadbeef' });
check('the second delivery does NOT create a record', second.created === false,
  'at-least-once delivery would produce a duplicate deposit');
check('and it returns the SAME record', second.record.id === first.record.id,
  `got ${second.record.id}, expected ${first.record.id}`);

const afterTwo = await db.listWalletDeposits('user_dep');
check('exactly one row exists', afterTwo.length === 1, `found ${afterTwo.length}`);

console.log('\n── delivered eight times, the way a retry schedule would ──────');

for (let i = 0; i < 8; i += 1) await recordDeposit({ ...base, txHash: '0xdeadbeef' });
const afterRetries = await db.listWalletDeposits('user_dep');
check('still exactly one row', afterRetries.length === 1, `found ${afterRetries.length}`);

console.log('\n── concurrent delivery, which is the case a check-then-insert loses ──');

const concurrent = await Promise.all(
  Array.from({ length: 10 }, () => recordDeposit({ ...base, txHash: '0xconcurrent' }))
);
const createdCount = concurrent.filter((r) => r.created).length;
check('exactly one of ten concurrent deliveries created a row', createdCount === 1,
  `${createdCount} claimed to have created it`);
check('all ten resolved to the same record id',
  new Set(concurrent.map((r) => r.record.id)).size === 1);

console.log('\n── distinct deposits must still be distinct ───────────────────');

await recordDeposit({ ...base, txHash: '0xsecond_tx' });
const distinct = await db.listWalletDeposits('user_dep');
check('a different transaction creates a new row', distinct.length === 3,
  `expected 3 (0xdeadbeef, 0xconcurrent, 0xsecond_tx), found ${distinct.length}`);

// Same tx, two transfers to the same wallet - a batch exchange payout.
await recordDeposit({ ...base, txHash: '0xbatch', amount: '10.000000' });
const batchKeyA = depositIdempotencyKey({ chain: 'base', txHash: '0xbatch', logIndex: 0 });
const batchKeyB = depositIdempotencyKey({ chain: 'base', txHash: '0xbatch', logIndex: 1 });
check('logIndex distinguishes two transfers inside one transaction',
  batchKeyA !== batchKeyB,
  'a batch payout would collapse into a single deposit');

console.log('\n── the key itself ────────────────────────────────────────────');

check('a tx-based key is chain:hash:logIndex',
  depositIdempotencyKey({ chain: 'base', txHash: '0xAbC' }) === 'base:0xabc:0',
  depositIdempotencyKey({ chain: 'base', txHash: '0xAbC' }));
check('hash case does not produce two different keys',
  depositIdempotencyKey({ chain: 'base', txHash: '0xABC' }) ===
  depositIdempotencyKey({ chain: 'base', txHash: '0xabc' }),
  'EVM hashes arrive in mixed case from different tooling');
check('the same hash on two chains is two different deposits',
  depositIdempotencyKey({ chain: 'base', txHash: '0xabc' }) !==
  depositIdempotencyKey({ chain: 'ethereum', txHash: '0xabc' }));

const pollKey = depositIdempotencyKey({
  chain: 'solana', address: 'SoLAddr', asset: 'USDC', windowStart: '2026-01-01T00:00:00.000Z'
});
check('a poll key needs no transaction hash', pollKey.includes('balance'), pollKey);
check('a poll key is address-cased consistently', pollKey.includes('soladdr'), pollKey);
check('two poll windows are two different keys',
  pollKey !== depositIdempotencyKey({
    chain: 'solana', address: 'SoLAddr', asset: 'USDC', windowStart: '2026-01-01T00:01:00.000Z'
  }));
check('two assets in one window are two different keys',
  pollKey !== depositIdempotencyKey({
    chain: 'solana', address: 'SoLAddr', asset: 'USDT', windowStart: '2026-01-01T00:00:00.000Z'
  }),
  'a USDC and a USDT deposit in the same tick must both be recorded');

console.log('\n── deposits are recorded pending, and credit nobody ───────────');

check('a new deposit is pending, not confirmed', first.record.status === 'pending',
  'a deposit seen on chain is not yet final');
check('detectionSource is stored on the row', first.record.detectionSource === 'rpc_webhook',
  'without it the poll -> webhook overlap cannot be reconciled');
check('notifiedAt starts unset, so a notification is owed',
  !first.record.notifiedAt);

const svc = fs.readFileSync(path.join(root, 'src/deposits/deposit.service.ts'), 'utf8');
check('the deposit service never writes a ledger entry',
  !svc.includes('createBalanceLedgerEntry'),
  'deposits are an observation log; crediting here creates a second source of truth');
check('the deposit service never touches balances',
  !/updateBalance|creditBalance|setBalance/.test(svc));

const migration = fs.readFileSync(
  path.join(root, 'database/migrations/042_create_wallet_deposits.sql'), 'utf8');
check('the database enforces uniqueness, not just the service',
  /create unique index[\s\S]*idempotency_key/i.test(migration),
  'a check-then-insert races; the constraint is the real guarantee');
check('postgres inserts with on conflict do nothing',
  fs.readFileSync(path.join(root, 'src/database/postgres-database.ts'), 'utf8')
    .includes('on conflict (idempotency_key) do nothing'));

fs.rmSync(dbFile, { force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

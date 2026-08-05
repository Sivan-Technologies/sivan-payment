/**
 * THE DETECTOR, DRIVEN WITH REAL BALANCE CHANGES.
 *
 * "A Sivan user would receive deposits from exchange platforms." Before this,
 * the product did nothing when that happened: no record, no activity row, no
 * notification. The balance simply read higher next time - and if the RPC read
 * failed, not even that, while the user held an exchange receipt.
 *
 * This suite seeds a mock wallet, moves its balance, and runs the actual scan.
 * A source-grep suite would pass against a detector that never fires.
 *
 * The cases that matter are the ones where the detector must STAY SILENT:
 * announcing a deposit that did not happen is far more damaging than missing
 * one, because the user acts on it.
 *
 * Run: npm run test:deposit-detection
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dbFile = path.join(root, '.data', 'test-deposit-detection.json');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
fs.writeFileSync(dbFile, JSON.stringify({
  users: [{ id: 'user_a', email: 'a@example.com', createdAt: new Date().toISOString() }],
  userWallets: [{
    id: 'wal_a', userId: 'user_a', provider: 'mock', providerWalletId: 'mock_a',
    chain: 'base', address: '0xAAA0000000000000000000000000000000000001',
    status: 'active', custodial: false, createdAt: new Date().toISOString()
  }],
  walletControls: [{ id: 'singleton', activeProvider: 'mock', updatedAt: new Date().toISOString() }],
  walletDeposits: []
}));
process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = dbFile;
process.env.EMAIL_PROVIDER = 'console';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.WALLET_PROVIDER = 'mock';
process.env.ALLOW_MOCK_WALLETS = 'true';

const { scanForDeposits, resetDepositBaseline } = await import('../src/deposits/deposit-detection.service.js');
const { getWalletProvider } = await import('../src/wallets/provider/provider-registry.js');
const { db } = await import('../src/database/json-database.js');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const provider = getWalletProvider('mock') as any;
// The wallet must exist in the provider before balances can be seeded.
await provider.createWallet({
  chain: 'base', idempotencyKey: 'seed-a', customerId: 'cus_a', userId: 'user_a'
}).catch(() => undefined);
const created = await provider.getWallet('mock_a').catch(() => undefined);
if (!created) {
  // The mock keys wallets by its own generated id; register ours explicitly.
  (provider as any).wallets?.set?.('mock_a', {
    providerWalletId: 'mock_a', chain: 'base',
    address: '0xAAA0000000000000000000000000000000000001',
    custodyModel: 'non_custodial', balances: []
  });
}

const seed = async (asset: string, chain: string, amount: string) =>
  provider.__seedBalance('mock_a', { asset, chain, amount });

const depositsFor = async () => db.listWalletDeposits('user_a');

console.log('\n── the first sighting establishes a baseline and announces nothing ──');

resetDepositBaseline();
await seed('USDC', 'base', '100.000000');
const firstScan = await scanForDeposits();
check('a wallet with an existing balance is not announced as a deposit',
  firstScan.depositsRecorded === 0,
  'every user would be emailed their entire balance on the first tick after a deploy');
check('but the wallet WAS scanned', firstScan.walletsScanned > 0);

console.log('\n── an increase is a deposit ──────────────────────────────────');

await seed('USDC', 'base', '150.000000');
const secondScan = await scanForDeposits();
check('a balance increase is recorded', secondScan.depositsRecorded === 1,
  `recorded ${secondScan.depositsRecorded}`);

const afterDeposit = await depositsFor();
check('the amount is the DELTA, not the new total',
  afterDeposit[0]?.amount === '50.000000',
  `got ${afterDeposit[0]?.amount}, expected 50.000000 (150 - 100)`);
check('the chain is recorded', afterDeposit[0]?.chain === 'base');
check('the asset is recorded', afterDeposit[0]?.asset === 'USDC');
check('it is attributed to the right user', afterDeposit[0]?.userId === 'user_a');
check('detectionSource says balance_poll',
  afterDeposit[0]?.detectionSource === 'balance_poll');
check('there is no txHash, and the code does not invent one',
  !afterDeposit[0]?.txHash,
  'a balance delta is not a transaction; a fabricated hash would 404 on an explorer');

console.log('\n── silence is the correct output in all of these ──────────────');

const before = (await depositsFor()).length;

await scanForDeposits();
check('an unchanged balance records nothing', (await depositsFor()).length === before);

await seed('USDC', 'base', '120.000000');
await scanForDeposits();
check('a DECREASE records nothing', (await depositsFor()).length === before,
  'a withdrawal is not a deposit; it is already recorded as a balance transfer');

// Dust below the floor: two reads of an unchanged balance can differ in the
// last decimal place through float noise.
await seed('USDC', 'base', '120.000001');
await scanForDeposits();
check('a sub-cent increase records nothing', (await depositsFor()).length === before,
  'float noise between two RPC reads would otherwise manufacture deposits');

console.log('\n── watched assets ────────────────────────────────────────────');

await seed('USDT', 'base', '75.000000');
await scanForDeposits();
const withUsdt = await depositsFor();
check('USDT establishes its own baseline first',
  withUsdt.length === before, 'first sighting of a new asset is a baseline');

await seed('USDT', 'base', '95.000000');
await scanForDeposits();
const usdtRows = (await depositsFor()).filter((d) => d.asset === 'USDT');
check('a USDT deposit is detected', usdtRows.length === 1,
  'USDT is at least as common as USDC on Nigerian exchanges');
check('and its amount is the USDT delta', usdtRows[0]?.amount === '20.000000',
  `got ${usdtRows[0]?.amount}`);

const src = fs.readFileSync(path.join(root, 'src/deposits/deposit-detection.service.ts'), 'utf8');
check('the asset list is an explicit allow-list',
  /WATCHED_ASSETS = new Set\(\['USDC', 'USDT'\]\)/.test(src),
  'watching every token invites dust and airdrop spam to generate alerts');

console.log('\n── an unreadable balance is not a zero balance ────────────────');

check('a failed read is counted, not treated as 0',
  /outcome\.unreadable \+= 1;\s*continue;/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
  'treating a failed RPC read as zero would announce the entire balance as a deposit on recovery');
check('the baseline is left untouched when a read fails',
  src.indexOf('outcome.unreadable += 1') < src.indexOf('lastSeen.set'),
  'the next tick must diff against the last figure we actually believed');

console.log('\n── the seam holds ────────────────────────────────────────────');

check('the detector records through recordDeposit and not the database',
  src.includes('recordDeposit(') && !src.includes('insertWalletDepositIfNew'),
  'writing straight to the DB would bypass idempotency and auditing');

const feed = fs.readFileSync(path.join(root, 'frontend/src/activityFeed.ts'), 'utf8');
check('the activity feed does not branch on detectionSource',
  !feed.includes('detectionSource'),
  'if the feed cares how a deposit was found, the detector is no longer swappable');
const notifier = fs.readFileSync(path.join(root, 'src/deposits/deposit-notification.service.ts'), 'utf8');
check('the notifier does not branch on detectionSource',
  !notifier.includes('detectionSource'));

console.log('\n── both EVM chains are swept from one key ─────────────────────');

check('networksServedByWallet decides which chains to read',
  src.includes('networksServedByWallet'),
  'a wallet filed as base also receives on ethereum at the same address');

fs.rmSync(dbFile, { force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

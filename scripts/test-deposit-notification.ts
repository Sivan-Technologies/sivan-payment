/**
 * TELLING THE USER, EXACTLY ONCE, WITHOUT LYING TO THEM.
 *
 * Two independent risks, and this suite runs the real code for both.
 *
 * 1. DUPLICATE DELIVERY. An email cannot be un-sent. A second "you received
 *    money" for money received once reads as a double credit or a phishing
 *    attempt - worse than silence. The row is CLAIMED before the send, so the
 *    failure mode is a lost message rather than a repeated one.
 *
 * 2. LYING ABOUT AVAILABILITY. A pending deposit has been seen on chain but is
 *    not final. If the message says the money is "available", a user who acts
 *    on that immediately hits a rejection they were just told would not happen.
 *    Wording is a correctness property here, so it is asserted like one.
 *
 * Run: npm run test:deposit-notification
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const now = new Date().toISOString();
const deposit = (id: string, over: Record<string, unknown> = {}) => ({
  id, userId: 'user_n', walletId: 'wal_n',
  address: '0xNNN0000000000000000000000000000000000001',
  chain: 'base', asset: 'USDC', amount: '50.000000',
  status: 'pending', detectionSource: 'balance_poll',
  idempotencyKey: `k_${id}`, createdAt: now, updatedAt: now, ...over
});

const dbFile = path.join(root, '.data', 'test-deposit-notification.json');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
fs.writeFileSync(dbFile, JSON.stringify({
  users: [
    { id: 'user_n', email: 'n@example.com', createdAt: now },
    { id: 'user_noemail', whatsappNumber: '+2348000000000', createdAt: now }
  ],
  walletDeposits: [
    deposit('dep_1'),
    deposit('dep_2', { id: 'dep_2', status: 'confirmed' }),
    deposit('dep_3', { id: 'dep_3', userId: 'user_noemail' }),
    deposit('dep_4', { id: 'dep_4', notifiedAt: now }),
    deposit('dep_5', { id: 'dep_5', status: 'failed' })
  ]
}));
process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = dbFile;
process.env.EMAIL_PROVIDER = 'console';
process.env.BRIDGE_MOCK_MODE = 'true';

const { notifyPendingDeposits, depositMessage, humanNetwork } =
  await import('../src/deposits/deposit-notification.service.js');
const { db } = await import('../src/database/json-database.js');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

console.log('\n── which deposits are owed a notification ────────────────────');

const owed = await db.listUnnotifiedWalletDeposits();
const owedIds = owed.map((d) => d.id).sort();
check('an already-notified deposit is not owed one', !owedIds.includes('dep_4'));
check('a FAILED deposit is not announced', !owedIds.includes('dep_5'),
  'telling someone about money that did not arrive is the worst possible message');
check('pending and confirmed deposits are both owed one',
  owedIds.includes('dep_1') && owedIds.includes('dep_2'));

console.log('\n── exactly once, even when the notifier overlaps itself ───────');

const [runA, runB] = await Promise.all([notifyPendingDeposits(), notifyPendingDeposits()]);
const totalSent = runA.sent + runB.sent;
check('two concurrent notifier runs send each deposit once', totalSent <= 2,
  `${totalSent} sends for 2 emailable deposits (dep_1, dep_2)`);
check('the second run skips rather than re-sending',
  runA.skipped + runB.skipped > 0);

const afterRun = await db.listWalletDeposits('user_n');
check('every notified deposit is stamped',
  afterRun.filter((d) => d.status !== 'failed').every((d) => Boolean(d.notifiedAt)),
  'an unstamped row would be re-sent on the next tick, forever');

const again = await notifyPendingDeposits();
check('a third run has nothing left to do', again.sent === 0,
  `sent ${again.sent} duplicate notifications`);

console.log('\n── a user with no email is claimed, not retried forever ───────');

const noEmail = (await db.listWalletDeposits('user_noemail'))[0];
check('the row is stamped even though no email was sent', Boolean(noEmail?.notifiedAt),
  'a WhatsApp-first user has no email; re-examining them every tick is a leak');

console.log('\n── the message must not claim the money is spendable ──────────');

const pendingMsg = depositMessage(deposit('x') as any);
const lower = `${pendingMsg.subject} ${pendingMsg.text}`.toLowerCase();
for (const forbidden of ['available', 'spendable', 'ready to spend', 'you can spend']) {
  check(`a PENDING message never says "${forbidden}"`, !lower.includes(forbidden),
    'the deposit is not final; a user acting on this hits a rejection');
}
check('a pending message says it is still confirming',
  lower.includes('confirm'), pendingMsg.text);
check('a pending message states the amount', pendingMsg.text.includes('50.000000'));
check('a pending message states the asset', pendingMsg.text.includes('USDC'));
check('a pending message tells them to do nothing',
  lower.includes('do not need to do anything'));

const confirmedMsg = depositMessage(deposit('y', { status: 'confirmed' }) as any);
check('a CONFIRMED message may say it is usable',
  /send or convert|balance/i.test(confirmedMsg.text));
check('the two messages differ', confirmedMsg.subject !== pendingMsg.subject);

console.log('\n── network names are for humans ──────────────────────────────');

check('base renders as Base', humanNetwork('base') === 'Base');
check('solana renders as Solana', humanNetwork('solana') === 'Solana',
  'a rendered screenshot already caught "Sending on solana"');
check('an unknown chain degrades readably, not to snake_case',
  !humanNetwork('some_new_chain').includes('_'));
check('the network appears in the message', pendingMsg.text.includes('Base'));

console.log('\n── claim-before-send is the ordering, and it is deliberate ────');

const src = fs.readFileSync(path.join(root, 'src/deposits/deposit-notification.service.ts'), 'utf8');
const claimAt = src.indexOf('markWalletDepositNotified(deposit.id, nowIso())\n    if (!claimed)') >= 0
  ? src.indexOf('const claimed =')
  : src.indexOf('const claimed =');
check('the row is claimed before sendEmail is called',
  claimAt >= 0 && claimAt < src.indexOf('await sendEmail('),
  'sending first means a crash before the stamp re-sends on the next tick');
check('a send failure does NOT un-claim the row',
  !/catch[\s\S]{0,200}markWalletDepositNotified\([^)]*undefined/.test(src),
  'un-claiming after a timeout that actually delivered would send twice');

const jsonDb = fs.readFileSync(path.join(root, 'src/database/json-database.ts'), 'utf8');
check('the JSON claim refuses a row that is already stamped',
  /if \(!found \|\| found\.notifiedAt\) return false;/.test(jsonDb));
const pg = fs.readFileSync(path.join(root, 'src/database/postgres-database.ts'), 'utf8');
check('the Postgres claim guards on notified_at is null',
  /where id = \$1 and notified_at is null/.test(pg),
  'without the guard two workers both send');

fs.rmSync(dbFile, { force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

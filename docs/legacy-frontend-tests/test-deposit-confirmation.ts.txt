/**
 * A DEPOSIT COULD NEVER STOP SAYING "In progress".
 *
 * Reported with a screenshot of the dashboard contradicting itself:
 *
 *     YOUR BALANCE   20 USDC   Available to send or sell   Ready
 *     Deposit received   Solana · 28m ago   +20.000000 USDC   [In progress]
 *
 * Same 20 USDC, same screen, two different answers. Confirmed against the live
 * Neon database - dep_fc5c402f, status 'pending', created 09:37:31Z - still
 * pending an hour later for money that was final on Solana in seconds.
 *
 * The cause was an absence, not a fault: `recordDeposit` writes 'pending', the
 * enum declares 'confirmed', both drivers implement updateWalletDepositStatus,
 * migration 042 indexes the pending set - and grep found ZERO callers of that
 * writer. Nothing was ever going to change the badge.
 *
 * Run: npm run test:deposit-confirmation
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-deposit-confirmation.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.NETWORK_MODE = 'testnet';
process.env.ADMIN_API_KEY = 'deposit-confirm-admin-key';
process.env.USER_JWT_SECRET = 'deposit-confirm-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-deposit-confirmation.json', { force: true });

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { recordDeposit } = await import('../src/deposits/deposit.service.js');
const { confirmDeposits, EVM_CONFIRMATIONS } = await import('../src/deposits/deposit-confirmation.service.js');
const { activityStatusLabel, activityState, buildActivityFeed } = await import('../frontend/src/activityFeed.js');

/**
 * THE CHAIN IS STUBBED AT THE RPC BOUNDARY, NOT ABOVE IT.
 *
 * Stubbing `balanceStillPresent` would test that confirmDeposits calls a
 * function that returns 'confirmed' - a tautology. Stubbing fetch means the
 * real RPC helpers, the real commitment parameter and the real block-tag
 * arithmetic all execute, and the assertions below can inspect what was
 * actually put on the wire.
 */
interface RpcCall { url: string; method: string; params: any[] }
const calls: RpcCall[] = [];
let solanaHeld = '0';
let evmHeld = 0n;
let evmHead = 0x1000n;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  calls.push({ url: String(url), method: body.method, params: body.params ?? [] });

  const reply = (result: unknown) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  if (body.method === 'getTokenAccountsByOwner') {
    return reply({
      value: solanaHeld === null ? [] : [
        { account: { data: { parsed: { info: { tokenAmount: { amount: solanaHeld } } } } } },
      ],
    });
  }
  if (body.method === 'eth_blockNumber') return reply(`0x${evmHead.toString(16)}`);
  if (body.method === 'eth_call') return reply(`0x${evmHeld.toString(16).padStart(64, '0')}`);
  if (body.method === 'getSignatureStatuses') return reply({ value: [null] });
  if (body.method === 'eth_getTransactionReceipt') return reply(null);
  return reply(null);
}) as typeof fetch;

const solanaDeposit = async (amount: string) => {
  const result = await recordDeposit({
    userId: 'usr_confirm',
    walletId: 'wal_confirm',
    address: 'GVeUsx5Pz3fAhoaMyzbRqf4sVwQb2SBayDx9ahdgvdxS',
    chain: 'solana',
    asset: 'USDC',
    amount,
    detectionSource: 'balance_poll',
    idempotencyKeyOverride: `solana:test:${amount}:${Math.random()}`,
  });
  return result.record;
};

console.log('\n── the reported bug: a deposit is recorded pending ───────────');

const deposit = await solanaDeposit('20.000000');
check('a new deposit starts pending', deposit.status === 'pending', deposit.status);
check('and reads as "In progress" in the feed',
  activityStatusLabel(deposit.status) === 'In progress',
  activityStatusLabel(deposit.status));

/**
 * THE REGRESSION GUARD FOR THE ABSENCE ITSELF.
 *
 * The bug was that nothing called the writer. A test that only checks
 * confirmDeposits works would still pass if the server loop were deleted and
 * the function never ran in production - which is the precise shape of the
 * original defect. So the wiring is asserted as source, separately.
 */
console.log('\n── the confirmer is actually WIRED, not merely written ───────');

const serverSrc = fs.readFileSync('src/server.ts', 'utf8');
check('server.ts imports confirmDeposits',
  /import \{ confirmDeposits \}/.test(serverSrc),
  'the original bug was a writer with zero callers');
check('and runs it on a timer',
  /DEPOSIT_CONFIRM_SECONDS[\s\S]{0,900}confirmDeposits\(\)/.test(serverSrc),
  'a confirmer that is never invoked leaves the badge exactly as stuck');
check('with a boot run, so a deploy heals the backlog',
  /confirmDeposits[\s\S]{0,1200}void tick\(\)/.test(serverSrc),
  'without this, rows stuck before the deploy stay stuck until the first interval');

const dbSrc = fs.readFileSync('src/database/postgres-database.ts', 'utf8');
check('the pending reader uses the partial index predicate',
  /where status = 'pending'\s*\n\s*order by created_at asc/.test(dbSrc),
  "042 created payments_wallet_deposits_pending_idx for exactly this query");

console.log('\n── finalised balance still holds it -> confirmed ─────────────');

// 20 USDC, six decimals, present at finalized commitment.
solanaHeld = '20000000';
calls.length = 0;
const outcome = await confirmDeposits();

check('the pending deposit is checked', outcome.checked === 1, String(outcome.checked));
check('and confirmed', outcome.confirmed.includes(deposit.id), JSON.stringify(outcome));

const after = (await db.listWalletDeposits('usr_confirm')).find((d) => d.id === deposit.id)!;
check('the stored status is now confirmed', after.status === 'confirmed', after.status);
/**
 * ASSERTED AS A DELIBERATE MAP ENTRY, NOT JUST AS A STRING.
 *
 * `activityStatusLabel('confirmed') === 'Confirmed'` passes even when the
 * STATUS_LABELS entry is deleted, because the unknown-status fallback
 * title-cases the raw token into the same word. Found by mutation-testing this
 * very assertion: removing the map entry left it green. A test that cannot
 * tell a considered label from an accidental one is measuring the wrong thing,
 * so the state classification - which the fallback does NOT provide - is what
 * carries the weight here.
 */
check('the feed label flips to "Confirmed"',
  activityStatusLabel(after.status) === 'Confirmed',
  activityStatusLabel(after.status));
check('and "confirmed" is a known terminal status, not an unrecognised token',
  activityState('confirmed') === 'success' && activityState('some_new_provider_state') === 'pending',
  'the fallback title-cases anything; only SUCCESS_STATUSES makes it terminal');
check('and the row is no longer pending state',
  activityState(after.status) === 'success',
  activityState(after.status));

/**
 * THE ASSERTION THAT SEPARATES THIS FROM RE-RUNNING THE DETECTOR.
 *
 * privy-wallet.provider.ts reads the same balance with NO commitment, so the
 * node answers at its default 'confirmed'. If this call did the same it would
 * be asking an already-answered question and confirming every deposit
 * unconditionally. 'finalized' is the whole evidence.
 */
const solCall = calls.find((c) => c.method === 'getTokenAccountsByOwner');
check('Solana is read at FINALIZED commitment',
  solCall?.params?.[2]?.commitment === 'finalized',
  JSON.stringify(solCall?.params?.[2]) + ' - without this it re-asks the detector\'s question');

console.log('\n── the dashboard no longer contradicts itself ────────────────');

/**
 * The actual reported symptom, asserted on the feed the dashboard renders
 * rather than on the database row - the screenshot showed a BADGE, so the
 * badge is what has to change.
 */
const feed = buildActivityFeed({ walletDeposits: [after as any] });
check('the deposit row renders as Confirmed',
  feed[0]?.statusLabel === 'Confirmed',
  feed[0]?.statusLabel);
check('so it is not counted as in-flight',
  feed.filter((r) => r.state === 'pending').length === 0,
  'the "IN PROGRESS 1" card counted this deposit while the balance called it Ready');

console.log('\n── a balance that does NOT hold it stays pending ─────────────');

const short = await solanaDeposit('50.000000');
solanaHeld = '20000000'; // only 20 held, 50 claimed
const shortOutcome = await confirmDeposits();
const shortAfter = (await db.listWalletDeposits('usr_confirm')).find((d) => d.id === short.id)!;

check('a deposit the chain cannot account for is not confirmed',
  shortAfter.status === 'pending',
  shortAfter.status);
check('and is NOT marked failed',
  !shortOutcome.failed.includes(short.id),
  'a balance that moved is not proof a deposit reversed - the user may have spent it');

console.log('\n── an unreachable RPC changes nothing ────────────────────────');

const offline = await solanaDeposit('7.000000');
const stubbed = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
const offlineOutcome = await confirmDeposits();
globalThis.fetch = stubbed;

const offlineAfter = (await db.listWalletDeposits('usr_confirm')).find((d) => d.id === offline.id)!;
check('an RPC outage leaves the deposit pending', offlineAfter.status === 'pending', offlineAfter.status);
check('and never marks it failed',
  offlineOutcome.failed.length === 0,
  'an unreachable node is not evidence that money vanished');
check('the outage is counted as unreadable',
  offlineOutcome.unreadable > 0,
  'silence about a chain we cannot read is how the original blindness happened');

console.log('\n── EVM is read BEHIND the head, not at latest ────────────────');

const evmDeposit = await recordDeposit({
  userId: 'usr_confirm',
  walletId: 'wal_evm',
  address: '0xf56c864f6ebb572e7dc76f2fe042cca5b8361932',
  chain: 'base',
  asset: 'USDC',
  amount: '10.000000',
  detectionSource: 'balance_poll',
  idempotencyKeyOverride: `base:test:${Math.random()}`,
});

evmHeld = 10000000n;
evmHead = 0x1000n;
calls.length = 0;
await confirmDeposits();

const evmCall = calls.find((c) => c.method === 'eth_call');
const blockTag = evmCall?.params?.[1];
check('the balance is read at an explicit block, not "latest"',
  blockTag !== 'latest' && typeof blockTag === 'string',
  String(blockTag) + " - 'latest' is the detector's own read and proves nothing about finality");
check(`and that block is ${EVM_CONFIRMATIONS} behind the head`,
  BigInt(String(blockTag)) === 0x1000n - BigInt(EVM_CONFIRMATIONS),
  `${blockTag} vs head 0x1000`);

const evmAfter = (await db.listWalletDeposits('usr_confirm')).find((d) => d.id === evmDeposit.record.id)!;
check('a held EVM balance confirms the deposit', evmAfter.status === 'confirmed', evmAfter.status);

console.log('\n── confirming is idempotent ──────────────────────────────────');

const second = await confirmDeposits();
check('an already-confirmed deposit is not re-checked',
  !second.confirmed.includes(deposit.id),
  'a re-confirm would rewrite updatedAt and re-fire the audit entry on every tick');

globalThis.fetch = realFetch;

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

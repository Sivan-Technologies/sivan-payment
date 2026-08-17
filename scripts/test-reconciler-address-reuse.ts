/**
 * THREE ORDERS ON ONE DEPOSIT ADDRESS. ONLY ONE EVER COMPLETED.
 *
 * Observed in production, 2026-08-15, on address 4JStqvP44RT6z...:
 *
 *     1d ago   -24990.24 NGN   Completed
 *     1d ago   -24990.24 NGN   Bank payout pending   <- customer was paid
 *     10h ago  -24697.89 NGN   Bank payout pending   <- customer was paid
 *
 * Breet deposit addresses are permanent and reusable, so every off-ramp by the
 * same user on the same asset shares one. The reconciler matched settlements
 * by address and then took `open[0]` - the OLDEST non-terminal order. With
 * several open orders on one address every settlement resolved to the same
 * row, so the rest were unreachable and sat "settlement processing" forever
 * while the naira was already in the customer's bank.
 *
 * The fix uses the payout amount, which listSettlements() already returned and
 * nothing read. It is compared against destinationAmount because both are the
 * NAIRA side.
 *
 * WHY THIS IS A SEPARATE SUITE FROM THE WEBHOOK ONE. The webhook path was
 * fixed first and has its own tests. This is the POLLER - the safety net that
 * has to work when a webhook is missed, which is exactly the situation these
 * stuck orders are in. Fixing one and assuming the other is how the second
 * order stayed broken after the first was repaired.
 *
 * Run: npm run test:reconciler-address-reuse
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-reconciler-address-reuse.json';
process.env.SIVAN_DATA_FILE = '.data/test-reconciler-address-reuse.json';
process.env.NGN_PROVIDER = 'breet';
process.env.WALLET_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'reconciler-admin-key';
process.env.BREET_APP_ID = 'test_app_id';
process.env.BREET_APP_SECRET = 'test_app_secret';
process.env.BREET_ENV = 'development';

import fs from 'node:fs';
fs.rmSync('.data/test-reconciler-address-reuse.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { BreetNgnProvider } = await import('../src/ngn/provider/breet.provider.js');
const { reconcileNgnSettlements } = await import('../src/ngn/service/ngn-settlement-reconciler.js');

const now = () => new Date().toISOString();
const ADDRESS = '4JStqvP44RT6zVSXjxhjMcTFNahsFCG4vF4WcaoXRzgv';

/** What Breet reports. Stubbed at the provider boundary - no network. */
let settlements: any[] = [];
(BreetNgnProvider as any).prototype.listSettlements = async () => settlements;

/** Three orders on ONE address, exactly as the screenshots show. */
async function seed() {
  await db.mutate((d: any) => {
    d.users = [{ id: 'usr_r', email: 'r@t.test', emailVerifiedAt: now(), country: 'NG',
      fullName: 'SAMSON MICHEAL OLALEYE', createdAt: now(), updatedAt: now() }];
    const base = (id: string, amount: string, status: string, createdAt: string) => ({
      id, quoteId: `q_${id}`, userId: 'usr_r', direction: 'offramp', provider: 'breet',
      sourceCurrency: 'usdt', destinationCurrency: 'ngn', sourceAmount: '16.4',
      destinationAmount: amount, rate: '1520', feeAmount: '0',
      status, providerTransferId: 'wallet_shared', depositAddress: ADDRESS,
      metadata: { transferMetadata: { depositAddress: ADDRESS } },
      createdAt, updatedAt: createdAt,
    });
    d.ngnTransfers = [
      base('ngnt_oldest', '24990.24', 'completed', '2026-08-13T09:00:00.000Z'),
      base('ngnt_middle', '24990.24', 'settlement_processing', '2026-08-13T11:00:00.000Z'),
      base('ngnt_newest', '24697.89', 'settlement_processing', '2026-08-14T17:49:00.000Z'),
    ];
    d.auditLogs = [];
    return 1;
  });
}

console.log('\n── the payout is matched by amount, not by "oldest open" ─────');

await seed();
// The 10h-ago payout. Distinguishable only by its amount.
settlements = [{
  depositAddress: ADDRESS, tradeId: '6a7f5512385f7180be28dd35',
  withdrawalId: '6a7f5522b2cb7cd144ebb5cd',
  tradeStatus: 'completed', withdrawalStatus: 'completed',
  fiatAmount: 24697.89, cryptoAmount: 16.4,
}];
await reconcileNgnSettlements();

let rows: any[] = await db.listNgnTransfers();
const byId = (id: string) => rows.find((t: any) => t.id === id);

check('the order whose amount matches is completed',
  byId('ngnt_newest').status === 'completed',
  `${byId('ngnt_newest').status} - this is the one the customer was paid for`);
check('the unrelated open order is NOT touched',
  byId('ngnt_middle').status === 'settlement_processing',
  `${byId('ngnt_middle').status} - completing it would tell a user money arrived that has not`);
check('and the already-completed order is unchanged',
  byId('ngnt_oldest').status === 'completed');

console.log('\n── the second stuck payout also settles ──────────────────────');

settlements = [{
  depositAddress: ADDRESS, tradeId: 'trade_middle', withdrawalId: 'wd_middle',
  tradeStatus: 'completed', withdrawalStatus: 'completed',
  fiatAmount: 24990.24, cryptoAmount: 16.4,
}];
await reconcileNgnSettlements();
rows = await db.listNgnTransfers();

/**
 * The point of the whole fix: with the oldest row already terminal, the
 * remaining order must still be reachable. Under "oldest open wins" it was,
 * eventually - but only one per poll and only in creation order, which is why
 * a newer order could sit pending behind an older one indefinitely.
 */
check('the remaining stuck order completes too',
  byId('ngnt_middle').status === 'completed',
  `${byId('ngnt_middle').status}`);

console.log('\n── ambiguity is refused, not guessed ─────────────────────────');

await seed();
await db.mutate((d: any) => {
  // Two OPEN orders for the same naira amount - the amount is now not evidence.
  d.ngnTransfers[2].destinationAmount = '24990.24';
  return 1;
});
settlements = [{
  depositAddress: ADDRESS, tradeId: 'trade_ambig', withdrawalId: 'wd_ambig',
  tradeStatus: 'completed', withdrawalStatus: 'completed',
  fiatAmount: 24990.24, cryptoAmount: 16.4,
}];
await reconcileNgnSettlements();
rows = await db.listNgnTransfers();

const completedCount = ['ngnt_middle', 'ngnt_newest']
  .filter((id) => byId(id).status === 'completed').length;
check('exactly one order is completed, never both',
  completedCount === 1,
  `${completedCount} completed - one payout must never settle two orders`);
check('and it falls back to the oldest open, deterministically',
  byId('ngnt_middle').status === 'completed',
  'with the amount ambiguous the previous rule is the honest tie-break');

console.log('\n── a trade id still wins outright when present ───────────────');

await seed();
await db.mutate((d: any) => {
  d.ngnTransfers[2].metadata.breetTradeId = 'trade_exact';
  return 1;
});
settlements = [{
  depositAddress: ADDRESS, tradeId: 'trade_exact', withdrawalId: 'wd_exact',
  tradeStatus: 'completed', withdrawalStatus: 'completed',
  // Amount deliberately matches the OTHER open order, to prove the exact key
  // is consulted first and the heuristic cannot override it.
  fiatAmount: 24990.24, cryptoAmount: 16.4,
}];
await reconcileNgnSettlements();
rows = await db.listNgnTransfers();

check('the transfer carrying the trade id is the one completed',
  byId('ngnt_newest').status === 'completed',
  `${byId('ngnt_newest').status}`);
check('and the amount-matching order is left alone',
  byId('ngnt_middle').status === 'settlement_processing',
  `${byId('ngnt_middle').status} - an exact id must outrank a matching number`);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

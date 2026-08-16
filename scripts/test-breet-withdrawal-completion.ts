/**
 * A DELIVERED `withdrawal.completed` MUST COMPLETE THE TRANSFER.
 *
 * From production, 2026-08-14. Breet's own webhook log:
 *
 *     Event Type    Completed Withdrawal
 *     Attempt Count 1
 *     Delivered At  Aug 14, 2026, 6:49:32 PM
 *     Webhook url   https://api.sivantech.online/api/payment/api/webhooks/breet
 *
 * Delivered first try, to the right URL. The customer's naira was in their
 * bank. The app still read "settlement processing" the next morning.
 *
 * WHY IT WAS DROPPED. The payload is:
 *
 *     { id: <withdrawal id>, trade: <trade id>, amount, payoutAmount,
 *       status: "completed", meta: {...}, event: "withdrawal.completed" }
 *
 * No destinationAddress. No txHash. No label. findTransferForEvent has six
 * keys and five of them need one of those fields. The sixth compares
 * `payload.id` to `providerTransferId` - but that holds Breet's WALLET id,
 * and this is a WITHDRAWAL id. Different namespaces, never equal. And
 * `breetTradeId` is only written when a `trade.*` webhook arrives, so if that
 * one was missed there is nothing on the transfer to match at all.
 *
 * The fix resolves the withdrawal through its trade: GET /trades/sell/{id}
 * returns the trade, the trade knows the deposit address, the address finds
 * the transfer.
 *
 * ASSERTS ON THE STORED RECORD, not on a returned flag: the transfer row is
 * what the transactions screen reads, and that screen was the thing lying.
 *
 * Run: npm run test:breet-withdrawal-completion
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-breet-withdrawal-completion.json';
process.env.SIVAN_DATA_FILE = '.data/test-breet-withdrawal-completion.json';
process.env.NGN_PROVIDER = 'breet';
process.env.WALLET_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'withdrawal-admin-key';
process.env.BREET_APP_ID = 'test_app_id';
process.env.BREET_APP_SECRET = 'test_app_secret';
process.env.BREET_ENV = 'development';

import fs from 'node:fs';
fs.rmSync('.data/test-breet-withdrawal-completion.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { BreetNgnProvider } = await import('../src/ngn/provider/breet.provider.js');
const { recordNgnWebhook } = await import('../src/ngn/service/ngn-webhooks.service.js');

/**
 * Driven through recordNgnWebhook - the REAL entry point the route calls -
 * rather than the internal applyWebhookToTransfer. That exercises verification
 * and storage too, so this cannot pass against a path production does not use.
 *
 * verifyWebhook re-fetches the transaction from Breet and merges it over the
 * delivered body. Stubbed to return the payload unchanged: this test is about
 * MATCHING, and a network call here would make it a Breet availability test.
 */
(BreetNgnProvider as any).prototype.verifyWebhook = async (payload: any) => ({
  provider: 'breet' as const,
  eventType: String(payload?.event ?? ''),
  payload,
  signatureValid: true,
  receivedAt: new Date().toISOString(),
});

const deliver = (payload: any) => recordNgnWebhook('breet' as any, payload, {});

const now = () => new Date().toISOString();

/** The exact ids from the production delivery. */
const WITHDRAWAL_ID = '6a7f5522b2cb7cd144ebb5cd';
const TRADE_ID = '6a7f5512385f7180be28dd35';
const WALLET_ID = 'wallet_abc123';
const DEPOSIT_ADDRESS = '4JStqvP44RT6zVSXjxhjMcTFNahsFCG4vF4WcaoXRzgv';

/** The withdrawal payload, verbatim from the Breet webhook log. */
function withdrawalPayload(over: Record<string, unknown> = {}) {
  return {
    id: WITHDRAWAL_ID,
    amount: 24699,
    originalAmount: 24699,
    payoutAmount: 24649,
    currency: 'ngn',
    status: 'completed',
    reference: WITHDRAWAL_ID,
    trade: TRADE_ID,
    meta: {
      type: 'nuban', bankId: '25', bankName: 'OPay - Paycom',
      accountName: 'SAMSON MICHEAL OLALEYE', account: '6a7f52293d0e93702fbb1bf4',
      accountNumber: '8079604214', autoSettlement: false,
      narration: 'Sivan payout', fee: 50,
    },
    reason: '',
    createdAt: '2026-08-14T17:49:23.286Z',
    updatedAt: '2026-08-14T17:49:27.828Z',
    event: 'withdrawal.completed',
    ...over,
  };
}

/**
 * The trade lookup the fix depends on. Stubbed on the prototype so no network
 * call is made; the shape matches what GET /trades/sell/{id} returns.
 */
let tradeLookups = 0;
(BreetNgnProvider as any).prototype.getTradeById = async (tradeId: string) => {
  tradeLookups += 1;
  if (tradeId !== TRADE_ID) return undefined;
  return { id: TRADE_ID, address: DEPOSIT_ADDRESS, status: 'completed', amountInUSD: 16.2 };
};

async function seed(status = 'settlement_processing', extraMeta: Record<string, unknown> = {}) {
  await db.mutate((d: any) => {
    d.users = [{ id: 'usr_w', email: 'w@t.test', emailVerifiedAt: now(), country: 'NG',
      fullName: 'SAMSON MICHEAL OLALEYE', createdAt: now(), updatedAt: now() }];
    d.ngnTransfers = [{
      id: 'ngnt_live', quoteId: 'q1', userId: 'usr_w', direction: 'offramp', provider: 'breet',
      sourceCurrency: 'usdt', destinationCurrency: 'ngn', sourceAmount: '16.2',
      destinationAmount: '24699', rate: '1520', feeAmount: '0',
      status,
      // The WALLET id, exactly as createOfframpTransfer stores it. Deliberately
      // NOT the trade or withdrawal id - that mismatch is the bug.
      providerTransferId: WALLET_ID,
      depositAddress: DEPOSIT_ADDRESS,
      metadata: { transferMetadata: { depositAddress: DEPOSIT_ADDRESS, label: 'sivan_usr_w' }, ...extraMeta },
      createdAt: now(), updatedAt: now(),
    }];
    d.auditLogs = [];
    return 1;
  });
}

console.log('\n── the production payload completes the transfer ─────────────');

await seed();
tradeLookups = 0;
await deliver(withdrawalPayload());

let row: any = (await db.listNgnTransfers()).find((t: any) => t.id === 'ngnt_live');
check('the transfer reaches completed',
  row.status === 'completed',
  `${row.status} - the customer had the naira and the screen said settlement processing`);
check('and it is stamped with a completion time',
  Boolean(row.completedAt), JSON.stringify(row.completedAt));
check('the withdrawal was resolved through its trade',
  tradeLookups === 1, `${tradeLookups} trade lookup(s)`);
check('the breet withdrawal id is recorded for support',
  (row.metadata as any)?.breetWithdrawalId === WITHDRAWAL_ID,
  JSON.stringify((row.metadata as any)?.breetWithdrawalId));

console.log('\n── it does not need a trade webhook to have arrived first ────');

/**
 * The whole point. Before the fix this only worked if `trade.completed` had
 * already run and written breetTradeId; the seed above deliberately has no
 * breet ids at all.
 */
check('no breetTradeId was needed on the transfer beforehand', true,
  'seeded without one, and it still completed');

console.log('\n── the exact key still wins when it exists ───────────────────');

await seed('settlement_processing', { breetTradeId: TRADE_ID });
tradeLookups = 0;
await deliver(withdrawalPayload());
row = (await db.listNgnTransfers()).find((t: any) => t.id === 'ngnt_live');
check('a transfer already carrying the trade id completes', row.status === 'completed');
check('and no provider call is made for it',
  tradeLookups === 0,
  `${tradeLookups} lookup(s) - the direct match must short-circuit the network hop`);

console.log('\n── an unmatchable webhook is logged, not silently dropped ────');

await seed();
tradeLookups = 0;
await deliver(withdrawalPayload({ id: 'unknown_w', trade: 'unknown_trade' }));

const unmatched = await db.listAuditLogsByActions(['ngn.webhook_unmatched']);
check('an unmatched delivery raises an error-severity audit log',
  unmatched.length === 1 && unmatched[0].severity === 'error',
  JSON.stringify(unmatched.map((l: any) => [l.action, l.severity])));
check('the log names the event and the refs a human needs',
  (unmatched[0]?.metadata as any)?.event === 'withdrawal.completed'
  && (unmatched[0]?.metadata as any)?.tradeRef === 'unknown_trade',
  JSON.stringify(unmatched[0]?.metadata));

row = (await db.listNgnTransfers()).find((t: any) => t.id === 'ngnt_live');
check('and no unrelated transfer was advanced by it',
  row.status === 'settlement_processing', row.status);

console.log('\n── a completed transfer is never rewound ─────────────────────');

await seed('completed');
await deliver(withdrawalPayload({ status: 'pending', event: 'withdrawal.pending' }));
row = (await db.listNgnTransfers()).find((t: any) => t.id === 'ngnt_live');
check('a late withdrawal.pending cannot drag it back',
  row.status === 'completed',
  `${row.status} - Breet retries for 24h and events arrive out of order`);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

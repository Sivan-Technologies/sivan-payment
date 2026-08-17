/**
 * A `withdrawal.completed` MUST FIND ITS TRANSFER WHEN NO TRADE EVENT ARRIVED.
 *
 * REPORTED, WITH THE DELIVERY LOG. Breet's dashboard shows the webhook
 * delivered to the live URL on the first attempt:
 *
 *   Event Type    Completed Withdrawal
 *   Attempt Count 1
 *   Delivered At  Aug 14, 2026, 6:49:32 PM
 *   Webhook url   https://api.sivantech.online/api/payment/api/webhooks/breet
 *
 * The money reached the user's bank. The app still said "settlement
 * processing". So the webhook was RECEIVED and then failed to match a
 * transfer - it was not lost in transit.
 *
 * WHY IT COULD NOT MATCH. This is the real payload, and what matters is what
 * is ABSENT from it:
 *
 *   { id: "6a7f5522b2cb7cd144ebb5cd",     <- the WITHDRAWAL id
 *     trade: "6a7f5512385f7180be28dd35",  <- the TRADE id
 *     amount: 24699, payoutAmount: 24649, currency: "ngn",
 *     status: "completed", event: "withdrawal.completed",
 *     meta: { bankId, accountNumber, ... } }
 *
 * There is no `destinationAddress`, no `txHash`, and no `label`. Every one of
 * findTransferForEvent's fallbacks keys on one of those three. So the ONLY
 * usable keys are the withdrawal id and the trade id, and at order creation
 * Sivan stores neither:
 *
 *   breet.provider.ts:704   providerTransferId = addressId   (the WALLET id)
 *
 * `breetTradeId` is only ever learned from a `trade.*` webhook
 * (ngn-webhooks.service.ts:473). If that event is missed, delayed, or - as
 * here - auto-settlement is off at the wallet so the trade never fires the
 * shape we expect, the withdrawal event arrives with nothing to join on and
 * is stored as an orphan.
 *
 * NOTE `meta.autoSettlement: false` in the payload. The withdrawal was placed
 * by BUSINESS-WIDE auto-settlement (dashboard) rather than per-address
 * auto-settlement (API). Per the Breet docs those are two different features,
 * and the business-wide one funnels every address to one destination - so the
 * per-address assumptions this integration was built on do not hold for it.
 *
 * WHAT THIS TEST PINS. A withdrawal event that names only a trade id must
 * still complete the right transfer, using the amount and the deposit address
 * recorded at order creation. And it must NOT complete a different user's
 * order that happens to share the reused Breet address.
 *
 * Run: npm run test:breet-withdrawal-orphan
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-breet-withdrawal-orphan.json';
process.env.SIVAN_DATA_FILE = '.data/test-breet-withdrawal-orphan.json';
process.env.NGN_PROVIDER = 'breet';
process.env.WALLET_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'orphan-admin-key';
process.env.BREET_APP_ID = 'test_app_id';
process.env.BREET_APP_SECRET = 'test_app_secret';
process.env.BREET_ENV = 'development';
process.env.BREET_WEBHOOK_SECRET = 'orphan-webhook-secret';
// Breet is unreachable from here (bogus credentials), which verifyWebhook
// tolerates: only a 404 is treated as a forgery. So the event passes through
// verified event to a transfer, not about verification, which
// unconfirmed, which is exactly the path a real delivery takes during an outage.

import fs from 'node:fs';
fs.rmSync('.data/test-breet-withdrawal-orphan.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { recordNgnWebhook } = await import('../src/ngn/service/ngn-webhooks.service.js');

const now = () => new Date().toISOString();
const HEADERS = { 'x-webhook-secret': 'orphan-webhook-secret' };
/** The reused Breet deposit address from the report. */
const ADDRESS = '4JStqvP44RT6zVSXjxhjMcTFNahsFCG4vF4WcaoXRzgv';

function transfer(over: Record<string, unknown>) {
  return {
    userId: 'usr_a', customerId: 'cus_a', direction: 'offramp', provider: 'breet',
    sourceCurrency: 'usdt', destinationCurrency: 'ngn',
    sourceAmount: '18.42', rate: '1394', feeAmount: '0',
    // The wallet id, which is what breet.provider.ts actually stores.
    providerTransferId: 'wallet_123',
    depositAddress: ADDRESS,
    status: 'settlement_processing',
    metadata: { quoteMetadata: { network: 'solana' }, transferMetadata: { depositAddress: ADDRESS } },
    createdAt: now(), updatedAt: now(),
    ...over,
  } as any;
}

await db.mutate((d: any) => {
  d.users = [
    { id: 'usr_a', email: 'a@t.test', emailVerifiedAt: now(), country: 'NG', fullName: 'SAMSON MICHEAL OLALEYE', createdAt: now(), updatedAt: now() },
    { id: 'usr_b', email: 'b@t.test', emailVerifiedAt: now(), country: 'NG', fullName: 'SOMEONE ELSE', createdAt: now(), updatedAt: now() },
  ];
  d.ngnTransfers = [
    // The order the payout belongs to: 24,699 NGN.
    transfer({ id: 'ngnt_target', destinationAmount: '24699.00' }),
    // A LATER order by the same user on the SAME reused address, different
    // amount. Address matching alone cannot tell these apart.
    transfer({ id: 'ngnt_other', destinationAmount: '24990.24', sourceAmount: '17.88',
      createdAt: new Date(Date.now() + 60_000).toISOString() }),
  ];
  return 1;
});

/** The payload exactly as Breet delivered it. */
const WITHDRAWAL_COMPLETED = {
  id: '6a7f5522b2cb7cd144ebb5cd',
  amount: 24699,
  originalAmount: 24699,
  payoutAmount: 24649,
  currency: 'ngn',
  status: 'completed',
  reference: '6a7f5522b2cb7cd144ebb5cd',
  trade: '6a7f5512385f7180be28dd35',
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
};

console.log('\n── a withdrawal naming only a trade id still settles the order ──');

await recordNgnWebhook('breet', WITHDRAWAL_COMPLETED, HEADERS);

const after = await db.listNgnTransfers();
const target = after.find((t: any) => t.id === 'ngnt_target') as any;
const other = after.find((t: any) => t.id === 'ngnt_other') as any;

check('the matching order is marked completed',
  target?.status === 'completed',
  `${target?.status} - the user was paid; the screen must not still say "settlement processing"`);
check('and it records when',
  Boolean(target?.completedAt),
  JSON.stringify(target?.completedAt));
check('the OTHER order on the same reused address is untouched',
  other?.status === 'settlement_processing',
  `${other?.status} - one payout must never complete two orders`);

/**
 * The ids must be stamped so a later event - or the reconciler - has an exact
 * key and never has to guess from the address again.
 */
check('the withdrawal id is stored for idempotency',
  (target?.metadata as any)?.breetWithdrawalId === '6a7f5522b2cb7cd144ebb5cd',
  JSON.stringify((target?.metadata as any)?.breetWithdrawalId));
check('the trade id is learned from the withdrawal payload',
  (target?.metadata as any)?.breetTradeId === '6a7f5512385f7180be28dd35',
  JSON.stringify((target?.metadata as any)?.breetTradeId));

console.log('\n── the same event twice changes nothing ────────────────────────');

await recordNgnWebhook('breet', WITHDRAWAL_COMPLETED, HEADERS);

const replayed = (await db.listNgnTransfers()).find((t: any) => t.id === 'ngnt_target') as any;
check('a redelivery is idempotent',
  replayed?.status === 'completed' && replayed?.completedAt === target?.completedAt,
  'Breet retries up to 7 times; a retry must not move anything');

const stillOther = (await db.listNgnTransfers()).find((t: any) => t.id === 'ngnt_other') as any;
check('and the redelivery does not spill onto the other order',
  stillOther?.status === 'settlement_processing',
  `${stillOther?.status}`);

console.log('\n── two orders for the SAME amount: refuse, never guess ─────────');

/**
 * THE CASE THAT MAKES THE AMOUNT FALLBACK SAFE OR DANGEROUS.
 *
 * Mutation-testing found this gap: relaxing the match from "exactly one
 * candidate" to "at least one" left the suite green, because nothing here had
 * two orders at the same price. A user who sells the same amount twice is
 * completely ordinary, so without this the fallback would silently complete
 * whichever order happened to be first while the other user's money was still
 * in flight.
 *
 * Refusing leaves an order pending, which the reconciler and a later
 * `trade.*` event can still resolve. Guessing tells someone their money has
 * arrived when it has not, and there is no way back from that.
 */
await db.mutate((d: any) => {
  d.ngnTransfers.push(
    transfer({ id: 'ngnt_dup_a', destinationAmount: '30000.00', sourceAmount: '21.50' }),
    transfer({ id: 'ngnt_dup_b', destinationAmount: '30000.00', sourceAmount: '21.50',
      createdAt: new Date(Date.now() + 120_000).toISOString() }),
  );
  return 1;
});

await recordNgnWebhook(
  'breet',
  { ...WITHDRAWAL_COMPLETED, id: 'wd_dup', trade: 'trade_dup',
    amount: 30000, originalAmount: 30000, payoutAmount: 29950 },
  HEADERS
);

const dupA = (await db.listNgnTransfers()).find((t: any) => t.id === 'ngnt_dup_a') as any;
const dupB = (await db.listNgnTransfers()).find((t: any) => t.id === 'ngnt_dup_b') as any;
check('an ambiguous payout completes NEITHER order',
  dupA?.status !== 'completed' && dupB?.status !== 'completed',
  `a=${dupA?.status} b=${dupB?.status} - guessing pays the wrong user's screen`);

console.log('\n── an unmatchable withdrawal is recorded, not silently dropped ──');

await recordNgnWebhook(
  'breet',
  { ...WITHDRAWAL_COMPLETED, id: 'unknown_wd', trade: 'unknown_trade',
    amount: 999999, originalAmount: 999999, payoutAmount: 999949 },
  HEADERS
);

const hooks = await db.listNgnWebhooks();
check('the unmatched delivery is stored for operators',
  hooks.some((h: any) => h.payload?.id === 'unknown_wd'),
  `${hooks.length} webhook row(s)`);
check('and it did not complete anything by accident',
  (await db.listNgnTransfers()).filter((t: any) => t.status === 'completed').length === 1,
  'a payout we cannot place must never advance an arbitrary order');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

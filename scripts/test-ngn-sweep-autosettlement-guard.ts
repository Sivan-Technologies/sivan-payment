/**
 * SIVAN MUST NOT SWEEP USER FUNDS INTO A BREET WALLET THAT CANNOT PAY OUT.
 *
 * A Breet off-ramp works in two hops:
 *
 *   1. Sivan sweeps the user's USDC/USDT from their own wallet into the Breet
 *      deposit address.
 *   2. Breet converts it and settles naira to the linked bank account.
 *
 * Hop 2 only happens if that Breet wallet has a bank linked AND auto-settlement
 * switched on. If it does not, hop 1 still succeeds - the crypto leaves the
 * user's wallet and lands in a Breet wallet that will never pay anyone. The
 * money is not lost, but it is out of the user's control and only recoverable
 * by hand, and the user is shown "settling" while nothing is settling.
 *
 * `sweepToRail` therefore refuses to sweep unless the order carries positive
 * proof - `metadata.transferMetadata.autoSettlementProof` with both
 * `bankLinked` and `autoSettlementEnabled` true - written at order creation by
 * `BreetNgnProvider.ensureWalletAutoSettlement`.
 *
 * WHY THIS TEST EXISTS SEPARATELY FROM test:breet-autosettlement-wallet.
 *
 * That suite proves the PROVIDER writes the proof. It stubs Breet's HTTP API
 * and never runs a sweep. Deleting the guard in ngn-transfers.service.ts left
 * it, and every other NGN suite, completely green - which is the definition of
 * an untested guard. This suite drives the real `acceptNgnQuote` ->
 * `scheduleSweep` -> `sweepToRail` path and asserts on the thing that actually
 * matters: whether the wallet provider was asked to move money.
 *
 * The absent-proof case is not hypothetical. Any off-ramp created before the
 * provider started writing the proof has metadata without it, and the
 * reconciler and admin retry both still walk those rows.
 *
 * Run: npm run test:ngn-sweep-autosettlement-guard
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-sweep-autosettlement-guard.json';
process.env.WALLET_PROVIDER = 'mock';
process.env.NGN_PROVIDER = 'breet';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'sweep-guard-admin-key';
process.env.USER_JWT_SECRET = 'sweep-guard-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.BREET_APP_ID = 'test_app_id';
process.env.BREET_APP_SECRET = 'test_app_secret';
process.env.BREET_ENV = 'development';

import fs from 'node:fs';
fs.rmSync('.data/test-sweep-autosettlement-guard.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { getWalletProvider } = await import('../src/wallets/provider/provider-registry.js');
const { BreetNgnProvider } = await import('../src/ngn/provider/breet.provider.js');
const { createNgnQuote } = await import('../src/ngn/service/ngn-quotes.service.js');
const { acceptNgnQuote } = await import('../src/ngn/service/ngn-transfers.service.js');

const now = () => new Date().toISOString();

/**
 * The Breet HTTP API is replaced at the PROVIDER boundary rather than at
 * `fetch`, because what varies between these two cases is exactly one field in
 * the order metadata. Stubbing fetch would force this test to also re-simulate
 * asset lookup, address generation and the two wallet PUTs - none of which it
 * is testing, and all of which test:breet-autosettlement-wallet already covers.
 */
const SOLANA_DEPOSIT = '4JStqvP44RT6zVSXjxhjMcTFNahsFCG4vF4WcaoXRzgv';
let proofToReturn: unknown;

/**
 * Pricing is stubbed with a fixed rate rather than left to hit Breet, which
 * answers "wrong app id and secret combination" without live credentials. The
 * numbers do not matter here; only that a Breet-provider quote exists to
 * accept, so `transfer.provider === 'breet'` and the guard is on the path.
 */
(BreetNgnProvider as any).prototype.createQuote = async (input: any) => {
  const source = Number(input.sourceAmount);
  const rate = 1500;
  return {
    provider: 'breet',
    providerQuoteId: 'breet_quote_test',
    sourceAmount: source.toFixed(2),
    destinationAmount: (source * rate).toFixed(2),
    rate: rate.toFixed(2),
    feeAmount: (source * 0.005).toFixed(6),
    metadata: { network: input.network, assetId: 'asset_usdt_sol_dev' },
  };
};

(BreetNgnProvider as any).prototype.createOfframpTransfer = async () => ({
  providerTransferId: 'wallet_123',
  status: 'awaiting_crypto_deposit' as const,
  depositAddress: SOLANA_DEPOSIT,
  metadata: {
    breet: true,
    assetId: 'asset_usdt_sol_dev',
    ...(proofToReturn === undefined ? {} : { autoSettlementProof: proofToReturn }),
  },
});

/**
 * Count real money movement, not log lines. `createTransfer` is the single
 * call that broadcasts the user's funds; if the guard works, the blocked case
 * must never reach it.
 */
const walletProvider: any = getWalletProvider('mock');
const originalCreateTransfer = walletProvider.createTransfer.bind(walletProvider);
let transfersBroadcast = 0;
walletProvider.createTransfer = async (input: any) => {
  transfersBroadcast += 1;
  return originalCreateTransfer(input);
};

async function seedUser(userId: string, accountNumber: string, amount: string) {
  const wallet: any = await walletProvider.createWallet({ chain: 'solana', customerId: userId } as any);
  await walletProvider.__seedBalance(wallet.providerWalletId, { asset: 'usdc', chain: 'solana', amount });
  await db.mutate((d: any) => {
    d.users = d.users ?? [];
    d.ngnPayoutAccounts = d.ngnPayoutAccounts ?? [];
    d.userWallets = d.userWallets ?? [];
    d.users.push({ id: userId, email: `${userId}@t.test`, emailVerifiedAt: now(), country: 'NG', fullName: 'SWEEP GUARD', createdAt: now(), updatedAt: now() });
    d.ngnPayoutAccounts.push({ id: `acct_${userId}`, userId, provider: 'breet', bankId: '25', bankName: 'OPay - Paycom',
      accountNumber, accountName: 'SWEEP GUARD', declaredName: 'SWEEP GUARD',
      matchVerdict: 'match', status: 'verified', createdAt: now(), updatedAt: now() });
    d.userWallets.push({ id: `wal_${userId}`, userId, provider: 'mock', providerWalletId: wallet.providerWalletId,
      chain: 'solana', address: wallet.address, status: 'active', custodial: true, createdAt: now(), updatedAt: now() });
    d.ngnControls = [{ id: 'global', onrampEnabled: true, offrampEnabled: true, mockProviderEnabled: true,
      bankSettlementEnabled: true, virtualAccountEnabled: false, activeProvider: 'breet',
      identityVerificationEnabled: false, externalFundingEnabled: false,
      limitEnforcementOfframp: true, limitEnforcementOnramp: true, limitEnforcementEscrow: true,
      maxTransactionNgn: '500000', dailyLimitNgn: '2000000', highValueReviewThresholdNgn: '1000000',
      updatedBy: 'seed', updatedAt: now() }];
    return 1;
  });
}

async function offramp(userId: string) {
  const quote: any = await createNgnQuote({
    userId, direction: 'offramp', sourceCurrency: 'usdc',
    destinationCurrency: 'ngn', sourceAmount: '20', network: 'solana',
  } as any);
  const order: any = await acceptNgnQuote({ userId, quoteId: quote.id } as any);
  // scheduleSweep runs on setImmediate and then awaits chain work.
  await new Promise((r) => setTimeout(r, 3000));
  return (await db.listNgnTransfers()).find((t: any) => t.id === order.id) as any;
}

console.log('\n── an order with no auto-settlement proof is NOT swept ───────');

proofToReturn = undefined;
await seedUser('usr_noproof', '8102524846', '80');
const before = transfersBroadcast;
const blocked = await offramp('usr_noproof');

check('no funds were broadcast out of the user wallet',
  transfersBroadcast === before,
  `createTransfer was called ${transfersBroadcast - before} time(s) - the user's crypto left for a wallet that cannot pay out`);
check('the transfer is parked for a human, not shown as settling',
  blocked.status === 'requires_review',
  `${blocked.status} - "settlement_processing" here would tell the user Breet is paying them when it is not`);
check('the reason is recorded on the transfer',
  (blocked.metadata as any)?.sweep?.status === 'blocked_auto_settlement_unverified',
  JSON.stringify((blocked.metadata as any)?.sweep ?? null));

const blockedLogs = await db.listAuditLogsByActions(['ngn.sweep_blocked']);
check('an error-severity audit log names the cause',
  blockedLogs.length === 1
    && blockedLogs[0].severity === 'error'
    && (blockedLogs[0].metadata as any)?.reason === 'auto_settlement_unverified',
  JSON.stringify(blockedLogs.map((l: any) => [l.action, l.severity, l.metadata?.reason])));

/**
 * A blocked sweep is not a sweep that merely needs the user to sign. Emitting
 * `sweep_requires_user_signature` here would put the order in the queue support
 * works through for stuck signatures, where nobody would ever link the bank.
 */
const signatureLogs = await db.listAuditLogsByActions(['ngn.sweep_requires_user_signature']);
check('it is NOT filed as a missing user signature',
  signatureLogs.length === 0,
  `${signatureLogs.length} signature log(s) - that is a different queue and a different fix`);

console.log('\n── half a proof is not a proof ───────────────────────────────');

proofToReturn = { walletId: 'wallet_123', bankLinked: true, autoSettlementEnabled: false };
await seedUser('usr_halfproof', '8102524847', '80');
const beforeHalf = transfersBroadcast;
const half = await offramp('usr_halfproof');

check('a bank-linked wallet with auto-settlement OFF is still refused',
  transfersBroadcast === beforeHalf && half.status === 'requires_review',
  `${half.status}, ${transfersBroadcast - beforeHalf} broadcast(s) - Breet would hold the crypto and settle nothing`);

const blockedAfterHalf = await db.listAuditLogsByActions(['ngn.sweep_blocked']);
check('each refusal is logged once, not once per rung',
  blockedAfterHalf.length === 2,
  `${blockedAfterHalf.length} block log(s), expected 2 (no-proof + half-proof)`);

console.log('\n── a proven wallet sweeps normally ───────────────────────────');

proofToReturn = { walletId: 'wallet_123', bankLinked: true, autoSettlementEnabled: true, checkedAt: now() };
await seedUser('usr_proven', '8102524848', '80');
const beforeOk = transfersBroadcast;
const swept = await offramp('usr_proven');

check('the funds ARE handed to the wallet provider',
  transfersBroadcast === beforeOk + 1,
  `${transfersBroadcast - beforeOk} broadcast(s) - the guard must not block a wallet that IS configured`);
check('the sweep is not marked blocked',
  (swept.metadata as any)?.sweep?.status !== 'blocked_auto_settlement_unverified',
  JSON.stringify((swept.metadata as any)?.sweep ?? null));
check('and it is not parked for review',
  swept.status !== 'requires_review',
  `${swept.status} - a working off-ramp must not land in the support queue`);

/**
 * The status here is `awaiting_crypto_deposit`, NOT `settlement_processing`,
 * and that is correct for this provider rather than a shortfall of the test.
 * MockWalletProvider declares `custodyModel = 'non_custodial'`, so its
 * createTransfer always answers `pending_user_signature` - and
 * `isRailSweepSubmitted` deliberately refuses to call that settled, because
 * telling a user Breet is paying them while the transaction is still unsigned
 * is the exact false-progress bug that check was added to prevent.
 *
 * So the honest assertion for the allowed path is "the provider was called and
 * nothing was blocked", above - not a status this provider cannot reach.
 */
check('the sweep result is recorded for support either way',
  Boolean((swept.metadata as any)?.sweep?.providerTransferId),
  JSON.stringify((swept.metadata as any)?.sweep ?? null));

const blockedAfterOk = await db.listAuditLogsByActions(['ngn.sweep_blocked']);
check('no new block was logged for the proven wallet',
  blockedAfterOk.length === 2,
  `${blockedAfterOk.length} block log(s), expected the 2 from the refused cases`);

walletProvider.createTransfer = originalCreateTransfer;

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

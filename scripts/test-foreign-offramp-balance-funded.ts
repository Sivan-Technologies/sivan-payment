/**
 * "I HOLD USDC IN MY SIVAN WALLET AND I WANT DOLLARS IN MY BANK."
 *
 * The naira rail has done this for a while: accept the order, then sweep the
 * user's USDC out of their Privy wallet to the rail's deposit address, from
 * `scheduleSweep` in ngn-transfers.service.ts.
 *
 * The FOREIGN rail - USD, GBP, EUR through Bridge - did not. It minted a
 * Bridge liquidation address and returned it, and that was the whole flow.
 * Nothing moved money. `grep -rn "sweep" src/offramp` matched zero lines.
 *
 * The user's own words: "he holds money in the privy wallet, can he send to
 * the bridge liquidation account and get his fiat". The answer was no, and
 * nothing in the product said so - the UI showed a deposit address exactly
 * like the naira one, which DOES self-fund. Two flows that look identical and
 * behave differently is worse than a missing feature.
 *
 * Three defects, all proven below by removing the fix and watching the
 * assertion fail:
 *
 *   1. createWithdrawalSchema had NO amount field, so the server could not
 *      have swept even if it wanted to - and could not enforce a limit either.
 *   2. Nothing measured a Bridge withdrawal against `offramp/foreign`, an
 *      allowance that exists, is returned by verification-summary, and was
 *      never once consulted. A Level 1 user could withdraw unlimited USD.
 *   3. MockBridgeProvider's Solana liquidation address was 'So' + random HEX.
 *      Hex contains '0'; base58 excludes it. 284 of 300 generated addresses
 *      could not be parsed by `new PublicKey()` - so the moment a sweep was
 *      pointed at one it would die exactly the way the naira sweep died in
 *      production ("Non-base58 character").
 *
 * Run: npx tsx scripts/test-foreign-offramp-balance-funded.ts
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-foreign-offramp.json';
process.env.WALLET_PROVIDER = 'mock';
process.env.NGN_PROVIDER = 'mock';
process.env.KYC_LEVEL_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'foreign-admin-key';
process.env.USER_JWT_SECRET = 'foreign-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-foreign-offramp.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { PublicKey } = await import('@solana/web3.js');
const { db } = await import('../src/database/json-database.js');
const { getWalletProvider } = await import('../src/wallets/provider/provider-registry.js');

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the Bridge liquidation address must be SENDABLE ───────');

const { MockBridgeProvider } = await import('../src/providers/bridge/mock-bridge.provider.js');
const bridge: any = new MockBridgeProvider();

/**
 * Not "is it a string" - it always was - but "can the code that will now send
 * to it actually parse it". `new PublicKey()` is the exact call the Solana
 * transfer path makes, so it is the exact call asserted.
 *
 * Run 200 times because the old bug was PROBABILISTIC: 'So'+hex only fails
 * when the random hex happens to contain a 0, which is ~95% of the time but
 * not always. A single-shot assertion could have gone green on the broken code.
 */
let parsed = 0, notBase58 = 0;
for (let i = 0; i < 200; i += 1) {
  const la = await bridge.createLiquidationAddress({
    customerId: 'c1', sourceCurrency: 'usdc', sourceChain: 'solana',
    externalAccountId: 'ea1', destinationCurrency: 'usd', destinationPaymentRail: 'ach',
  });
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(la.address))) notBase58 += 1;
  try { new PublicKey(la.address); parsed += 1; } catch { /* counted by omission */ }
}
check('all 200 Solana liquidation addresses parse as a PublicKey', parsed === 200, `${parsed}/200`);
check('and none contain a non-base58 character', notBase58 === 0, `${notBase58} bad`);

const evmLa = await bridge.createLiquidationAddress({
  customerId: 'c1', sourceCurrency: 'usdc', sourceChain: 'base',
  externalAccountId: 'ea1', destinationCurrency: 'usd', destinationPaymentRail: 'ach',
});
check('an EVM liquidation address is still 0x + 40 hex',
  /^0x[0-9a-f]{40}$/.test(String(evmLa.address)), String(evmLa.address));

// The literal broken shape, asserted directly so nobody reintroduces it.
let legacyThrew = false;
try { new PublicKey('So' + 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'); } catch { legacyThrew = true; }
check('the old So+hex shape genuinely throws', legacyThrew,
  'if this stops throwing the base58 fix is no longer load-bearing');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. seed a verified user holding 500 USDC ─────────────────');

const wallet: any = await getWalletProvider('mock').createWallet({ chain: 'solana', customerId: 'cus_f' } as any);
await (getWalletProvider('mock') as any).__seedBalance(wallet.providerWalletId, {
  asset: 'usdc', chain: 'solana', amount: '500',
});

await db.mutate((d: any) => {
  d.users = [{ id: 'usr_f', email: 'f@t.test', emailVerifiedAt: now(), country: 'NG',
    fullName: 'OGUNMEPON SHARAFA', createdAt: now(), updatedAt: now() }];
  d.customers = [{ id: 'cus_f', userId: 'usr_f', provider: 'bridge', providerCustomerId: 'mock_cust_f',
    customerType: 'individual', kycStatus: 'kyc_approved', createdAt: now(), updatedAt: now() }];
  d.userWallets = [{ id: 'wal_f', userId: 'usr_f', provider: 'mock', providerWalletId: wallet.providerWalletId,
    chain: 'solana', address: wallet.address, status: 'active', custodial: true, createdAt: now(), updatedAt: now() }];
  d.externalAccounts = [{ id: 'ea_f', userId: 'usr_f', customerId: 'cus_f', provider: 'bridge',
    providerExternalAccountId: 'mock_ea_f', currency: 'usd', accountType: 'us', bankName: 'Chase',
    accountOwnerName: 'OGUNMEPON SHARAFA', accountLast4: '6789', paymentRail: 'ach', status: 'verified',
    createdAt: now(), updatedAt: now() }];
  // The ledger the balance service reads. The mock wallet's on-chain balance
  // above and this credit are two different things and BOTH are required:
  // getSpendable reads the ledger, the provider checks the chain.
  d.auditLogs = d.auditLogs ?? [];
  d.balanceLedgerEntries = [{ entryId: 'bal_f', userId: 'usr_f', asset: 'usdc', amount: '500',
    kind: 'deposit', status: 'available', sourceType: 'wallet_deposit', sourceId: 'dep_f',
    description: 'seed', createdAt: now(), updatedAt: now() }];
  return 1;
});

const { getSpendable } = await import('../src/balances/unified-balance.service.js');
const spendable = await getSpendable('usr_f', 'usdc');
check('the user has 500 USDC spendable', Number(spendable) === 500, String(spendable));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. a balance-funded USD withdrawal SENDS the crypto ──────');

const { createWithdrawal } = await import('../src/offramp/service/withdrawals.service.js');

const result: any = await createWithdrawal({
  userId: 'usr_f', externalAccountId: 'ea_f', sourceCurrency: 'usdc',
  sourceChain: 'solana', destinationCurrency: 'usd',
  sourceAmount: 100, fundingSource: 'balance',
} as any);

check('the withdrawal is created', Boolean(result?.withdrawal?.id));
check('the amount is persisted on the record', String(result.withdrawal.sourceAmount) === '100',
  String(result.withdrawal.sourceAmount));
check('the response says it is balance-funded', result.fundingSource === 'balance', String(result.fundingSource));
check('a deposit address was issued', Boolean(result?.deposit?.address));

// The sweep is detached from the response on purpose - awaiting a blockchain
// inside the request is what blew the Cloudflare worker's 12s cap and returned
// a 503 for an order that HAD been created. So wait for it here.
await sleep(600);

const logs = (await db.read()).auditLogs ?? [];
const submitted = logs.find((l: any) => l.action === 'withdrawal.sweep_submitted' && l.resourceId === result.withdrawal.id);
const skipped = logs.find((l: any) => l.action === 'withdrawal.sweep_skipped' && l.resourceId === result.withdrawal.id);
const failed = logs.find((l: any) => l.action === 'withdrawal.sweep_failed' && l.resourceId === result.withdrawal.id);

check('a sweep was SUBMITTED', Boolean(submitted),
  `skipped=${JSON.stringify(skipped?.metadata)} failed=${JSON.stringify(failed?.metadata)}`);
check('it was sent to the liquidation address, not somewhere else',
  (submitted?.metadata as any)?.toAddress === result.deposit.address,
  `${(submitted?.metadata as any)?.toAddress} vs ${result.deposit.address}`);
check('for the exact amount requested', String((submitted?.metadata as any)?.amount) === '100',
  String((submitted?.metadata as any)?.amount));
check('on the network the user chose', (submitted?.metadata as any)?.network === 'solana');
check('and it carries a provider transfer id', Boolean((submitted?.metadata as any)?.providerTransferId));

const stored = (await db.read()).withdrawals.find((w: any) => w.id === result.withdrawal.id);
check('the withdrawal advanced past pending_deposit', stored?.status === 'deposit_received', String(stored?.status));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. GBP behaves identically ───────────────────────────────');

await db.mutate((d: any) => {
  d.externalAccounts.push({ id: 'ea_g', userId: 'usr_f', customerId: 'cus_f', provider: 'bridge',
    providerExternalAccountId: 'mock_ea_g', currency: 'gbp', accountType: 'gb', bankName: 'Monzo',
    accountOwnerName: 'OGUNMEPON SHARAFA', accountLast4: '5678', paymentRail: 'faster_payments',
    status: 'active', createdAt: now(), updatedAt: now() });
  return 1;
});

const gbp: any = await createWithdrawal({
  userId: 'usr_f', externalAccountId: 'ea_g', sourceCurrency: 'usdc',
  sourceChain: 'solana', destinationCurrency: 'gbp',
  sourceAmount: 50, fundingSource: 'balance',
} as any);
await sleep(600);
const gbpSubmitted = (await db.read()).auditLogs.find(
  (l: any) => l.action === 'withdrawal.sweep_submitted' && l.resourceId === gbp.withdrawal.id);
check('a GBP withdrawal also sweeps', Boolean(gbpSubmitted));
check('to its own distinct liquidation address',
  (gbpSubmitted?.metadata as any)?.toAddress !== (submitted?.metadata as any)?.toAddress);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. manual-send is preserved, not broken ──────────────────');

const manual: any = await createWithdrawal({
  userId: 'usr_f', externalAccountId: 'ea_f', sourceCurrency: 'usdc',
  sourceChain: 'solana', destinationCurrency: 'usd',
} as any);
await sleep(400);
check('an amount-less withdrawal is still accepted', Boolean(manual?.withdrawal?.id));
check('it is classified external', manual.fundingSource === 'external', String(manual.fundingSource));
check('and nothing was swept for it',
  !(await db.read()).auditLogs.some((l: any) => l.action === 'withdrawal.sweep_submitted' && l.resourceId === manual.withdrawal.id));
check('it still gets a usable deposit address', Boolean(manual?.deposit?.address));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 6. it refuses to send money the user does not have ───────');

/**
 * THE AMOUNT HERE IS CHOSEN, NOT ARBITRARY.
 *
 * USD 1,000 is ~NGN 1.5m, comfortably UNDER the ceiling, and far OVER the
 * ~350 USDC this user has left. That is the whole point: it isolates the
 * balance guard from the limit guard.
 *
 * The first version used USD 100,000, which the LIMIT refused before the
 * balance was ever consulted - so the assertion went green while testing
 * nothing about balances. It would have kept passing with the entire
 * spendable check deleted. Caught by making the failure branch loud instead
 * of accepting either outcome.
 */
const over: any = await createWithdrawal({
  userId: 'usr_f', externalAccountId: 'ea_f', sourceCurrency: 'usdc',
  sourceChain: 'solana', destinationCurrency: 'usd',
  sourceAmount: 1000, fundingSource: 'balance',
} as any).catch((e: Error) => ({ refused: e.message }));

if ((over as any).refused) {
  check('an unaffordable withdrawal is refused up front', false,
    `expected the sweep to run and skip, but creation threw: ${(over as any).refused}`);
} else {
  await sleep(600);
  const overLogs = (await db.read()).auditLogs;
  const overSkip = overLogs.find((l: any) => l.action === 'withdrawal.sweep_skipped' && l.resourceId === over.withdrawal.id);
  check('the oversized sweep is SKIPPED, with a reason',
    (overSkip?.metadata as any)?.reason === 'insufficient_spendable',
    JSON.stringify(overSkip?.metadata));
  check('the shortfall is stated, so support can act on it',
    typeof (overSkip?.metadata as any)?.shortfall === 'number');
  check('and nothing was reported as sent',
    !overLogs.some((l: any) => l.action === 'withdrawal.sweep_submitted' && l.resourceId === over.withdrawal.id));
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 7. a contradictory request is refused ────────────────────');

const contradiction = await createWithdrawal({
  userId: 'usr_f', externalAccountId: 'ea_f', sourceCurrency: 'usdc',
  sourceChain: 'solana', destinationCurrency: 'usd', fundingSource: 'balance',
} as any).then(() => null).catch((e: Error) => e.message);
check('fundingSource=balance with no amount is rejected', Boolean(contradiction), String(contradiction));
check('and the message tells the user what to do',
  /amount/i.test(String(contradiction)), String(contradiction));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 8. the foreign rail is now MEASURED against a limit ──────');

/**
 * `offramp/foreign` has always been a real allowance with a real ceiling, and
 * nothing on the Bridge path ever read it. This asserts the ceiling BINDS -
 * not merely that the code path runs.
 *
 * The user is Level 0 here (no bank check, no BVN), so the ceiling is small
 * and a large USD withdrawal must be refused.
 */
const { usdToNgn, usdToNgnRate } = await import('../src/kyc/service/foreign-rail-fx.js');
check('USD is converted to NGN before being measured', usdToNgn(100) === 100 * usdToNgnRate(),
  String(usdToNgn(100)));
check('a zero or nonsense amount converts to 0, never NaN',
  usdToNgn(0) === 0 && usdToNgn(NaN as any) === 0);

const huge = await createWithdrawal({
  userId: 'usr_f', externalAccountId: 'ea_f', sourceCurrency: 'usdc',
  sourceChain: 'solana', destinationCurrency: 'usd',
  sourceAmount: 10_000_000, fundingSource: 'balance',
} as any).then(() => null).catch((e: Error) => e.message);
check('a withdrawal far over the foreign ceiling is refused', Boolean(huge), String(huge));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

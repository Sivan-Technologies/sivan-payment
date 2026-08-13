/**
 * "WITHDRAW FROM MY BALANCE TO NAIRA" NEVER SWEPT. THE ADDRESS WAS UNUSABLE.
 *
 * Reported as the sandbox withdraw not working. Reproduced against the
 * deployed test API as a real signed-in user - quote fine, order created, then
 * stuck at `awaiting_crypto_deposit` forever with no txHash. The audit log
 * named it exactly:
 *
 *     ngn.sweep_failed
 *       reason: "Non-base58 character"
 *       depositAddress: "mock_avalanche_ab4417f71ff548f0b9683883394b21cf"
 *
 * MockNgnProvider.createOfframpTransfer returned `mock_avalanche_<uuid>` for
 * EVERY off-ramp, whatever network the quote asked for. Harmless while nothing
 * was sent to it - and fatal once scheduleSweep() began funding off-ramps from
 * the user's Sivan balance, because the Solana path does:
 *
 *     new PublicKey(input.recipientAddress)      // spl-transfer.ts:233
 *
 * which throws on 'l', '0' and '_'. The sweep died before broadcasting, and
 * the order sat telling the user to send crypto that Sivan had promised to
 * move for them - the entire point of the "From my Sivan balance" path, and
 * the only path left now that manual funding is switched off.
 *
 * WHY THE MOCK BEING WRONG WAS A REAL BUG, NOT A TEST-ONLY DETAIL.
 *
 * The sweep is production code doing real address validation even when the
 * RAIL is mocked. A mock that hands back an address the sweep cannot parse
 * does not exercise the happy path at all - it only ever exercises the error
 * path, which is why every existing suite passed while the sandbox was broken.
 *
 * Run: npm run test:ngn-offramp-sweep-address
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-sweep-address.json';
process.env.WALLET_PROVIDER = 'mock';
process.env.NGN_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'sweep-admin-key';
process.env.USER_JWT_SECRET = 'sweep-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-sweep-address.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { PublicKey } = await import('@solana/web3.js');
const { db } = await import('../src/database/json-database.js');
const { getWalletProvider } = await import('../src/wallets/provider/provider-registry.js');

const now = () => new Date().toISOString();

console.log('\n── the address must be decodable by the chain it is for ──────');

/**
 * THE ASSERTION THAT WOULD HAVE CAUGHT THIS.
 *
 * Not "does the mock return a string" - it always did - but "can the real
 * Solana path parse it". new PublicKey() is the exact call that threw in
 * production, so it is the exact call used here.
 */
const { MockNgnProvider } = await import('../src/ngn/provider/mock-ngn.provider.js');
const provider: any = new MockNgnProvider();

const solOrder = await provider.createOfframpTransfer({
  id: 'q_sol', metadata: { network: 'solana' },
} as any);

let solParsed = true;
let solError = '';
try { new PublicKey(solOrder.depositAddress); } catch (e) { solParsed = false; solError = (e as Error).message; }
check('a Solana off-ramp address parses as a real PublicKey', solParsed,
  `${solOrder.depositAddress} -> ${solError}`);
check('and it is base58 with no 0/O/I/l',
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(solOrder.depositAddress)),
  String(solOrder.depositAddress));

const evmOrder = await provider.createOfframpTransfer({
  id: 'q_evm', metadata: { network: 'base' },
} as any);
check('a Base off-ramp address is 0x + 40 hex',
  /^0x[0-9a-f]{40}$/.test(String(evmOrder.depositAddress)),
  String(evmOrder.depositAddress));

check('the two networks get DIFFERENT address shapes',
  String(solOrder.depositAddress).slice(0, 2) !== '0x',
  'one hardcoded shape for every chain is exactly the reported bug');

/**
 * The literal string from the production audit log, asserted directly. If
 * anyone reintroduces a prefixed placeholder, this says why it cannot work.
 */
let legacyThrew = false;
try { new PublicKey('mock_avalanche_ab4417f71ff548f0b9683883394b21cf'); }
catch { legacyThrew = true; }
check('the old mock_avalanche_ address genuinely throws', legacyThrew,
  'if this ever stops throwing, the fix below is no longer needed');

console.log('\n── end to end: balance -> naira actually sweeps ──────────────');

const wallet: any = await getWalletProvider('mock').createWallet({ chain: 'solana', customerId: 'c1' } as any);
await (getWalletProvider('mock') as any).__seedBalance(wallet.providerWalletId, {
  asset: 'usdc', chain: 'solana', amount: '80',
});

await db.mutate((d: any) => {
  d.users = [{ id: 'usr_w', email: 'w@t.test', emailVerifiedAt: now(), country: 'NG', fullName: 'OGUNMEPON SHARAFA', createdAt: now(), updatedAt: now() }];
  d.ngnPayoutAccounts = [{ id: 'a1', userId: 'usr_w', provider: 'mock', bankId: '1', bankName: 'Access Bank',
    accountNumber: '1111111111', accountName: 'OGUNMEPON SHARAFA', declaredName: 'OGUNMEPON SHARAFA',
    matchVerdict: 'match', status: 'verified', createdAt: now(), updatedAt: now() }];
  d.userWallets = [{ id: 'wal1', userId: 'usr_w', provider: 'mock', providerWalletId: wallet.providerWalletId,
    chain: 'solana', address: wallet.address, status: 'active', custodial: true, createdAt: now(), updatedAt: now() }];
  d.ngnControls = [{ id: 'global', onrampEnabled: true, offrampEnabled: true, mockProviderEnabled: true,
    bankSettlementEnabled: true, virtualAccountEnabled: false, activeProvider: 'mock',
    identityVerificationEnabled: false, externalFundingEnabled: false,
    limitEnforcementOfframp: true, limitEnforcementOnramp: true, limitEnforcementEscrow: true,
    maxTransactionNgn: '500000', dailyLimitNgn: '2000000', highValueReviewThresholdNgn: '1000000',
    updatedBy: 'seed', updatedAt: now() }];
  return 1;
});

const { createNgnQuote } = await import('../src/ngn/service/ngn-quotes.service.js');
const { acceptNgnQuote } = await import('../src/ngn/service/ngn-transfers.service.js');

const quote: any = await createNgnQuote({
  userId: 'usr_w', direction: 'offramp', sourceCurrency: 'usdc',
  destinationCurrency: 'ngn', sourceAmount: '20', network: 'solana',
} as any);
check('a balance-funded quote is priced', Boolean(quote?.id), JSON.stringify(quote).slice(0, 120));

const order: any = await acceptNgnQuote({ userId: 'usr_w', quoteId: quote.id } as any);
check('the order is created', Boolean(order?.id));
check('its deposit address is Solana-shaped',
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(order.depositAddress)),
  String(order.depositAddress));

// scheduleSweep runs on setImmediate; give it a moment.
await new Promise((r) => setTimeout(r, 3000));

const settled: any = (await db.listNgnTransfers()).find((t: any) => t.id === order.id);
check('the sweep moves it OFF awaiting_crypto_deposit',
  settled.status === 'settlement_processing',
  `${settled.status} - stuck here is the reported symptom`);
check('and records what it swept',
  Boolean((settled.metadata as any)?.sweep?.providerTransferId),
  JSON.stringify((settled.metadata as any)?.sweep ?? null));

const failures = await db.listAuditLogsByActions(['ngn.sweep_failed']);
check('with no sweep failure logged', failures.length === 0,
  JSON.stringify(failures[0]?.metadata ?? null).slice(0, 160));

console.log('\n── regression: pending signature is NOT settlement ───────────');

const pendingWallet: any = await getWalletProvider('mock').createWallet({ chain: 'solana', customerId: 'c2' } as any);
await (getWalletProvider('mock') as any).__seedBalance(pendingWallet.providerWalletId, {
  asset: 'usdc', chain: 'solana', amount: '40',
});

await db.mutate((d: any) => {
  d.users.push({ id: 'usr_pending', email: 'pending@t.test', emailVerifiedAt: now(), country: 'NG', fullName: 'PENDING SIGNATURE', createdAt: now(), updatedAt: now() });
  d.ngnPayoutAccounts.push({ id: 'a_pending', userId: 'usr_pending', provider: 'mock', bankId: '1', bankName: 'Access Bank',
    accountNumber: '2222222222', accountName: 'PENDING SIGNATURE', declaredName: 'PENDING SIGNATURE',
    matchVerdict: 'match', status: 'verified', createdAt: now(), updatedAt: now() });
  d.userWallets.push({ id: 'wal_pending', userId: 'usr_pending', provider: 'mock', providerWalletId: pendingWallet.providerWalletId,
    chain: 'solana', address: pendingWallet.address, status: 'active', custodial: true, createdAt: now(), updatedAt: now() });
  return 1;
});

const mockWalletProvider: any = getWalletProvider('mock');
const originalCreateTransfer = mockWalletProvider.createTransfer.bind(mockWalletProvider);
mockWalletProvider.createTransfer = async (input: any) => ({
  provider: 'mock',
  providerTransferId: `privy_pending_${input.idempotencyKey}`,
  status: 'pending_user_signature',
  userSignaturePayload: { reference: input.reference, toAddress: input.toAddress },
});

const pendingQuote: any = await createNgnQuote({
  userId: 'usr_pending', direction: 'offramp', sourceCurrency: 'usdc',
  destinationCurrency: 'ngn', sourceAmount: '10', network: 'solana',
} as any);
const pendingOrder: any = await acceptNgnQuote({ userId: 'usr_pending', quoteId: pendingQuote.id } as any);
await new Promise((r) => setTimeout(r, 3000));

const stillWaiting: any = (await db.listNgnTransfers()).find((t: any) => t.id === pendingOrder.id);
check('a pending user signature does NOT become settlement_processing',
  stillWaiting.status === 'awaiting_crypto_deposit',
  `${stillWaiting.status} would falsely tell the user Breet is settling`);
check('the pending sweep status is stored for support',
  (stillWaiting.metadata as any)?.sweep?.status === 'pending_user_signature',
  JSON.stringify((stillWaiting.metadata as any)?.sweep ?? null));

mockWalletProvider.createTransfer = originalCreateTransfer;

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

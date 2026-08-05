/**
 * THE FEE MUST NOT LOSE ANYONE'S MONEY.
 *
 * Pricing a transfer changes the money math, and this is the file that proves
 * it still balances. The transfer path has already produced two real incidents -
 * a hold that was not released on a gateway timeout, and a getSpendable that
 * asked the wrong source and blocked funded users - so a change to the hold and
 * debit arithmetic is the highest-risk edit in the codebase.
 *
 * THE INVARIANT, stated once:
 *
 *     hold placed  ==  debit_transfer (the net) + fee
 *
 * Both entries clear the same hold. If they do not sum exactly, `held` never
 * returns to zero and the user has money that is neither spendable nor spent -
 * silently frozen, which is worse than a visible error.
 *
 * Runs the REAL service against a real JSON store. A source-grep suite would
 * pass against a fee that is quoted and never charged.
 *
 * Run: npm run test:transfer-fee-ledger
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Seed BEFORE importing anything that reads the store: the JSON database caches
// in memory on first read, so a later out-of-process write is invisible.
const dbFile = path.join(root, '.data', 'test-transfer-fee-ledger.json');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const now = new Date().toISOString();
fs.writeFileSync(dbFile, JSON.stringify({
  users: [{ id: 'user_fee', email: 'fee@example.com', createdAt: now }],
  userWallets: [{
    id: 'wal_fee', userId: 'user_fee', provider: 'mock', providerWalletId: 'mock_fee',
    chain: 'base', address: '0xFEE0000000000000000000000000000000000001',
    status: 'active', custodial: false, createdAt: now,
  }],
  walletControls: [{ id: 'singleton', activeProvider: 'mock', updatedAt: now }],
  auditLogs: [],
}));
process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = dbFile;
process.env.BALANCE_TRANSFERS_ENABLED = 'true';
process.env.WALLET_PROVIDER = 'mock';
process.env.ALLOW_MOCK_WALLETS = 'true';
process.env.EMAIL_PROVIDER = 'console';
process.env.BRIDGE_MOCK_MODE = 'true';

const {
  requestBalanceTransfer, getUserBalance, getBalanceTransferControls,
  quoteTransfer, listUserBalanceLedger, createBalanceLedgerEntry,
} = await import('../src/balances/balance.service.js');
const { getWalletProvider } = await import('../src/wallets/provider/provider-registry.js');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const num = (v: unknown) => Number(v ?? 0);

// Fund the mock wallet so getSpendable sees real money on chain.
const provider = getWalletProvider('mock') as any;
(provider as any).wallets?.set?.('mock_fee', {
  providerWalletId: 'mock_fee', chain: 'base',
  address: '0xFEE0000000000000000000000000000000000001',
  custodyModel: 'non_custodial',
  balances: [{ asset: 'usdc', chain: 'base', amount: '1000.000000' }],
});

console.log('\n── the controls now come from the fee tab ────────────────────');

const controls = await getBalanceTransferControls();
check('the minimum send amount is 5, not the old hardcoded 10',
  controls.minimumSendAmount === 5,
  `${controls.minimumSendAmount} - it must be admin-settable, not env-only`);
check('ethereum is disabled for transfers',
  !controls.supportedNetworks.includes('ethereum' as any),
  `${controls.supportedNetworks.join(',')} - ethereum loses money at every size`);
check('base and solana remain enabled',
  controls.supportedNetworks.includes('base' as any) &&
  controls.supportedNetworks.includes('solana' as any));

console.log('\n── a transfer is priced before it is sent ────────────────────');

const quote = await quoteTransfer(100);
check('a 100 USDC transfer is quoted at $0.50', Number(quote.fee) === 0.5, quote.fee);
check('and nets 99.50 to the recipient', Number(quote.netAmount) === 99.5, quote.netAmount);

const transfer = await requestBalanceTransfer('user_fee', {
  asset: 'usdc', network: 'base', amount: 100,
  destinationAddress: '0xAAA0000000000000000000000000000000000002',
} as any);

check('the transfer records the fee', Number((transfer as any).fee) === 0.5, String((transfer as any).fee));
check('the transfer records the net amount', Number((transfer as any).netAmount) === 99.5, String((transfer as any).netAmount));
check('the gross amount is unchanged', Number(transfer.amount) === 100, transfer.amount);
check('the fee uses the same string format as the amount',
  !/\.\d*0$/.test(String((transfer as any).fee)) && !/\.\d*0$/.test(String(transfer.amount)),
  `amount="${transfer.amount}" fee="${(transfer as any).fee}" - two formats in one record is how string comparisons silently disagree`);

console.log('\n── THE INVARIANT: hold == debit + fee ────────────────────────');

const ledger = await listUserBalanceLedger('user_fee');
const of = (kind: string) => ledger.filter((e: any) => e.kind === kind && e.transferId === transfer.transferId);

const holds = of('hold');
const debits = of('debit_transfer');
const fees = of('fee');

check('exactly one hold was placed', holds.length === 1, `${holds.length}`);
check('the hold is the GROSS amount', num(holds[0]?.amount) === 100,
  `${holds[0]?.amount} - holding only the net would leave the fee unfunded`);
check('exactly one debit was written', debits.length === 1, `${debits.length}`);
check('the debit is the NET amount', num(debits[0]?.amount) === 99.5,
  `${debits[0]?.amount} - this is what actually left for the recipient`);
check('exactly one fee entry was written', fees.length === 1, `${fees.length}`);
check('the fee entry is its own ledger kind', fees[0]?.kind === 'fee',
  'folding it into debit_transfer would make Sivan revenue unmeasurable');
check('the fee is 0.50', num(fees[0]?.amount) === 0.5, `${fees[0]?.amount}`);

check('debit + fee exactly clears the hold',
  Math.abs((num(debits[0]?.amount) + num(fees[0]?.amount)) - num(holds[0]?.amount)) < 1e-9,
  `${debits[0]?.amount} + ${fees[0]?.amount} != ${holds[0]?.amount}`);

console.log('\n── WHAT WAS ACTUALLY BROADCAST TO THE CHAIN ──────────────────');

/**
 * THE ASSERTION THIS SUITE WAS MISSING, and it is the most important one.
 *
 * Every ledger check above still passed when the provider was handed the GROSS
 * amount instead of the net - because the ledger says one thing and the chain
 * does another, which is precisely the divergence that costs real money. The
 * user would have had 100 leave their wallet on chain AND been charged a 0.50
 * fee on top: 100.50 for a 100 send.
 *
 * So ask the provider what it was told to send, rather than trusting the record
 * of what we intended to send.
 */
const broadcast = [...((provider as any).transfers?.values?.() ?? [])] as any[];
const sentForTransfer = broadcast
  .map((t) => t?.rawProviderPayload?.input)
  .filter((i) => i && i.reference === transfer.transferId);

check('the provider was called exactly once for this transfer',
  sentForTransfer.length === 1, `${sentForTransfer.length} calls`);
check('the chain was asked to move the NET amount',
  Number(sentForTransfer[0]?.amount) === 99.5,
  `broadcast ${sentForTransfer[0]?.amount} - sending the gross would charge the user 100.50 for a 100 send`);
check('the chain was NOT asked to move the gross',
  Number(sentForTransfer[0]?.amount) !== 100,
  'the fee must come out of the amount, not be added on top of it');
check('what was broadcast plus the fee equals what the user paid',
  Math.abs((Number(sentForTransfer[0]?.amount) + num((transfer as any).fee)) - Number(transfer.amount)) < 1e-9,
  `${sentForTransfer[0]?.amount} + ${(transfer as any).fee} != ${transfer.amount}`);

console.log('\n── the balance returns to a consistent state ─────────────────');

const balance = await getUserBalance('user_fee');
const usdc = balance.balances.find((b: any) => b.asset === 'usdc') as any;
check('nothing is left held', num(usdc?.held) === 0,
  `${usdc?.held} held - money that is neither spendable nor spent is frozen`);
check('the full gross is accounted as spent', num(usdc?.spent) === 100,
  `${usdc?.spent} - the user parted with 100, whoever received it`);

console.log('\n── the fee is separable, which is the point of its own kind ──');

const revenue = ledger.filter((e: any) => e.kind === 'fee').reduce((sum: number, e: any) => sum + num(e.amount), 0);
check('Sivan revenue can be summed from the ledger alone', revenue === 0.5, String(revenue));
check('and it is distinguishable from money sent to the recipient',
  revenue !== ledger.filter((e: any) => e.kind === 'debit_transfer').reduce((s: number, e: any) => s + num(e.amount), 0));

console.log('\n── a second transfer does not disturb the first ──────────────');

const t2 = await requestBalanceTransfer('user_fee', {
  asset: 'usdc', network: 'base', amount: 10,
  destinationAddress: '0xBBB0000000000000000000000000000000000003',
} as any);
check('a 10 USDC transfer pays the 0.10 floor', Number((t2 as any).fee) === 0.1, String((t2 as any).fee));
check('and nets 9.90', Number((t2 as any).netAmount) === 9.9, String((t2 as any).netAmount));

const ledger2 = await listUserBalanceLedger('user_fee');
const t2fees = ledger2.filter((e: any) => e.kind === 'fee' && e.transferId === t2.transferId);
check('the second fee is its own entry', t2fees.length === 1, `${t2fees.length}`);
const totalRevenue = ledger2.filter((e: any) => e.kind === 'fee').reduce((s: number, e: any) => s + num(e.amount), 0);
check('total revenue is the sum of both fees', Math.abs(totalRevenue - 0.6) < 1e-9, String(totalRevenue));

console.log('\n── the fee ledger entry is idempotent ────────────────────────');

/**
 * createBalanceLedgerEntry dedupes on (sourceType, sourceId, kind). The new
 * `fee` kind must get its own slot - if it collided with debit_transfer the
 * fee would be silently dropped, and if it did not dedupe at all a retried
 * broadcast would charge twice.
 */
await createBalanceLedgerEntry({
  userId: 'user_fee', asset: 'usdc', amount: '0.500000', kind: 'fee', status: 'completed',
  sourceType: 'balance_transfer', sourceId: transfer.transferId,
  description: 'duplicate attempt', network: 'base', transferId: transfer.transferId,
} as any, { actorType: 'system' });

const afterDup = await listUserBalanceLedger('user_fee');
const dupFees = afterDup.filter((e: any) => e.kind === 'fee' && e.transferId === transfer.transferId);
check('re-writing the same fee does not charge twice', dupFees.length === 1, `${dupFees.length} fee entries`);

console.log('\n── below the minimum is still refused ────────────────────────');

let refused = false;
try {
  await requestBalanceTransfer('user_fee', {
    asset: 'usdc', network: 'base', amount: 2,
    destinationAddress: '0xCCC0000000000000000000000000000000000004',
  } as any);
} catch { refused = true; }
check('a $2 transfer is refused below the $5 minimum', refused,
  'at $2 the $0.10 floor would be a 5% rate');

console.log('\n── a disabled network is refused ─────────────────────────────');

let ethRefused = false;
try {
  await requestBalanceTransfer('user_fee', {
    asset: 'usdc', network: 'ethereum', amount: 100,
    destinationAddress: '0xDDD0000000000000000000000000000000000005',
  } as any);
} catch { ethRefused = true; }
check('an ethereum transfer is refused', ethRefused,
  'ethereum loses $2-3 on every send regardless of size');

console.log('\n── the release path returns the WHOLE hold ───────────────────');

const svc = fs.readFileSync(path.join(root, 'src/balances/balance.service.ts'), 'utf8');
const releaseUsesGross = /kind: 'hold_release'[\s\S]{0,400}?amount: money\(input\.amount\)|amount: money\(input\.amount\),[\s\S]{0,200}kind: 'hold_release'/.test(svc);
check('a failed transfer releases the gross amount, not the net',
  releaseUsesGross,
  'releasing only the net would silently keep the fee on a transfer that never happened');
check('the fee is only charged after the provider accepts',
  svc.indexOf("kind: 'fee'") > svc.indexOf('provider.createTransfer'),
  'charging before the broadcast takes money for a send that may fail');

fs.rmSync(dbFile, { force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

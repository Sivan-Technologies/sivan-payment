/**
 * A SELECTED TRANSACTION MUST SHOW ITS DETAIL.
 *
 * Reported with two screenshots side by side. Clicking a crypto send gives the
 * row a green selected border and leaves the panel reading
 *
 *     "Select a transaction to see its timeline."
 *
 * while the naira sell immediately below opens a full detail view. The page
 * does not look incomplete, it looks broken - the user has clicked and the app
 * has told them to click.
 *
 * TWO BUGS BEHIND IT.
 *
 * 1. detailRows is built from withdrawals, on-ramp orders and naira transfers
 *    only. A crypto send, deposit, supplier payout or virtual-account deposit
 *    is not in that map, so detailById.get() returned undefined and the panel
 *    rendered the empty state - the same state as "nothing is selected". The
 *    code's own comment claimed the fallback "renders as a summary"; it did
 *    not.
 *
 * 2. walletDeposits reached the DASHBOARD feed but were never passed to the
 *    Transactions page, so deposits were missing from it entirely. That is the
 *    exact divergence this file's header comment warns about, reintroduced by
 *    me when deposits shipped.
 *
 * Run: npm run test:transaction-detail-panel
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const strip = (src: string) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { networkLabel, explorerLink, shortHash } = await import('../frontend/src/blockExplorer.js');
const { buildActivityFeed } = await import('../frontend/src/activityFeed.js');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const panel = read('frontend/src/components/transactions/TransactionsSection.tsx');
const panelCode = strip(panel);
const app = read('frontend/src/App.tsx');

console.log('\n── a selected row never shows the empty state ────────────────');

check('the panel takes the feed row as a fallback',
  /activityRow\?: ActivityRow \| null/.test(panelCode),
  'without it there is nothing to render for a crypto send');
check('and renders a summary when there is no server timeline',
  /if \(!transaction\?\.timeline && activityRow\) \{/.test(panelCode),
  'this branch is what replaces "Select a transaction"');
check('the empty state is now only reachable with NO row at all',
  panelCode.indexOf('Select a transaction to see its timeline') >
  panelCode.indexOf('if (!transaction?.timeline && activityRow)'),
  'the fallback must be checked before the empty state');
check('the selected row is passed down',
  /activityRow=\{selectedRow\}/.test(panelCode),
  'selectedRow is always set when the list is non-empty; `selected` often is not');

console.log('\n── deposits reach the transactions page ──────────────────────');

check('TransactionsView accepts walletDeposits',
  /walletDeposits\?: WalletDepositRecord\[\]/.test(panelCode));
check('and feeds them into the shared merge',
  /buildActivityFeed\(\{[^}]*walletDeposits[^}]*\}\)/.test(panelCode));
check('walletDeposits is in the memo dependency list',
  /\[withdrawals, onrampOrders, ngnTransfers, balanceTransfers, supplierPayments, virtualAccountTransactions, walletDeposits\]/.test(panelCode),
  'omitting it means the feed never updates when a deposit arrives');
check('App passes them to the page',
  /<TransactionsView[^>]*walletDeposits=\{walletDeposits\}/.test(app),
  'they were on the dashboard feed and not here - the divergence this file warns about');

console.log('\n── every activity kind resolves to something ─────────────────');

const now = new Date().toISOString();
const feed = buildActivityFeed({
  withdrawals: [{ id: 'w1', status: 'completed', createdAt: now, destinationCurrency: 'gbp', destinationAmount: '400' }],
  supplierPayments: [{ id: 's1', status: 'processing', createdAt: now, amount: '1200', destinationCurrency: 'usd' }],
  virtualAccountTransactions: [{ id: 'v1', status: 'completed', createdAt: now, sourceAmount: '5', sourceCurrency: 'usd' }],
  walletDeposits: [{ id: 'd1', status: 'pending', createdAt: now, asset: 'USDC', amount: '50', chain: 'base' }],
  balanceTransfers: [{ transferId: 'b1', status: 'completed', createdAt: now, asset: 'usdc', amount: '10', network: 'solana', txHash: 'SIG123' }],
  ngnTransfers: [{ id: 'n1', status: 'completed', createdAt: now, direction: 'offramp', destinationAmount: '82473', network: 'solana' }],
  onrampOrders: [{ id: 'o1', status: 'completed', createdAt: now, amount: '20', sourceCurrency: 'usd', destinationChain: 'base' }],
} as any);

check('all seven sources produce a row', feed.length === 7, `${feed.length}`);
for (const row of feed) {
  check(`${row.kind} has a label and an amount`,
    Boolean(row.label) && Boolean(row.amount),
    'the summary card renders these directly');
}

console.log('\n── chain names are capitalised, everywhere ───────────────────');

check('solana renders as Solana', networkLabel('solana') === 'Solana');
check('base renders as Base', networkLabel('base') === 'Base');
check('an unknown chain still gets a capital',
  networkLabel('some_new_chain') === 'Some new chain',
  networkLabel('some_new_chain'));
check('undefined is safe', networkLabel(undefined) === '');
check('the panel uses networkLabel and not a raw replaceAll',
  /networkLabel\(activityRow\.network\)/.test(panelCode) &&
  !/activityRow\.network\.replaceAll/.test(panelCode),
  'a rendered screenshot caught "Sent on solana" and a Network field reading "base"');

console.log('\n── fiat rows are not offered chain affordances ───────────────');

check('the panel distinguishes on-chain from bank rails',
  /const onChain = Boolean\(activityRow\.network\)/.test(panelCode));
check('a bank transfer shows no transaction hash field',
  /\{onChain && <Kv label="Transaction hash"/.test(panelCode),
  'showing "Pending" implies a hash is coming, and for a bank payout it never is');
check('and is not promised an explorer link',
  /: onChain && activityRow\.state === 'pending'/.test(panelCode),
  'a promise that can never come true is worse than saying nothing');
/**
 * A CONFIRMED on-chain row with no hash will never get one either. The poller
 * detects deposits by diffing balances, so it sees that money arrived without
 * ever seeing the transaction - "a link appears once the network confirms" on
 * a row already reading Confirmed is a promise that silently never resolves.
 * Caught by looking at a rendered screenshot, after every assertion passed.
 */
check('a confirmed row with no hash says so instead of promising a link',
  /detected from an on-chain balance change/.test(panelCode),
  'the poller never sees a transaction, so no amount of waiting produces one');
check('and its hash field reads "Not recorded", not "Pending"',
  /'Not recorded'/.test(panelCode),
  'nothing is pending on a confirmed transfer');
check('its Network field says what it actually is',
  /'Bank transfer'/.test(panelCode),
  'blank reads as missing data; "Bank transfer" is the truth');

console.log('\n── the explorer link is honest ───────────────────────────────');

const solLink = explorerLink({ network: 'solana', txHash: 'SIG123', networkMode: 'testnet' });
check('a solana send with a signature gets a link', Boolean(solLink), JSON.stringify(solLink));
check('and a devnet send is badged as testnet', solLink?.testnet === true);
const noHash = explorerLink({ network: 'solana', txHash: undefined });
check('no hash means NO link, not a guessed one', noHash === undefined,
  'a 404 reads to the user as evidence about their money');
const fiatLink = explorerLink({ network: undefined, txHash: undefined });
check('a bank transfer gets no link', fiatLink === undefined);

check('the hash is shortened for display',
  shortHash('4RPuLPbYvJ8dQvGgWnh1kUUq9YvT7cGZ4Kh5xN2mSdVpQeLrT8fMwXyZaB3cD6eF9gH2jK5mN8pQ1rS4tU7v').length < 20,
  'an 88-character Solana signature wraps to three lines and pushes the card apart');

console.log('\n── the summary explains what happened, honestly ──────────────');

check('an explanation helper exists', /function activitySummaryExplanation/.test(panelCode));
check('it does not invent an arrival time',
  !/arrives in|estimated arrival|within \d+ (minutes|hours)/i.test(panelCode),
  'Sivan does not control when a chain confirms');
check('a failed send says the money came back',
  /returned to your balance/.test(panelCode),
  '"failed" alone leaves the user wondering where their funds went');
check('a broadcast send says it cannot be reversed',
  /cannot be reversed once broadcast/.test(panelCode),
  'the one thing a user most needs to know before asking support to cancel');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

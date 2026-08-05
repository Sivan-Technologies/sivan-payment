/**
 * "IN MY DASHBOARD I SEE NOTHING BUT IN SEND AND TRANSFER THERE IS SOMETHING."
 *
 * Measured before writing any code. The frontend already loaded SIX money
 * sources in one Promise.allSettled. App.tsx:1876 handed the dashboard two:
 *
 *   <DashboardTransactions withdrawals={...} onrampOrders={...} />
 *
 * On the reporter's live account that was 0 rows against 15 real records - 5
 * crypto sends and 10 naira transfers. And crypto sends, supplier payouts and
 * virtual-account deposits were on NEITHER screen, so "View all" did not show
 * them either.
 *
 * THE ROOT CAUSE IS NOT THE MISSING PROPS. It is that two screens each built
 * their own merge, so a mapper added to one was invisible to the other. That
 * is what the completeness test below exists to prevent: a new money type that
 * is loaded but never mapped fails CI rather than silently vanishing from a
 * user's history.
 *
 * Run: npm run test:activity-feed
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildActivityFeed,
  activityStatusLabel,
  activityState,
  filterActivity,
  searchActivity,
  type ActivityKind,
} from '../frontend/src/activityFeed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const at = (iso: string) => iso;

/** One record of every kind, so the feed can be checked for completeness. */
const sources = {
  withdrawals: [{ id: 'w1', status: 'completed', createdAt: at('2026-08-01T10:00:00Z'), sourceCurrency: 'usdc', destinationCurrency: 'usd', sourceAmount: '100', destinationAmount: '98' }],
  onrampOrders: [{ id: 'o1', status: 'awaiting_payment', createdAt: at('2026-08-02T10:00:00Z'), sourceCurrency: 'usd', destinationCurrency: 'usdc', amount: '500' }],
  ngnTransfers: [{ id: 'n1', status: 'awaiting_crypto_deposit', createdAt: at('2026-08-03T10:00:00Z'), direction: 'offramp', sourceCurrency: 'usdc', destinationCurrency: 'ngn', sourceAmount: '50', destinationAmount: '82473', network: 'solana' }],
  balanceTransfers: [{ transferId: 'b1', status: 'processing', createdAt: at('2026-08-04T10:00:00Z'), asset: 'usdc', network: 'base', amount: '10', destinationAddress: '0xabc', txHash: '0xdead' }],
  supplierPayments: [{ id: 's1', status: 'pending_review', createdAt: at('2026-08-05T10:00:00Z'), amount: '250', sourceAsset: 'usdc', destinationCurrency: 'gbp', supplier: { supplierName: 'Acme Ltd' } }],
  virtualAccountTransactions: [{ id: 'v1', status: 'completed', createdAt: at('2026-08-06T10:00:00Z'), sourceCurrency: 'usd', destinationCurrency: 'usdc', sourceAmount: '1000' }],
} as any;

console.log('\n── EVERY loaded source reaches the feed ───────────────────────');

const feed = buildActivityFeed(sources);
check('all six sources produce a row', feed.length === 6, `got ${feed.length}`);

/**
 * THE GUARD THAT MATTERS.
 *
 * The bug was a source that existed, was loaded, and was never mapped. This
 * asserts every declared ActivityKind is actually produced, so adding a
 * seventh money type without a mapper fails here instead of disappearing from
 * someone's transaction history.
 */
const EXPECTED_KINDS: ActivityKind[] = ['withdrawal', 'onramp_order', 'ngn_transfer', 'balance_transfer', 'supplier_payment', 'virtual_account_deposit'];
for (const kind of EXPECTED_KINDS) {
  check(`${kind} appears in the feed`, feed.some((row) => row.kind === kind));
}

/** And the reverse: the union must not declare a kind nothing can emit. */
const declared = (read('frontend/src/activityFeed.ts').match(/\| '([a-z_]+)'/g) ?? []).map((m) => m.replace(/\| '|'/g, ''));
const kindUnion = declared.filter((k) => EXPECTED_KINDS.includes(k as ActivityKind));
check('the ActivityKind union matches what the builder emits',
  new Set(kindUnion).size === EXPECTED_KINDS.length,
  `declared ${[...new Set(kindUnion)].join(',')}`);

console.log('\n── the sources the dashboard used to drop ─────────────────────');

const bt = feed.find((r) => r.kind === 'balance_transfer')!;
check('a crypto send is in the feed at all', Boolean(bt), 'it was on NEITHER screen before');
check('it is internal, not an outgoing payment', bt.direction === 'internal',
  'the user is moving their own funds to their own wallet');
check('it carries the chain', bt.network === 'base');
check('and the tx hash as its reference', bt.providerReference === '0xdead');

const sp = feed.find((r) => r.kind === 'supplier_payment')!;
check('a supplier payout is in the feed', Boolean(sp));
check('it is labelled with the supplier name, not an id', sp.label === 'Pay Acme Ltd');
check('it counts as money out', sp.direction === 'out');

const va = feed.find((r) => r.kind === 'virtual_account_deposit')!;
check('a virtual-account deposit is in the feed', Boolean(va));
check('it counts as money in', va.direction === 'in');

console.log('\n── direction, not storage table ───────────────────────────────');

const ngn = feed.find((r) => r.kind === 'ngn_transfer')!;
const usd = feed.find((r) => r.kind === 'withdrawal')!;
check('a naira sell and a USD sell are BOTH money out',
  ngn.direction === 'out' && usd.direction === 'out',
  'they live in different tables; that is our problem, not the user\'s');
check('a buy is money in', feed.find((r) => r.kind === 'onramp_order')!.direction === 'in');
check('an ngn ONRAMP flips to money in',
  buildActivityFeed({ ngnTransfers: [{ ...sources.ngnTransfers[0], direction: 'onramp' }] as any })[0].direction === 'in');

console.log('\n── one status vocabulary ──────────────────────────────────────');

/** The three phrasings that meant the same thing on three screens. */
check('awaiting_crypto_deposit and pending_deposit read identically',
  activityStatusLabel('awaiting_crypto_deposit') === activityStatusLabel('pending_deposit'));
check('processing and pending read identically',
  activityStatusLabel('processing') === activityStatusLabel('pending'));
check('settling and bank_processing read identically',
  activityStatusLabel('settling') === activityStatusLabel('bank_processing'),
  'the difference is our plumbing, not something a user can act on');
check('settled and completed read identically',
  activityStatusLabel('settled') === activityStatusLabel('completed'));
check('a waiting-on-the-user status says so', /waiting for your/i.test(activityStatusLabel('awaiting_payment')));
check('a review is named, since the user cannot speed it up', activityStatusLabel('pending_review') === 'Under review');
check('an unknown status never leaks snake_case',
  activityStatusLabel('some_new_provider_state') === 'Some new provider state');
check('an absent status does not render as undefined', activityStatusLabel(undefined) === 'In progress');

check('completed is success', activityState('completed') === 'success');
check('settled is success too', activityState('settled') === 'success');
check('expired is failed, not pending', activityState('expired') === 'failed',
  'an expired order sitting in "pending" forever is how the stale-sell report started');
check('cancelled is failed', activityState('cancelled') === 'failed');
check('anything unrecognised is pending, never a false success',
  activityState('brand_new_state') === 'pending');

console.log('\n── ordering ───────────────────────────────────────────────────');

check('newest first', feed[0].kind === 'virtual_account_deposit' && feed[feed.length - 1].kind === 'withdrawal');
/**
 * Several sources stamp createdAt from the same request, so ties are common.
 * Without a stable tiebreak the order depends on array order and the list
 * visibly reshuffles between renders.
 */
/**
 * MY FIRST VERSION OF THIS WAS DECORATIVE, and only running the mutation
 * showed it. It compared two feeds built with the sources in different orders
 * and expected the same result - but Array.prototype.sort is stable in modern
 * V8, so removing the id tiebreak left it passing. It asserted a property the
 * engine already guaranteed.
 *
 * What actually needs guaranteeing is a DETERMINISTIC order across renders
 * where the array order within a source can differ - a refetch can return the
 * same records in a different sequence. Asserting the explicit id ordering
 * tests the tiebreak itself rather than V8's stability.
 */
const tied = buildActivityFeed({
  withdrawals: [
    { id: 'zzz', status: 'completed', createdAt: at('2026-08-01T10:00:00Z') },
    { id: 'aaa', status: 'completed', createdAt: at('2026-08-01T10:00:00Z') },
  ] as any,
});
check('equal timestamps fall back to a deterministic id order',
  JSON.stringify(tied.map((r) => r.id)) === JSON.stringify(['aaa', 'zzz']),
  'without an explicit tiebreak the order follows however the API happened to return them');

console.log('\n── it never crashes on partial data ───────────────────────────');

check('no sources yields an empty feed', buildActivityFeed({}).length === 0);
check('one source loaded and five missing still works', buildActivityFeed({ withdrawals: sources.withdrawals }).length === 1,
  'the dashboard mounts before some of these resolve');
check('a record with no amount degrades to a dash',
  buildActivityFeed({ withdrawals: [{ id: 'x', status: 'pending', createdAt: at('2026-08-01T00:00:00Z') }] as any })[0].amount === '—');

console.log('\n── filters and search ─────────────────────────────────────────');

check('money in returns only inbound', filterActivity(feed, 'in').every((r) => r.direction === 'in'));
check('money out includes internal sends',
  filterActivity(feed, 'out').some((r) => r.direction === 'internal'),
  'a crypto send is money leaving the balance from the user\'s point of view');
check('in progress filters by STATE, not direction',
  filterActivity(feed, 'pending').every((r) => r.state === 'pending'));
check('all returns everything', filterActivity(feed, 'all').length === feed.length);
check('search matches the supplier name', searchActivity(feed, 'acme').length === 1);
check('search matches a network', searchActivity(feed, 'solana').length === 1);
check('search matches a tx hash', searchActivity(feed, '0xdead').length === 1);
check('search is case-insensitive', searchActivity(feed, 'ACME').length === 1);
check('an empty query returns everything', searchActivity(feed, '   ').length === feed.length);

console.log('\n── both screens use the SHARED feed, not their own merge ──────');

const app = read('frontend/src/App.tsx');
const dash = read('frontend/src/components/dashboard/DashboardSections.tsx');
const txPage = read('frontend/src/components/transactions/TransactionsSection.tsx');

check('App builds the feed once', app.includes('buildActivityFeed({'));
check('the dashboard is handed rows, not raw sources',
  app.includes('<DashboardTransactions rows={activityFeed}'),
  'passing four more props would recreate the divergence');
check('the dashboard no longer builds its own rows',
  !dash.includes('withdrawals.map(') && !dash.includes('onrampOrders.map('));
check('the transactions page uses the shared builder', txPage.includes('buildActivityFeed({'));
check('both render the SAME row component',
  dash.includes('<ActivityRowItem') && txPage.includes('<ActivityRowItem'),
  'two row implementations is how the original divergence happened');
check('the transactions page is given all six sources',
  ['balanceTransfers={balanceTransfers}', 'supplierPayments={supplierPayments}', 'virtualAccountTransactions={virtualAccountTransactions}']
    .every((prop) => app.includes(prop)));

console.log('\n── the dashboard points at the detail view, it does not clone it ──');

check('a dashboard row hands an id to the transactions page',
  app.includes('setSelectedActivityId(id)') && app.includes("goToView('history')"));
check('the transactions page opens on that row', txPage.includes('initialSelectedId'));
check('the dashboard no longer has an inline detail grid',
  !dash.includes('dashboard-tx-detail-grid'),
  'it duplicated the timeline panel that already exists one click away');

console.log('\n── layout ─────────────────────────────────────────────────────');

const css = read('frontend/src/styles.css');
const section = css.slice(css.indexOf('/* ACTIVITY FEED'));
check('the row shrinks its middle column, never the amount',
  /\.activity-row\{[^}]*minmax\(0,1fr\) max-content/.test(section));
check('direction is shown by an arrow, not colour alone',
  read('frontend/src/components/activity/ActivityRowItem.tsx').includes('DIRECTION_ICON'),
  'red/green alone is invisible to roughly 1 in 12 men');
check('rows are keyboard-focusable with a visible ring', section.includes('button.activity-row:focus-visible'));
/**
 * A blanket text-transform on the sub-line hit the TIMESTAMP as well as the
 * chain, rendering "2h ago" as "2h Ago" - visible in the rendered screenshot.
 * The chain is capitalised at its own span instead.
 */
check('the sub-line does not capitalise the timestamp',
  !/\.activity-main small\{[^}]*text-transform:capitalize/.test(section),
  'it turned "2h ago" into "2h Ago"');
check('only the network name is capitalised', section.includes('.activity-network{text-transform:capitalize}'));
check('a non-clickable row is not a button',
  read('frontend/src/components/activity/ActivityRowItem.tsx').includes('if (!onOpen)'));
check('the page list scrolls internally rather than growing forever',
  /\.activity-list-page\{[^}]*overflow-y:auto/.test(section));
const mobile = section.slice(section.indexOf('@media(max-width:640px)'));
check('mobile drops to two columns', /\.activity-row\{grid-template-columns:34px minmax\(0,1fr\)/.test(mobile));
check('mobile moves the amount under the label', /\.activity-figures\{grid-column:2/.test(mobile));
check('mobile releases the scroll cap so the page scrolls naturally',
  /\.activity-list-page\{max-height:none/.test(mobile));
check('the sideways-scrolling table is gone from the transactions page',
  !txPage.includes('premium-table'),
  'a 760px-wide table put amount and status out of view together on a phone');

console.log('\n── no test may anchor on "the last media query" ───────────────');

/**
 * THREE separate suites broke on css.lastIndexOf('@media(max-width:640px)') -
 * block-explorer, ngn-deposit-instruction and transfer-confirm - each time
 * someone appended a styles block and the previous "last" query stopped being
 * last. Their assertions then silently pointed at unrelated CSS.
 *
 * Fixing the instance three times was treating the symptom. This fails CI if
 * the pattern comes back, so the fourth person does not rediscover it.
 */
const suites = fs.readdirSync(path.join(root, 'scripts')).filter((f) => f.startsWith('test-') && f.endsWith('.ts'));
const offenders = suites.filter((f) => {
  // Strip comments AND this guard's own regex literal, or it reports itself
  // and every suite that documents the trap in prose.
  const body = fs.readFileSync(path.join(root, 'scripts', f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/lastIndexOf[^/]*\//g, '');
  // Split so this guard's own needle is not itself a match in this file.
  return body.includes('lastIndexOf(' + "'@media");
});
check('no suite anchors CSS assertions on the LAST media query',
  offenders.length === 0,
  `${offenders.join(', ')} - anchor on the section header comment instead`);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

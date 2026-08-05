/**
 * THE KPI ROW WAS TWO BROKEN CARDS AND TWO GOOD ONES.
 *
 * Measured on the reporter's live account before changing anything:
 *
 *   Payout volume   $0.00  - while 2 crypto sends were COMPLETED
 *   Transactions    0      - while 15 records existed
 *
 * Both read a single source (`withdrawals`, and `withdrawals + onrampOrders`)
 * on a product with six. The same defect the activity feed had, and shipping
 * the feed made it worse: the card said "0 Lifetime" directly above six
 * transactions.
 *
 * Payout volume had a second, unfired bug. It summed destinationAmount across
 * withdrawals whose destinationCurrency is 'usd' | 'gbp' | 'eur' and the UI
 * prefixed "$", so a GBP payout and a EUR payout would have rendered as one
 * dollar figure. Nothing had completed yet, so nobody saw it.
 *
 * Replaced with questions rather than metrics:
 *   Your balance   what can I spend            (unchanged)
 *   In progress    is anything stuck
 *   Your limit     how much headroom is left   (naira users only)
 *
 * Run: npm run test:dashboard-kpis
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inProgressKpi, limitKpi, showsNairaLimit } from '../frontend/src/dashboardKpis.js';
import { buildActivityFeed } from '../frontend/src/activityFeed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'x', kind: 'withdrawal', direction: 'out', label: 'Sell crypto',
  amount: '10', currency: 'USD', status: 'processing', statusLabel: 'In progress',
  state: 'pending', createdAt: '2026-08-01T00:00:00Z', raw: {}, ...over,
}) as any;

const app0 = read('frontend/src/App.tsx');
const ngnSummary0 = {
  level: 1, levelLabel: 'Level 1: Bank verified', path: 'ngn_bank', windowDays: 30,
  allowances: [{ flow: 'offramp', rail: 'ngn', limitNgn: 100000, usedNgn: 20000, remainingNgn: 80000 }],
} as any;

console.log('\n── In progress counts EVERY source, not just withdrawals ──────');

/** The exact shape of the reported account: crypto sends the old card ignored. */
const feed = buildActivityFeed({
  balanceTransfers: [
    { transferId: 'b1', status: 'processing', createdAt: '2026-08-04T10:00:00Z', asset: 'usdc', amount: '10' },
    { transferId: 'b2', status: 'completed', createdAt: '2026-08-04T09:00:00Z', asset: 'usdc', amount: '10' },
  ],
  ngnTransfers: [
    { id: 'n1', status: 'awaiting_crypto_deposit', createdAt: '2026-08-03T10:00:00Z', direction: 'offramp', sourceCurrency: 'usdc', destinationCurrency: 'ngn', destinationAmount: '82473' },
  ],
} as any);

const ip = inProgressKpi(feed);
check('a crypto send in flight is counted', ip.count === 2, `count=${ip.count}`);
check('a completed row is NOT counted', !feed.filter((r) => r.state === 'pending').some((r) => r.status === 'completed'));
check('the naira sell waiting on the user is flagged', ip.needsYou === 1, `needsYou=${ip.needsYou}`);
check('the trend names the user as the blocker', ip.trend === '1 needs you', ip.trend);

console.log('\n── the three states of the trend line ─────────────────────────');

check('nothing pending reads as nothing pending', inProgressKpi([]).trend === 'Nothing pending');
check('and its value is zero, not a dash', inProgressKpi([]).value === '0');
check('moving but not their turn is reassuring, not empty',
  inProgressKpi([row({ status: 'processing' })]).trend === 'All on track');
check('several waiting on them pluralises',
  inProgressKpi([row({ id: 'a', status: 'awaiting_payment' }), row({ id: 'b', status: 'pending_deposit' })]).trend === '2 need you');
check('one waiting on them is singular',
  inProgressKpi([row({ status: 'requires_action' })]).trend === '1 needs you');

/**
 * Matching on raw provider status rather than the friendly label: the label is
 * presentation and could be reworded without anyone realising it silently
 * stopped flagging blocked transfers.
 */
const src = read('frontend/src/dashboardKpis.ts');
check('the blocker set matches raw statuses, not display labels',
  src.includes("'awaiting_crypto_deposit'") && !/WAITING_ON_USER[\s\S]{0,300}statusLabel/.test(src));

console.log('\n── "needs you" must not look like "Ready" ─────────────────────');

/**
 * The trend line was hardcoded green on every card, so the one line asking the
 * user to act rendered identically to reassurance. Caught by looking at the
 * render, not the code.
 */
check('a blocked transfer sets the action tone',
  inProgressKpi([row({ status: 'awaiting_payment' })]).tone === 'action');
check('things merely moving stay calm',
  inProgressKpi([row({ status: 'processing' })]).tone === 'ok');
check('nothing pending stays calm', inProgressKpi([]).tone === 'ok');
check('KpiCard accepts a tone', read('frontend/src/components/dashboard/DashboardSections.tsx').includes("tone?: 'ok' | 'action' | 'muted'"));
check('both cards pass their tone through',
  app0.includes('tone={inProgress.tone}') && app0.includes('tone={limitCard.tone}'));
check('action is amber, matching the countdown and testnet badge',
  read('frontend/src/styles.css').includes('.kpi-trend.action { color: #f1bd72; }'));
check('loading is muted, never green',
  read('frontend/src/styles.css').includes('.kpi-trend.muted'),
  'green while loading reads as a verdict');
check('an unloaded summary uses the muted tone', limitKpi(ngnSummary0, false).tone === 'muted');
check('a fully spent limit turns amber',
  limitKpi({ ...ngnSummary0, allowances: [{ flow: 'offramp', rail: 'ngn', limitNgn: 100000, usedNgn: 100000, remainingNgn: 0 }] } as any, true).tone === 'action',
  'at ₦0 left the user cannot transact and must not read a calm green Ready');

console.log('\n── the naira limit is gated on transacting in naira ───────────');

const ngnSummary = {
  level: 1, levelLabel: 'Level 1: Bank verified', path: 'ngn_bank', windowDays: 30,
  allowances: [{ flow: 'offramp', rail: 'ngn', limitNgn: 100000, usedNgn: 20000, remainingNgn: 80000 }],
} as any;
const ukSummary = {
  level: 1, levelLabel: 'Level 1: Bank verified', path: 'bridge_kyc', windowDays: 30,
  allowances: [{ flow: 'offramp', rail: 'foreign', limitNgn: 500000, usedNgn: 0, remainingNgn: 500000 }],
} as any;

check('a naira user sees a limit card', showsNairaLimit(ngnSummary));
check('a bridge user does NOT', !showsNairaLimit(ukSummary));
check('an absent summary does not accidentally show one', !showsNairaLimit(null));

const ngnCard = limitKpi(ngnSummary, true);
check('the naira card is labelled Your limit', ngnCard.label === 'Your limit');
check('it shows what is LEFT, not the ceiling', ngnCard.value === '₦80,000 left', ngnCard.value);
check('it names the window', ngnCard.sub.includes('next 30 days'), ngnCard.sub);
check('it names the level', ngnCard.sub.includes('Level 1'), ngnCard.sub);

const ukCard = limitKpi(ukSummary, true);
check('a bridge user gets the verification card instead', ukCard.label === 'Verification');
/**
 * THE WHOLE POINT OF THE GATE. limitNgn is the internal denominator for every
 * limit including the foreign rail, so the number EXISTS for a UK user - it is
 * simply in a currency they never touch.
 */
check('and never sees a naira figure',
  !JSON.stringify(ukCard).includes('₦'),
  'limitNgn is the internal denominator; showing it to a GBP seller is meaningless');
check('the bridge card still states their level', ukCard.sub === 'Level 1');

console.log('\n── it refuses to invent a number ──────────────────────────────');

const loading = limitKpi(ngnSummary, false);
check('an unloaded summary shows a dash, never a confident zero', loading.value === '—');
check('and says it is checking', loading.sub === 'Checking…',
  'the dashboard has twice shipped a KPI that accused a verified user while loading');
check('a null summary does not crash', limitKpi(null, true).value.length > 0);

/** null remainingNgn is genuinely uncapped and already modelled server-side. */
const uncapped = limitKpi({ ...ngnSummary, allowances: [{ flow: 'offramp', rail: 'ngn', limitNgn: null, usedNgn: 0, remainingNgn: null }] } as any, true);
check('an uncapped user sees No limit, not ₦0', uncapped.value === 'No limit',
  'rendering null as zero would tell an unlimited user they can do nothing');

const missing = limitKpi({ ...ngnSummary, allowances: [] } as any, true);
check('a missing allowance falls back rather than inventing a ceiling',
  missing.label === 'Verification', 'a wrong limit is worse than an absent one');

const exhausted = limitKpi({ ...ngnSummary, allowances: [{ flow: 'offramp', rail: 'ngn', limitNgn: 100000, usedNgn: 100000, remainingNgn: 0 }] } as any, true);
check('a fully used limit reads ₦0 left, which is the truth', exhausted.value === '₦0 left');

console.log('\n── NIN/BVN is not offered as something they can do now ────────');

const withNext = limitKpi({ ...ngnSummary, nextStep: { description: 'Add your NIN or BVN', available: false } } as any, true);
check('an unavailable next step says coming, not go do it',
  withNext.trend === 'Higher limits coming',
  'no NIN/BVN provider is integrated, so offering the action would dead-end');
const withAvailable = limitKpi({ ...ngnSummary, nextStep: { description: 'Add your NIN or BVN', available: true } } as any, true);
check('an available next step invites the action', withAvailable.trend === 'Raise your limit');

console.log('\n── the broken cards are gone, not relocated ───────────────────');

const app = read('frontend/src/App.tsx');
check('Payout volume is deleted', !app.includes('label="Payout volume"'));
check('Transactions count is deleted', !app.includes('label="Transactions"'));
check('the cross-currency sum has no consumer left',
  !/const completedVolume =/.test(app),
  'leaving an unused usd+gbp+eur sum is a loaded gun for the next KPI');
check('Your balance survives untouched', app.includes('label="Your balance"'));
check('In progress is wired', app.includes('label="In progress"'));
check('the limit card is wired', app.includes('label={limitCard.label}'));
check('both derive from data already on the client, via useMemo',
  app.includes('inProgressKpi(activityFeed)') && app.includes('limitKpi(verificationSummary'));
check('In progress reads the SAME feed as the list below it',
  app.includes('inProgressKpi(activityFeed)'),
  'a second source is exactly how "0 Lifetime" ended up above six rows');

console.log('\n── layout ─────────────────────────────────────────────────────');

const css = read('frontend/src/styles.css');
check('the grid is three columns', /\.dashboard-kpis \{ display: grid; grid-template-columns: repeat\(3, minmax\(0,1fr\)\)/.test(css));
check('two columns at 1180px', /max-width: 1180px\)[^}]*\.dashboard-kpis \{ grid-template-columns: repeat\(2, minmax\(0,1fr\)\)/.test(css));
check('full width on a phone', /max-width: 760px\)[^}]*\.dashboard-kpis \{ grid-template-columns: 1fr/.test(css),
  'three cards abreast on a 390px screen is unreadable at any font size');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

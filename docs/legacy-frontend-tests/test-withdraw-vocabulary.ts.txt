/**
 * "SELL CRYPTO" READ AS A TRADING APP.
 *
 * Reported by the cofounder: most Nigerian users are not traders, and "Sell
 * crypto" suggests an exchange. "Withdraw" is what a non-technical person
 * calls moving money to their bank. The specific line quoted:
 *
 *     Selling USDC on Solana.   ->   Withdrawing USDC on Solana.
 *
 * The codebase ALREADY agreed. The route is /withdraw, the nav key is
 * 'withdraw', the history page is /withdrawals and the table is
 * payments_withdrawals - only the visible labels said "sell". This rename
 * removed an inconsistency rather than introducing a vocabulary.
 *
 * TWO RULES THIS FILE ENFORCES.
 *
 * 1. VERB FOR ACTIONS, NOUN FOR RECORDS. A button the user presses says
 *    "Withdraw"; a row in their history says "Withdrawal". Mixing them is the
 *    kind of thing that reads as sloppy without anyone being able to say why.
 *
 * 2. CODE IDENTIFIERS MUST NOT BE RENAMED. `direction: 'sell'` is a stored
 *    value, `.sell` is a CSS hook, `onSell` is a prop, and '/app/sell' is a
 *    LEGACY URL that real bookmarks still point at. Renaming any of them
 *    breaks something silently while the UI looks perfect - which is exactly
 *    the failure a cosmetic rename invites.
 *
 * Run: npm run test:withdraw-vocabulary
 */

import fs from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const read = (p: string) => fs.readFileSync(`frontend/src/${p}`, 'utf8');

const appUtils = read('appUtils.tsx');
const app = read('App.tsx');
const feed = read('activityFeed.ts');
const dash = read('components/dashboard/DashboardSections.tsx');
const payout = read('components/sell/NgnPayoutForm.tsx');
const sections = read('components/AppSections.tsx');
const txs = read('components/transactions/TransactionsSection.tsx');
const trade = read('components/transfer/TradeTransferSections.tsx');
const support = read('components/support/SupportSection.tsx');
const verify = read('verificationPath.ts');

console.log('\n── the line the cofounder quoted ─────────────────────────────');

check('the network hint says "Withdrawing", not "Selling"',
  payout.includes('Withdrawing {asset.toUpperCase()} on {networkLabel(network)}.'),
  'this is the exact string that was reported');
check('and "Selling ... on" is gone entirely',
  !/Selling \{asset/.test(payout));

console.log('\n── VERB for actions ──────────────────────────────────────────');

check('the main nav item is "Withdraw"',
  /label: 'Withdraw'/.test(appUtils),
  'the nav key was already `withdraw`; only the label disagreed');
check('the dashboard action card is "Withdraw"',
  app.includes('<strong>Withdraw</strong>'));
check('the empty-state buttons say "⊕ Withdraw"',
  (dash.match(/⊕ Withdraw/g) ?? []).length === 2,
  'there are two of these and both must change');
check('the buy/sell toggle offers "↗ Withdraw"',
  trade.includes('↗ Withdraw</button>'));

console.log('\n── NOUN for records ──────────────────────────────────────────');

/**
 * Feed rows are the one place the NOUN is correct: they name a thing that
 * happened, and they sit on the /withdrawals page. A row reading "Withdraw"
 * would be describing an action the user can no longer take.
 */
check('activity feed rows are labelled "Withdrawal"',
  feed.includes("label: 'Withdrawal',"));
check('naira feed rows read "Withdrawal to naira"',
  feed.includes("'Withdrawal to naira'"));
check('the transactions list labels rows "Withdrawal"',
  txs.includes("label: 'Withdrawal',"));
check('cancelling says "Cancel this withdrawal"',
  txs.includes('Cancel this withdrawal'));

console.log('\n── the crypto-native ambiguity is addressed ──────────────────');

/**
 * "Withdraw" means "send USDC to another wallet" to a crypto user - which is
 * the Transfer screen, not this one. The subtitle has to disambiguate or the
 * rename trades one confusion for another.
 */
check('the dashboard card names the BANK explicitly',
  /Withdraw<\/strong><small>Cash out to your bank account<\/small>/.test(app),
  'without this, a crypto user reads "Withdraw" as an on-chain send');

console.log('\n── withdrawals choose the exact stablecoin ───────────────────');

check('the NGN flow has an explicit asset selector',
  payout.includes('<legend>Asset to withdraw</legend>'));
check('the NGN quote uses the selected asset, not a hardcoded USDC',
  payout.includes('sourceCurrency=${asset}'));
check('switching asset invalidates the old quote',
  payout.includes('setQuote(null);') && payout.includes('useEffect(() => {'));
check('the app no longer hardcodes ngnAsset="usdc"',
  !app.includes('ngnAsset="usdc"'));
check('the app passes the selected asset into the withdraw wizard',
  app.includes('ngnAsset={ngnAsset}') && app.includes('onNgnAssetChange'));
check('withdraw validation checks the selected asset balance',
  app.includes('spendableSelectedAsset') && !app.includes('spendableUsdc'));
check('zero-balance asset choices are disabled on balance-funded withdrawals',
  sections.includes('asset.spendable <= 0') && payout.includes('option.spendable <= 0'));

console.log('\n── no user-facing "sell" language left ───────────────────────');

for (const [name, src] of [
  ['App.tsx', app], ['AppSections', sections], ['DashboardSections', dash],
  ['NgnPayoutForm', payout], ['TransactionsSection', txs], ['activityFeed', feed],
  ['verificationPath', verify],
] as const) {
  /**
   * Strip comments and code identifiers before asserting. The point is to
   * catch "Sell crypto" in a button, NOT `onSell` or `direction: 'sell'`.
   */
  const visible = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/onSell|'sell'|"sell"|sell\/NgnPayoutForm|sell-network|card sell|\.sell\b/g, '');
  check(`${name} has no "Sell crypto" / "selling" copy`,
    !/Sell crypto|Sell stablecoins|Start selling|start selling|Sell to naira|available to sell/.test(visible),
    (visible.match(/Sell crypto|Sell stablecoins|Start selling|start selling|Sell to naira|available to sell/) ?? [])[0]);
}

console.log('\n── CODE IDENTIFIERS SURVIVED (the dangerous half) ────────────');

check("the stored union `direction: 'sell' | 'buy'` is intact",
  read('types.ts').includes("direction: 'sell' | 'buy' | 'deposit'"),
  'renaming a persisted value orphans every existing record');
check('the legacy /app/sell URL still resolves',
  appUtils.includes("clean === '/app/sell'"),
  'real bookmarks point at this; dropping it 404s them');
check('the route is still /withdraw',
  /withdraw: '\/withdraw'/.test(appUtils));
check('the onSell prop was not renamed',
  sections.includes('onSell'),
  'a cosmetic rename must not churn component APIs');
check('the .sell CSS hook still exists',
  fs.readFileSync('frontend/src/styles.css', 'utf8').includes('.tx-type.sell'),
  'the class is still applied in App.tsx');

console.log('\n── support routing still catches BOTH words ──────────────────');

/**
 * Users will type "withdraw" now and "sell" for a long time yet. The matcher
 * previously tested 'withdrawal', which does NOT match someone typing plain
 * "withdraw" - the very word the UI now teaches them.
 */
check("support matches the bare word 'withdraw'",
  support.includes("lower.includes('withdraw')"),
  "'withdrawal' misses a user who types 'withdraw'");
check("and still matches legacy 'sell'",
  support.includes("lower.includes('sell')"),
  'users trained on the old wording must still be routed');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

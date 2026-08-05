/**
 * CHAIN MARKS ON TRANSACTION ROWS.
 *
 * "the transaction pages what do you think do we have the logo of the chains
 * on at the front of the chains what do you think of this"
 *
 * Yes - but beside the chain NAME, not in the leading column, and only for
 * rows that are actually on a chain. The reasoning is in ActivityRowItem.tsx;
 * this suite makes the parts that could silently regress into failures.
 *
 * THE CASE THIS EXISTS TO PROTECT is the negative one. Of seven activity
 * sources, three move fiat over bank rails and have no chain at all. If a
 * future change gives them a fallback logo, every withdrawal and supplier
 * payout starts claiming to be an on-chain event. That is a lie about where
 * someone's money went, and it would look like a cosmetic improvement in
 * review.
 *
 * Run: npm run test:activity-network-logo
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { logoChainFor } = await import('../frontend/src/components/receive/NetworkLogo.js');
const { buildActivityFeed } = await import('../frontend/src/activityFeed.js');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const row = read('frontend/src/components/activity/ActivityRowItem.tsx');
const rowCode = strip(row);
const css = read('frontend/src/styles.css');

console.log('\n── a mark is resolved only for chains we actually draw ────────');

check('base resolves', logoChainFor('base') === 'base');
check('ethereum resolves', logoChainFor('ethereum') === 'ethereum');
check('solana resolves', logoChainFor('solana') === 'solana');
check('mixed case resolves', logoChainFor('Base') === 'base',
  'a chain string arriving capitalised must not lose its logo');
check('surrounding whitespace resolves', logoChainFor(' solana ') === 'solana');

for (const unknown of ['polygon', 'arbitrum', 'avalanche_c_chain', 'tron']) {
  check(`${unknown} resolves to NOTHING, not a placeholder`,
    logoChainFor(unknown) === undefined,
    'an unrecognisable blob beside a chain name invites misreading it as a known network');
}
check('undefined input is safe', logoChainFor(undefined) === undefined);
check('empty string is safe', logoChainFor('') === undefined);

console.log('\n── the row renders a mark only when one exists ────────────────');

check('the row imports the real logo component',
  /import \{[^}]*NetworkLogo[^}]*\} from '\.\.\/receive\/NetworkLogo'/.test(row),
  'the marks must be the same ones the Receive screen uses, not a second set');
check('the row resolves through logoChainFor',
  rowCode.includes('logoChainFor(row.network)'));
check('the logo is conditional on that resolution',
  /logoChain \?[\s\S]{0,80}NetworkLogo/.test(rowCode),
  'rendering unconditionally would draw a wrong or missing mark');
check('the name still renders when there is no mark',
  rowCode.includes('activity-network') &&
  rowCode.indexOf('row.network.replaceAll') > rowCode.indexOf('logoChain ?'),
  'losing the label along with the icon would remove information');

console.log('\n── the leading slot still carries direction ───────────────────');

check('the direction arrow is unchanged',
  rowCode.includes('DIRECTION_ICON[row.direction]'),
  'the arrow is how direction reaches a red-green colourblind user');
check('the logo is NOT in the leading icon span',
  !/activity-icon[^>]*>\s*\{?\s*<?NetworkLogo/.test(rowCode),
  'the leading column is the scan anchor and is already load-bearing');
check('the mark sits inside the metadata line, beside the name',
  rowCode.indexOf('activity-network-tag') > rowCode.indexOf('activity-main'));

console.log('\n── rows that are not on a chain must show no mark ─────────────');

const now = new Date().toISOString();
const feed = buildActivityFeed({
  withdrawals: [{ id: 'w1', status: 'completed', createdAt: now, destinationCurrency: 'ngn', destinationAmount: '1000' }],
  supplierPayments: [{ id: 's1', status: 'completed', createdAt: now, amount: '10', destinationCurrency: 'usd' }],
  virtualAccountTransactions: [{ id: 'v1', status: 'completed', createdAt: now, sourceAmount: '5', sourceCurrency: 'usd' }],
  walletDeposits: [{ id: 'd1', status: 'pending', createdAt: now, asset: 'USDC', amount: '50', chain: 'base' }],
  balanceTransfers: [{ transferId: 'b1', status: 'processing', createdAt: now, asset: 'usdc', amount: '5', network: 'solana' }],
  ngnTransfers: [{ id: 'n1', status: 'completed', createdAt: now, direction: 'onramp', sourceAmount: '100', network: 'solana' }],
  onrampOrders: [{ id: 'o1', status: 'completed', createdAt: now, amount: '20', sourceCurrency: 'usd', destinationChain: 'base' }],
} as any);

const byKind = (kind: string) => feed.find((r) => r.kind === kind);

for (const fiat of ['withdrawal', 'supplier_payment', 'virtual_account_deposit']) {
  const found = byKind(fiat);
  check(`${fiat} carries no network`, found && !found.network,
    'these move fiat over bank rails; a chain logo would misdescribe them');
  check(`${fiat} therefore resolves no mark`, logoChainFor(found?.network) === undefined);
}

console.log('\n── and the on-chain rows do ──────────────────────────────────');

check('a deposit carries its chain', byKind('wallet_deposit')?.network === 'base');
check('a deposit resolves a mark', logoChainFor(byKind('wallet_deposit')?.network) === 'base');
check('a crypto send carries its chain', byKind('balance_transfer')?.network === 'solana');
check('an naira transfer carries its chain', byKind('ngn_transfer')?.network === 'solana');

check('a BUY now carries its delivery chain',
  byKind('onramp_order')?.network === 'base',
  'destinationChain existed on the record and was never mapped into the feed');
check('and it resolves a mark', logoChainFor(byKind('onramp_order')?.network) === 'base');

const withNetwork = feed.filter((r) => r.network).length;
check('four of seven sources are network-bearing', withNetwork === 4,
  `${withNetwork} rows carried a network`);

console.log('\n── layout details that broke things before ────────────────────');

check('the mark and name are wrapped as one unit',
  rowCode.includes('activity-network-tag'),
  'wrapping between an icon and its label orphans the icon onto the timestamp line');
check('the tag is styled inline-flex',
  /\.activity-network-tag\{[^}]*inline-flex/.test(css),
  'a bare SVG sits on the baseline and hangs low against 11.5px text');
check('the svg is prevented from shrinking',
  /\.activity-network-tag svg\{[^}]*flex:0 0 auto/.test(css),
  'the parent ellipsises; a squashed half-circle is not recognisably Base');
check('capitalisation is still scoped to the chain name only',
  /\.activity-network\{text-transform:capitalize\}/.test(css) &&
  !/\.activity-main small\{[^}]*text-transform/.test(css),
  'a blanket transform on this line rendered "2h ago" as "2h Ago"');

/**
 * THE REGRESSION THAT BROKE THREE SUITES.
 *
 * block-explorer, ngn-deposit-instruction and transfer-confirm each anchored on
 * css.lastIndexOf('@media(max-width:640px)'). Every time someone appended a
 * styles block, the previous "last" query stopped being last and those
 * assertions silently pointed at unrelated CSS - passing while testing nothing.
 *
 * The hazard is the lastIndexOf ANCHOR, not the media query, of which there are
 * legitimately ten. So this suite asserts that IT does not use the pattern.
 * The repo-wide guard lives in test:activity-feed.
 */
/*
 * No "does this suite use lastIndexOf('@media')" check here. Written, and
 * removed: a source scanner that looks for its own forbidden string inside its
 * own file always matches itself. The repo-wide guard in test:activity-feed
 * already fails CI on that pattern, which is the right place for it.
 */

/**
 * The rule must apply at EVERY width, so it has to sit at the top level rather
 * than inside a breakpoint. "appears before the first @media" is the wrong test
 * - this stylesheet interleaves queries throughout - so count brace depth at
 * the rule instead. Depth 0 is top level.
 */
const tagAt = css.indexOf('.activity-network-tag{');
const depth = css.slice(0, tagAt).split('{').length - css.slice(0, tagAt).split('}').length;
check('the chain mark styles apply at every width, not just one breakpoint',
  tagAt > 0 && depth === 0,
  `brace depth ${depth} - a chain mark is not a desktop-only affordance, and mobile is where most users are`);

console.log('\n── the mark is decorative; the name is the accessible label ───');

const logo = read('frontend/src/components/receive/NetworkLogo.tsx');

console.log('\n── the Base mark must not read as a prohibition sign ──────────');

/**
 * A REAL BUG, FOUND BY ZOOMING A RENDER RATHER THAN READING CODE.
 *
 * The mark was drawn as a #0052FF circle with a WHITE shape laid over most of
 * it, leaving a blue bar across the middle. At 13px in a transaction row that
 * is a white disc with a bar through it - a "no entry" sign - sitting next to
 * a completed payment. Every assertion passed the whole time, because they
 * checked that an <svg> existed, not what it depicted.
 *
 * The official mark is a BLUE disc with a notch cut out of the left edge, the
 * background showing through the cut. So: no white fill anywhere in it.
 */
const baseMark = logo.slice(logo.indexOf("if (chain === 'base')"), logo.indexOf('// Ethereum:'));
check('the Base mark contains no white fill',
  !/fill="#fff"|fill="white"/i.test(baseMark),
  'a white overlay on the blue disc renders as a no-entry sign');
check('the Base mark is drawn in Base blue', baseMark.includes('#0052FF'));
check('the Base mark is a single path, not a circle plus an overlay',
  !/<circle/.test(baseMark),
  'the notch must come from the geometry so the background shows through');

check('logos are aria-hidden',
  /'aria-hidden': true/.test(logo),
  'the network name is adjacent in text; announcing both says "Base Base"');
check('the row aria-label is unchanged and text-only',
  /aria-label=\{`\$\{row\.label\}, \$\{row\.amount\} \$\{row\.currency\}, \$\{row\.statusLabel\}`\}/.test(row));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

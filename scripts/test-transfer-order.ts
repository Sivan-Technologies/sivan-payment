/**
 * THE SEND & TRANSFER PAGE PUT THREE ZEROES WHERE THE ACTION SHOULD BE.
 *
 * Reported from a phone with two screenshots. Opening Send & transfer, the
 * first thing in the column was:
 *
 *   SETTLED USDC AVAILABLE
 *   0 USDC
 *   Pending settlement  0 USDC
 *   Held for review     0 USDC
 *   Spent               0 USDC
 *   This is an internal mirror of settled stablecoin funds from
 *   virtual-account deposits or approved adjustments...
 *
 * A full phone screen of zeroes and ledger prose before a single control the
 * user could touch. "Transfer USDC to a wallet" - the reason anyone opens this
 * page - was below the fold, and the supplier form below that.
 *
 * The user's instruction: the transfer/payout form comes BEFORE the settled
 * balance, and the balance comes second.
 *
 * That is also the right call on the merits. The balance is context for the
 * action, not a destination; and at 0 USDC it is discouraging context, shown
 * to someone who may be arriving precisely to find out how to fund it.
 *
 * These assertions are ORDER assertions. They are written against the source
 * positions of the panels because that is exactly the property a later edit
 * would break without noticing - the page still renders, still typechecks, and
 * simply reads worse.
 *
 * Run: npm run test:transfer-order
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

function main() {
  const src = read('frontend/src/components/transfer/TradeTransferSections.tsx');

  // The grid is the ordered column. Everything outside it - the hero, the
  // route tabs, the ledger table - is not what was reported and is not
  // asserted here.
  const gridStart = src.indexOf('<div className="transfer-grid">');
  const gridEnd = src.indexOf('<article className="panel"><div className="panel-head"><div><p className="eyebrow">Stablecoin ledger');
  const grid = src.slice(gridStart, gridEnd);

  const at = (needle: string) => grid.indexOf(needle);

  /**
   * Matched on the CSS class, not the label.
   *
   * This searched for the literal 'Settled USDC available'. That eyebrow was
   * renamed to 'USDC available to send' when the figure stopped being a ledger
   * mirror and became chain + credits - holds, and the test then reported the
   * card as MISSING - three ordering assertions failed against a card that was
   * on screen and correct. The class is what identifies the panel; the words
   * are copy and will change again.
   */
  const balance = at('transfer-balance-card');
  const cryptoForm = at('Transfer USDC to a wallet');
  const cryptoHistory = at('<h3>Crypto sends</h3>');
  const supplierAdd = at('<h3>Add supplier bank</h3>');
  const supplierPay = at('<h3>Pay from settled USDC</h3>');
  const supplierHistory = at('<h3>Cross-border payouts</h3>');

  console.log('\nEVERY PANEL IS STILL ON THE PAGE\n');
  {
    // A reorder that quietly drops a panel would satisfy every ordering
    // assertion below. Presence is checked first, on purpose.
    check('the settled balance card', balance > -1);
    check('the crypto transfer form', cryptoForm > -1);
    check('the crypto transfer history', cryptoHistory > -1);
    check('the add-supplier form', supplierAdd > -1);
    check('the supplier payment form', supplierPay > -1);
    check('the supplier payment history', supplierHistory > -1);
  }

  console.log('\nTHE ACTION COMES FIRST — THIS IS THE REPORTED BUG\n');
  {
    check('"Transfer USDC to a wallet" is ABOVE the settled balance',
      cryptoForm < balance, `form@${cryptoForm} balance@${balance}`);
    check('the supplier payment form is above it too',
      supplierPay < balance, `pay@${supplierPay} balance@${balance}`);
    check('and so is the add-supplier form',
      supplierAdd < balance, `add@${supplierAdd} balance@${balance}`);
    /**
     * The balance is the SECOND thing, not the last. The user asked for it
     * second, and it belongs directly under the form it funds - a spend
     * control with its budget out of sight is its own bug.
     */
    check('the balance still comes before the histories',
      balance < cryptoHistory && balance < supplierHistory,
      `balance@${balance} cryptoHist@${cryptoHistory} supplierHist@${supplierHistory}`);
  }

  console.log('\nHISTORY IS LAST, WHERE IT BELONGS\n');
  {
    check('crypto history sits below its own form',
      cryptoForm < cryptoHistory, `form@${cryptoForm} history@${cryptoHistory}`);
    check('supplier history sits below its own form',
      supplierPay < supplierHistory, `pay@${supplierPay} history@${supplierHistory}`);
  }

  console.log('\nTHE ROUTE TABS STILL GATE THE RIGHT PANELS\n');
  {
    /**
     * The reorder had to split two JSX fragments that each wrapped a form AND
     * its history. Splitting them is where a panel most easily escapes its
     * `activeRoute` guard - and a supplier form appearing under the "Send
     * crypto" tab would be a worse bug than the one being fixed.
     */
    const cryptoGuards = (grid.match(/\{activeRoute === 'crypto' &&/g) ?? []).length;
    const supplierGuards = (grid.match(/\{activeRoute === 'supplier' &&/g) ?? []).length;
    check('the crypto route guards both of its panels', cryptoGuards === 2, `${cryptoGuards} guards`);
    check('the supplier route guards both of its groups', supplierGuards === 2, `${supplierGuards} guards`);

    /**
     * Which route guards the panel containing this text?
     *
     * This took two corrections, both worth recording because each version
     * looked reasonable and was wrong in a different way.
     *
     * v1 walked backwards to the nearest `{activeRoute === ...` in the string.
     * It reported the balance card as living in the 'user' route, because the
     * user route's panel is the line above it - but that guard opens and
     * closes on its own line and owns nothing below it.
     *
     * v2 looked only at the panel's own line. That reported the two supplier
     * FORMS as ungated, because they sit inside a `<>...</>` fragment opened
     * on an earlier line and closed after them.
     *
     * v3 tracked the guard as state but ended the fragment on the first
     * `</>` seen - and the supplier forms contain their own nested
     * `<>...</>` conditionals for optional bank fields, so it closed early
     * and again called a guarded panel ungated.
     *
     * The answer is fragment DEPTH. All three earlier versions would have
     * passed a genuinely broken page, which is why this is spelled out.
     */
    const gridLines = grid.split('\n');
    const routeOfLine: string[] = [];
    let openRoute: string | null = null;
    let depth = 0;
    for (const line of gridLines) {
      const opened = line.match(/\{activeRoute === '(crypto|supplier|user)' &&/);
      const opens = (line.match(/<>/g) ?? []).length;
      const closes = (line.match(/<\/>/g) ?? []).length;

      if (openRoute) {
        routeOfLine.push(openRoute);
        // DEPTH, not "does this line contain </>". The supplier forms include
        // their own nested `<>...</>` conditionals for optional bank fields,
        // and a naive close-check ended the route fragment on the first inner
        // one - reporting a correctly-guarded panel as ungated.
        depth += opens - closes;
        if (depth <= 0) { openRoute = null; depth = 0; }
        continue;
      }

      if (opened) {
        routeOfLine.push(opened[1]);
        const net = opens - closes;
        if (net > 0) { openRoute = opened[1]; depth = net; }
        continue;
      }
      routeOfLine.push('none');
    }
    const routeOwning = (position: number) =>
      routeOfLine[grid.slice(0, position).split('\n').length - 1] ?? 'none';

    check('the transfer form is inside the crypto route', routeOwning(cryptoForm) === 'crypto', routeOwning(cryptoForm));
    check('the crypto history is inside the crypto route', routeOwning(cryptoHistory) === 'crypto', routeOwning(cryptoHistory));
    check('the add-supplier form is inside the supplier route', routeOwning(supplierAdd) === 'supplier', routeOwning(supplierAdd));
    check('the supplier payment form is inside the supplier route', routeOwning(supplierPay) === 'supplier', routeOwning(supplierPay));
    check('the supplier history is inside the supplier route', routeOwning(supplierHistory) === 'supplier', routeOwning(supplierHistory));
    /**
     * The balance is the one panel that must NOT be route-gated - it is the
     * same money whichever route is selected, and hiding it behind a tab was
     * never the ask.
     */
    check('the balance card is shown on every route', routeOwning(balance) === 'none', routeOwning(balance));
  }

  console.log('\nTHE JSX IS STILL BALANCED\n');
  {
    /**
     * Splitting `<>...</>` fragments by hand is exactly how a stray `</>}` or a
     * missing `}` gets left behind. tsc catches it, but only if someone runs
     * it; this makes the failure legible in the suite that owns the change.
     */
    const openFragments = (grid.match(/<>/g) ?? []).length;
    const closeFragments = (grid.match(/<\/>/g) ?? []).length;
    check('every fragment that opens also closes',
      openFragments === closeFragments, `${openFragments} open vs ${closeFragments} close`);
    const openBraces = (grid.match(/\{/g) ?? []).length;
    const closeBraces = (grid.match(/\}/g) ?? []).length;
    check('braces balance across the grid',
      openBraces === closeBraces, `${openBraces} open vs ${closeBraces} close`);
    check('no orphaned fragment close survived the split',
      !/<\/>\}\s*<\/>\}/.test(grid));
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();

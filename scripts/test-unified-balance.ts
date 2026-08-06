/**
 * ONE BALANCE, AND MONEY THAT ACTUALLY MOVES.
 *
 * Reported: "I have balance in the receive wallet now, but not showing in the
 * dashboard or the transfer area... we should have one uniform balance logic."
 *
 * Investigating that turned up four separate defects, in increasing order of
 * seriousness:
 *
 * 1. TWO BALANCES THAT NEVER SPOKE.
 *    Receive read the Privy wallet live (/wallets?balances=true). Dashboard
 *    and Transfer summed a LEDGER. Grepping every caller of
 *    createBalanceLedgerEntry shows the ledger is credited from exactly two
 *    places - Bridge virtual-account settlements and admin adjustments.
 *    NOTHING credits it when crypto lands in a user's own Privy wallet. So
 *    real money was invisible to every path that decides what may be spent.
 *
 * 2. NOTHING EVER SENT ANYTHING.
 *    `grep -rn '\.createTransfer(' src/` returned NOTHING outside the adapter
 *    itself. requestBalanceTransfer validated, wrote a hold, wrote an audit
 *    log and returned. "Send crypto" marked money as spoken for and stopped.
 *    The Privy adapter that signs, sponsors gas and broadcasts was unreachable
 *    from any route.
 *
 * 3. THE REVIEW THRESHOLD WAS DEAD CODE.
 *      status: amount >= manualReviewThreshold || riskHoldsEnabled ? ...
 *    riskHoldsEnabled defaults to TRUE and is OR'd, so the 1,000 threshold
 *    could never apply and EVERY transfer went to manual review.
 *
 * 4. OFF-RAMP ASKED THE USER TO MOVE THEIR OWN CRYPTO.
 *    Breet returns a deposit address and the flow stopped there, even though
 *    the funds sit in a Sivan-signable wallet with gas sponsored.
 *
 * Run: npm run test:unified-balance
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
/** Comments describe the bug and name the very calls being banned. */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const after = source.slice(start);
  const next = after.slice(1).search(/\nexport (async )?function |\nasync function |\nfunction /);
  return next < 0 ? after : after.slice(0, next + 1);
}

async function main() {
  console.log('\n1. THE UNIFIED BALANCE EXISTS AND COMBINES BOTH SOURCES\n');
  {
    const svc = code('src/balances/unified-balance.service.ts');
    check('the service exists', svc.length > 0);
    check('it reads the LEDGER', /getUserBalance\(/.test(svc));
    check('and it reads the CHAIN through the wallet provider',
      /provider\.getBalances\(/.test(svc));
    /**
     * The formula is the whole point. chain + credited - held, floored.
     */
    check('spendable = chain + credited - held',
      /num\(row\.chain\) \+ num\(row\.credited\) - num\(row\.held\)/.test(svc));
    /**
     * Scoped to the spendable lines. My first regex was `Math.max([^)]*, 0)`,
     * which cannot match `Math.max(num(row.chain) + ... , 0)` because the
     * argument contains its own parentheses - it failed against correct code.
     */
    check('and is floored at zero, because a hold can exceed a readable balance',
      (svc.match(/money\(Math\.max\(/g) ?? []).length === 2,
      `${(svc.match(/money\(Math\.max\(/g) ?? []).length} floored expressions`);
    /**
     * "Could not read" must never render as "you have nothing". That is the
     * difference between a slow RPC and telling a user their funds vanished.
     */
    check('a failed chain read is distinguished from a zero balance',
      /chainUnavailable/.test(svc));
    /**
     * MY OWN BUG, caught by pointing this at the real Privy wallet while an
     * upstream RPC returned HTTP 521.
     *
     * The first version set chainUnavailable by looping byAsset.values(). The
     * chain is what CREATES those rows, so when the read failed there were no
     * rows yet, the loop ran over an empty map, and the failure was silently
     * lost. getSpendable then found no row and returned 0 instead of null - an
     * RPC outage read as "you have no money" and refused every send with a
     * confident, wrong number.
     */
    check('the failure flag does not depend on rows the failed read would have created',
      /const anyChainUnavailable = wallets\.some/.test(svc));
    check('and it is applied to every row afterwards',
      /if \(anyChainUnavailable\) row\.chainUnavailable = true/.test(svc));
    check('with at least one row surfaced so the flag is visible at all',
      /if \(anyChainUnavailable && byAsset\.size === 0\) ensure\('usdc'\)/.test(svc));
    check('and getSpendable returns null rather than guessing',
      /if \(row\.chainUnavailable && num\(row\.credited\) === 0\) return null/.test(svc));
    check('per-wallet reads run in parallel', /Promise\.all\(/.test(svc));

    /**
     * ONE EVM WALLET SERVES SEVERAL EVM CHAINS - AND THE MONEY IS RARELY ON
     * THE ONE IT IS FILED UNDER.
     *
     * walletsToProvision() issues a single 'ethereum' wallet that `alsoServes`
     * base: same key, same address, different networks. NOTHING in the
     * codebase read `alsoServes`, so the first version of this service asked
     * for balances on 'ethereum' only.
     *
     * Caught by a REAL off-ramp, not by these tests: a wallet holding 180.59
     * USDC on BASE Sepolia reported chain=0, spendable=0, and the sweep
     * silently declined to send. Every unit assertion passed, because none of
     * them crossed the chain boundary. Base is the default deposit network, so
     * this would have hidden most users' money.
     */
    /**
     * UPDATED. These two used to assert the presence of:
     *
     *   walletsToProvision().find((entry) => entry.chain === wallet.chain)?.alsoServes
     *
     * which is the code that turned out to BE the next bug. walletsToProvision()
     * lists only 'ethereum' and 'solana', and every wallet this deployment
     * actually creates is filed as 'base', so that .find returned undefined and
     * `?? []` quietly narrowed the read back to one chain. The assertions
     * passed the whole time - they were pinned to an implementation rather than
     * to the behaviour, so they guarded the bug instead of the fix.
     *
     * Now pinned to the behaviour: the served list comes from the key family
     * and cannot collapse to empty. See test:wallet-chain-family.
     */
    check('every chain an EVM wallet serves is read, not just its filed chain',
      /networksServedByWallet\(wallet\.chain\)/.test(svc));
    check('and the served list cannot silently fall back to empty',
      !/alsoServes\s*\?\?\s*\[\]/.test(svc) && !/walletsToProvision/.test(svc));
    check('the balance is read on that chain, not on the wallet record chain',
      /chain as WalletChain/.test(svc) && !/wallet\.chain as WalletChain/.test(svc));
    check('a provider throw is caught per wallet, not for the whole call',
      /catch \(error\)[\s\S]{0,400}balancesUnavailable: true/.test(svc));
  }

  console.log('\n   …and it is actually exposed and consumed\n');
  {
    const routes = code('src/balances/balance.routes.ts');
    check('GET /balance/unified is routed', /balance\/unified/.test(routes));
    check('and calls the unified service', /getUnifiedBalance\(userId\)/.test(routes));
    /**
     * The ledger endpoint must SURVIVE: the "deposit, hold and spend trail" is
     * genuinely a journal and should keep reading like one.
     */
    check('the ledger endpoint still exists for the journal view',
      /getUserBalance\(userId\)/.test(routes));

    const hook = code('frontend/src/hooks/usePaymentData.ts');
    check('the frontend fetches it', /balance\/unified/.test(hook));
    const app = code('frontend/src/App.tsx');
    check('App holds it in state', /setUnifiedBalance/.test(app));
    check('and passes it to the transfer screen', /unifiedBalance=\{unifiedBalance\}/.test(app));

    const view = code('frontend/src/components/transfer/TradeTransferSections.tsx');
    check('the transfer screen prefers the unified figure',
      /unified \? Number\(unified\.spendable/.test(view));
    check('and falls back to the ledger rather than to zero',
      /: Number\(usdc\?\.available \|\| 0\)/.test(view));
  }

  console.log('\n2. SENDING ACTUALLY BROADCASTS\n');
  {
    const svc = code('src/balances/balance.service.ts');
    /**
     * THE REGRESSION GUARD FOR THE BIGGEST DEFECT. Before this, no route in
     * the product reached createTransfer at all.
     */
    check('the balance service calls the wallet provider',
      /provider\.createTransfer\(/.test(svc));
    check('through an executeBalanceTransfer step',
      /export async function executeBalanceTransfer/.test(svc));
    check('and requestBalanceTransfer invokes it', /await executeBalanceTransfer\(/.test(svc));

    const request = fnBody(svc, 'export async function requestBalanceTransfer');
    /**
     * A transfer under review must NOT be sent, or the review is theatre.
     */
    check('it only sends when no review is required',
      /if \(!needsReview\) \{/.test(request));
    /**
     * A failed broadcast that leaves the hold in place strands the user's
     * money behind a transfer that never happened.
     */
    check('a failed send releases the hold', /kind: 'hold_release'/.test(request));
    check('and records the failure', /balance\.transfer_failed/.test(request));

    const execute = fnBody(svc, 'export async function executeBalanceTransfer');
    check('the hold becomes a DEBIT once sent, not a release',
      /kind: 'debit_transfer'/.test(execute));
    /**
     * Solana has its own key; every EVM chain shares one. Getting this wrong
     * signs against a wallet that does not hold the funds.
     */
    /**
     * UPDATED for the same reason. This asserted the literal
     * `network === 'solana' ? 'solana' : 'ethereum'` ternary, which was fine as
     * a description of key material and fatal as a DATABASE LOOKUP: the row is
     * filed as 'base', so findUserWallet(userId, 'ethereum') found nothing and
     * a real user's 10 USDC send sat in pending_review.
     */
    check('the signing wallet is found by chain family, not by literal chain',
      /findUserWalletForNetwork\(userId, transfer\.network\)/.test(execute)
      && !/db\.findUserWallet\(/.test(execute));
    check('idempotency is keyed on the transfer, so a retry cannot double-spend',
      /idempotencyKey: `btx_\$\{transfer\.transferId\}`/.test(execute));
    /**
     * A REGRESSION I INTRODUCED AND test:balance-transfer CAUGHT.
     *
     * My first version THREW when the user had no wallet. But a user funded
     * entirely by a Bridge virtual-account settlement or an admin adjustment
     * has real spendable ledger balance and no Privy wallet - those funds are
     * in pooled custody and an operator moves them. Throwing rejected a
     * legitimate transfer and, because the caller releases the hold on
     * failure, made it look like the request had merely bounced.
     */
    check('a user with no wallet is queued for an operator, not thrown at',
      /status: 'pending_review'/.test(execute) && !/throw badRequest\(`You do not have/.test(execute));
    check('and that hand-off is recorded',
      /balance\.transfer_requires_operator/.test(execute));
  }

  console.log('\n3. THE SPEND CHECK ASKS THE RIGHT QUESTION\n');
  {
    const svc = code('src/balances/balance.service.ts');
    const request = fnBody(svc, 'export async function requestBalanceTransfer');
    check('it checks SPENDABLE, not the ledger figure',
      /const spendable = await getSpendable\(/.test(request));
    check('and the old ledger-only check is gone',
      !/amount\(assetBalance\?\.available\) < input\.amount/.test(request));
    /**
     * "We do not know" must refuse. Assuming zero blocks a funded user;
     * assuming plenty signs a transfer that reverts after we said it worked.
     */
    check('an unreadable balance refuses rather than assuming',
      /if \(spendable === null\)/.test(request));
    check('and the refusal says how much IS available',
      /You can send up to/.test(request));
  }

  console.log('\n4. THE REVIEW THRESHOLD MEANS SOMETHING AGAIN\n');
  {
    const svc = code('src/balances/balance.service.ts');
    /**
     * The bug: `>= threshold || riskHoldsEnabled` with riskHoldsEnabled
     * defaulting to true made the threshold unreachable.
     */
    check('the OR that made the threshold dead code is gone',
      !/input\.amount >= controls\.manualReviewThreshold \|\| controls\.riskHoldsEnabled/.test(svc));
    check('review now requires BOTH the toggle and the threshold',
      /controls\.riskHoldsEnabled && input\.amount >= controls\.manualReviewThreshold/.test(svc));
  }

  console.log('\n   …proved arithmetically, since this decides who waits for a human\n');
  {
    // Mirrors the shipped expression exactly.
    const needsReview = (amount: number, riskHolds: boolean, threshold: number) =>
      riskHolds && amount >= threshold;
    check('30 under a 1000 threshold goes straight through',
      needsReview(30, true, 1000) === false);
    check('1000 exactly is reviewed', needsReview(1000, true, 1000) === true);
    check('1500 is reviewed', needsReview(1500, true, 1000) === true);
    check('with risk holds OFF even a large amount is not reviewed',
      needsReview(5000, false, 1000) === false);
    /**
     * The old expression, kept as a witness: it reviewed a 30 USDC send.
     */
    const oldBehaviour = (amount: number, riskHolds: boolean, threshold: number) =>
      amount >= threshold || riskHolds;
    check('the OLD expression really did review a 30 USDC send',
      oldBehaviour(30, true, 1000) === true);
  }

  console.log('\n5. OFF-RAMP SWEEPS FROM THE WALLET TO THE RAIL\n');
  {
    const svc = code('src/ngn/service/ngn-transfers.service.ts');
    check('a sweep step exists', /async function sweepToRail/.test(svc));
    check('it is invoked on offramp only',
      /transfer\.direction === 'offramp' && transfer\.depositAddress/.test(svc));
    check('and it sends to the rail deposit address',
      /toAddress: transfer\.depositAddress!/.test(svc));

    const sweep = fnBody(svc, 'async function sweepToRail');
    /**
     * Never sweep more than the wallet holds: Privy signs what it is told to,
     * and an oversized transfer reverts AFTER the user has been told their
     * off-ramp is under way.
     */
    check('it refuses to sweep more than is spendable',
      /spendable === null \|\| spendable < amount/.test(sweep));
    check('idempotency is keyed on the transfer', /idempotencyKey: `ngnsweep_\$\{transfer\.id\}`/.test(sweep));
    check('the signing wallet is found by chain family, not by literal chain',
      /findUserWalletForNetwork\(transfer\.userId, network\)/.test(sweep)
      && !/db\.findUserWallet\(/.test(sweep));
    /**
     * NON-FATAL by design: the order and deposit address are already valid, so
     * a sweep failure must not destroy them. Manual send still works and the
     * reconciler still watches the address.
     */
    /**
     * REPINNED. This searched acceptNgnQuote's own body for the try/catch.
     * The sweep now runs in scheduleSweep(), a detached task started AFTER the
     * response is sent - because awaiting an on-chain transfer inside the HTTP
     * handler blew the Cloudflare worker's 12s budget and returned a 503 for
     * an order that had actually been created.
     *
     * The PROPERTY is unchanged and is what this still asserts: a sweep
     * failure is caught and audited, never thrown, so the order and its
     * deposit address survive. Only the function it lives in moved.
     */
    const sweepTask = fnBody(svc, 'function scheduleSweep');
    check('a sweep failure does not destroy the order',
      /catch \(error\) \{[\s\S]{0,400}ngn\.sweep_failed/.test(sweepTask));
    check('and the order is created before the sweep is even attempted',
      /scheduleSweep\(transfer\)/.test(fnBody(svc, 'export async function acceptNgnQuote')),
      'the response must not wait on a blockchain');
    check('and the failure is recorded for operators',
      /action: 'ngn\.sweep_failed'/.test(svc));
    /**
     * REPINNED. This asserted the literal `if (!wallet) return undefined`.
     * The sweep was since refactored to route every skip through
     * recordSweepSkipped(), which returns undefined AND logs the reason - the
     * behaviour is unchanged and strictly better, but the literal moved.
     *
     * Pinned to the BEHAVIOUR now: a missing wallet must still be a skip
     * rather than a throw, because a user who funds their wallet elsewhere is
     * a legitimate case and not a failed off-ramp.
     */
    check('a user with no wallet is skipped, not failed',
      /if \(!wallet\) return recordSweepSkipped\(transfer, 'no_wallet_for_network'/.test(sweep));
    check('and the skip is recorded rather than silent',
      /return undefined;/.test(fnBody(svc, 'async function recordSweepSkipped'))
      && /action: 'ngn\.sweep_skipped'/.test(svc));
  }

  console.log('\n6. A REFUSAL THE USER CAN ACT ON\n');
  {
    /**
     * avalanche_c_chain is ENABLED as a deposit network but carries no USDC or
     * USDT the naira rail can settle, so a user can pick it in the sell screen
     * and be refused. The refusal said "Breet cannot price USDC on
     * avalanche_c_chain", which safeUserMessage() rewrites - because it names
     * a provider - to "We could not complete that request." Measured live
     * against api-test: exactly that blank refusal, with the one useful fact
     * (which network to use instead) stripped out.
     */
    const breet = code('src/ngn/provider/breet.provider.ts');
    check('the unsupported-network refusal names no provider',
      !/Breet cannot price/.test(breet));
    check('and tells the user which networks DO work',
      /Use Base, Ethereum or Solana instead/.test(breet));
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error('threw:', error); process.exit(1); });

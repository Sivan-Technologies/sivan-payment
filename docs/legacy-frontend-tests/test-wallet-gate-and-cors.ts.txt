/**
 * TWO REPORTED PRODUCTION FAILURES.
 *
 * 1. "when creating a wallet on live i get this"
 *      POST /api/users/:id/wallets  400 (Bad Request)
 *
 *    Reproduced against the deployed test API with a fresh account:
 *      "Add and confirm your payout bank account to create your wallet."
 *
 *    The button was OFFERED and then refused. The screen and the server were
 *    asking different questions:
 *
 *      ReceiveView   isVerified = pathComplete - "did you finish your
 *                    country's path". Its fallback, before
 *                    /verification-summary loads, is
 *                    `customer?.kycStatus === 'kyc_approved'`, which says
 *                    nothing whatever about a bank account.
 *      the server    canProvisionWallet() - level >= BANK **and**
 *                    bankStatus === VERIFIED.
 *
 *    A Bridge-approved user with no payout account passes the first and fails
 *    the second, and so does anyone whose summary call was slow, because the
 *    fallback grants access by default.
 *
 * 2. CORS from the Render-hosted frontends.
 *      Origin https://sivan-payments-user-test.onrender.com -> no
 *      Access-Control-Allow-Origin, every fetch ERR_FAILED.
 *
 *    The Cloudflare worker in front of the API answers the preflight, and its
 *    allow-list carried only *.vercel.app patterns. The API's own CORS_ORIGIN
 *    already permitted the Render hosts; the gateway did not.
 *
 *    Both worker files on disk carry the fix. Neither is DEPLOYED - verified
 *    live, the gateway still returns no ACAO for that origin. This test pins
 *    the file so the fix cannot be lost again while it waits for a deploy.
 *
 * Run: npm run test:wallet-gate-and-cors
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canProvisionWallet } from '../src/wallets/wallet-eligibility.js';
import { CheckStatus, VerificationLevel } from '../src/kyc/types/verification.types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const home = path.resolve(root, '..');
const readHome = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const state = (over: Partial<any> = {}) => ({
  level: VerificationLevel.NONE,
  identityStatus: CheckStatus.NOT_STARTED,
  bankStatus: CheckStatus.NOT_STARTED,
  bvnStatus: CheckStatus.NOT_STARTED,
  ninStatus: CheckStatus.NOT_STARTED,
  livenessStatus: CheckStatus.NOT_STARTED,
  proofOfAddressStatus: CheckStatus.NOT_STARTED,
  sourceOfFundsStatus: CheckStatus.NOT_STARTED,
  riskLevel: 'low',
  enhancedDueDiligence: false,
  ...over,
}) as any;

console.log('\n── what the SERVER actually requires for a wallet ─────────────');

const noBank = canProvisionWallet(state({ level: VerificationLevel.NONE }));
check('nothing verified at all -> refused', !noBank.eligible);
/**
 * THE REASON NOW NAMES BOTH ROUTES.
 *
 * It used to be pinned to the exact string "Add and confirm your payout bank
 * account to create your wallet." That was the only way to clear this gate at
 * the time. It no longer is - identity alone clears it - so a message naming
 * only the bank sends a user who needs a document check to the wrong screen,
 * and names a step a non-Nigerian's path never asks for.
 *
 * Asserting on MEANING rather than the exact sentence, so rewording the copy
 * does not fail the test while changing which routes it offers does.
 */
check('and the reason offers identity as a route', /identity/i.test(noBank.reason), noBank.reason);
check('and still offers the payout-account route', /payout bank account/i.test(noBank.reason), noBank.reason);

const bankOk = canProvisionWallet(state({ level: VerificationLevel.BANK, bankStatus: CheckStatus.VERIFIED }));
check('a verified payout account -> allowed', bankOk.eligible, bankOk.reason);

/**
 * The case that produced the report: level says BANK but the bank check is
 * stale. A cached level must never outrank the evidence under it.
 */
/**
 * WHAT "STALE" MEANS HAS BEEN NARROWED, DELIBERATELY.
 *
 * This asserted that level BANK with bankStatus NOT_STARTED must be refused.
 * That conflated "your payout account has a problem" with "you have not added
 * one yet", and the second is now a legitimate state - a Bridge-approved user
 * reaches IDENTITY with no payout account at all and must be able to hold a
 * wallet.
 *
 * A FAILED or EXPIRED check is still stale evidence and must still refuse: a
 * deposit address, unlike a transaction, cannot be withdrawn once issued.
 */
const failedBank = canProvisionWallet(state({ level: VerificationLevel.BANK, bankStatus: CheckStatus.FAILED }));
check('a FAILED bank check -> still refused', !failedBank.eligible, failedBank.reason);
const expiredBank = canProvisionWallet(state({ level: VerificationLevel.BANK, bankStatus: CheckStatus.EXPIRED }));
check('an EXPIRED bank check -> still refused', !expiredBank.eligible, expiredBank.reason);

/**
 * AND THE CASE THE UI GOT WRONG. A Bridge-approved user (kyc_approved, which
 * is what the frontend fallback tests) with NO payout account. The old screen
 * showed them the button.
 */
/**
 * THE POLICY REVERSED HERE, ON PURPOSE.
 *
 * This previously asserted that a Bridge-approved user with no payout account
 * must be REFUSED, and called the UI wrong for offering them a button. On
 * review that was the wrong way round: the person had completed a document
 * check Sivan paid for, and a wallet is where their crypto LANDS - it has
 * nothing to do with where naira would later be sent. Refusing them produced
 * an account reading "Verification complete" and "Level 0: Starter" at once.
 *
 * Withdrawing to a Nigerian bank still requires a name-matched NUBAN. That is
 * a separate gate, enforced at the withdrawal, and it is untouched.
 */
const bridgeNoBank = canProvisionWallet(state({ level: VerificationLevel.IDENTITY, bankStatus: CheckStatus.NOT_STARTED }));
check('Bridge-approved with no payout account -> ALLOWED a wallet', bridgeNoBank.eligible,
  bridgeNoBank.reason);

console.log('\n── the screen now asks the SAME question ──────────────────────');

const receive = read('frontend/src/components/ReceiveView.tsx');
const app = read('frontend/src/App.tsx');

/**
 * THESE WERE SOURCE-REGEX ASSERTIONS AND TWO OF THEM PINNED THE OLD RULE.
 *
 * `/if \(!isVerified \|\| !hasPayoutAccount\)/` matched the literal text of a
 * condition, so it failed the moment the condition changed - which is the
 * point - but it could equally have passed against that line sitting inside a
 * comment or a dead branch. It asserts that code EXISTS, not that it RUNS,
 * which is a failure mode already recorded twice in this repo.
 *
 * The real behaviour - does a Bridge-approved user with no NUBAN get a deposit
 * address - is asserted in the browser by e2e/receive-gate.mjs, against the
 * rendered page. What is worth checking HERE, cheaply, is that the screen has
 * not drifted back to demanding a payout account for identity, and that the
 * server-side answer it mirrors is the one above.
 *
 * Comments are stripped first so a paragraph explaining the old rule cannot
 * satisfy a check about the new one.
 */
const receiveCode = receive.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check('ReceiveView no longer blocks a verified user for lacking a payout account',
  !/if \(!isVerified \|\| !hasPayoutAccount\)/.test(receiveCode),
  'the payout-account gate is back on the receive screen');
check('ReceiveView still gates on verification',
  /if \(!isVerified\)/.test(receiveCode));
check('App passes the same hasBank the rest of the app uses',
  app.includes('hasPayoutAccount={hasBank}'),
  'a second source of truth here would drift from the server');
check('the identity message is still shown when identity IS the gap',
  receive.includes('Verify your identity first'));
check('and adding a payout account is still offered as a route',
  receive.includes('Add payout account'));

console.log('\n── the Cloudflare gateway must allow the Render frontends ─────');

for (const file of ['cloudflare-worker-test-DEPLOY.js', 'cloudflare-worker-live-FIXED.js', 'cloudflare-worker-test-FIXED.js']) {
  const worker = readHome(file);
  const match = worker.match(/const ALLOWED_ORIGIN_PATTERNS = \[([\s\S]*?)\];/);
  check(`${file}: has an origin allow-list`, Boolean(match));
  if (!match) continue;

  // Evaluate the REAL patterns rather than grepping for a substring: a comment
  // mentioning onrender.com would satisfy a grep and allow nothing.
  const patterns: RegExp[] = eval(`[${match[1]}]`);
  const allows = (origin: string) => patterns.some((p) => p.test(origin));

  check(`${file}: allows the Render test frontend`, allows('https://sivan-payments-user-test.onrender.com'));
  check(`${file}: allows the Render live frontend`, allows('https://sivan-payments-user.onrender.com'));
  check(`${file}: still allows Vercel`, allows('https://sivan-payments-user-test.vercel.app'));
  check(`${file}: still allows the custom domain`, allows('https://app.sivantech.online'));

  /**
   * The allow-list is the only thing between a hostile page and an
   * authenticated request made with a logged-in user's own cookies. Widening
   * it to a bare *.onrender.com - which anyone can deploy to - would trade one
   * bug for a much worse one.
   */
  check(`${file}: does NOT allow a stranger's Render app`, !allows('https://evil.onrender.com'));
  check(`${file}: does NOT allow a stranger's Vercel app`, !allows('https://evil.vercel.app'));
  check(`${file}: is not fooled by a suffix attack`, !allows('https://sivan-x.onrender.com.evil.com'));
  check(`${file}: does not allow plain http on a real host`, !allows('http://sivan-payments-user.onrender.com'));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

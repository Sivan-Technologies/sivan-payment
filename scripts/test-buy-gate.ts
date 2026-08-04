/**
 * "THE PAYMENTS-API SERVICE DID NOT RESPOND." ON A SCREEN THAT SHOULD HAVE
 * SAID NO IN THE FIRST PLACE.
 *
 * Reported from a phone, app.sivantech.online/buy. A Nigerian user at Level 1
 * - bank check done, dashboard showing verified and 100% set up - filled in
 * the whole buy form and pressed "Create buy order". They got:
 *
 *   The payments-api service did not respond. This was a POST request and it
 *   was NOT retried, because repeating it could duplicate the action. Check
 *   whether it took effect before trying again.
 *
 * That is the Cloudflare gateway giving up, and it is the most frightening
 * message we own: it tells someone their money might already be moving.
 *
 * Reproduced against the deployed test API. TWO defects, not one.
 *
 * 1. THE WRONG GATE ON THE FRONTEND.
 *    `isVerified` is `summary.pathComplete` - "did you finish the check your
 *    COUNTRY asks for". True for a Nigerian at Level 1. But buying stablecoins
 *    runs on BRIDGE, which requires its own document check, so the server
 *    correctly refused with "Complete verification before buying stablecoins"
 *    - to a user the same app had just told was verified. The form should
 *    never have rendered.
 *
 * 2. EIGHTEEN SECONDS TO SAY NO.
 *    Measured warm, three times: 18155ms, 17625ms, 17977ms. The gateway cuts
 *    at 12s, so the user never even saw the refusal. Cause: four control
 *    guards, each calling listPaymentControls(), each doing a full db.read() -
 *    47 sequential `select *` queries on Postgres - all BEFORE the cheap
 *    "is this user even allowed" check.
 *
 * Run: npm run test:buy-gate
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeRequiredMessage } from '../src/onramp/service/onramp-validation.service.js';
import { leaksInternals, safeUserMessage } from '../src/shared/user-message.js';
import { bridgeFlowBlockedReason, canUseBridgeFlows } from '../frontend/src/verificationPath.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

function main() {
  console.log('\nWHO MAY USE A BRIDGE-BACKED FLOW\n');
  {
    check('an approved Bridge customer may', canUseBridgeFlows('kyc_approved') === true);
    check('and the provider spellings are accepted too',
      canUseBridgeFlows('approved') === true && canUseBridgeFlows('active') === true);
    /**
     * THE BUG, IN ONE ASSERTION. A Nigerian at Level 1 has pathComplete=true
     * and no Bridge KYC. If this returns true the buy form renders and the
     * user is walked into a server refusal they cannot see.
     */
    check('a Nigerian at Level 1 with no Bridge KYC may NOT',
      canUseBridgeFlows('kyc_not_started') === false);
    check('nor may someone still under review', canUseBridgeFlows('kyc_under_review') === false);
    check('nor someone rejected', canUseBridgeFlows('kyc_rejected') === false);
    check('nor someone with no customer row at all', canUseBridgeFlows(undefined) === false);
    /**
     * Level 2 by NIN/BVN is a Sivan judgement about naira limits. Bridge has
     * agreed to nothing, so it must not open a Bridge flow.
     */
    check('a level, however high, is not Bridge approval',
      canUseBridgeFlows('level_2') === false && canUseBridgeFlows('verified') === false);
  }

  console.log('\nWHAT THE NIGERIAN AT LEVEL 1 IS TOLD\n');
  {
    const msg = bridgeFlowBlockedReason('kyc_not_started', 'ngn_bank', 'Buying stablecoins');
    console.log(`     "${msg}"`);
    check('there IS a reason', Boolean(msg));
    /**
     * The heart of the report. "Complete verification" to someone who just
     * completed verification reads as the app being broken. The message has to
     * acknowledge what they have done.
     */
    check('it credits the bank check they already passed',
      /bank verification/i.test(msg ?? ''), msg);
    check('and does not simply say "complete verification"',
      !/^complete verification/i.test(msg ?? ''), msg);
    check('it names Bridge, so the next screen is not a surprise',
      /Bridge/.test(msg ?? ''), msg);
    check('it says concretely what is needed', /photo ID/i.test(msg ?? '') && /selfie/i.test(msg ?? ''), msg);
    check('and it names the action being blocked', /Buying stablecoins/.test(msg ?? ''), msg);
  }

  console.log('\n  …and the other states get their own answer\n');
  {
    const review = bridgeFlowBlockedReason('kyc_under_review', 'ngn_bank', 'Buying stablecoins');
    check('under review is not told to go and verify',
      /being reviewed/i.test(review ?? '') && !/photo ID/i.test(review ?? ''), review);
    const rejected = bridgeFlowBlockedReason('kyc_rejected', 'bridge_kyc', 'Buying stablecoins');
    check('a rejection points at support', /support/i.test(rejected ?? ''), rejected);
    const foreign = bridgeFlowBlockedReason('kyc_not_started', 'bridge_kyc', 'Buying stablecoins');
    check('a non-Nigerian is not told about a bank check they never took',
      !/bank verification/i.test(foreign ?? ''), foreign);
    check('an approved user is given no reason at all',
      bridgeFlowBlockedReason('kyc_approved', 'ngn_bank', 'Buying stablecoins') === undefined);
  }

  console.log('\nTHE SERVER SAYS THE SAME THING AS THE SCREEN\n');
  {
    /**
     * These two decide the same question at different layers. When they
     * disagree the user is told one thing by the button and another by the
     * error, which is exactly the split that produced this report.
     */
    const server = bridgeRequiredMessage('ngn_bank', 'kyc_not_started');
    const client = bridgeFlowBlockedReason('kyc_not_started', 'ngn_bank', 'Buying stablecoins');
    check('the server also credits the bank check', /bank verification/i.test(server), server);
    check('the server also asks for ID and selfie',
      /photo ID/i.test(server) && /selfie/i.test(server), server);

    /**
     * THE SERVER MUST NOT NAME THE PROVIDER, AND THE FRONTEND MAY.
     *
     * My first draft of the server message said "our partner Bridge". It never
     * reached a user: safeUserMessage() rewrites anything matching
     * PROVIDER_NAMES to "We could not complete that request", so all the
     * careful wording was replaced by the blandest possible line. Found by
     * running the endpoint, not by reading the code.
     *
     * These four assertions pin BOTH halves of that rule, because getting
     * either wrong silently destroys the message.
     */
    for (const status of ['kyc_not_started', 'kyc_under_review', 'kyc_rejected', undefined]) {
      for (const p of ['ngn_bank', 'bridge_kyc'] as const) {
        const m = bridgeRequiredMessage(p, status);
        const leak = leaksInternals(m);
        check(`server message survives the leak filter (${p}/${status ?? 'none'})`,
          leak === undefined, `leaks "${leak}"`);
        check(`  …and is not swallowed at the edge (${p}/${status ?? 'none'})`,
          safeUserMessage(m, 400) === m, safeUserMessage(m, 400));
      }
    }
    // The frontend is a different context: it names the partner on purpose,
    // right before handing the user to their domain.
    check('the frontend still names the partner, as a disclosure',
      /Bridge/.test(client ?? ''), client);
    check('neither opens with a bare "complete verification"',
      !/^complete verification/i.test(server) && !/^complete verification/i.test(client ?? ''));
    check('the server under-review wording matches the screen',
      /being reviewed/i.test(bridgeRequiredMessage('ngn_bank', 'kyc_under_review')));
    check('and the server no longer emits the old contradictory sentence',
      !read('src/onramp/service/onramp-validation.service.ts')
        .includes("badRequest('Complete verification before buying stablecoins')"));
  }

  console.log('\nEIGHTEEN SECONDS TO SAY NO — THE READ COUNT\n');
  {
    const raw = read('src/onramp/service/onramp-validation.service.ts');
    /**
     * COMMENTS STRIPPED FIRST.
     *
     * The first version of these checks counted matches in this file's own
     * doc comment - which describes the bug and therefore names db.read() and
     * listPaymentControls() - and reported two calls where the code has one.
     * A test that greps prose is not testing the code.
     */
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    /**
     * Each of these guards did its own listPaymentControls(), and each of
     * those is a whole-database read. Four of them, per rejected request.
     */
    const guardCalls = (src.match(/await require(CurrencyEnabled|SourceAssetEnabled|SourceNetworkEnabled)\(/g) ?? []).length;
    check('the three whole-database control guards are gone', guardCalls === 0, `${guardCalls} remain`);
    check('the controls are read exactly once',
      (src.match(/listPaymentControls\(\)/g) ?? []).length === 1,
      `${(src.match(/listPaymentControls\(\)/g) ?? []).length} calls`);
    /**
     * db.read() is the 47-query one. The user lookup must use the indexed
     * finders instead.
     */
    check('and the whole database is never read here', !/db\.read\(\)/.test(src));
    check('the user is fetched by an indexed lookup', /db\.findUserById\(/.test(src));
    check('as is the customer', /db\.findCustomerByUserId\(/.test(src));
    check('the three lookups run in parallel, not in series',
      /Promise\.all\(\[[\s\S]{0,240}listPaymentControls\(\)[\s\S]{0,240}findCustomerByUserId/.test(src));

    /**
     * ORDERING. The refusal must be reachable before the expensive work, or
     * the honest answer arrives after the gateway has already given up.
     */
    const userGate = src.indexOf('customer.kycStatus !== ');
    const currencyGate = src.indexOf('payoutCurrencies.find');
    check('the verification refusal is decided BEFORE the control checks',
      userGate > 0 && currencyGate > 0 && userGate < currencyGate,
      `user@${userGate} controls@${currencyGate}`);
  }

  console.log('\nTHE BUY SCREEN MUST NOT OFFER A FORM IT CANNOT SUBMIT\n');
  {
    const view = read('frontend/src/components/transfer/TradeTransferSections.tsx');
    check('BuyCryptoView is told why Bridge would refuse',
      /bridgeBlockedReason\?: string;/.test(view));
    check('and the gate actually consults it',
      /!hasUser \|\| !isVerified \|\| bridgeBlockedReason \?/.test(view));
    check('the reason is shown verbatim, not replaced by a generic line',
      /bridgeBlockedReason \?\? 'Complete verification before buying stablecoins\.'/.test(view));
    /**
     * "Verify account" sent a Nigerian to the modal, which asked their country
     * and served the bank form they had already completed. The button has to
     * request the DOCUMENT path explicitly.
     */
    check('the button opens the ID path, not the bank form again',
      /bridgeBlockedReason \? onVerifyWithId :/.test(view));
    check('and it is labelled for what it does', /'Verify with ID →'/.test(view));

    const app = read('frontend/src/App.tsx');
    check('App computes the reason from the Bridge status',
      /bridgeFlowBlockedReason\(\s*customer\?\.kycStatus/.test(app));
    check('and passes it to the buy screen', /bridgeBlockedReason=\{buyBlockedReason\}/.test(app));
    check('wired to the explicit Bridge path', /onVerifyWithId=\{openBridgeVerification\}/.test(app));
    /**
     * The submit handler was gated on isVerified - the country path - which is
     * the same wrong question the screen was asking.
     */
    check('the submit guard uses the Bridge check, not the country path',
      /if \(!canUseBridge\) return notify\(buyBlockedReason/.test(app));
    check('and the old country-path guard is gone from the buy handler',
      !/if \(!isVerified\) return notify\('Please complete verification before buying stablecoins/.test(app));

    /**
     * NARROWLY SCOPED ON PURPOSE. Naira payouts run on Breet and Bridge plays
     * no part; gating them on Bridge KYC would lock every Nigerian out of the
     * one rail that does work for them.
     */
    check('naira withdrawals are NOT gated on Bridge',
      /if \(!isVerified\) return notify\('Please complete verification first\.'/.test(app));
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();

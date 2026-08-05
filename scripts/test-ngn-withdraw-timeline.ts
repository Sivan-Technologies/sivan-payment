/**
 * THE WITHDRAW SCREEN CRASHED AFTER THE MONEY HAD ALREADY MOVED.
 *
 * Reported with a screenshot of sivan-payments-user-test.vercel.app/withdraw
 * showing nothing but:
 *
 *     Something went wrong. Please refresh or try again.
 *
 * and the console:
 *
 *     TypeError: Cannot read properties of undefined (reading 'currency')
 *     Caused by: React ErrorBoundary
 *
 * "its does show success page or failure page / the withdraw would still
 * proceed" - which is the whole severity of it. The order was created, the
 * user was charged, and the deposit address they needed in order to complete
 * the send was inside the response that crashed the page.
 *
 * REPRODUCED IN A REAL BROWSER, not reasoned about. Driving the built bundle
 * against a real API through the full naira flow - bank, account, amount,
 * quote, confirm - crashed on the "Create deposit" click with:
 *
 *     TypeError: Cannot read properties of undefined (reading 'map')
 *     at index-C-SSW4RJ.js:11:90413
 *
 * Resolved through the sourcemap to TransactionsSection.tsx, in
 * InlineTransactionTimeline, at `timeline.steps.map(...)`.
 *
 * ROOT CAUSE, established by calling the endpoint and reading the response:
 *
 *     POST /api/ngn/offramp/orders  ->  timeline: [ {key,label,status,at}, ... ]
 *     TransactionTimeline           ->  { status, steps: [...], requestId, ... }
 *
 * The naira rail sends the timeline as a BARE ARRAY of steps. App.tsx assigned
 * it straight to `transactionTimeline`, so the value was truthy with no
 * `.steps`, AppSections rendered the inline timeline, and it threw. The type
 * declares `steps: TransactionTimelineStep[]` as required, so every read of it
 * typechecked - a cast is a compile-time assertion and the wire is not.
 *
 * Two fixes, deliberately both:
 *   1. Normalise the array into the object shape at the App.tsx boundary that
 *      already reconciles the two rails.
 *   2. Default `steps` to [] at both render sites anyway. A missing step list
 *      is a degraded card; a throw is a lost deposit address. The cost of
 *      being wrong is asymmetric, so the guard stays even though (1) should
 *      make it unreachable.
 *
 * Run: npm run test:ngn-withdraw-timeline
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const appSrc = strip(read('frontend/src/App.tsx'));
const txSrc = strip(read('frontend/src/components/transactions/TransactionsSection.tsx'));
const sectionsSrc = strip(read('frontend/src/components/AppSections.tsx'));

console.log('\n── the crash: steps is optional at runtime ───────────────────');

check('the timeline panel no longer maps steps unguarded',
  !/timeline\.steps\.map\(/.test(txSrc),
  'this is the exact expression that threw');
check('the INLINE timeline no longer maps steps unguarded',
  !/\{timeline\.steps\.map\(/.test(txSrc),
  'the inline one is the component that actually crashed the confirm screen');
check('both render sites default steps to an array',
  (txSrc.match(/steps\s*=\s*timeline\??\.steps\s*\?\?\s*\[\]/g) ?? []).length >= 2,
  'one guard per component - the panel and the inline card are separate');
check('the panel no longer reads timeline.steps.length directly',
  !/timeline\.steps\.length/.test(txSrc));

/**
 * The type says `steps` is required. That is exactly why the bug survived: the
 * compiler had no reason to complain. Pinning it here so nobody "tidies up"
 * the guard on the grounds that the type makes it unnecessary.
 */
const typesSrc = read('frontend/src/types.ts');
check('TransactionTimeline still DECLARES steps as required',
  /steps:\s*TransactionTimelineStep\[\]/.test(typesSrc),
  'if this ever becomes optional the guards are still correct, but the comment explaining them must change');

console.log('\n── the root cause: an array is not an object with .steps ─────');

check('App.tsx normalises the timeline instead of passing it through',
  /transactionTimeline:\s*normalizeTimeline\(/.test(appSrc),
  'it previously assigned `value.timeline` straight across');
check('normalizeTimeline exists',
  /function normalizeTimeline\(/.test(appSrc));
check('it detects the array shape',
  /Array\.isArray\(raw\)/.test(appSrc),
  'the naira rail sends [ ...steps ], Bridge sends { steps: [...] }');
check('it returns undefined when there are no steps',
  /if \(!raw\.length\) return undefined/.test(appSrc),
  'a half-built timeline object renders as an empty card, which reads as missing data');
check('an already-correct object is passed through untouched',
  /return raw\.steps \? raw : undefined/.test(appSrc));

console.log('\n── the amount shown is the one the user receives ─────────────');

check('the naira leg is labelled with the destination currency',
  /currency:\s*String\(value\.destinationCurrency/.test(appSrc),
  'labelling 29,699.80 as USDC would be worse than showing nothing');
check('the asset sent is reported separately',
  /asset:\s*String\(value\.sourceCurrency/.test(appSrc));

console.log('\n── the confirmation screen states the money ──────────────────');

check('"You receive" is shown',
  /label="You receive"/.test(sectionsSrc),
  'the single number a person cares about on a withdrawal, and it was absent');
check('"You send" is shown', /label="You send"/.test(sectionsSrc));
check('the fee reads BOTH rails',
  /withdrawal\?\.feeAmount\s*\?/.test(sectionsSrc) && /withdrawal\?\.feePercent\s*\?/.test(sectionsSrc),
  'Bridge sends feePercent, Breet sends feeAmount - reading one showed "FEE —" on every NGN withdrawal');

console.log('\n── the network name is a name, not a database value ──────────');

check('the deposit warning runs the chain through networkLabel',
  /networkLabel\(result\.deposit\.chain\)/.test(sectionsSrc),
  'it rendered "Send only USDC on solana" on the screen where a user decides where to send real money');
check('networkLabel is imported',
  /import \{ networkLabel \} from '\.\.\/blockExplorer'/.test(sectionsSrc));

/**
 * Asserted against the real helper, not just its presence, because the point
 * is the OUTPUT.
 */
const { networkLabel } = await import('../frontend/src/blockExplorer.js');
check('networkLabel capitalises solana', networkLabel('solana') === 'Solana', networkLabel('solana'));
check('and expands avalanche_c_chain', networkLabel('avalanche_c_chain') === 'Avalanche', networkLabel('avalanche_c_chain'));
check('and does not mangle an unknown chain',
  networkLabel('some_new_chain') === 'Some new chain', networkLabel('some_new_chain'));

console.log('\n── the deposit card still cannot throw ───────────────────────');

check('the deposit address is optional-chained',
  /const depositAddress = result\.deposit\?\.address/.test(sectionsSrc),
  'this screen runs after the money moved and must never be the thing that throws');
check('a missing address degrades instead of crashing',
  /Withdrawal created/.test(sectionsSrc) && /could not load the deposit address/.test(sectionsSrc));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

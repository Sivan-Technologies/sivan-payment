/**
 * "THE OTHER PART DID NOT GET HIS PAYMENT."
 *
 * Reported with a screenshot: three crypto sends, all showing "Processing",
 * the oldest two hours old. Two of them 10 USDC to Solana.
 *
 * I CHECKED THE CHAIN FIRST, AND THE MONEY HAD ARRIVED.
 *
 *   sender    GVeUsx5Pz3fAhoaMyzbRqf4sVwQb2SBayDx9ahdgvdxS
 *   recipient EevL5P2e3j6p8vEkdxmaFPKf1pKrjigHBF3BGiD39nWm
 *
 *   sig QYMhAFgq...GGtT  finalized  err:null  30 -> 40 USDC
 *   sig 2Mshwrfk...vUZ7  finalized  err:null  40 -> 50 USDC
 *
 * Both transferChecked, both succeeded. The recipient holds 50 USDC and the
 * sender holds 0. Nothing was lost, and there was no bug in the sending path.
 *
 * TWO REAL BUGS MADE IT LOOK OTHERWISE.
 *
 * 1. NOTHING COULD EVER FINISH A TRANSFER.
 *    'completed' is declared in BalanceTransferStatus and, grepping every
 *    assignment, is set on LEDGER ENTRIES and never once on a transfer.
 *    executeBalanceTransfer writes 'processing' when the provider accepts the
 *    broadcast and that is the last word anything says. getTransfer() is
 *    called by the onramp, sync and supplier services and by NOTHING on this
 *    path. So "Processing" did not mean "in flight" - it meant "submitted, and
 *    never looked at again". It would have stayed that way forever.
 *
 * 2. THE HISTORY ROW SHOWED THE RECIPIENT AND CALLED IT NOTHING.
 *    It printed shortRef(destinationAddress) with no label. Two sends to the
 *    same person therefore showed the SAME truncated string, which reads as a
 *    duplicated transaction reference - exactly the "did not get his payment"
 *    conclusion. The frontend BalanceTransferRecord type did not even declare
 *    txHash, so the one identifier a user can verify was undisplayable.
 *
 * Run: npm run test:transfer-confirmation
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const svc = code('src/balances/transfer-confirmation.service.ts');
const server = code('src/server.ts');

console.log('\n── a submitted transfer can now reach a final state ───────────');

check('a confirmation service exists', svc.length > 0);
check('it only re-examines transfers that are still processing',
  /OPEN_STATUSES = new Set\(\['processing'\]\)/.test(svc));
check('it emits balance.transfer_confirmed', svc.includes("action: 'balance.transfer_confirmed'"));
check('and records status completed on that event', /status: 'completed'/.test(svc));
check('transferLogs folds that event in, so the list reflects it',
  code('src/balances/balance.service.ts').includes("'balance.transfer_confirmed'"),
  'without this the confirmation is written and never read');

console.log('\n── the chain is the authority, and it is read directly ────────');

check('Solana signatures are checked on chain',
  svc.includes("solanaRpc") && svc.includes('getSignatureStatuses'));
check('searchTransactionHistory is set, so an older send is still findable',
  /searchTransactionHistory: true/.test(svc));
check('processed is NOT treated as confirmed - it can still roll back',
  /confirmationStatus === 'confirmed' \|\| status\.confirmationStatus === 'finalized'/.test(svc));
check('the provider is consulted for EVM sponsored transfers',
  svc.includes('provider.getTransfer('),
  'a user operation has no txHash until a bundler includes it');

console.log('\n── it must never invent a failure ─────────────────────────────');

/**
 * The single most dangerous thing this service could do is tell a user their
 * send failed when it actually succeeded - they would send it again.
 */
check('a signature that is not found yet returns unknown, not failed',
  /if \(!status\) return 'unknown'/.test(svc));
check('an RPC error returns unknown, not failed',
  /catch \{[\s\S]{0,120}return 'unknown'/.test(svc));
check('only an explicit on-chain err marks it failed',
  /if \(status\.err\) return 'failed'/.test(svc));
check('a stale transfer is escalated, NOT auto-refunded',
  svc.includes("action: 'balance.transfer_stale'")
  && !/stale[\s\S]{0,400}status: 'failed'/.test(svc));
check('a genuine on-chain failure returns the money as hold_release',
  /kind: 'hold_release'[\s\S]{0,200}the on-chain transaction failed/i.test(read('src/balances/transfer-confirmation.service.ts')));
check('a failure is NOT recorded as a new credit that invents money',
  !/kind: 'credit_available'/.test(svc));

console.log('\n── it runs, and cannot take the process down ──────────────────');

check('the confirmer is scheduled in server.ts', server.includes('confirmBalanceTransfers()'));
check('it is behind its own interval setting', server.includes('TRANSFER_CONFIRM_POLL_SECONDS'));
check('zero disables it', /TRANSFER_CONFIRM_POLL_SECONDS > 0/.test(server));
check('errors are swallowed and logged, like the settlement reconciler',
  /transfer confirmer failed/.test(server));
check('the timer is unref\'d so it cannot hold a shutdown open',
  (server.match(/setInterval\(tick, intervalMs\)\.unref\(\)/g) || []).length >= 2);
check('it runs once at boot, when a missed confirmation is most likely',
  (server.match(/void tick\(\);/g) || []).length >= 2);
check('it is NOT started from buildApp, so tests do not hit a live chain',
  !code('src/app.ts').includes('confirmBalanceTransfers'));

console.log('\n── the history row no longer reads as a duplicate ─────────────');

const ui = read('frontend/src/components/transfer/TradeTransferSections.tsx');
const types = read('frontend/src/types.ts');

check('the recipient is now labelled rather than bare',
  ui.includes('To {shortRef(transfer.destinationAddress)}'),
  'an unlabelled address reads as a transaction reference');
check('the transaction identifier is shown when one exists',
  ui.includes('Tx {shortRef(transfer.txHash || transfer.userOperationHash)}'));
check('a sponsored transfer falls back to the user-operation hash',
  ui.includes('transfer.txHash || transfer.userOperationHash'));
check('processing explains itself instead of just sitting there',
  ui.includes('Submitted to the network'));
check('the frontend type declares txHash', /txHash\?: string;/.test(types));
check('and userOperationHash', /userOperationHash\?: string;/.test(types));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

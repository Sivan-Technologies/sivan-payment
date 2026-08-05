/**
 * WHICH CHAIN, BY WHEN, AND HOW TO BACK OUT.
 *
 * Reported against a screenshot of a live sell showing a bare deposit address:
 *   "the network should show here telling the user which network chain they
 *    would send to"
 *   "seems like a stale sell ngn withdraw"
 *
 * THE NETWORK IS THE DANGEROUS ONE. The address in that screenshot is
 * AVXsBHMhRtc5LqoLTvaQBX7oUayS4f3h1TrATUX1v7Df. Checked against the live
 * record on api-test: quoteMetadata.network is "solana". Nothing on screen
 * said so.
 *
 * USDC exists on Solana, Base, Ethereum and more. Send it on the wrong chain
 * to a rail deposit address and it is gone - there is no recall on chain, and
 * the provider is not watching that network for that address. Expecting a user
 * to infer the chain from whether a string starts with 0x is not a design.
 *
 * The data was never missing. quoteMetadata.network has been written on every
 * quote. It was missing from every layer ABOVE the database:
 * NgnTransferRecord has no `network` field, so the API could not return it and
 * the UI could not show it without digging through a nested blob.
 *
 * THE STALENESS is the second half. Auto-expiry already existed - the
 * reconciler closes unfunded orders after NGN_UNFUNDED_EXPIRY_HOURS (24h), and
 * 8 of the 10 transfers on api-test are already 'expired' by it. What did not
 * exist was any way to SEE that deadline, or to close an order yourself: grep
 * found no cancel route, no service function, nothing. An abandoned sell sat
 * looking live, inviting a deposit into an order the user no longer wanted.
 *
 * Run: npm run test:ngn-deposit-instruction
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

const svc = code('src/ngn/service/ngn-transfers.service.ts');
const routes = code('src/ngn/api/ngn.routes.ts');
const recon = code('src/ngn/service/ngn-settlement-reconciler.ts');
const ui = read('frontend/src/components/transactions/TransactionsSection.tsx');
const css = read('frontend/src/styles.css');
const types = read('frontend/src/types.ts');

console.log('\n── the network reaches the API at all ─────────────────────────');

check('transfers are decorated before being returned', svc.includes('.map(decorate)'));
check('the network is lifted out of quoteMetadata',
  /quoteMetadata\?\.network/.test(svc),
  'this is where the value has always lived');
check('it is lowercased, so casing cannot vary per provider',
  /toLowerCase\(\)/.test(svc.slice(svc.indexOf('function decorate'))));
check('an unknown network stays undefined rather than becoming a guess',
  /network = meta\?\.quoteMetadata\?\.network \? [\s\S]{0,60}: undefined/.test(svc));
check('the frontend type declares network', /network\?: string;/.test(types.slice(types.indexOf('interface NgnTransferRecord'))));

console.log('\n── the deadline is real, and matches the reconciler ───────────');

/**
 * If these two numbers ever diverge the UI shows a countdown to a moment that
 * is not when the order actually closes, which is worse than no countdown.
 */
check('the service reads NGN_UNFUNDED_EXPIRY_HOURS', svc.includes('NGN_UNFUNDED_EXPIRY_HOURS'));
check('so does the reconciler', recon.includes('NGN_UNFUNDED_EXPIRY_HOURS'));
check('both default to the same 24 hours',
  /NGN_UNFUNDED_EXPIRY_HOURS \|\| 24/.test(svc) && /NGN_UNFUNDED_EXPIRY_HOURS \|\| 24/.test(recon));
check('expiry is measured from updatedAt with a createdAt fallback, as the reconciler does',
  /transfer\.updatedAt \?\? transfer\.createdAt/.test(svc) && /transfer\.updatedAt \?\? transfer\.createdAt/.test(recon));
check('a funded or finished order carries NO deadline',
  /expiresAt = unfunded && Number\.isFinite\(started\)/.test(svc),
  'a countdown on a settled order would be nonsense');

console.log('\n── cancelling, and refusing to cancel ─────────────────────────');

check('a cancel service exists', svc.includes('export async function cancelNgnTransfer'));
check('there is a user-facing route', routes.includes("'/api/users/:userId/ngn-transfers/:id/cancel'"));
check('the route checks ownership', /ensureOwnUser\(request, userId\)/.test(routes.slice(routes.indexOf('ngn-transfers/:id/cancel'))));
check('the service checks ownership too, not just the route',
  svc.includes('if (options.userId && transfer.userId !== options.userId)'),
  'a cancel is a state change on money; one guard is not enough');

/**
 * THE REFUSAL THAT MATTERS. destinationTxHash means coins are on chain and
 * heading for the rail. "Cancelling" that would tell the user nothing is
 * coming while their money is mid-flight.
 */
check('it REFUSES once crypto is already on the way',
  /if \(transfer\.destinationTxHash\) \{[\s\S]{0,220}throw badRequest/.test(svc));
check('and the refusal points at support rather than dead-ending',
  /already on the way[\s\S]{0,120}support/.test(svc));
check('only pre-funding statuses are cancellable', svc.includes('NGN_CANCELLABLE_STATUSES'));
check('a settled or processing order cannot be cancelled',
  /if \(!NGN_CANCELLABLE_STATUSES\.has\(String\(transfer\.status\)\)\) \{[\s\S]{0,160}throw badRequest/.test(svc));
check('cancelled is its own status, distinct from expired',
  read('src/ngn/types/ngn.types.ts').includes("| 'cancelled'"),
  '"I cancelled" and "you never funded it" are different facts');
check('the cancel is audited', svc.includes("action: 'ngn.transfer_cancelled'"));
check('the previous status is recorded, so the funnel stays readable',
  /previousStatus: transfer\.status/.test(svc));

console.log('\n── the screen states the chain BEFORE the address ─────────────');

const network_i = ui.indexOf('deposit-network-row');
const address_i = ui.indexOf('deposit-address-value');
check('a deposit instruction component exists', ui.includes('function DepositInstruction('));
check('the network row is rendered ABOVE the address',
  network_i > 0 && address_i > 0 && network_i < address_i,
  'a user who has copied the address has stopped reading');
check('the chain is named in the warning as well',
  ui.includes('Send only {transaction.asset} on <b>{network.replaceAll'),
  'the one mistake that cannot be undone is worth saying twice');
check('the warning says funds cannot be recovered', ui.includes('cannot be recovered'));
check('an unknown network is a WARNING, not a blank',
  ui.includes('Not specified - check with support before sending'),
  'silently omitting the chain is how the original bug read');
check('the countdown is shown when there is one', ui.includes('deposit-countdown'));
check('an elapsed countdown never renders as negative',
  /if \(ms <= 0\) return \{ text: 'Closing now'/.test(ui));
check('the user is told what expiry actually means for their money',
  ui.includes('closes on its own and no funds move'));

console.log('\n── cancelling is deliberate, and server-confirmed ─────────────');

check('cancel is only offered when the SERVER says so',
  ui.includes('transaction.cancellable && onCancel'),
  'the client must not decide whether an order is still cancellable');
check('it is two-step, so a mis-tap cannot destroy a live order',
  ui.includes('setConfirming(true)') && ui.includes('Yes, cancel it') && ui.includes('Keep it open'));
check('the list is re-read from the server afterwards',
  /await onRefresh\?\.\(\)/.test(ui),
  'the server may refuse; optimistic local state would show a false Cancelled');
check('the button is disabled while the request is in flight',
  /disabled=\{cancelling\}/.test(ui));

console.log('\n── it holds together on a phone ───────────────────────────────');

check('the instruction block has styles', css.includes('.deposit-instruction{'));
check('the network chip is styled distinctly', css.includes('.deposit-network-chip{'));
check('an unknown network is amber, not muted grey',
  /\.deposit-network-unknown\{[^}]*f1bd72/.test(css));
check('the countdown is neutral until it is urgent',
  /\.deposit-countdown\{[^}]*a9b8c7/.test(css) && /\.deposit-countdown\.urgent\{[^}]*f1bd72/.test(css));
check('a danger button style exists for the confirm step', css.includes('.danger-btn{'));
check('it is keyboard-focusable with a visible ring', css.includes('.danger-btn:focus-visible'));
const mobile = css.slice(css.lastIndexOf('@media(max-width:640px)'));
check('mobile stacks the actions into one column',
  /\.deposit-instruction-actions\{display:grid;grid-template-columns:1fr/.test(mobile),
  'the destructive button must not sit a thumb-width from Copy');
check('mobile buttons reach a real tap target', /min-height:40px/.test(mobile));
check('the address is selectable in one tap', /user-select:all/.test(css.slice(css.indexOf('.deposit-instruction .deposit-address-value'))));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

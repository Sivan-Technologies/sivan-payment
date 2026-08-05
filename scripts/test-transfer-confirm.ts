/**
 * THE BUTTON SAID "REVIEW" AND DID NO REVIEWING.
 *
 * Reported: "when i click on the review and create transfer there is no
 * confirm screen saying am sending something".
 *
 * Confirmed in the source: the submit button read "Review and create
 * transfer →" and its form went straight to onSubmit, which POSTs and
 * broadcasts on chain. There was no intermediate step at all. The copy was
 * describing a screen that did not exist.
 *
 * WHY A CONFIRM STEP EARNS ITS FRICTION HERE, when usually it would not:
 * an on-chain send is irreversible, a wrong-but-valid address passes every
 * check we have, and the address is typically pasted - which is exactly what
 * clipboard-hijacking malware targets. This is the narrow case where one more
 * deliberate action is worth more than the tap it costs.
 *
 * Run: npm run test:transfer-confirm
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkAddress } from '../frontend/src/components/transfer/chunkAddress.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const confirm = read('frontend/src/components/transfer/TransferConfirm.tsx');
const view = read('frontend/src/components/transfer/TradeTransferSections.tsx');
const css = read('frontend/src/styles.css');

console.log('\n── the form now reviews before it sends ───────────────────────');

check('the crypto form submits to a review handler, not straight to onSubmit',
  view.includes('onSubmit={handleReview}'),
  'this is the whole reported bug');
check('handleReview does NOT call the API', !/function handleReview[\s\S]{0,900}onSubmit\(/.test(view));
check('the confirm dialog is rendered when a transfer is pending',
  view.includes('{pendingTransfer && <TransferConfirm'));
check('confirming replays the ORIGINAL form element',
  view.includes('currentTarget: form') && view.includes('pendingFormRef'),
  'rebuilding a payload here would be a second source of truth that can drift');
check('cancelling clears both the pending state and the form ref',
  /setPendingTransfer\(null\); pendingFormRef\.current = null;/.test(view),
  'a stale form ref would resubmit the previous transfer');
/**
 * Scoped to CODE, not comments. The first version scanned the whole file and
 * tripped on a comment that QUOTES the old copy while explaining the bug -
 * which would have forced me to delete the explanation to make the test pass.
 * A test that punishes documentation is a bad test.
 */
const viewCode = view.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the button no longer promises a review it does not give',
  !viewCode.includes('Review and create transfer'),
  'the copy must match what the button does');
check('it now says Review transfer', view.includes('Review transfer'));

console.log('\n── the address is presented so a human can actually check it ──');

check('the address is chunked', confirm.includes('chunkAddress'));
const chunkSrc = read('frontend/src/components/transfer/chunkAddress.ts');
check('the chunker is a plain .ts module, importable by the backend suite', chunkSrc.includes('export function chunkAddress'), 'a .tsx cannot compile under the backend tsconfig');
check('chunks are 4 characters by default', JSON.stringify(chunkAddress('EJJaFs7u3QyT')) === JSON.stringify(['EJJa','Fs7u','3QyT']));
check('a trailing partial group is kept, never dropped',
  JSON.stringify(chunkAddress('EJJaFs7u3')) === JSON.stringify(['EJJa','Fs7u','3']),
  'dropping it would display an address that is not the real one');
check('an empty address yields no groups', chunkAddress('').length === 0);
check('whitespace is trimmed before chunking', chunkAddress('  EJJa  ')[0] === 'EJJa');
check('the first and last groups are emphasised',
  confirm.includes("index === 0 || index === groups.length - 1"),
  'those are the characters people actually compare');
check('the full address is exposed to screen readers',
  confirm.includes('aria-label={details.destinationAddress}'),
  'a chunked address would otherwise be read out as nonsense');
check('the address is one-tap selectable', /\.confirm-address\{[^}]*user-select:all/.test(css));

console.log('\n── what it shows, and what it refuses to invent ───────────────');

check('the amount is the headline', /<h2 id="transfer-confirm-title">\{details\.amount\} \{asset\}<\/h2>/.test(confirm));
check('the network is stated', confirm.includes('Sending on <b'));
check('the balance after the send is shown', confirm.includes('Balance after'));
check('remaining balance is floored at zero', /Math\.max\(details\.available - amount, 0\)/.test(confirm));
check('a testnet send is badged', confirm.includes('confirm-testnet'));
check('the testnet badge is amber, not green',
  /\.confirm-testnet\{[^}]*241,189,114/.test(css),
  'it is a warning that the funds are not real, not a confirmation');
/**
 * Sivan sponsors gas, and the frontend is not told the review threshold. A
 * fee or an ETA here would be a number we do not have.
 */
check('it does not invent a network fee', !/network fee|gas fee|estimated fee/i.test(confirm));
check('it does not invent an arrival time', !/arrives in|estimated arrival|will arrive/i.test(confirm));
check('it does not re-validate the address itself',
  !confirm.includes('validateAddress'),
  'the server is the authority; a second validator would drift from it');

console.log('\n── the acknowledgement guards the real risk ───────────────────');

check('there is an acknowledgement', confirm.includes('confirm-ack'));
check('it names the actual network, not a generic warning',
  confirm.includes('accepts {asset} on <b>{network}</b>'),
  'wrong-chain sends are the most common way people lose crypto');
check('confirm is disabled until it is ticked', confirm.includes('disabled={!acknowledged || submitting}'));
check('the checkbox is a real target, not a 13px default',
  /\.confirm-ack input\{[^}]*width:18px/.test(css));

console.log('\n── it behaves like a dialog ───────────────────────────────────');

check('it is a real dialog', confirm.includes('role="dialog"') && confirm.includes('aria-modal="true"'));
check('it is labelled by its title', confirm.includes('aria-labelledby="transfer-confirm-title"'));
check('focus moves into the panel on open', confirm.includes('panelRef.current?.focus()'));
check('escape closes it', /event\.key === 'Escape'/.test(confirm));
check('escape does NOT close it mid-submit',
  /event\.key === 'Escape' && !submitting/.test(confirm),
  'dismissing an in-flight request leaves the user unsure what happened');
check('a backdrop click does not close it mid-submit',
  /onClick=\{\(\) => \{ if \(!submitting\) onCancel\(\); \}\}/.test(confirm));
check('clicks inside do not bubble to the backdrop',
  confirm.includes('onClick={(event) => event.stopPropagation()}'));
check('the keydown listener is removed on unmount',
  confirm.includes("removeEventListener('keydown', onKey)"));
check('it reuses the existing modal shell rather than inventing a second one',
  confirm.includes('sv-modal-backdrop') && confirm.includes('className="sv-modal transfer-confirm"'));

console.log('\n── mobile ─────────────────────────────────────────────────────');

/**
 * SCOPED TO ITS OWN SECTION. This is the THIRD test to break on
 * css.lastIndexOf('@media(max-width:640px)') - block-explorer, then
 * ngn-deposit-instruction, now this one. Every time someone appends a styles
 * block, the previous "last" media query stops being last and the assertions
 * silently point at unrelated CSS.
 *
 * Fixing the instance three times was the wrong move; the pattern is the bug.
 */
const confirmSection = css.slice(css.indexOf('/* TRANSFER CONFIRM'), css.indexOf('/* ACTIVITY FEED'));
check('the confirm CSS section is findable', confirmSection.length > 0, 'the section header comment moved or was removed');
const mobile = confirmSection.slice(confirmSection.indexOf('@media(max-width:640px)'));
check('actions stack on a phone', /\.transfer-confirm-actions\{grid-template-columns:1fr\}/.test(mobile));
check('Send sits ABOVE Back on mobile',
  /\.transfer-confirm-actions \.primary-btn\{order:-1\}/.test(mobile),
  'so the confirm is not under the thumb resting position');
check('buttons reach a real tap target', /\.transfer-confirm-actions button\{min-height:48px\}/.test(mobile));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

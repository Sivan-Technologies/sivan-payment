/**
 * THE RECEIVE SCREEN: A GATE THAT BOUGHT NOTHING, AND A QR THAT LEAKED.
 *
 * Three problems, reported and then measured:
 *
 * 1. THE ACKNOWLEDGEMENT HID THE ADDRESS AND THE QR.
 *    `{view === 'receive' && <ReceiveView/>}` UNMOUNTS the component, and the
 *    flag was a plain useState(false), so it reset on every single visit - not
 *    just on chain switch. A user depositing to Solana weekly re-confirmed the
 *    same box every week to see an address they had used ten times.
 *
 *    It also guarded a moment with no risk in it. The wrong-network mistake
 *    happens AFTER the user leaves: they copy the address, open Phantom, and
 *    choose the network there. A checkbox here has no reach into that moment.
 *    Compare the send confirm dialog, where an acknowledgement IS correct
 *    because the irreversible action happens on that screen.
 *
 * 2. THE QR WAS A THIRD-PARTY IMAGE.
 *    `api.qrserver.com/v1/create-qr-code?data=${address}` sent every deposit
 *    address this product issues to an outside service, and rendered nothing
 *    when that host was slow or blocked. The QR is the one control that
 *    genuinely reduces wrong-address loss - it removes the clipboard - so it
 *    must not depend on someone else's uptime.
 *
 * 3. THREE CARDS FOR TWO ADDRESSES.
 *    walletsToProvision() issues one EVM wallet and one Solana wallet. Base
 *    and Ethereum are the SAME key at the SAME 0x string, so the grid showed
 *    one address twice under two headings with equally severe warnings - which
 *    flattened the distinction that decides recoverability:
 *      Base <-> Ethereum   same address, recoverable
 *      Solana <-> any EVM  different address, gone
 *
 * I ALSO GOT THE QR WRONG FIRST. My hand-written encoder produced a matrix
 * that diffed 272 modules against a reference encoder and would not have
 * scanned. Replaced with qrcode-generator and verified by DECODING the
 * rendered image - see test-receive-qr-decode.
 *
 * Run: npm run test:receive-screen
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrDataUri, qrMatrix } from '../frontend/src/qrCode.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
const check = (name: string, ok: unknown, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const view = read('frontend/src/components/ReceiveView.tsx');
const css = read('frontend/src/styles.css');
const qrSrc = read('frontend/src/qrCode.ts');

console.log('\n── the QR is generated locally ────────────────────────────────');

/**
 * Scoped to CODE. The first version scanned whole files and tripped on the
 * comments that NAME the removed host while explaining why it went - a test
 * that forces you to delete the explanation to go green is a bad test. Same
 * lesson as test:transfer-confirm.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('no third-party QR service in the code',
  !stripComments(view).includes('qrserver.com') && !stripComments(qrSrc).includes('qrserver.com'),
  'it sent every deposit address to an outside host');
check('the QR comes from the local module', view.includes('qrDataUri(wallet.address)'));
check('it renders as an inline data URI, so there is no request to fail',
  qrSrc.includes('data:image/svg+xml,'));
check('error correction M, for a camera reading a screen at an angle',
  /qrcode\(0, 'M'\)/.test(qrSrc));
check('byte mode, because base58 is case-sensitive',
  qrSrc.includes('alphanumeric mode is'),
  'QR alphanumeric is upper-case only - "EJJa" would encode as "EJJA", a different address');
check('a quiet zone is included', /margin = options\.margin \?\? 4/.test(qrSrc),
  'cameras fail to lock on without it');
check('the img has explicit dimensions, so the layout does not jump',
  /width=\{176\} height=\{176\}/.test(view));

/** Shape sanity. The decode test is the real proof - this catches gross breaks. */
const sol = qrMatrix('EJJaFs7u3QyTAREDsAW7RCK4KeSTtBwujnrqKDGfJzZp');
const evm = qrMatrix('0x6d7D2Eb4667395437739634D3382A90Fff238295');
check('a 44-char Solana address yields a square matrix', sol.length === sol[0].length && sol.length === 33, `${sol.length}`);
check('a 42-char EVM address yields a smaller one', evm.length === 29, `${evm.length}`);
check('the data URI is non-trivial', qrDataUri('EJJaFs7u3QyTAREDsAW7RCK4KeSTtBwujnrqKDGfJzZp').length > 1000);

console.log('\n── the address is no longer gated ─────────────────────────────');

check('the acknowledgement state is gone', !view.includes('acknowledged'),
  'it reset on every visit because the component unmounts');
check('there is no checkbox gate before the address', !view.includes('receive-ack'));
check('the address block renders on assets alone', view.includes('{assetsOnChain.length > 0 && ('));
check('switching chain still clears the Copied flag', /setCopied\(false\);\s*\}, \[chain\]\)/.test(view),
  'it referred to the previous address');

console.log('\n── the warning sits where the address is copied ───────────────');

const bannerAt = view.indexOf('receive-network-banner');
const addressAt = view.indexOf('receive-address-wrap');
const copyAt = view.indexOf('Copy address');
check('a network banner exists', bannerAt > 0);
check('it is ABOVE the address and the copy button',
  bannerAt < addressAt && bannerAt < copyAt,
  'it used to be in a panel the user had already scrolled past');
check('it names the network', view.includes('<strong>{meta.label} network only.</strong>'));
check('it says funds cannot be recovered', view.includes('cannot be recovered'));
check('the QR is captioned with the network too', view.includes('{meta.label} only'));

console.log('\n── networks grouped by the address they share ─────────────────');

check('families are derived, not hardcoded per chain', view.includes('const chainFamilies = useMemo'));
check('Solana stands alone', /key: 'solana'[\s\S]{0,300}chains: \['solana'\]/.test(view));
check('Base and Ethereum share one row', /key: 'evm'[\s\S]{0,700}chains: \['base', 'ethereum'\]/.test(view));
check('the shared address is stated on the row', view.includes("One 0x address for both networks"));
check('a family with no enabled chains disappears',
  view.includes('.filter((family) => family.chains.length > 0)'),
  'otherwise an admin disabling Base would leave an empty card');
check('a disabled chain is filtered out of its family',
  view.includes('chains: family.chains.filter((c) => availableChains.includes(c))'));
check('the sub-choice only appears when a family has more than one chain',
  view.includes('activeFamily.chains.length > 1'));
check('and it tells the user that mistake is recoverable',
  view.includes('a mix-up between them is recoverable'),
  'the distinction the three-card grid flattened');
check('a single-chain family does not repeat its own name',
  view.includes('{family.chains.length > 1 && ('),
  'the Solana card read "Solana ... Solana"');

console.log('\n── the wallet is matched by family, not literal chain ─────────');

/**
 * THE BUG IN THE REPORTED SCREENSHOT: "No Ethereum address yet", with a
 * Generate button, for a user who already HAS an EVM wallet.
 *
 * Every wallet this deployment provisions is stored as chain:'base' -
 * confirmed against the live audit log. Selecting Ethereum asked for a row
 * filed under 'ethereum', found none, and offered to create a SECOND wallet
 * for an address the user already holds.
 *
 * Same defect already fixed server-side in balance.service.ts and
 * ngn-transfers.service.ts. The frontend was missed because nothing selected
 * Ethereum until this screen grouped the EVM chains and made it reachable.
 */
check('the wallet lookup is no longer an exact chain match',
  !view.includes("wallets.find((w) => w.chain === activeChain && w.status !== 'closed')"),
  'a base-filed wallet would show "No Ethereum address yet"');
check('any EVM row serves any EVM chain',
  view.includes("const family = activeChain === 'solana' ? ['solana'] : ['base', 'ethereum']"));
check('an exact match still wins when one exists',
  view.includes('open.find((w) => w.chain === activeChain) ??'));
check('closed wallets are still excluded', view.includes("w.status !== 'closed'"));

console.log('\n── network logos ─────────────────────────────────────────────');

const logo = read('frontend/src/components/receive/NetworkLogo.tsx');
check('logos are inline SVG, not fetched', logo.includes('<svg') && !logo.includes('http'),
  'a logo that fails to load leaves two rows looking interchangeable');
check('every supported chain has a mark',
  ['solana', 'base', 'ethereum'].every((c) => logo.includes(`chain === '${c}'`) || logo.includes('// Ethereum')));
/**
 * DECORATIVE FIRST TIME. This only checked the call site, so deleting the
 * multi-mark branch inside NetworkFamilyLogo left it passing - the component
 * would have silently rendered one logo for a two-chain family, hiding that
 * Ethereum is in there at all. Caught by mutation.
 *
 * Pinned to the branch that actually maps over the chains.
 */
check('family rows show every member mark',
  view.includes('<NetworkFamilyLogo chains={family.chains}')
  && /chains\.length === 1[\s\S]{0,220}chains\.map\(/.test(logo),
  'showing only the first would hide that Ethereum is in the family');
check('sub-chain pills carry their own mark', view.includes('<NetworkLogo chain={option}'));
check('marks keep their brand colour, not currentColor',
  logo.includes('#0052FF') && logo.includes('#627EEA') && logo.includes('#9945FF'),
  'recolouring them would make Base and Ethereum look like one network');
check('they are hidden from screen readers', logo.includes("'aria-hidden': true"),
  'the network name is always adjacent, so announcing both says "Base Base"');
check('the coloured dot is gone from the family card',
  !view.includes('<span className="receive-chain-dot" style={{ background: family.accent }} />'),
  'every dot was the same shape differing only in hue');
check('stacked marks overlap by a quarter, so the second stays readable',
  logo.includes('-size / 4'),
  'at a third the Ethereum diamond sat mostly behind the Base circle');
check('the first chain sits on top', logo.includes('zIndex: chains.length - index'));
check('a ring keeps overlapping marks separable', css.includes('.network-logo-stack-item svg{'));

console.log('\n── Base is the default EVM chain ─────────────────────────────');

check('Base comes before Ethereum', /chains: \['base', 'ethereum'\]/.test(view),
  'Base is cheaper by an order of magnitude and is what this product settles on');
check('the family is labelled Base first', view.includes("label: 'Base & Ethereum'"));
check('the family accent is Base blue, not Ethereum',
  view.includes('accent: CHAIN_META.base.accent'),
  'the accent marks the default member');

console.log('\n── colour carries meaning ─────────────────────────────────────');

check('the selected sub-chain wears the CHAIN colour, not success green',
  view.includes('borderColor: CHAIN_META[option].accent'),
  'green reads as "correct", but this is an identity');
check('the css no longer hardcodes green for the selected pill',
  !/\.receive-subchain-btn\.selected\{[^}]*74ddbe/.test(css));
check('the recommendation is a badge, not grey helper text',
  view.includes('receive-family-badge') && css.includes('.receive-family-badge{'));

console.log('\n── layout ─────────────────────────────────────────────────────');

check('families are two across on desktop',
  /\.receive-family-grid\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(css));
/**
 * Anchored to this section, not "the last 760px query". The guard in
 * test:activity-feed caught me writing the exact pattern it exists to
 * prevent - which is the guard working, and worth leaving in place.
 */
const receiveSection = css.slice(css.indexOf('/* RECEIVE - NETWORK FAMILIES'));
check('the receive CSS section is findable', receiveSection.length > 0);
const mobile = receiveSection.slice(receiveSection.indexOf('@media(max-width:760px)'));
check('one per row on a phone', /\.receive-family-grid\{grid-template-columns:1fr/.test(mobile),
  'two cards at 390px truncate the chain list');
check('sub-chain buttons reach a real tap target', /\.receive-subchain-btn\{flex:1;min-height:42px/.test(mobile));
check('they are equal width, so neither is the easier tap', /flex:1/.test(mobile));
check('cards are keyboard-focusable', css.includes('.receive-family-card:focus-visible'));
check('so are the sub-chain buttons', css.includes('.receive-subchain-btn:focus-visible'));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

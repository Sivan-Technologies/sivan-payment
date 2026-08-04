/**
 * A LINK TO THE USER'S OWN TRANSACTION.
 *
 * Requested: "add a blockchain field here where user can see the blockchain
 * transaction based on the network they sent", slick on mobile and desktop.
 *
 * It earns its place because of what its absence cost. Two Solana sends both
 * showed "Processing" with the same truncated RECIPIENT address beside them,
 * and the user concluded the money had not arrived. Both had settled on chain
 * minutes earlier. The product held the answer and offered no way to see it.
 *
 * THE TWO WAYS A LINK LIKE THIS LOSES MONEY-TRUST, both guarded here:
 *
 *   WRONG NETWORK. A Base Sepolia hash on basescan.org mainnet returns "not
 *   found", which a worried user reads as "my transaction does not exist".
 *   That is strictly worse than showing no link. The mode comes from the
 *   SERVER (preferences.networkMode <- NETWORK_MODE) and is never guessed.
 *
 *   WRONG IDENTIFIER. A sponsored EVM transfer is an ERC-4337 user operation.
 *   Its userOperationHash is NOT a transaction hash and does not resolve on a
 *   normal explorer until a bundler includes it. Sent to /tx/ it produces a
 *   dead page - the same false negative. User operations go to jiffyscan.
 *
 * Run: npm run test:block-explorer
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explorerLink, explorerReference, shortHash } from '../frontend/src/blockExplorer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

/** The user's real Solana signature, from the send they thought had failed. */
const SOL_SIG = '2MshwrfkEez1obGJdqR3TfPGCAjXSRzDsyum4yoVhFKsJWgqbpLjbFbueg2oQKK427bSqg6vZTsRA5aHiN58vUZ7';
const EVM_TX = '0xabc1230000000000000000000000000000000000000000000000000000000def';
const USER_OP = '0x15213e1bdd0b64d4ac546aa49deed6d60b49ec52e45a331898a17c729306d051';

console.log('\n── the network decides the host, and the server decides the network ──');

const solMain = explorerLink({ network: 'solana', txHash: SOL_SIG, networkMode: 'mainnet' });
check('solana mainnet points at solscan', solMain?.url.startsWith('https://solscan.io/tx/'), solMain?.url);
check('and carries NO cluster parameter', !solMain?.url.includes('cluster='), solMain?.url);
check('it is not flagged as testnet', solMain?.testnet === false);

const solTest = explorerLink({ network: 'solana', txHash: SOL_SIG, networkMode: 'testnet' });
check('solana testnet appends the devnet cluster', solTest?.url.includes('?cluster=devnet'), solTest?.url);
check('and IS flagged testnet, so the UI can warn', solTest?.testnet === true);
check('the real signature survives the round trip intact',
  solTest?.url.includes(SOL_SIG), 'a mangled signature is a dead link');

const baseMain = explorerLink({ network: 'base', txHash: EVM_TX, networkMode: 'mainnet' });
const baseTest = explorerLink({ network: 'base', txHash: EVM_TX, networkMode: 'testnet' });
check('base mainnet uses basescan.org', baseMain?.url === `https://basescan.org/tx/${EVM_TX}`, baseMain?.url);
check('base testnet uses SEPOLIA basescan, not mainnet',
  baseTest?.url === `https://sepolia.basescan.org/tx/${EVM_TX}`,
  'a testnet hash on mainnet reads as "your transaction does not exist"');
check('ethereum mainnet uses etherscan',
  explorerLink({ network: 'ethereum', txHash: EVM_TX, networkMode: 'mainnet' })?.url.startsWith('https://etherscan.io/tx/'));
check('ethereum testnet uses sepolia etherscan',
  explorerLink({ network: 'ethereum', txHash: EVM_TX, networkMode: 'testnet' })?.url.startsWith('https://sepolia.etherscan.io/tx/'));

/**
 * Absent mode must mean MAINNET, matching the server default and types.ts.
 * Defaulting to testnet would tell someone holding real funds that their money
 * is on a test chain.
 */
check('an absent networkMode is treated as mainnet, never testnet',
  explorerLink({ network: 'base', txHash: EVM_TX })?.url === `https://basescan.org/tx/${EVM_TX}`);

console.log('\n── a user operation is not a transaction hash ─────────────────');

const op = explorerLink({ network: 'base', userOperationHash: USER_OP, networkMode: 'testnet' });
check('a sponsored transfer with no txHash still gets a link', Boolean(op), 'this is every gas-sponsored send');
check('it goes to jiffyscan, which indexes user operations', op?.url.includes('jiffyscan.xyz/userOpHash/'), op?.url);
check('NOT to /tx/, which would 404 and read as a failed payment',
  !op?.url.includes('/tx/'), op?.url);
check('the jiffyscan network matches the mode', op?.url.includes('network=base-sepolia'), op?.url);
check('mainnet user ops use the mainnet network id',
  explorerLink({ network: 'base', userOperationHash: USER_OP, networkMode: 'mainnet' })?.url.includes('network=base'));

/** A real hash always wins: once included, the transaction page is better. */
const both = explorerLink({ network: 'base', txHash: EVM_TX, userOperationHash: USER_OP, networkMode: 'mainnet' });
check('when BOTH exist the real transaction hash wins', both?.url.includes(`/tx/${EVM_TX}`), both?.url);

console.log('\n── it must never invent a link ────────────────────────────────');

check('no identifier at all -> no link', explorerLink({ network: 'base', networkMode: 'mainnet' }) === undefined);
check('an unknown network -> no link',
  explorerLink({ network: 'dogecoin', txHash: EVM_TX }) === undefined,
  'a guessed host is a 404, and a 404 reads as lost money');
check('solana with only a user-op hash -> no link',
  explorerLink({ network: 'solana', userOperationHash: USER_OP }) === undefined,
  'solana has no user-operation concept');
check('an empty-string hash is treated as absent, not linked',
  explorerLink({ network: 'base', txHash: '   ', networkMode: 'mainnet' }) === undefined,
  'Privy returns "" for a sponsored transfer, and it must not become /tx/');

console.log('\n── the reference shown to the user ────────────────────────────');

check('the transaction hash is preferred as the reference',
  explorerReference({ txHash: EVM_TX, userOperationHash: USER_OP }) === EVM_TX);
check('the user-op hash is used when that is all there is',
  explorerReference({ userOperationHash: USER_OP }) === USER_OP);
check('nothing yields undefined, so the UI can say so in words',
  explorerReference({}) === undefined);
check('a short value is shown whole', shortHash('0x1234') === '0x1234');
check('a long one is middle-truncated, keeping both ends',
  shortHash(SOL_SIG).startsWith('2Mshwrfk') && shortHash(SOL_SIG).endsWith('iN58vUZ7'),
  'both ends matter when comparing against a wallet');

console.log('\n── the component behaves, and the data reaches it ─────────────');

const ui = read('frontend/src/components/transfer/TradeTransferSections.tsx');
const app = read('frontend/src/App.tsx');

check('the history row renders an on-chain receipt', ui.includes('<OnChainReceipt'));
check('it is given the transfer network', ui.includes('network={transfer.network}'));
check('and both identifier kinds', ui.includes('txHash={transfer.txHash}') && ui.includes('userOperationHash={transfer.userOperationHash}'));
check('networkMode comes from server preferences, not a constant',
  app.includes('networkMode={userPreferences?.networkMode}'),
  'a hardcoded mode would break every link on one of the two deployments');
check('a missing reference is explained rather than left blank',
  ui.includes('Waiting for the network reference'));
check('a transfer awaiting review says THAT, not "waiting for the network"',
  ui.includes('Waiting on review, nothing sent yet'),
  'nothing has been broadcast, so promising a network reference would be a lie');
check('the sponsored case explains why the reference looks unusual',
  ui.includes('Gas was sponsored'));
check('the full reference is in the title attribute for comparison',
  ui.includes('title={reference}'),
  'truncation is for layout; a user checking their wallet needs every character');
check('the reference can be copied', ui.includes('navigator.clipboard?.writeText(reference)'));
check('a blocked clipboard fails silently, since the text is selectable anyway',
  /catch \{[\s\S]{0,200}\}/.test(ui.slice(ui.indexOf('const copy = async'))));
check('the explorer opens in a new tab', ui.includes('target="_blank"'));
check('with noopener AND noreferrer - an explorer is a third party',
  ui.includes('rel="noopener noreferrer"'));

console.log('\n── the styling holds on a phone as well as a desktop ──────────');

const css = read('frontend/src/styles.css');
check('the receipt has its own styles', css.includes('.chain-receipt{'));
check('the hash column can shrink instead of pushing buttons off the card',
  /\.chain-receipt\{[^}]*minmax\(0,1fr\)/.test(css));
check('one tap selects the whole reference on mobile',
  /\.chain-receipt-hash\{[^}]*user-select:all/.test(css));
check('there is a mobile breakpoint', css.includes('@media(max-width:640px)') && css.slice(css.indexOf('@media(max-width:640px)')).includes('.chain-receipt'));
const mobile = css.slice(css.lastIndexOf('@media(max-width:640px)'));
check('it stacks to a single column on a phone', /\.chain-receipt\{grid-template-columns:1fr/.test(mobile));
check('the hash wraps rather than ellipsing when there is room',
  /\.chain-receipt-hash\{white-space:normal/.test(mobile));
check('buttons reach a real tap target', /min-height:40px/.test(mobile));
check('testnet is amber, not green - it is a warning, not a confirmation',
  /\.chain-receipt-testnet\{[^}]*241,189,114/.test(css));
check('keyboard focus is visible', css.includes('.chain-receipt-btn:focus-visible'));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * A 10 USDC SEND THAT WAS NEITHER SENT NOR REFUSED.
 *
 * Reported with a screenshot: "Send & transfer" showed 108 USDC in the wallet
 * and 98 available; the user sent 10 USDC to Base - a tenth of the 1,000
 * manual-review threshold - and it came back "held". The ledger recorded a
 * hold. Nothing was broadcast. Nothing was rejected. The money simply stopped.
 *
 * The live audit log on api-test named the cause exactly:
 *
 *   balance.transfer_requires_operator
 *   "No ethereum wallet - balance is in pooled custody and needs an operator
 *    payout."
 *
 * Except the user HAS a wallet, and it holds the 108 USDC. Both wallet.created
 * events on that service read {"chain":"base"}. executeBalanceTransfer asked:
 *
 *   const walletChain = transfer.network === 'solana' ? 'solana' : 'ethereum';
 *   const wallet = await db.findUserWallet(userId, walletChain);
 *
 * findUserWallet matches `chain` EXACTLY. 'base' !== 'ethereum', so it found
 * nothing and took the "this must be pooled custody" branch - a branch written
 * for a genuinely different case (a user funded only by a virtual account, who
 * has no wallet at all) and which correctly leaves those in pending_review.
 *
 * Base and Ethereum are ONE secp256k1 key at ONE 0x address. Privy's own
 * CHAIN_TYPE map says so: base -> ethereum. Which of the two names ended up in
 * the database row is provisioning trivia, and it was deciding whether a user
 * could spend their own money.
 *
 * THREE money paths had the same defect, all found by grepping findUserWallet:
 *
 *   balance.service.ts       crypto sends -> stuck in pending_review
 *   ngn-transfers.service.ts off-ramp sweep -> returned "nothing to sweep",
 *                            so the order sat in awaiting_crypto_deposit
 *                            forever. That is the orders_awaiting_deposit
 *                            pile-up, and the reason the earlier manual sweep
 *                            proof passed: THAT wallet happened to be filed
 *                            as 'ethereum'.
 *   ngn-quotes.service.ts    on-ramp quote carried no recipient address
 *
 * And a fourth, differently shaped, in unified-balance.service.ts:
 *
 *   walletsToProvision().find(e => e.chain === wallet.chain)?.alsoServes ?? []
 *
 * walletsToProvision() lists only 'ethereum' and 'solana', so for a 'base' row
 * the .find returned undefined and alsoServes fell back to []. The balance
 * reader then looked at Base only. The `?? []` turned a lookup miss into a
 * silently narrower read instead of an error.
 *
 * Run: npm run test:wallet-chain-family
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainFamily, networksServedByWallet, walletServesNetwork, EVM_CHAINS } from '../src/wallets/chain-family.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
/** Strip comments: they describe the bug and NAME the calls being banned. */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

console.log('\n── the family rule itself ─────────────────────────────────────');

check('base is EVM', chainFamily('base') === 'evm');
check('ethereum is EVM', chainFamily('ethereum') === 'evm');
check('solana is its own family', chainFamily('solana') === 'solana');
check('case does not change the family', chainFamily('BASE') === 'evm' && chainFamily('Solana') === 'solana');
// An unknown EVM-ish name must not silently become Solana and try to sign with
// the wrong key type. Defaulting to evm is the safe side: the transfer then
// fails at the provider with a real error rather than signing on ed25519.
check('an unknown chain defaults to EVM, not Solana', chainFamily('arbitrum') === 'evm');

console.log('\n── which networks a stored wallet can sign for ────────────────');

const fromBase = networksServedByWallet('base');
const fromEth = networksServedByWallet('ethereum');
check('a wallet filed as base serves base', fromBase.includes('base'), fromBase.join(','));
check('a wallet filed as base ALSO serves ethereum', fromBase.includes('ethereum'), fromBase.join(','));
check('a wallet filed as ethereum ALSO serves base', fromEth.includes('base'), fromEth.join(','));
check('base and ethereum rows serve the identical set', JSON.stringify([...fromBase].sort()) === JSON.stringify([...fromEth].sort()));
check('a solana wallet serves only solana', JSON.stringify(networksServedByWallet('solana')) === JSON.stringify(['solana']));
check('a solana wallet does NOT serve base', !networksServedByWallet('solana').includes('base'));
// The old code path could produce [] and that is what made the bug invisible.
check('the served list is never empty for a known chain', ['base', 'ethereum', 'solana'].every((c) => networksServedByWallet(c).length > 0));
check('EVM_CHAINS covers exactly base and ethereum', JSON.stringify([...EVM_CHAINS].sort()) === JSON.stringify(['base', 'ethereum']));

console.log('\n── the exact reported case ────────────────────────────────────');

// The user's row is chain:'base'; they sent to network 'base'.
check("a base-filed wallet can sign a base transfer", walletServesNetwork('base', 'base'));
// And the case that actually broke: the OLD code asked for 'ethereum'.
check("a base-filed wallet can sign an ethereum transfer", walletServesNetwork('base', 'ethereum'));
check("an ethereum-filed wallet can sign a base transfer", walletServesNetwork('ethereum', 'base'));
check('a solana wallet must NOT be used for a base transfer', !walletServesNetwork('solana', 'base'));
check('a base wallet must NOT be used for a solana transfer', !walletServesNetwork('base', 'solana'));

console.log('\n── the lookup exists on BOTH database backends ────────────────');

// Production runs DATABASE_PROVIDER=postgres. A fix that lands only on the
// JSON class would throw "is not a function" on the live service, which is
// strictly worse than the bug it replaces.
const jsonDb = read('src/database/json-database.ts');
const pgDb = read('src/database/postgres-database.ts');
check('JsonDatabase has findUserWalletForNetwork', jsonDb.includes('async findUserWalletForNetwork('));
check('PostgresDatabase has findUserWalletForNetwork', pgDb.includes('async findUserWalletForNetwork('));
check('the postgres version filters on a family list, not one chain', /chain = any\(\$2::text\[\]\)/.test(pgDb));
check('the postgres version prefers an exact chain match', /order by \(chain = \$3\) desc/.test(pgDb));
check('both versions still exclude closed wallets', /status <> 'closed'/.test(pgDb) && jsonDb.includes("w.status !== 'closed'"));

console.log('\n── no money path may match a wallet by literal chain ──────────');

// The regression guard. If any of these reintroduce findUserWallet on a
// spending path, the same class of bug returns silently.
const balanceSvc = code('src/balances/balance.service.ts');
const ngnTransfers = code('src/ngn/service/ngn-transfers.service.ts');
const ngnQuotes = code('src/ngn/service/ngn-quotes.service.ts');
const unified = code('src/balances/unified-balance.service.ts');

check('executeBalanceTransfer uses the family lookup', balanceSvc.includes('findUserWalletForNetwork(userId, transfer.network)'));
check('balance.service.ts no longer calls findUserWallet at all', !balanceSvc.includes('db.findUserWallet('), 'literal lookup is back on the send path');
check("balance.service.ts no longer hardcodes the 'solana' : 'ethereum' guess for lookup",
  !/findUserWallet\(userId,\s*walletChain/.test(balanceSvc));
check('the off-ramp sweep uses the family lookup', ngnTransfers.includes('findUserWalletForNetwork(transfer.userId, network)'));
check('ngn-transfers.service.ts no longer calls findUserWallet', !ngnTransfers.includes('db.findUserWallet('));
check('the on-ramp quote uses the family lookup', ngnQuotes.includes('findUserWalletForNetwork(input.userId, quoteNetwork)'));
check('ngn-quotes.service.ts no longer calls findUserWallet', !ngnQuotes.includes('db.findUserWallet('));

console.log('\n── the balance reader must not narrow itself on a lookup miss ──');

check('unified-balance reads networksServedByWallet', unified.includes('networksServedByWallet(wallet.chain)'));
check('unified-balance no longer depends on walletsToProvision', !unified.includes('walletsToProvision'),
  'a base-filed row makes that .find return undefined');
check('unified-balance has no `?? []` fallback that could blank the chain list',
  !/alsoServes\s*\?\?\s*\[\]/.test(unified));

console.log('\n── provisioning may still ask for an exact chain ──────────────');

// ensureUserWallet SHOULD match literally: "do I already have a base row"
// before creating one is a different question from "who can sign this".
// Removing the literal lookup entirely would be the opposite mistake.
const walletSvc = code('src/wallets/user-wallet.service.ts');
check('ensureUserWallet still uses the exact-match lookup', walletSvc.includes('db.findUserWallet(userId, chain)'));
check('getUserWalletWithBalances still uses the exact-match lookup', /findUserWallet\(userId, chain\)/.test(walletSvc));

console.log('\n── the dashboard shows a balance, from the shared source ──────');

const app = read('frontend/src/App.tsx');
check('the dashboard has a balance KPI', app.includes('label="Your balance"'));
check('it reads the SAME unified balance the transfer screen uses', app.includes("unifiedBalance?.balances.find((item) => item.asset === 'usdc')"));
check('it does not recompute a balance of its own', !/dashboardBalance\s*=/.test(app));
check('an unreadable chain shows a dash, never a confident zero', app.includes("chainUnavailable ? '—'"));
check('"Total volume" no longer sits where a balance belongs', !app.includes('label="Total volume"'));
/**
 * SUPERSEDED. This asserted the "Payout volume" card, which was DELETED in the
 * three-card KPI change: it read only `withdrawals` on a six-source product
 * (showing $0.00 beside two completed crypto sends) and summed usd|gbp|eur
 * behind a "$" prefix.
 *
 * I should have caught this when I removed the card - I ran a subset of suites
 * that did not include this one. Repointed at what replaced it, so the
 * assertion still guards a real card rather than being deleted outright.
 */
check('the KPI row shows In progress in its place', app.includes('label="In progress"'));
check('and the deleted cross-currency card has not crept back',
  !app.includes('label="Payout volume"'));
check('the hardcoded "Avg. payout time" pseudo-metric is gone', !app.includes('Avg. payout time'));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

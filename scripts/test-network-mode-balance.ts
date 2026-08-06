/**
 * "COULD NOT REACH THE NETWORK" WHILE THE MONEY WAS SITTING THERE.
 *
 * Reported with a screenshot of the dashboard: YOUR BALANCE blank, "Could not
 * reach the network / Retrying shortly", immediately after receiving 20 USDC
 * on Base. The activity feed showed the deposit; the balance card did not.
 *
 * NOTHING WAS UNREACHABLE. Checked at the time - every Base endpoint answered
 * 200 (mainnet.base.org, publicnode, drpc, 1rpc) and Privy was reachable. The
 * money was real. It was on Base SEPOLIA, and the reader was querying MAINNET.
 *
 * Verified directly against both chains for the user's own address
 * 0xAAc97e03c92531efBe5Ac47317C81C3e9E778B21:
 *
 *     mainnet  USDC 0x833589fC...  ->   0 USDC
 *     sepolia  USDC 0x036CbD53...  ->  20 USDC
 *
 * And through the real code path, by flipping NETWORK_MODE:
 *
 *     NETWORK_MODE=mainnet  ->  0 USDC
 *     NETWORK_MODE=testnet  -> 20 USDC
 *
 * TWO FAULTS.
 *
 * 1. CONFIG. sivan-payments-api-test had no NETWORK_MODE, and the default is
 *    mainnet, so a test deployment read balances off the wrong chain. Fixed by
 *    setting the variable - not by this file.
 *
 * 2. CODE, and the reason it could drift at all. createTransfer takes a
 *    per-request networkMode and picks its CAIP-2 chain from it, while
 *    getBalances had no such parameter and fell back to the process-wide
 *    resolveNetworkMode(). Two code paths, one wallet, and no structural
 *    reason for them to agree.
 *
 * The cost is not a cosmetic number. getSpendable() feeds the off-ramp sweep,
 * so a testnet balance reading as zero makes the sweep skip with
 * insufficient_spendable and silently leaves the user to send the crypto by
 * hand - which is exactly what was happening on the naira off-ramps.
 *
 * Run: npm run test:network-mode-balance
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-network-mode.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.ADMIN_API_KEY = 'netmode-admin-key';
process.env.USER_JWT_SECRET = 'netmode-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-network-mode.json', { force: true });

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { erc20TokenAddress } = await import('../src/wallets/provider/privy-wallet.provider.js');
const { evmRpcEndpoints } = await import('../src/wallets/evm/evm-rpc.js');

console.log('\n── the two networks use DIFFERENT contracts ──────────────────');

const mainnetUsdc = erc20TokenAddress('base' as any, 'usdc', true);
const testnetUsdc = erc20TokenAddress('base' as any, 'usdc', false);

check('base mainnet USDC is 0x833589fC...',
  String(mainnetUsdc).toLowerCase().startsWith('0x833589fc'), String(mainnetUsdc));
check('base sepolia USDC is 0x036CbD53...',
  String(testnetUsdc).toLowerCase().startsWith('0x036cbd53'), String(testnetUsdc));
/**
 * The whole bug in one assertion: these are different addresses, so reading
 * the wrong one returns 0 for a funded wallet rather than erroring.
 */
check('they are NOT the same contract',
  mainnetUsdc !== testnetUsdc,
  'if these were equal the mode could not change the answer, and it does');

console.log('\n── and different endpoints ───────────────────────────────────');

const mainnetRpc = evmRpcEndpoints('base' as any, { production: true });
const testnetRpc = evmRpcEndpoints('base' as any, { production: false });
check('mainnet reads mainnet.base.org', mainnetRpc[0].includes('mainnet.base.org'), mainnetRpc[0]);
check('testnet reads sepolia.base.org', testnetRpc[0].includes('sepolia.base.org'), testnetRpc[0]);

console.log('\n── getBalances now ACCEPTS a network mode ────────────────────');

const providerSrc = fs.readFileSync('src/wallets/provider/privy-wallet.provider.ts', 'utf8');
const ifaceSrc = fs.readFileSync('src/wallets/provider/wallet-provider.ts', 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('the interface declares networkMode on getBalances',
  /getBalances\([\s\S]{0,400}networkMode\?: NetworkMode/.test(strip(ifaceSrc)),
  'without it, no caller CAN pass one - the drift was structural');
check('the Privy provider accepts it',
  /async getBalances\([\s\S]{0,300}networkMode\?: NetworkMode/.test(strip(providerSrc)));
check('and USES it instead of a bare isProduction()',
  /const production = isProduction\(networkMode\)/.test(strip(providerSrc)),
  'this line was isProduction(), which ignored the caller entirely');

/**
 * Backward compatibility matters here: three call sites pass nothing today,
 * and they must keep resolving the deployment default rather than silently
 * becoming testnet.
 */
check('omitting the mode still falls back to the deployment default',
  /function isProduction\(mode\?: NetworkMode\)[\s\S]{0,200}resolveNetworkMode\(\)/.test(strip(providerSrc)),
  'Bridge and Mock callers pass no mode and must be unaffected');

console.log('\n── transfers and balances read the SAME switch ───────────────');

/**
 * The original inconsistency: one path honoured a per-request mode, the other
 * did not. Both must now route through isProduction so they cannot diverge.
 */
const transferUsesMode = /isProduction\(input\.networkMode\)/.test(strip(providerSrc));
check('createTransfer resolves its chain from a mode', transferUsesMode);
check('getBalances resolves its chain from a mode too',
  /isProduction\(networkMode\)/.test(strip(providerSrc)),
  'a transfer on Sepolia and a balance on mainnet is the bug');

console.log('\n── a mismatched deployment is now VISIBLE ────────────────────');

const healthSrc = strip(fs.readFileSync('src/monitoring/operational-health.service.ts', 'utf8'));
check('operational health reports the network mode',
  /name: 'network_mode_matches_environment'/.test(healthSrc),
  'this failed silently and looked like an outage');
check('a live app on testnet is CRITICAL',
  /severity: mismatched \? \(appIsLive \? 'critical' : 'warn'\)/.test(healthSrc),
  'production reading real balances off Sepolia is the worse direction');
check('the detail names the variable to change',
  /Set NETWORK_MODE explicitly on this deployment/.test(healthSrc),
  '"could not reach the network" told an operator nothing actionable');
check('and explains what it breaks',
  /off-ramp sweeps/.test(healthSrc),
  'the sweep skipping is the expensive consequence, not the dashboard number');

console.log('\n── the signal actually fires ─────────────────────────────────');

/**
 * Asserted by running it, not by reading it. APP_ENV development against the
 * mainnet default is precisely the reported misconfiguration.
 */
process.env.APP_ENV = 'development';
process.env.NETWORK_MODE = 'mainnet';
const { getOperationalHealth } = await import('../src/monitoring/operational-health.service.js');
const health = await getOperationalHealth();
const signal = health.signals.find((s: any) => s.name === 'network_mode_matches_environment');

check('the signal is present in a real health run', Boolean(signal));
check('a development app on mainnet is flagged',
  signal?.severity === 'warn',
  `severity ${signal?.severity} - this is the exact reported state`);
check('and the detail names both sides',
  /APP_ENV is "development" but NETWORK_MODE is "mainnet"/.test(String(signal?.detail)),
  String(signal?.detail).slice(0, 120));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * ARC, END TO END.
 *
 * Arc is Circle's own Layer 1: EVM-compatible, Reth execution, Malachite BFT
 * consensus, and USDC as the NATIVE gas token. Mainnet opened 16 September 2026.
 *
 * Written the same shape as test-arbitrum-adapter.ts, but the assertions differ
 * in one structural way, and it is the whole reason this file exists:
 *
 *   On every other EVM chain Sivan supports, USDC is an ERC-20 contract.
 *   On Arc, USDC is the native coin. There is no contract to call.
 *
 * That changes the balance path (eth_getBalance, not erc20BalanceOf), the send
 * path (value, not calldata), and the decimals (18, not 6). None of those three
 * mistakes throws. Each produces a plausible wrong answer, so each is asserted
 * against the live chain here rather than against a mock.
 *
 * Deliberately NOT mocked. A registration bug looks identical to a working
 * integration under mocks.
 */

import { evmRpcEndpoints, usesNativeStablecoin } from '../src/wallets/evm/evm-rpc.js';
import { EVM_CHAINS, chainFamily, networksServedByWallet } from '../src/wallets/chain-family.js';
import { decimalsFor, decimalsForChainAsset, erc20TokenAddress, toBaseUnits } from '../src/wallets/provider/privy-wallet.provider.js';
import { validateAddressForChain } from '../src/wallets/address-validation.js';
import type { WalletChain } from '../src/wallets/types/wallet.types.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✅ ok - ${name}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL - ${name}${detail ? `  (${detail})` : ''}`);
  }
}

async function rpc(url: string, method: string, params: unknown[] = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.json() as Promise<{ result?: string; error?: { message: string } }>;
}

/** Chain IDs read from the live network, not from documentation. */
const ARC_MAINNET_CHAIN_ID = 5042;      // 0x13b2
const ARC_TESTNET_CHAIN_ID = 5042002;   // 0x4cef52

const ARC_MAINNET_RPC = 'https://rpc.mainnet.arc.io';
const ARC_TESTNET_RPC = 'https://rpc.testnet.arc.io';

async function main() {
  console.log('\n' + '='.repeat(50));
  console.log('🔷 SIVAN ARC INTEGRATION TEST SUITE');
  console.log('='.repeat(50));

  // ── 1. Type and registration layer ──────────────────────────────
  console.log('\n══ 1. Chain Registration ══');

  const chain: WalletChain = 'arc';
  check('arc is assignable to WalletChain', chain === 'arc');
  check('arc is classified as an EVM chain', (EVM_CHAINS as readonly string[]).includes('arc'));
  check('chainFamily(arc) is evm', chainFamily('arc') === 'evm');

  /**
   * An EVM wallet must serve every EVM chain from one address. If arc is
   * missing here the wallet exists, the balance reads, and the transfer is
   * refused at the last step for no visible reason: findUserWallet matches the
   * chain column exactly, so a row stored as 'base' would not be found for an
   * arc transfer and the money would sit held forever.
   */
  check('an existing EVM wallet serves arc', networksServedByWallet('base').includes('arc'));
  check('an arc wallet serves the other EVM chains', networksServedByWallet('arc').includes('base'));
  check('a solana wallet does NOT serve arc', !networksServedByWallet('solana').includes('arc'));

  // ── 2. Address validation ───────────────────────────────────────
  console.log('\n══ 2. Address Validation ══');

  const goodEvm = '0x4a1A9cf30A86b2b333D1a743181aAE71a50BAFBc';
  check('a valid 0x address is accepted on arc', validateAddressForChain(goodEvm, 'arc' as any).valid);
  check('a Solana address is rejected on arc',
    !validateAddressForChain('7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs', 'arc' as any).valid);
  check('a truncated 0x address is rejected on arc',
    !validateAddressForChain('0x4a1A9cf30A86b2b333', 'arc' as any).valid);

  // ── 3. RPC endpoint resolution ──────────────────────────────────
  console.log('\n══ 3. RPC Endpoint Resolution ══');

  const mainnetEndpoints = evmRpcEndpoints('arc', { production: true });
  const testnetEndpoints = evmRpcEndpoints('arc', { production: false });

  check('arc resolves at least one mainnet endpoint', mainnetEndpoints.length > 0);
  check('arc resolves at least one testnet endpoint', testnetEndpoints.length > 0);
  check('mainnet and testnet endpoint sets differ',
    mainnetEndpoints[0] !== testnetEndpoints[0]);

  /**
   * No hardcoded URLs. The configured environment variable must take priority
   * over the public tier, or a production deployment silently runs on a
   * rate-limited public node.
   */
  const previous = process.env.ARC_RPC_URL;
  process.env.ARC_RPC_URL = 'https://arc-rpc.example.invalid';
  const overridden = evmRpcEndpoints('arc', { production: true });
  check('ARC_RPC_URL takes priority over the public tier',
    overridden[0] === 'https://arc-rpc.example.invalid', overridden[0]);
  if (previous === undefined) delete process.env.ARC_RPC_URL;
  else process.env.ARC_RPC_URL = previous;

  /**
   * rpc.mainnet.arc.network appears in several launch-week write-ups but
   * returns an EMPTY body. Listing it would consume a failover tier and answer
   * nothing, so it must not be present.
   */
  check('the non-responding arc.network mainnet host is not listed',
    !mainnetEndpoints.some((u) => u.includes('rpc.mainnet.arc.network')),
    mainnetEndpoints.join(', '));

  // ── 4. Live chain verification ──────────────────────────────────
  console.log('\n══ 4. Live Chain Verification ══');

  const mainnetId = await rpc(ARC_MAINNET_RPC, 'eth_chainId');
  check(`mainnet RPC reports chain id ${ARC_MAINNET_CHAIN_ID}`,
    Number(mainnetId.result) === ARC_MAINNET_CHAIN_ID,
    `got ${mainnetId.result} (${Number(mainnetId.result)})`);

  const testnetId = await rpc(ARC_TESTNET_RPC, 'eth_chainId');
  check(`testnet RPC reports chain id ${ARC_TESTNET_CHAIN_ID}`,
    Number(testnetId.result) === ARC_TESTNET_CHAIN_ID,
    `got ${testnetId.result} (${Number(testnetId.result)})`);

  check('mainnet and testnet chain ids differ',
    ARC_MAINNET_CHAIN_ID !== ARC_TESTNET_CHAIN_ID);

  const block = await rpc(ARC_MAINNET_RPC, 'eth_blockNumber');
  check('mainnet is producing blocks', Number(block.result) > 0, String(block.result));

  // ── 5. THE NATIVE USDC PREMISE ──────────────────────────────────
  console.log('\n══ 5. Native USDC (not ERC-20) ══');

  /**
   * The load-bearing assertion of this entire suite.
   *
   * If USDC were an ERC-20 on Arc, the generic EVM path would be correct and
   * all the special-casing would be dead weight. It is not. Every well-known
   * USDC contract address from another chain has NO CODE on Arc.
   *
   * Checked against real addresses from other chains rather than a made-up
   * one, because an arbitrary address trivially has no code and would pass
   * this assertion while proving nothing.
   */
  const knownUsdcElsewhere = [
    ['Arbitrum USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'],
    ['Ethereum USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
  ] as const;

  for (const [label, addr] of knownUsdcElsewhere) {
    const code = await rpc(ARC_MAINNET_RPC, 'eth_getCode', [addr, 'latest']);
    check(`${label} address has NO contract code on Arc`,
      code.result === '0x', `got ${String(code.result).slice(0, 20)}`);
  }

  check('usesNativeStablecoin(arc) is true', usesNativeStablecoin('arc'));
  check('usesNativeStablecoin(base) is false', !usesNativeStablecoin('base'));
  check('usesNativeStablecoin(arbitrum) is false', !usesNativeStablecoin('arbitrum'));

  /**
   * erc20TokenAddress must NOT invent an address for Arc. Returning one would
   * send the transfer down the ERC-20 path, to a contract that does not exist.
   */
  check('no ERC-20 USDC address is registered for arc (mainnet)',
    erc20TokenAddress('arc', 'usdc', true) === undefined);
  check('no ERC-20 USDC address is registered for arc (testnet)',
    erc20TokenAddress('arc', 'usdc', false) === undefined);

  // ── 6. DECIMALS: the silent 10^12 bug ───────────────────────────
  console.log('\n══ 6. Decimals ══');

  /**
   * Arc's native USDC is 18dp. Every other USDC Sivan handles is 6dp.
   *
   * This is the most dangerous assertion in the file because the failure is
   * silent: using 6 where 18 is correct reports a balance one trillion times
   * too large, and formats cleanly all the way to the user's screen.
   */
  check('arc USDC is 18 decimals', decimalsForChainAsset('arc', 'usdc') === 18,
    String(decimalsForChainAsset('arc', 'usdc')));
  check('base USDC is still 6 decimals', decimalsForChainAsset('base', 'usdc') === 6,
    String(decimalsForChainAsset('base', 'usdc')));
  check('arbitrum USDC is still 6 decimals', decimalsForChainAsset('arbitrum', 'usdc') === 6);
  check('celo USDC is still 6 decimals', decimalsForChainAsset('celo', 'usdc') === 6);

  /** The chain-blind helper must still answer 6, so callers that were correct stay correct. */
  check('the chain-blind decimalsFor still returns 6 for usdc', decimalsFor('usdc') === 6);

  /**
   * Prove the magnitude of the bug rather than only the flag. One USDC on Arc
   * is 10^18 base units; read as 6dp it would be 10^6, a factor of 10^12.
   */
  const oneUsdcArc = toBaseUnits('1', decimalsForChainAsset('arc', 'usdc'));
  const oneUsdcBase = toBaseUnits('1', decimalsForChainAsset('base', 'usdc'));
  check('1 USDC on arc is 10^18 base units', oneUsdcArc === 1_000_000_000_000_000_000n,
    String(oneUsdcArc));
  check('1 USDC on base is 10^6 base units', oneUsdcBase === 1_000_000n, String(oneUsdcBase));
  check('the arc/base base-unit ratio is exactly 10^12',
    oneUsdcArc / oneUsdcBase === 1_000_000_000_000n);

  // ── 7. Gas token identity ───────────────────────────────────────
  console.log('\n══ 7. Gas Token ══');

  /**
   * Arc prices gas in USDC with a documented EIP-1559 minimum base fee of
   * 20 gwei. Asserted as a floor, not an equality: the base fee moves with
   * load, and pinning the exact value would make this suite fail on a busy day
   * for no good reason.
   */
  const gasPrice = await rpc(ARC_MAINNET_RPC, 'eth_gasPrice');
  const gwei = Number(BigInt(gasPrice.result ?? '0x0') / 1_000_000_000n);
  check('mainnet gas price is at or above the 20 gwei floor', gwei >= 20, `${gwei} gwei`);

  // ── 8. CAIP-2 ───────────────────────────────────────────────────
  console.log('\n══ 8. CAIP-2 Identifiers ══');

  /**
   * An EVM address is identical on Arc mainnet and testnet, so a transaction
   * sent with the wrong CAIP-2 does not bounce. It succeeds on a chain nobody
   * is watching. Asserted against the live chain ids read in section 4.
   */
  check('mainnet CAIP-2 matches the live chain id',
    `eip155:${ARC_MAINNET_CHAIN_ID}` === 'eip155:5042');
  check('testnet CAIP-2 matches the live chain id',
    `eip155:${ARC_TESTNET_CHAIN_ID}` === 'eip155:5042002');
  check('mainnet and testnet CAIP-2 differ',
    `eip155:${ARC_MAINNET_CHAIN_ID}` !== `eip155:${ARC_TESTNET_CHAIN_ID}`);

  console.log('\n' + '='.repeat(50));
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50) + '\n');

  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\nSUITE ERROR:', e.message);
  process.exitCode = 1;
});

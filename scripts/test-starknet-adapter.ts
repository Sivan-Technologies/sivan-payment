/**
 * STARKNET, END TO END.
 *
 * Starknet is the FOURTH chain family in this codebase, alongside evm, solana
 * and stellar. It is not an EVM chain: STARK curve, felt252 addresses, Cairo
 * contracts, and its own RPC namespace. Nothing from the EVM stack is reused.
 *
 * Written the same shape as test-arc-adapter.ts, but the assertions differ in
 * four structural ways, and each corresponds to a bug that does NOT throw:
 *
 *   1. family split      an EVM wallet must not claim to serve Starknet
 *   2. felt252 zeros     0x123 and 0x0123 are the SAME account
 *   3. u256 balances     returned as two felts; reading one truncates silently
 *   4. account deploy    an account is a contract and may not exist yet
 *
 * Deliberately NOT mocked. A registration bug looks identical to a working
 * integration under mocks.
 */

import {
  starknetRpcEndpoints,
  starknetChainId,
  starknetCall,
  u256ToBigInt,
  decodeShortString,
  fromBaseUnits,
  isAccountDeployed,
  SELECTOR,
  STARKNET_CHAIN_ID,
  STARKNET_CHAIN_ID_HEX,
} from '../src/wallets/starknet/starknet-rpc.js';
import {
  StarknetAdapter,
  STARKNET_USDC,
  STARKNET_USDC_DECIMALS,
} from '../src/wallets/starknet/StarknetAdapter.js';
import { EVM_CHAINS, chainFamily, networksServedByWallet } from '../src/wallets/chain-family.js';
import { validateAddressForChain, normaliseStarknetAddress } from '../src/wallets/address-validation.js';
import { getChainAdapter } from '../src/wallets/chain-adapter-registry.js';
import { getNetworkExplorer } from '../src/utils/explorers.js';
import { resolveNetworkFeeConfig } from '../src/balances/transfer-fee-policy.js';
import {
  SN_SELECTOR, toU256Calldata, buildErc20TransferCall, buildSivanTransferCalls,
} from '../src/wallets/starknet/starknet-transfer.js';
import {
  paymasterEndpoint, isPaymasterAvailable, getSupportedGasTokens,
  isGasTokenSupported, sameFelt, defaultFeeMode, paymasterHealth,
  STARKNET_GAS_TOKEN,
} from '../src/wallets/starknet/paymaster.js';
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

async function main() {
  console.log('\n' + '='.repeat(50));
  console.log('🔷 SIVAN STARKNET INTEGRATION TEST SUITE');
  console.log('='.repeat(50));

  // ── 1. Chain family: the core structural change ─────────────────
  console.log('\n══ 1. Chain Family ══');

  const chain: WalletChain = 'starknet';
  check('starknet is assignable to WalletChain', chain === 'starknet');
  check('chainFamily(starknet) is its own family', chainFamily('starknet') === 'starknet');
  check('starknet is NOT in EVM_CHAINS', !(EVM_CHAINS as readonly string[]).includes('starknet'));

  /**
   * The load bearing pair. Starknet uses the STARK curve, so an existing 0x
   * wallet holds no key that can sign for it. If either direction leaks, the
   * wallet service hands back a wallet that cannot sign and the transfer dies
   * at the last step with no visible cause.
   */
  check('an EVM wallet does NOT serve starknet',
    !networksServedByWallet('base').includes('starknet'));
  check('a starknet wallet does NOT serve base',
    !networksServedByWallet('starknet').includes('base'));
  check('a starknet wallet serves starknet',
    networksServedByWallet('starknet').includes('starknet'));
  check('a solana wallet does NOT serve starknet',
    !networksServedByWallet('solana').includes('starknet'));

  // ── 2. felt252 addresses ────────────────────────────────────────
  console.log('\n══ 2. felt252 Addresses ══');

  const usdc = STARKNET_USDC.mainnet;
  check('a real felt252 address is accepted', validateAddressForChain(usdc, 'starknet').valid);
  check('a 42 char EVM address is also a valid felt', // shorter than 64, still legal
    validateAddressForChain('0x4a1A9cf30A86b2b333D1a743181aAE71a50BAFBc', 'starknet').valid);
  check('a Solana base58 address is rejected',
    !validateAddressForChain('7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs', 'starknet').valid);
  check('the zero address is rejected',
    !validateAddressForChain('0x0', 'starknet').valid);
  check('over 64 hex chars is rejected',
    !validateAddressForChain('0x' + 'a'.repeat(65), 'starknet').valid);
  check('a value above the field prime is rejected',
    !validateAddressForChain('0x' + 'f'.repeat(64), 'starknet').valid);

  /**
   * THE DUPLICATE WALLET TRAP. Starknet drops leading zeros freely, so the
   * same account arrives as 0x123 from one source and 0x0123 from another.
   * Comparing raw strings creates two wallet rows for one user and splits
   * their balance. No EVM equivalent: EVM addresses are fixed at 20 bytes.
   */
  check('0x123 and 0x0123 normalise to the same address',
    normaliseStarknetAddress('0x123') === normaliseStarknetAddress('0x0123'),
    `${normaliseStarknetAddress('0x123')} vs ${normaliseStarknetAddress('0x0123')}`);
  check('normalised form is 0x plus 64 hex chars',
    normaliseStarknetAddress('0x123').length === 66);
  check('normalisation is case insensitive',
    normaliseStarknetAddress(usdc.toLowerCase()) === normaliseStarknetAddress(usdc.toUpperCase().replace('0X', '0x')));

  // ── 3. Chain id is a STRING, not a number ───────────────────────
  console.log('\n══ 3. Chain Id Encoding ══');

  check('mainnet chain id hex decodes to SN_MAIN',
    decodeShortString(STARKNET_CHAIN_ID_HEX.mainnet) === 'SN_MAIN',
    decodeShortString(STARKNET_CHAIN_ID_HEX.mainnet));
  check('testnet chain id hex decodes to SN_SEPOLIA',
    decodeShortString(STARKNET_CHAIN_ID_HEX.testnet) === 'SN_SEPOLIA',
    decodeShortString(STARKNET_CHAIN_ID_HEX.testnet));
  check('mainnet and testnet chain ids differ',
    STARKNET_CHAIN_ID.mainnet !== STARKNET_CHAIN_ID.testnet);

  // ── 4. u256: the silent truncation ──────────────────────────────
  console.log('\n══ 4. u256 Reassembly ══');

  check('u256 [low, high] reassembles as high*2^128 + low',
    u256ToBigInt(['0x2', '0x1']) === (1n << 128n) + 2n,
    String(u256ToBigInt(['0x2', '0x1'])));
  check('a low-only value is correct',
    u256ToBigInt(['0xff', '0x0']) === 255n);
  /**
   * Proves the magnitude of the bug rather than only the flag. A value with a
   * high word set is exactly what a truncating implementation gets wrong, and
   * it is invisible below 2^128 which is every test balance ever.
   */
  check('a high-word value is NOT equal to its low word',
    u256ToBigInt(['0x5', '0x3']) !== 5n);
  check('a single felt throws rather than truncating',
    (() => { try { u256ToBigInt(['0x5'] as any); return false; } catch { return true; } })());

  check('fromBaseUnits formats 6dp correctly',
    fromBaseUnits(1_500_000n, 6) === '1.5', fromBaseUnits(1_500_000n, 6));

  // ── 5. RPC endpoint resolution ──────────────────────────────────
  console.log('\n══ 5. RPC Endpoints ══');

  const mainnetEndpoints = starknetRpcEndpoints({ production: true });
  const testnetEndpoints = starknetRpcEndpoints({ production: false });
  check('resolves at least one mainnet endpoint', mainnetEndpoints.length > 0);
  check('resolves at least one testnet endpoint', testnetEndpoints.length > 0);
  check('mainnet and testnet endpoints differ', mainnetEndpoints[0] !== testnetEndpoints[0]);

  const previous = process.env.STARKNET_RPC_URL;
  process.env.STARKNET_RPC_URL = 'https://starknet-rpc.example.invalid';
  const overridden = starknetRpcEndpoints({ production: true });
  check('STARKNET_RPC_URL takes priority over the public tier',
    overridden[0] === 'https://starknet-rpc.example.invalid', overridden[0]);
  if (previous === undefined) delete process.env.STARKNET_RPC_URL;
  else process.env.STARKNET_RPC_URL = previous;

  /** Three public endpoints died in 2026. None of them may be listed. */
  for (const dead of ['blastapi.io', 'lava.build', 'drpc.org']) {
    check(`the dead endpoint ${dead} is not listed`,
      !mainnetEndpoints.some((u) => u.includes(dead)));
  }

  // ── 6. Live chain ───────────────────────────────────────────────
  console.log('\n══ 6. Live Chain Verification ══');

  const liveId = await starknetChainId({ production: true });
  check('mainnet RPC reports SN_MAIN', liveId === 'SN_MAIN', liveId);

  const blockNumber = await (async () => {
    try {
      const { starknetRpc } = await import('../src/wallets/starknet/starknet-rpc.js');
      return await starknetRpc<number>('starknet_blockNumber', [], { production: true });
    } catch { return 0; }
  })();
  check('mainnet is producing blocks', Number(blockNumber) > 0, String(blockNumber));

  // ── 7. USDC contract, read from the chain ───────────────────────
  console.log('\n══ 7. USDC Contract ══');

  const symbolRaw = await starknetCall(usdc, SELECTOR.symbol, [], { production: true });
  const symbol = decodeShortString(symbolRaw[symbolRaw.length >= 2 ? 1 : 0]);
  check('configured USDC address reports symbol USDC', symbol === 'USDC', symbol);

  const decimalsRaw = await starknetCall(usdc, SELECTOR.decimals, [], { production: true });
  const decimals = Number(BigInt(decimalsRaw[0]));
  /**
   * 6 on Starknet. Arc's native USDC is 18. Two answers across the estate, so
   * decimals must always come from a (chain, asset) lookup, never the asset.
   */
  check('USDC reports 6 decimals on chain', decimals === 6, String(decimals));
  check('the configured constant matches the chain',
    decimals === STARKNET_USDC_DECIMALS, `chain ${decimals} vs const ${STARKNET_USDC_DECIMALS}`);

  const balRaw = await starknetCall(usdc, SELECTOR.balanceOf, [usdc], { production: true });
  check('balanceOf returns a u256 as two felts', balRaw.length >= 2, JSON.stringify(balRaw));

  // ── 8. Account deployment ───────────────────────────────────────
  console.log('\n══ 8. Account Deployment ══');

  check('the USDC contract reads as deployed',
    await isAccountDeployed(usdc, { production: true }));
  /** A random felt has no contract. No other chain Sivan supports has this state. */
  const fresh = '0x' + '7'.repeat(62);
  check('an undeployed address reads as not deployed',
    (await isAccountDeployed(fresh, { production: true })) === false);

  // ── 9. Adapter registry ─────────────────────────────────────────
  console.log('\n══ 9. Adapter Registry ══');

  const adapter = getChainAdapter('starknet');
  check('getChainAdapter(starknet) returns an adapter', adapter?.chain === 'starknet');
  check('the adapter validates a felt252 address', adapter.validateAddress(usdc));
  check('the adapter rejects a Solana address',
    !adapter.validateAddress('7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs'));
  check('isHealthy() confirms the live chain id', await adapter.isHealthy());

  /**
   * transfer() must REFUSE, not simulate. Privy is Tier 2 on Starknet, so
   * nothing can broadcast yet. A stub returning a fake hash would record a
   * settlement that never happened.
   */
  let refused = false;
  try {
    await adapter.transfer({ fromUserId: 'u', toAddress: usdc, amountUsdc: 1, idempotencyKey: 'k' });
  } catch { refused = true; }
  check('transfer() refuses rather than simulating', refused);

  /** The gap this branch also fixes: Arc and Arbitrum were never registered. */
  check('getChainAdapter(arc) no longer throws', getChainAdapter('arc')?.chain === 'arc');
  check('getChainAdapter(arbitrum) no longer throws',
    getChainAdapter('arbitrum')?.chain === 'arbitrum');

  // ── 10. Explorer routing: the substring trap ────────────────────
  console.log('\n══ 10. Explorer Routing ══');

  /**
   * The explorer resolver dispatches on net.includes(...), so a new chain name
   * can be swallowed by an earlier branch. Checked explicitly: of the twelve
   * patterns in that file, only 'starknet' matches the string 'starknet'.
   * 'starknet' contains 'ark', not 'arc', so there is no collision with the
   * arc branch.
   *
   * An earlier version of this comment claimed such a collision existed and
   * the accompanying test passed under mutation, which means it was asserting
   * nothing. What follows asserts the property that actually matters: a
   * Starknet link points at Starkscan and at no other chain's explorer.
   */
  const snExp = getNetworkExplorer('starknet', undefined, undefined, 'mainnet');
  check('starknet routes to Starkscan, not Arc',
    snExp.url.includes('starkscan'), `${snExp.name} ${snExp.url}`);
  const foreignDomains = ['arc.io', 'arcscan', 'arbiscan', 'basescan', 'celoscan',
                          'solscan', 'stellar.expert', 'bscscan', 'etherscan'];
  check('starknet routes to no other chain explorer',
    foreignDomains.every((d) => !snExp.url.includes(d)), snExp.url);

  const arcExp = getNetworkExplorer('arc', undefined, undefined, 'mainnet');
  check('arc still routes to the Arc explorer',
    arcExp.url.includes('arc.io'), arcExp.url);

  const snTest = getNetworkExplorer('starknet', undefined, undefined, 'testnet');
  check('starknet testnet routes to sepolia.starkscan',
    snTest.url.includes('sepolia.starkscan'), snTest.url);

  const snTx = getNetworkExplorer('starknet', '0xabc123', undefined, 'mainnet');
  check('a starknet tx hash builds a Starkscan tx link',
    snTx.url === 'https://starkscan.co/tx/0xabc123', snTx.url);

  // ── 11. Fee policy ──────────────────────────────────────────────
  console.log('\n══ 11. Fee Policy ══');

  const snFee = resolveNetworkFeeConfig('starknet');
  const baseFee = resolveNetworkFeeConfig('base');
  check('starknet is on the high efficiency rail (floor 0.10)',
    snFee.minimumUsd === 0.10, String(snFee.minimumUsd));
  check('starknet cap is 0.75', snFee.maximumUsd === 0.75, String(snFee.maximumUsd));
  check('starknet rate is 0.5 percent', snFee.percent === 0.5, String(snFee.percent));
  check('base is still on the standard rail (floor 0.25)',
    baseFee.minimumUsd === 0.25, String(baseFee.minimumUsd));
  check('starknet has no new-recipient surcharge',
    snFee.newRecipientUsd === 0, String(snFee.newRecipientUsd));

  // ── 12. Gas abstraction via AVNU paymaster ─────────────────────
  console.log('\n══ 12. Gas Abstraction (AVNU) ══');

  /**
   * Privy does NOT sponsor gas on Starknet and will not broadcast there
   * (Tier 2: sign only). The paymaster removes both problems at once, because
   * AVNU submits the transaction itself. These assertions are what make that
   * claim real rather than a comment.
   */
  check('paymaster is available on mainnet', await isPaymasterAvailable({ production: true }));

  const tokens = await getSupportedGasTokens({ production: true });
  check('paymaster lists supported gas tokens', tokens.length > 0, `${tokens.length} tokens`);

  check('our settlement USDC is an accepted gas token',
    await isGasTokenSupported({ production: true }));

  /**
   * THE TWO-USDC TRAP, the Starknet form of Arbitrum's USDC.e.
   * Both contracts report symbol() as exactly "USDC" and AVNU accepts BOTH as
   * gas tokens, so neither a symbol check nor a supported-token check tells
   * them apart. Only name() and supply do.
   */
  const bridged = '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8';
  check('the bridged USDC is a DIFFERENT contract from ours',
    !sameFelt(bridged, STARKNET_GAS_TOKEN.mainnet));

  const nameOurs = decodeShortString(
    (await starknetCall(STARKNET_GAS_TOKEN.mainnet, SELECTOR.symbol, [], { production: true })).slice(-2)[0]
  );
  check('our token still reports symbol USDC on chain', nameOurs === 'USDC', nameOurs);

  const bridgedSym = decodeShortString(
    (await starknetCall(bridged, SELECTOR.symbol, [], { production: true }))[0]
  );
  check('the bridged token ALSO reports symbol USDC, so symbol cannot discriminate',
    bridgedSym === 'USDC', bridgedSym);

  /** Endpoint comes from env, never hardcoded in a caller. */
  const prevPm = process.env.AVNU_PAYMASTER_URL;
  process.env.AVNU_PAYMASTER_URL = 'https://paymaster.example.invalid';
  check('AVNU_PAYMASTER_URL overrides the public endpoint',
    paymasterEndpoint({ production: true }) === 'https://paymaster.example.invalid');
  if (prevPm === undefined) delete process.env.AVNU_PAYMASTER_URL;
  else process.env.AVNU_PAYMASTER_URL = prevPm;

  check('mainnet and testnet paymaster endpoints differ',
    paymasterEndpoint({ production: true }) !== paymasterEndpoint({ production: false }));

  /** Default mode is the user paying in USDC, not us sponsoring. */
  const fm = defaultFeeMode(true);
  check('default fee mode is user-pays, not sponsored', fm.mode === 'default');
  check('default fee mode uses our settlement USDC',
    fm.mode === 'default' && sameFelt(fm.gasToken, STARKNET_GAS_TOKEN.mainnet));

  const health = await paymasterHealth({ production: true });
  check('paymasterHealth reports available and token supported',
    health.available && health.gasTokenSupported, JSON.stringify(health));

  // ── 13. Transaction construction ────────────────────────────────
  console.log('\n══ 13. Transaction Construction ══');

  /**
   * Selectors are DERIVED at load via starknet.js, not pasted. Cross-checked
   * here against values computed independently (keccak256 truncated to 250
   * bits), so a library change that altered them would fail rather than
   * silently sign calls against the wrong entry point.
   */
  check('transfer selector matches the independent computation',
    BigInt(SN_SELECTOR.transfer) ===
      BigInt('0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e'),
    SN_SELECTOR.transfer);
  check('balanceOf selector matches the rpc layer constant',
    BigInt(SN_SELECTOR.balanceOf) === BigInt(SELECTOR.balanceOf));

  /** u256 in CALLDATA is two felts, low first. Wrong length reverts. */
  // Felts are emitted as hex, which is canonical for calldata, so compare
  // numerically rather than by string.
  const [lo, hi] = toU256Calldata('1.5', 6);
  check('1.5 USDC at 6dp encodes as low=1500000, high=0',
    BigInt(lo) === 1_500_000n && BigInt(hi) === 0n, `${lo},${hi}`);

  /**
   * The split only shows up ABOVE 2^128. An earlier version of this assertion
   * used 3.4e26, which is a trillion times too small, so it asserted nothing.
   * 2^128 at 6dp is ~3.4e32 USDC.
   */
  const huge = (2n ** 128n) + 5n;
  const [bigLo, bigHi] = toU256Calldata(
    (huge / 1_000_000n).toString() + '.' + (huge % 1_000_000n).toString().padStart(6, '0'), 6);
  check('a value above 2^128 sets the high felt', BigInt(bigHi) > 0n, `${bigLo},${bigHi}`);
  check('the two felts reassemble to the original value',
    (BigInt(bigHi) << 128n) + BigInt(bigLo) === huge);
  check('more decimals than the token allows is rejected',
    (() => { try { toU256Calldata('1.1234567', 6); return false; } catch { return true; } })());

  const call = buildErc20TransferCall(STARKNET_GAS_TOKEN.mainnet, usdc, '2.5', 6);
  check('a transfer call has exactly 3 calldata entries', call.calldata.length === 3,
    JSON.stringify(call.calldata));
  check('the transfer call targets the token contract',
    sameFelt(call.contract_address, STARKNET_GAS_TOKEN.mainnet));

  /**
   * MULTICALL. Recipient and protocol fee go in ONE invoke, so they are
   * atomic. On Celo the fee needs a second transaction after the first
   * confirms, which can leave a fee uncollected.
   */
  const withFee = buildSivanTransferCalls({
    tokenAddress: STARKNET_GAS_TOKEN.mainnet, recipient: usdc,
    amount: '10', decimals: 6, feeAmount: '0.10', feeRecipient: usdc,
  });
  check('a transfer with a fee builds 2 atomic calls', withFee.length === 2, String(withFee.length));

  const noFee = buildSivanTransferCalls({
    tokenAddress: STARKNET_GAS_TOKEN.mainnet, recipient: usdc, amount: '10', decimals: 6,
  });
  check('a zero fee builds 1 call, not a 0-value transfer', noFee.length === 1, String(noFee.length));

  console.log('\n' + '='.repeat(50));
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50) + '\n');

  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('\nSUITE ERROR:', e.message);
  process.exitCode = 1;
});

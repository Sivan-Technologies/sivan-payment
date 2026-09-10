import { strict as assert } from 'node:assert';
import { getChainAdapter } from '../src/wallets/chain-adapter-registry.js';
import { CeloAdapter } from '../src/wallets/celo/CeloAdapter.js';
import { validateAddressForChain } from '../src/wallets/address-validation.js';
import { CELO_USDC_MAINNET, CELO_CUSD_MAINNET, CELO_CUSD_ALFAJORES, celoRpcEndpoints } from '../src/wallets/celo/celo-rpc.js';
import { chainFamily, networksServedByWallet } from '../src/wallets/chain-family.js';

/**
 * AUTOMATED MULTI-CHAIN TEST SUITE: CELO ADAPTER & PROTOCOLS
 */

async function runCeloAdapterTests() {
  console.log('\n==================================================');
  console.log('🚀 TESTING SIVAN CELO WALLET ADAPTER & PROTOCOLS');
  console.log('==================================================\n');

  let passed = 0;
  let failed = 0;

  function test(description: string, fn: () => void | Promise<void>) {
    try {
      fn();
      console.log(`  ✅ ok - ${description}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL - ${description}`);
      console.error(`     Error: ${err.message}`);
      failed++;
    }
  }

  console.log('══ 1. Celo Address Validation (EVM 0x Format) ══');

  test('accepts valid 42-char EVM address on Celo', () => {
    const validCelo = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
    const res = validateAddressForChain(validCelo, 'celo');
    assert.equal(res.valid, true);
  });

  test('rejects Stellar address when Celo is requested', () => {
    const stellarG = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    const res = validateAddressForChain(stellarG, 'celo');
    assert.equal(res.valid, false);
  });

  test('rejects truncated EVM address on Celo', () => {
    const truncated = '0xcebA9300f2b948710d2653d';
    const res = validateAddressForChain(truncated, 'celo');
    assert.equal(res.valid, false);
  });

  console.log('\n══ 2. Centralized Multi-Chain Adapter Registry ══');

  test('resolves CeloAdapter via getChainAdapter("celo")', () => {
    const adapter = getChainAdapter('celo');
    assert.ok(adapter instanceof CeloAdapter);
    assert.equal(adapter.chain, 'celo');
  });

  test('chainFamily("celo") returns "evm"', () => {
    assert.equal(chainFamily('celo'), 'evm');
  });

  test('networksServedByWallet("celo") includes celo', () => {
    const networks = networksServedByWallet('celo');
    assert.ok(networks.includes('celo'));
    assert.ok(networks.includes('base'));
    assert.ok(networks.includes('ethereum'));
  });

  console.log('\n══ 3. Celo Token Contracts & RPC Configuration ══');

  test('verifies Circle USDC on Celo mainnet constant', () => {
    assert.equal(CELO_USDC_MAINNET, '0xcebA9300f2b948710d2653dD7B07f33A8B32118C');
  });

  test('verifies cUSD on Celo mainnet and alfajores constants', () => {
    assert.equal(CELO_CUSD_MAINNET, '0x765DE816845861e75A25fCA122bb6898B8B1282a');
    assert.equal(CELO_CUSD_ALFAJORES, '0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1');
  });

  test('verifies default Celo RPC endpoint fallback', () => {
    const endpoints = celoRpcEndpoints();
    assert.ok(endpoints.length > 0);
  });

  console.log('\n══ 4. Celo Multicall3 & Fee Abstraction Payload Building ══');

  const { buildCeloTransferPayload, encodeMulticall3Aggregate3, MULTICALL3_ADDRESS } = await import('../src/wallets/celo/celo-tx-builder.js');
  const { getCeloFeeCurrencyRegistry } = await import('../src/wallets/celo/celo-fee-currency.js');

  test('verifies Multicall3 canonical address', () => {
    assert.equal(MULTICALL3_ADDRESS, '0xcA11bde05977b3631167028862bE2a173976CA11');
  });

  test('builds single ERC-20 transfer when fee is zero or unconfigured', () => {
    const payload = buildCeloTransferPayload({
      tokenAddress: CELO_USDC_MAINNET,
      recipientAddress: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      amount: '10.000000',
      decimals: 6,
    });
    assert.equal(payload.isMulticall, false);
    assert.equal(payload.to, CELO_USDC_MAINNET);
    assert.ok(payload.data.startsWith('0xa9059cbb'));
    assert.equal(payload.netAmount, '10.000000');
    assert.equal(payload.feeAmount, '0');
  });

  test('builds atomic Multicall3 aggregate3 batch when fee is configured', () => {
    const feeWallet = '0x1111111111111111111111111111111111111111';
    const recipient = '0x2222222222222222222222222222222222222222';
    const payload = buildCeloTransferPayload({
      tokenAddress: CELO_USDC_MAINNET,
      recipientAddress: recipient,
      amount: '10.000000',
      feeAmount: '0.250000',
      feeWallet,
      decimals: 6,
    });
    assert.equal(payload.isMulticall, true);
    assert.equal(payload.to, MULTICALL3_ADDRESS);
    assert.ok(payload.data.startsWith('0x82ad56a4'));
    assert.equal(payload.netAmount, '9.750000');
    assert.equal(payload.feeAmount, '0.250000');
  });

  test('verifies Celo fee currency registry resolution', () => {
    const registry = getCeloFeeCurrencyRegistry();
    assert.ok(registry.usdcAdapter.startsWith('0x'));
    assert.ok(registry.usdtAdapter.startsWith('0x'));
    assert.ok(registry.cusd.startsWith('0x'));
  });

  test('verifies Celo ERC-8021 attribution tag attaches to calldata and decodes', async () => {
    const { fromDataSuffix } = await import('@celo/attribution-tags');
    const singlePayload = buildCeloTransferPayload({
      tokenAddress: CELO_USDC_MAINNET,
      recipientAddress: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
      amount: '5.000000',
      decimals: 6,
    });
    const decoded = fromDataSuffix(singlePayload.data as any);
    assert.ok(decoded, 'Attribution tag suffix must be present on payload calldata');
    assert.equal(decoded.codes[0], 'celo_bafcc2e56bd7');
  });

  console.log('\n══ 5. cNGN Token Contract & Integration ══');

  const { CELO_CNGN_MAINNET, CELO_CNGN_DECIMALS } = await import('../src/wallets/celo/celo-rpc.js');

  test('verifies cNGN on Celo mainnet constant', () => {
    assert.equal(CELO_CNGN_MAINNET, '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f');
  });

  test('verifies cNGN uses 6 decimals (matching USDC)', () => {
    assert.equal(CELO_CNGN_DECIMALS, 6);
  });

  test('verifies fee currency registry includes cNGN token address', () => {
    const registry = getCeloFeeCurrencyRegistry();
    assert.ok(registry.cngnToken, 'cngnToken must be present in registry');
    assert.equal(registry.cngnToken, '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f');
  });

  test('builds cNGN transfer payload with attribution tag', () => {
    const cngnPayload = buildCeloTransferPayload({
      tokenAddress: CELO_CNGN_MAINNET,
      recipientAddress: '0x2222222222222222222222222222222222222222',
      amount: '50000.000000',
      decimals: CELO_CNGN_DECIMALS,
    });
    assert.equal(cngnPayload.isMulticall, false);
    assert.equal(cngnPayload.to, CELO_CNGN_MAINNET);
    assert.ok(cngnPayload.data.startsWith('0xa9059cbb'), 'Must be ERC-20 transfer selector');
    assert.equal(cngnPayload.netAmount, '50000.000000');
  });

  test('cNGN transfer payload contains attribution tag suffix', async () => {
    const { fromDataSuffix } = await import('@celo/attribution-tags');
    const cngnPayload = buildCeloTransferPayload({
      tokenAddress: CELO_CNGN_MAINNET,
      recipientAddress: '0x2222222222222222222222222222222222222222',
      amount: '7000.000000',
      decimals: CELO_CNGN_DECIMALS,
    });
    const decoded = fromDataSuffix(cngnPayload.data as any);
    assert.ok(decoded, 'cNGN payload must have attribution suffix');
    assert.equal(decoded.codes[0], 'celo_bafcc2e56bd7');
  });

  console.log('\n==================================================');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('==================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runCeloAdapterTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

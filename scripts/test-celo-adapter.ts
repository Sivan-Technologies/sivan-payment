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

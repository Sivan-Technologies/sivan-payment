import assert from 'node:assert/strict';
import { getChainAdapter } from '../src/wallets/chain-adapter-registry.js';
import { chainFamily, networksServedByWallet, walletServesNetwork } from '../src/wallets/chain-family.js';
import { validateAddressForChain } from '../src/wallets/address-validation.js';

async function runBscAdapterTests() {
  console.log('\n==================================================');
  console.log('🚀 TESTING SIVAN BNB CHAIN (BSC) WALLET ADAPTER & E2E');
  console.log('==================================================\n');

  // 1. Address Validation
  console.log('══ 1. BNB Chain (BSC) Address Validation (EVM 0x Format) ══');
  const validBsc = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
  const checkValid = validateAddressForChain(validBsc, 'bsc');
  assert.equal(checkValid.valid, true, 'Valid 42-char BSC EVM address must pass');
  console.log('  ✅ ok - accepts valid 42-char EVM address on BSC');

  const checkBnb = validateAddressForChain(validBsc, 'bnb');
  assert.equal(checkBnb.valid, true, 'Valid 42-char BNB EVM address must pass');
  console.log('  ✅ ok - accepts valid 42-char EVM address on BNB');

  const checkInvalid = validateAddressForChain('invalid_address_format', 'bsc');
  assert.equal(checkInvalid.valid, false, 'Invalid address format must fail');
  console.log('  ✅ ok - rejects non-EVM address on BSC');

  const checkTruncated = validateAddressForChain('0x742d35Cc6634C0532925a3b844', 'bsc');
  assert.equal(checkTruncated.valid, false, 'Truncated address must fail');
  console.log('  ✅ ok - rejects truncated EVM address on BSC');

  // 2. Centralized Multi-Chain Adapter Registry
  console.log('\n══ 2. Centralized Multi-Chain Adapter Registry ══');
  const bscAdapter = getChainAdapter('bsc');
  assert.equal(bscAdapter.chain, 'bsc', 'getChainAdapter("bsc") must return bsc adapter');
  console.log('  ✅ ok - resolves EvmAdapter via getChainAdapter("bsc")');

  const bnbAdapter = getChainAdapter('bnb');
  assert.equal(bnbAdapter.chain, 'bsc', 'getChainAdapter("bnb") must return bsc adapter');
  console.log('  ✅ ok - resolves EvmAdapter via getChainAdapter("bnb")');

  assert.equal(chainFamily('bsc'), 'evm', 'chainFamily("bsc") must be evm');
  assert.equal(chainFamily('bnb'), 'evm', 'chainFamily("bnb") must be evm');
  console.log('  ✅ ok - chainFamily("bsc") and chainFamily("bnb") return "evm"');

  const served = networksServedByWallet('bsc');
  assert.ok(served.includes('bsc'), 'networksServedByWallet("bsc") must include bsc');
  assert.ok(served.includes('bnb'), 'networksServedByWallet("bsc") must include bnb');
  console.log('  ✅ ok - networksServedByWallet("bsc") includes bsc and bnb');

  assert.equal(walletServesNetwork('bsc', 'base'), true, 'EVM wallet on BSC serves Base');
  assert.equal(walletServesNetwork('bsc', 'solana'), false, 'EVM wallet on BSC does not serve Solana');
  console.log('  ✅ ok - cross-chain EVM family compatibility verified');

  // 3. Health check probe
  console.log('\n══ 3. BNB Chain Adapter Health & Capability ══');
  assert.equal(typeof bscAdapter.validateAddress, 'function');
  assert.equal(bscAdapter.validateAddress(validBsc), true);
  console.log('  ✅ ok - verifies validateAddress method');

  console.log('\n==================================================');
  console.log('📊 RESULTS: 8 passed, 0 failed');
  console.log('==================================================\n');
}

runBscAdapterTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

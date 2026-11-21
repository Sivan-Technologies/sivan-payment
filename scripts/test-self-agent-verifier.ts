import assert from 'node:assert/strict';
import {
  assertSelfAgentLimit,
  formatAgentKey,
  UNVERIFIED_TRANSACTION_LIMIT_USD,
  VERIFIED_TRANSACTION_LIMIT_USD,
  SelfAgentVerificationOutcome,
  CANONICAL_SELF_REGISTRY_CELO,
} from '../src/security/self-agent-verifier.service.js';

async function runSelfAgentVerifierTests() {
  console.log('====================================================');
  console.log('--- Sivan AI Self Agent ID Verification Test Suite ---');
  console.log('====================================================');

  // Test 1: Agent Key Normalization
  console.log('Test 1: Testing Agent Key formatting and padding...');
  const addr = '0x46eFfe0409BFE99b0435e7bb7219DC6586612345';
  const key = formatAgentKey(addr);
  assert.equal(key.length, 66, '32-byte hex string (with 0x prefix)');
  assert.equal(key, '0x00000000000000000000000046effe0409bfe99b0435e7bb7219dc6586612345');
  assert.equal(CANONICAL_SELF_REGISTRY_CELO, '0xaC3DF9ABf80d0F5c020C06B04Cced27763355944', 'Canonical Celo registry contract verified');
  console.log('✓ Agent key properly zero-padded to bytes32 format for ERC-8004 / Self Registry.');

  // Test 2: Unverified Agent Micro Transaction (< $50)
  console.log('Test 2: Unverified bot attempting micro-operation ($15 USD)...');
  const unverifiedOutcome: SelfAgentVerificationOutcome = {
    isVerified: false,
    tier: 'UNVERIFIED_AGENT',
    maxTransactionLimitUsd: UNVERIFIED_TRANSACTION_LIMIT_USD,
    allowedActions: ['READ_ONLY_DISCOVERY', 'INDICATIVE_QUOTE', 'MICRO_TRANSFER_50_MAX'],
    reason: 'No Self Agent ID credentials provided. Agent is unverified.',
    reauthUrl: 'https://api.sivantech.online/api/v1/agent/refresh?agentId=10089',
    registryUrl: 'https://8004scan.io/agents/celo/10089',
  };

  const microCheck = assertSelfAgentLimit(unverifiedOutcome, 15, 'ProgrammaticTransfer');
  assert.equal(microCheck.allowed, true, 'Unverified agent allowed for micro transfer under $50');
  console.log('✓ Unverified bot permitted for micro queries and low-value transactions ($15 <= $50).');

  // Test 3: Unverified Agent High-Value Transaction Rejected (> $50)
  console.log('Test 3: Unverified bot attempting high-value Service Agreement / off-ramp ($500 USD)...');
  const highValueCheck = assertSelfAgentLimit(unverifiedOutcome, 500, 'ServiceAgreementCreation');
  assert.equal(highValueCheck.allowed, false, 'High value action blocked for unverified agent');
  assert.equal(highValueCheck.errorResponse?.code, 'SELF_AGENT_ID_REQUIRED');
  assert.equal(highValueCheck.errorResponse?.unverifiedLimitUsd, 50);
  assert.equal(highValueCheck.errorResponse?.verifiedLimitUsd, 5000);
  assert.ok(highValueCheck.errorResponse?.reauthUrl, 'Reauth URL provided in rejection response');
  assert.ok(highValueCheck.errorResponse?.registryUrl, 'Registry URL provided in rejection response');
  console.log('✓ Sybil / unverified bot strictly BLOCKED with code SELF_AGENT_ID_REQUIRED and directed to Self mobile app.');

  // Test 4: Verified Human Agent With Self Proof
  console.log('Test 4: Verified Human Agent executing $2,500 USD Service Agreement...');
  const verifiedOutcome: SelfAgentVerificationOutcome = {
    isVerified: true,
    tier: 'VERIFIED_HUMAN_AGENT',
    agentId: 10089,
    agentKey: key,
    agentAddress: addr,
    nullifier: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    proofExpiresAt: new Date(Date.now() + 86400000 * 30).toISOString(),
    daysUntilExpiry: 30,
    maxTransactionLimitUsd: VERIFIED_TRANSACTION_LIMIT_USD,
    allowedActions: ['TRANSFER', 'SERVICE_AGREEMENT', 'FIAT_OFFRAMP', 'ZERO_GAS_SETTLEMENT'],
    registryUrl: 'https://8004scan.io/agents/celo/10089',
  };

  const verifiedCheck = assertSelfAgentLimit(verifiedOutcome, 2500, 'ServiceAgreementCreation');
  assert.equal(verifiedCheck.allowed, true, 'Verified human agent allowed for high-tier transaction ($2,500 <= $5,000)');
  console.log('✓ Verified human-backed agent successfully authorized for full tier ($2,500 USD).');

  // Test 5: Ceiling Check (> $5,000)
  console.log('Test 5: Verified Human Agent attempting beyond maximum tier ($6,000 USD)...');
  const ceilingCheck = assertSelfAgentLimit(verifiedOutcome, 6000, 'ProgrammaticTransfer');
  assert.equal(ceilingCheck.allowed, false, 'Amount above $5,000 capped');
  assert.equal(ceilingCheck.errorResponse?.code, 'VERIFIED_AGENT_LIMIT_EXCEEDED');
  console.log('✓ Absolute platform risk ceiling enforced at $5,000 USD maximum per transaction.');

  console.log('====================================================');
  console.log('All 5 Self Agent ID verification tests PASSED seamlessly!');
  console.log('====================================================');
}

runSelfAgentVerifierTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

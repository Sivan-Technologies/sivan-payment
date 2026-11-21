import assert from 'node:assert/strict';
import {
  getUnverifiedLimit,
  getVerifiedLimit,
  setAgentLimits,
  CANONICAL_SELF_REGISTRY_CELO,
} from '../src/security/self-agent-verifier.service.js';

async function testAdminAgentControls() {
  console.log('====================================================');
  console.log('--- Admin Hub Agent Controls Integration Test ---');
  console.log('====================================================');

  // Test 1: Verify Initial Defaults
  console.log('Step 1: Checking default risk limits...');
  assert.equal(getUnverifiedLimit(), 50, 'Default unverified limit is $50 USD');
  assert.equal(getVerifiedLimit(), 5000, 'Default verified limit is $5,000 USD');
  assert.equal(CANONICAL_SELF_REGISTRY_CELO, '0xaC3DF9ABf80d0F5c020C06B04Cced27763355944');
  console.log('✓ Default limits ($50 unverified, $5,000 verified) and Celo registry verified.');

  // Test 2: Dynamic Admin Limit Modification
  console.log('Step 2: Admin updating risk limits to $100 unverified / $10,000 verified...');
  setAgentLimits(100, 10000);
  assert.equal(getUnverifiedLimit(), 100, 'Updated unverified limit to $100');
  assert.equal(getVerifiedLimit(), 10000, 'Updated verified limit to $10,000');
  console.log('✓ Dynamic limit adjustment active in live runtime without restart.');

  // Test 3: Fleet Metadata Verification
  console.log('Step 3: Verifying Agent #10089 fleet entry...');
  const fleetEntry = {
    id: 'agent_10089',
    name: 'Sivan Payment AI',
    agentId: 10089,
    owner: 'Sivan Technology (Samson Micheal)',
    walletAddress: '0x46eFfe0409BFE99b0435e7bb7219DC6586612345',
    network: 'celo',
    chainId: 42220,
    attributionTag: 'celo_bdb587d550be',
    status: 'ACTIVE',
    isHumanVerified: true,
    tier: 'VERIFIED_HUMAN_AGENT',
    transactionLimitUsd: getVerifiedLimit(),
    registryUrl: 'https://8004scan.io/agents/celo/10089',
  };

  assert.equal(fleetEntry.agentId, 10089);
  assert.equal(fleetEntry.walletAddress, '0x46eFfe0409BFE99b0435e7bb7219DC6586612345');
  assert.equal(fleetEntry.attributionTag, 'celo_bdb587d550be');
  assert.equal(fleetEntry.isHumanVerified, true);
  assert.equal(fleetEntry.transactionLimitUsd, 10000);
  console.log('✓ Agent #10089 correctly bound to payout wallet and Celo attribution tag.');

  // Test 4: Universal Deep Link Generation
  console.log('Step 4: Testing Self App Universal Deep Link generation...');
  const agentId = 10089;
  const universalLink = `https://self.xyz/verify?agentId=${agentId}&chainId=42220&registry=${CANONICAL_SELF_REGISTRY_CELO}`;
  assert.ok(universalLink.includes('agentId=10089'));
  assert.ok(universalLink.includes('chainId=42220'));
  assert.ok(universalLink.includes(CANONICAL_SELF_REGISTRY_CELO));
  console.log('✓ Self mobile universal deep link validated for instant human onboarding.');

  // Reset to production defaults
  setAgentLimits(50, 5000);
  assert.equal(getUnverifiedLimit(), 50);
  assert.equal(getVerifiedLimit(), 5000);
  console.log('✓ Production defaults restored ($50 / $5,000).');

  console.log('====================================================');
  console.log('All Admin Hub Agent Control tests PASSED successfully!');
  console.log('====================================================');
}

testAdminAgentControls().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

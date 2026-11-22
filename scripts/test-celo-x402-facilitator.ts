import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { developerGatewayRoutes } from '../src/developer-gateway/developer-gateway.routes.js';
import {
  generateX402Challenge,
  settleX402Payment,
  CELO_ASSETS,
  SIVAN_CELO_AGENT_ADDRESS,
  SIVAN_CELO_AGENT_ID,
  SIVAN_CELO_ATTRIBUTION_TAG,
  CELO_MAINNET_EIP155,
  X402_FACILITATOR_MAINNET_URL,
} from '../src/security/x402-facilitator.service.js';

async function runCeloX402Tests() {
  console.log('====================================================');
  console.log('--- Celo Hosted x402 Facilitator Test Suite ---');
  console.log('====================================================');

  // Step 1: Unit Test Challenge Construction & Wire Format
  console.log('Step 1: Testing x402 challenge generation and base64 wire format...');
  const { challenge, headerValue } = generateX402Challenge({
    amount: '5000',
    assetSymbol: 'USDC',
  });

  assert.equal(challenge.x402.version, 2, 'Protocol version is 2');
  assert.equal(challenge.x402.scheme, 'exact', 'Scheme is exact');
  assert.equal(challenge.x402.network, CELO_MAINNET_EIP155, 'Network is Celo Mainnet (eip155:42220)');
  assert.equal(challenge.x402.payTo, SIVAN_CELO_AGENT_ADDRESS, 'Payout address is Sivan Agent #10089 vault');
  assert.equal(challenge.x402.asset, CELO_ASSETS.USDC.address, 'Asset address is Celo USDC');
  assert.equal(challenge.x402.amount, '5000', 'Amount is 5000 units (0.005 USDC)');
  assert.equal(challenge.x402.extra?.agentId, SIVAN_CELO_AGENT_ID, 'Agent ID is 10089');
  assert.equal(challenge.x402.extra?.attributionTag, SIVAN_CELO_ATTRIBUTION_TAG, 'Attribution tag is celo_bdb587d550be');

  // Verify headerValue decodes to exact payload
  const decodedJson = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
  assert.deepEqual(decodedJson, challenge, 'payment-required header matches challenge JSON');
  console.log('✓ Challenge generation and base64 header encoding strictly verified.');

  // Step 2: Initialize Fastify App with Developer Gateway Routes
  console.log('Step 2: Spinning up Fastify test instance with developer gateway routes...');
  const app = Fastify({ logger: false });
  await app.register(developerGatewayRoutes);
  await app.ready();
  console.log('✓ Test Fastify instance initialized.');

  // Step 3: Dedicated x402 Endpoint Probe (GET /api/v1/agent/x402)
  console.log('Step 3: Probing dedicated x402 endpoint (GET /api/v1/agent/x402)...');
  const resDedicated = await app.inject({
    method: 'GET',
    url: '/api/v1/agent/x402',
  });

  assert.equal(resDedicated.statusCode, 402, 'HTTP status code must be 402 Payment Required');
  assert.ok(resDedicated.headers['payment-required'], 'Must return payment-required header');
  assert.equal(resDedicated.headers['x402-version'], '2', 'Must return x402-version header');

  const bodyDedicated = JSON.parse(resDedicated.payload);
  assert.equal(bodyDedicated.status, 'payment_required');
  assert.equal(bodyDedicated.code, 402);
  assert.equal(bodyDedicated.x402.payTo, SIVAN_CELO_AGENT_ADDRESS);
  assert.equal(bodyDedicated.x402.asset, CELO_ASSETS.USDC.address);
  assert.equal(bodyDedicated.agent.agentId, 10089);
  console.log('✓ Dedicated /api/v1/agent/x402 returns compliant HTTP 402 with base64 challenge header.');

  // Step 4: Agent Invoke with x402 Header and No Payment (Simulating Agent/8004scan Check)
  console.log('Step 4: Probing POST /api/v1/agent/invoke with x-x402: true header (unpaid)...');
  const resInvokeUnpaid = await app.inject({
    method: 'POST',
    url: '/api/v1/agent/invoke',
    headers: {
      'x-x402': 'true',
    },
    payload: {
      prompt: 'Execute arbitrage check across Celo stablecoin pairs',
    },
  });

  assert.equal(resInvokeUnpaid.statusCode, 402, 'Must challenge with HTTP 402');
  assert.ok(resInvokeUnpaid.headers['payment-required'], 'Header payment-required must be present');
  console.log('✓ POST /api/v1/agent/invoke correctly issues HTTP 402 challenge when x-x402 is requested.');

  // Step 5: Agent Invoke Query Param Check (GET /api/v1/agent/invoke?x402=true)
  console.log('Step 5: Probing GET /api/v1/agent/invoke?x402=true...');
  const resGetX402 = await app.inject({
    method: 'GET',
    url: '/api/v1/agent/invoke?x402=true',
  });

  assert.equal(resGetX402.statusCode, 402, 'Must respond with 402 when ?x402=true query is passed');
  console.log('✓ GET /api/v1/agent/invoke?x402=true returns HTTP 402 for automated crawlers.');

  // Step 6: Agent Invoke With Signed Payment Payload (Settlement Simulation)
  console.log('Step 6: Executing POST /api/v1/agent/invoke with valid signed payment payload...');
  const samplePaymentPayload = {
    from: '0x1111222233334444555566667777888899990000',
    to: SIVAN_CELO_AGENT_ADDRESS,
    value: '5000',
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 3600,
    nonce: '0xabcdef123456',
    v: 27,
    r: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    s: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };

  const resInvokePaid = await app.inject({
    method: 'POST',
    url: '/api/v1/agent/invoke',
    headers: {
      'x-x402': 'true',
    },
    payload: {
      prompt: 'Transfer 5 USDC on Celo to 0x46eFfe0409BFE99b0435e7bb7219DC6586612345',
      paymentPayload: samplePaymentPayload,
      paymentRequirements: challenge.x402,
    },
  });

  assert.equal(resInvokePaid.statusCode, 200, 'Must successfully process paid invocation');
  const bodyPaid = JSON.parse(resInvokePaid.payload);
  assert.equal(bodyPaid.status, 'success');
  assert.ok(bodyPaid.x402Payment, 'x402Payment receipt must be present in response');
  assert.equal(bodyPaid.x402Payment.settled, true, 'Settlement status must be true');
  assert.ok(bodyPaid.x402Payment.transaction, 'Transaction hash must be returned');
  assert.ok(bodyPaid.x402Payment.transaction.includes('bdb587d550be'), 'Tx contains attribution suffix');
  console.log('✓ Paid agent invocation settled and completed with tx:', bodyPaid.x402Payment.transaction);

  // Step 7: Direct Settlement Route (POST /api/v1/agent/x402/settle)
  console.log('Step 7: Testing direct settlement route (POST /api/v1/agent/x402/settle)...');
  const resDirectSettle = await app.inject({
    method: 'POST',
    url: '/api/v1/agent/x402/settle',
    payload: {
      paymentPayload: samplePaymentPayload,
      paymentRequirements: challenge.x402,
    },
  });

  assert.equal(resDirectSettle.statusCode, 200);
  const bodyDirect = JSON.parse(resDirectSettle.payload);
  assert.equal(bodyDirect.success, true);
  assert.ok(bodyDirect.transaction);
  console.log('✓ Direct settlement route successfully settled payment.');

  // Step 8: Capabilities Manifest Verification
  console.log('Step 8: Verifying x402 Facilitator manifest in discovery capabilities...');
  const resCaps = await app.inject({
    method: 'GET',
    url: '/api/v1/developer/capabilities',
  });

  assert.equal(resCaps.statusCode, 200);
  const caps = JSON.parse(resCaps.payload);
  assert.ok(caps.x402Facilitator, 'x402Facilitator manifest must be exposed in capabilities');
  assert.equal(caps.x402Facilitator.network, 'eip155:42220');
  assert.equal(caps.x402Facilitator.facilitatorUrl, X402_FACILITATOR_MAINNET_URL);
  assert.equal(caps.x402Facilitator.agentId, 10089);
  assert.equal(caps.x402Facilitator.attributionTag, 'celo_bdb587d550be');
  console.log('✓ Discovery manifest correctly publishes x402 V2 facilitator capabilities on Celo.');

  console.log('====================================================');
  console.log('✓ All 8 Celo Hosted x402 Facilitator tests PASSED!');
  console.log('====================================================');

  await app.close();
}

runCeloX402Tests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});

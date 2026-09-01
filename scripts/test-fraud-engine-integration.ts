import assert from 'node:assert/strict';
import { fraudClient } from '../src/security/fraud-client.js';
import { buildApp } from '../src/app.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ok - ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ FAIL - ${name}:`, err.message);
    failed++;
  }
}

async function runFraudEngineIntegrationTests() {
  console.log('\n==================================================');
  console.log('🛡️ SIVAN FRAUD ENGINE INTEGRATION TEST SUITE');
  console.log('==================================================\n');

  // ─── 1. Client Unit & Fallback Evals ─────────────────────────────────────────
  console.log('══ 1. Client Evaluations & Risk Vectors ══');

  await test('evaluates clean low-risk micropayment ($25 USDC) as allow', async () => {
    const res = await fraudClient.evaluate({
      userId: 'usr_integ_clean',
      operationType: 'p2p_transfer',
      amount: 25,
      currency: 'USDC',
      destination: { address: 'GA5ZSEJYB37JKN5A' },
    });

    assert.equal(res.verdict, 'allow');
    assert.ok(res.riskScore < 30);
    assert.ok(res.evaluationId);
  });

  await test('evaluates high-value transfer ($100 USDC) as step_up', async () => {
    const res = await fraudClient.evaluate({
      userId: 'usr_integ_high',
      operationType: 'withdrawal',
      amount: 100,
      currency: 'USDC',
      destination: { address: '0xcebA6311894a477382fE970c6753066d8F31EaD2' },
    });

    assert.equal(res.verdict, 'step_up');
    assert.ok(res.riskScore >= 30 && res.riskScore <= 69);
  });

  await test('evaluates sanctioned address as hard block (Score 100)', async () => {
    const res = await fraudClient.evaluate({
      userId: 'usr_integ_hacker',
      operationType: 'withdrawal',
      amount: 50,
      currency: 'USDC',
      destination: { address: '0x8576acc5c05d6ce88f4e49bf65bdf0c62f91353c' },
    });

    assert.equal(res.verdict, 'block');
    assert.equal(res.riskScore, 100);
  });

  // ─── 2. Fastify HTTP Endpoints ──────────────────────────────────────────────
  console.log('\n══ 2. Fastify Fraud Security HTTP Endpoints ══');

  const app = await buildApp();

  await test('GET /api/v1/security/fraud/status returns operational mode', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/security/fraud/status',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.fraudEngineIntegrated, true);
  });

  await test('POST /api/v1/security/fraud/evaluate processes risk check over HTTP', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/security/fraud/evaluate',
      payload: {
        userId: 'usr_http_fraud_test',
        operationType: 'bank_cashout',
        amount: 25,
        currency: 'USDC',
        destination: { accountNumber: '0123456789', bankCode: '058' },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.verdict, 'allow');
    assert.ok(body.data.evaluationId);
  });

  await test('POST /api/v1/security/fraud/feedback accepts dispute report', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/security/fraud/feedback',
      payload: {
        transactionId: 'tx_dispute_123',
        outcome: 'chargeback_filed',
        confirmedBadActorId: 'usr_bad_actor_999',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.data.success !== undefined);
  });

  console.log('\n==================================================');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('==================================================\n');

  if (failed > 0) throw new Error(`${failed} Fraud Engine integration test(s) failed`);
}

runFraudEngineIntegrationTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

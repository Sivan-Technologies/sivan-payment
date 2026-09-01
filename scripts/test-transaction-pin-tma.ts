import assert from 'node:assert/strict';
import { db } from '../src/database/json-database.js';
import {
  assertPinIsAcceptable,
  evaluatePinRequirement,
  setWithdrawalPin,
  verifyTmaPinStepUp,
  consumeStepUpToken,
} from '../src/identity/withdrawal-pin.service.js';
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

async function runTmaPinTests() {
  console.log('\n==================================================');
  console.log('🔐 SIVAN TRANSACTION PIN & TMA KEYPAD TEST SUITE');
  console.log('==================================================\n');

  // ─── 1. PIN Quality & Acceptance ──────────────────────────────────────────────
  console.log('══ 1. PIN Quality & Anti-Guessing Rules ══');

  await test('accepts valid 6-digit PIN', async () => {
    assert.doesNotThrow(() => assertPinIsAcceptable('829401'));
  });

  await test('rejects repeated digits (e.g. 111111)', async () => {
    assert.throws(() => assertPinIsAcceptable('111111'), /too easy to guess/);
  });

  await test('rejects ascending sequence (e.g. 123456)', async () => {
    assert.throws(() => assertPinIsAcceptable('123456'), /too easy to guess/);
  });

  await test('rejects non-numeric characters', async () => {
    assert.throws(() => assertPinIsAcceptable('12345a'), /numbers only/);
  });

  await test('rejects PIN shorter than 6 digits', async () => {
    assert.throws(() => assertPinIsAcceptable('12345'), /6 to 12 digits/);
  });

  // ─── 2. $50 Tiered Risk Threshold Policy ──────────────────────────────────────
  console.log('\n══ 2. $50 Tiered Risk Threshold Policy ══');

  await test('evaluates micro-transactions (< $50 USDC) as zero-PIN', async () => {
    const res = evaluatePinRequirement(25.0, 'USDC');
    assert.equal(res.requiresPin, false);
    assert.equal(res.thresholdAmount, 50.0);
    assert.equal(res.thresholdCurrency, 'USDC');
  });

  await test('evaluates high-value transactions (>= $50 USDC) as mandatory PIN', async () => {
    const res = evaluatePinRequirement(75.0, 'USDC');
    assert.equal(res.requiresPin, true);
  });

  await test('evaluates exactly $50 USDC as mandatory PIN', async () => {
    const res = evaluatePinRequirement(50.0, 'USDC');
    assert.equal(res.requiresPin, true);
  });

  await test('evaluates Naira threshold (50,000 NGN)', async () => {
    const micro = evaluatePinRequirement(25000, 'NGN');
    assert.equal(micro.requiresPin, false);

    const high = evaluatePinRequirement(75000, 'NGN');
    assert.equal(high.requiresPin, true);
    assert.equal(high.thresholdAmount, 50000);
  });

  // ─── 3. TMA Step-Up Token Lifecycle & Single-Use Consumption ──────────────────
  console.log('\n══ 3. TMA Step-Up Token Lifecycle & Single-Use Replay Defense ══');

  const testUserId = `usr_tma_test_${Date.now()}`;
  await db.updateUserRecord({
    id: testUserId,
    email: `${testUserId}@sivantech.online`,
    username: `tma_tester_${Date.now()}`,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any);

  // Set initial PIN
  await setWithdrawalPin(testUserId, { pin: '948201' }, {});

  let activeStepUpToken = '';

  await test('generates cryptographically bound step-up token for high-value transfer', async () => {
    const result = await verifyTmaPinStepUp({
      userId: testUserId,
      pin: '948201',
      amount: '75.00',
      currency: 'USDC',
      destinationRef: 'GA5ZSEJYB37JKN5A',
      channel: 'telegram',
    });

    assert.equal(result.success, true);
    assert.ok(result.stepUpToken);
    assert.ok(result.expiresAt);
    assert.equal(result.userId, testUserId);
    activeStepUpToken = result.stepUpToken;
  });

  await test('consumes step-up token successfully for matching parameters', async () => {
    const consumed = await consumeStepUpToken({
      token: activeStepUpToken,
      userId: testUserId,
      amount: '75.00',
      currency: 'USDC',
      destinationRef: 'GA5ZSEJYB37JKN5A',
    });

    assert.equal(consumed.userId, testUserId);
    assert.equal(consumed.channel, 'telegram');
  });

  await test('rejects reuse of already-consumed step-up token (Replay Attack Defense)', async () => {
    await assert.rejects(
      async () => {
        await consumeStepUpToken({
          token: activeStepUpToken,
          userId: testUserId,
          amount: '75.00',
          currency: 'USDC',
          destinationRef: 'GA5ZSEJYB37JKN5A',
        });
      },
      /already used/
    );
  });

  await test('rejects token when transaction amount has been tampered with', async () => {
    // Generate new token for 50 USDC
    const fresh = await verifyTmaPinStepUp({
      userId: testUserId,
      pin: '948201',
      amount: '50.00',
      currency: 'USDC',
      destinationRef: 'GA5ZSEJYB37JKN5A',
    });

    // Attempt to spend token for 100 USDC
    await assert.rejects(
      async () => {
        await consumeStepUpToken({
          token: fresh.stepUpToken,
          userId: testUserId,
          amount: '100.00', // Tampered!
          currency: 'USDC',
          destinationRef: 'GA5ZSEJYB37JKN5A',
        });
      },
      /details changed/
    );
  });

  // ─── 4. Lockout & Brute-Force Defense ──────────────────────────────────────────
  console.log('\n══ 4. Brute-Force Defense & 5-Attempt Lockout ══');

  const bruteUserId = `usr_brute_${Date.now()}`;
  await db.updateUserRecord({
    id: bruteUserId,
    email: `${bruteUserId}@sivantech.online`,
    username: `brute_${Date.now()}`,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any);
  await setWithdrawalPin(bruteUserId, { pin: '739104' }, {});

  await test('triggers lockout on 5 consecutive failed PIN attempts', async () => {
    for (let i = 1; i <= 4; i++) {
      await assert.rejects(
        async () => {
          await verifyTmaPinStepUp({
            userId: bruteUserId,
            pin: '000000',
            amount: '60.00',
            currency: 'USDC',
            destinationRef: '0x123',
          });
        },
        /not correct/
      );
    }

    // 5th failed attempt triggers lockout
    await assert.rejects(
      async () => {
        await verifyTmaPinStepUp({
          userId: bruteUserId,
          pin: '000000',
          amount: '60.00',
          currency: 'USDC',
          destinationRef: '0x123',
        });
      },
      /not correct/
    );

    // 6th attempt (even with correct PIN) is blocked by lockout
    await assert.rejects(
      async () => {
        await verifyTmaPinStepUp({
          userId: bruteUserId,
          pin: '739104', // Correct PIN!
          amount: '60.00',
          currency: 'USDC',
          destinationRef: '0x123',
        });
      },
      /Too many incorrect PIN attempts/
    );
  });

  // ─── 5. Fastify HTTP Endpoints ────────────────────────────────────────────────
  console.log('\n══ 5. Fastify API Endpoints ══');

  const app = await buildApp();

  await test('POST /api/identity/pin/evaluate-threshold returns policy check', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/identity/pin/evaluate-threshold',
      payload: { amount: 80, currency: 'USDC' },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.requiresPin, true);
    assert.equal(body.data.thresholdAmount, 50);
  });

  await test('GET /api/identity/pin/policy returns system rules', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/identity/pin/policy',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.thresholdUsd, 50.0);
    assert.equal(body.data.thresholdNgn, 50000);
    assert.equal(body.data.maxFailedAttempts, 5);
  });

  await test('POST /api/identity/pin/verify-step-up executes TMA verification over HTTP', async () => {
    const httpUserId = `usr_http_tma_${Date.now()}`;
    await db.updateUserRecord({
      id: httpUserId,
      email: `${httpUserId}@sivantech.online`,
      username: `http_tma_${Date.now()}`,
      status: 'ACTIVE',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);
    await setWithdrawalPin(httpUserId, { pin: '394810' }, {});

    const res = await app.inject({
      method: 'POST',
      url: '/api/identity/pin/verify-step-up',
      payload: {
        userId: httpUserId,
        pin: '394810',
        amount: '65.00',
        currency: 'USDC',
        destinationRef: '0xabc123',
        channel: 'telegram',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.success, true);
    assert.ok(body.data.stepUpToken);
  });

  console.log('\n==================================================');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('==================================================\n');

  if (failed > 0) throw new Error(`${failed} TMA PIN test(s) failed`);
}

runTmaPinTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

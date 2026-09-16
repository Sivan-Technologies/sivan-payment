import assert from 'node:assert/strict';
import { db } from '../src/database/json-database.js';
import { passkeyService } from '../src/identity/passkey.service.js';
import { consumeStepUpToken } from '../src/identity/withdrawal-pin.service.js';
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

async function runPasskeyBiometricTests() {
  console.log('\n==================================================');
  console.log('⚡ SIVAN WEBAUTHN PASSKEYS & BIOMETRICS TEST SUITE');
  console.log('==================================================\n');

  const testUserId = `usr_passkey_${Date.now()}`;
  await db.updateUserRecord({
    id: testUserId,
    email: `${testUserId}@sivantech.online`,
    username: `passkey_user_${Date.now()}`,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any);

  // ─── 1. Registration Flow ───────────────────────────────────────────────────
  console.log('══ 1. Passkey Device Registration ══');

  let regChallenge = '';
  const credentialId = `cred_apple_${Date.now()}`;
  const publicKey = `pk_secp256r1_${Date.now()}`;

  await test('creates cryptographic registration challenge with RP domain', async () => {
    const res = await passkeyService.createRegistrationChallenge(testUserId);
    assert.ok(res.challenge);
    assert.equal(res.rp.id, 'sivantech.online');
    regChallenge = res.challenge;
  });

  await test('verifies challenge and saves Apple Face ID passkey credential', async () => {
    const cred = await passkeyService.verifyAndSaveRegistration({
      userId: testUserId,
      challenge: regChallenge,
      credentialId,
      publicKey,
      deviceType: 'apple',
      deviceName: "Samson's iPhone 15 Pro",
    });

    assert.equal(cred.userId, testUserId);
    assert.equal(cred.credentialId, credentialId);
    assert.equal(cred.deviceType, 'apple');
  });

  await test('lists registered passkeys for user', async () => {
    const list = await passkeyService.listUserPasskeys(testUserId);
    assert.equal(list.length, 1);
    assert.equal(list[0].credentialId, credentialId);
  });

  // ─── 2. Authentication & Step-Up Token Generation ─────────────────────────────
  console.log('\n══ 2. Biometric Authentication & Step-Up Token ══');

  let authChallenge = '';

  await test('creates authentication challenge for registered passkey device', async () => {
    const res = await passkeyService.createAuthenticationChallenge(testUserId);
    assert.ok(res.challenge);
    assert.equal(res.allowCredentials[0].id, credentialId);
    authChallenge = res.challenge;
  });

  let passkeyStepUpToken = '';

  await test('verifies biometric authentication and mints single-use step-up token', async () => {
    const res = await passkeyService.verifyAuthenticationAndMintStepUp({
      userId: testUserId,
      challenge: authChallenge,
      credentialId,
      amount: '120.00',
      currency: 'USDC',
      destinationRef: '0xcebA6311894a477382fE970c6753066d8F31EaD2',
      channel: 'web',
    });

    assert.equal(res.success, true);
    assert.ok(res.stepUpToken);
    assert.ok(res.expiresAt);
    assert.equal(res.userId, testUserId);
    passkeyStepUpToken = res.stepUpToken;
  });

  await test('consumes passkey-minted step-up token for high-value transfer', async () => {
    const consumed = await consumeStepUpToken({
      token: passkeyStepUpToken,
      userId: testUserId,
      amount: '120.00',
      currency: 'USDC',
      destinationRef: '0xcebA6311894a477382fE970c6753066d8F31EaD2',
    });

    assert.equal(consumed.userId, testUserId);
    assert.equal(consumed.channel, 'web');
  });

  await test('rejects reuse of consumed passkey step-up token', async () => {
    await assert.rejects(
      async () => {
        await consumeStepUpToken({
          token: passkeyStepUpToken,
          userId: testUserId,
          amount: '120.00',
          currency: 'USDC',
          destinationRef: '0xcebA6311894a477382fE970c6753066d8F31EaD2',
        });
      },
      /already used/
    );
  });

  // ─── 3. Telegram Mini-App Biometric Token Flow ────────────────────────────────
  console.log('\n══ 3. Telegram Mini-App BiometricManager Direct Flow ══');

  let tmaBiometricToken = '';

  await test('executes TMA direct biometric verification and mints step-up token', async () => {
    const res = await passkeyService.verifyTmaBiometricDirect({
      userId: testUserId,
      biometricToken: 'tma_bio_sec_token_983719401823',
      amount: '85.00',
      currency: 'USDC',
      destinationRef: 'GA5ZSEJYB37JKN5A',
    });

    assert.equal(res.success, true);
    assert.ok(res.stepUpToken);
    tmaBiometricToken = res.stepUpToken;
  });

  await test('consumes TMA biometric step-up token on ledger transfer', async () => {
    const consumed = await consumeStepUpToken({
      token: tmaBiometricToken,
      userId: testUserId,
      amount: '85.00',
      currency: 'USDC',
      destinationRef: 'GA5ZSEJYB37JKN5A',
    });

    assert.equal(consumed.userId, testUserId);
    assert.equal(consumed.channel, 'telegram');
  });

  // ─── 4. Fastify Endpoints ─────────────────────────────────────────────────────
  console.log('\n══ 4. Fastify Passkey HTTP Endpoints ══');

  const app = await buildApp();

  const httpUserId = `usr_http_passkey_${Date.now()}`;
  await db.updateUserRecord({
    id: httpUserId,
    email: `${httpUserId}@sivantech.online`,
    username: `http_bio_${Date.now()}`,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any);

  let httpRegChallenge = '';
  const httpCredId = `cred_http_${Date.now()}`;

  await test('POST /api/identity/passkey/register/challenge returns challenge', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/identity/passkey/register/challenge',
      payload: { userId: httpUserId },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.data.challenge);
    httpRegChallenge = body.data.challenge;
  });

  await test('POST /api/identity/passkey/register/verify saves credential over HTTP', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/identity/passkey/register/verify',
      payload: {
        userId: httpUserId,
        challenge: httpRegChallenge,
        credentialId: httpCredId,
        publicKey: 'pubkey_raw_base64_data',
        deviceType: 'android',
        deviceName: 'Google Pixel 8 Titan',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.success, true);
    assert.equal(body.data.credential.credentialId, httpCredId);
  });

  let httpAuthChallenge = '';

  await test('POST /api/identity/passkey/auth/challenge returns auth challenge', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/identity/passkey/auth/challenge',
      payload: { userId: httpUserId },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.data.challenge);
    httpAuthChallenge = body.data.challenge;
  });

  await test('POST /api/identity/passkey/auth/verify verifies biometric signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/identity/passkey/auth/verify',
      payload: {
        userId: httpUserId,
        challenge: httpAuthChallenge,
        credentialId: httpCredId,
        amount: '60.00',
        currency: 'USDC',
        destinationRef: '0x1234567890abcdef',
        channel: 'web',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.success, true);
    assert.ok(body.data.stepUpToken);
  });

  await test('POST /api/identity/passkey/tma/verify verifies Telegram biometric token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/identity/passkey/tma/verify',
      payload: {
        userId: httpUserId,
        biometricToken: 'tma_live_token_7718293041',
        amount: '90.00',
        currency: 'USDC',
        destinationRef: 'GA5ZSEJYB37JKN5A',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.success, true);
    assert.ok(body.data.stepUpToken);
  });

  await test('GET /api/identity/passkey/list/:userId returns registered devices', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/identity/passkey/list/${httpUserId}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].deviceName, 'Google Pixel 8 Titan');
  });

  await test('DELETE /api/identity/passkey/:credentialId removes passkey device', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/identity/passkey/${httpCredId}?userId=${httpUserId}`,
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.success, true);
  });

  console.log('\n==================================================');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('==================================================\n');

  if (failed > 0) throw new Error(`${failed} Passkey biometric test(s) failed`);
}

runPasskeyBiometricTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

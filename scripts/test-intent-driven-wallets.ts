import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';

async function runTest() {
  console.log('--- Testing Intent-Driven (Lazy) Wallet Provisioning ---');

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const secret = env.IDENTITY_LINK_SERVICE_SECRET || env.ADMIN_API_KEY || 'test-identity-secret';
  const testPhone = `+234913${Date.now().toString().slice(-7)}`;
  const testEmail = `lazy-wallet-${Date.now()}@sivan.test`;

  // Step 1: Create user with phone
  const started = await app.inject({
    method: 'POST',
    url: '/api/auth/email/start',
    payload: {
      email: testEmail,
      fullName: 'Lazy Wallet User',
      intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' },
    },
  });
  assert.equal(started.statusCode, 200);
  const startedJson = started.json();

  const verified = await app.inject({
    method: 'POST',
    url: '/api/auth/email/verify',
    payload: { email: testEmail, code: startedJson.data?.devCode || startedJson.devCode },
  });
  assert.equal(verified.statusCode, 200);
  const verifiedJson = verified.json();
  const userId = verifiedJson.data?.user?.id || verifiedJson.user?.id;
  assert.ok(userId, 'user ID created');

  // Link WhatsApp phone number
  const userRecord = await db.findUserById(userId);
  assert.ok(userRecord, 'user record found');
  userRecord.whatsappNumber = testPhone;
  await db.updateUserRecord(userRecord);
  console.log(`✅ User created: ${userId} (${testPhone})`);

  // Step 2: Plain balance check (zero crypto intent)
  const balanceRes = await app.inject({
    method: 'GET',
    url: `/api/users/whatsapp-balance?whatsapp=${encodeURIComponent(testPhone)}`,
    headers: { 'x-sivan-identity-link-secret': secret },
  });
  assert.equal(balanceRes.statusCode, 200);
  const balanceJson = balanceRes.json();
  const walletsAfterBalance = (balanceJson.data?.wallets || balanceJson.wallets || []);
  const dbWalletsAfterBalance = await db.listUserWallets(userId);

  assert.equal(dbWalletsAfterBalance.length, 0, 'Must have ZERO wallet rows in database after normal balance read');
  assert.equal(walletsAfterBalance.length, 0, 'Balance response must return 0 wallets for user with zero crypto intent');
  console.log('✅ Verified: Normal balance check creates ZERO wallets');

  // Step 3: Resolve target (strictly read-only)
  const resolveRes = await app.inject({
    method: 'GET',
    url: `/api/identity/resolve-target?target=${encodeURIComponent(testPhone)}&chain=solana`,
    headers: { 'x-sivan-identity-link-secret': secret },
  });
  assert.equal(resolveRes.statusCode, 200);
  const resolveJson = resolveRes.json();
  assert.equal(resolveJson.data?.found, true);
  assert.equal(resolveJson.data?.user?.targetAddress, undefined, 'targetAddress must be undefined when no wallet exists yet');

  const dbWalletsAfterResolve = await db.listUserWallets(userId);
  assert.equal(dbWalletsAfterResolve.length, 0, 'resolve-target must NOT provision any wallet');
  console.log('✅ Verified: GET /api/identity/resolve-target is strictly read-only and provisions 0 wallets');

  // Step 4: User shows intent to receive on Solana (ensureChain=solana)
  const ensureSolanaRes = await app.inject({
    method: 'GET',
    url: `/api/users/whatsapp-balance?whatsapp=${encodeURIComponent(testPhone)}&ensureChain=solana`,
    headers: { 'x-sivan-identity-link-secret': secret },
  });
  assert.equal(ensureSolanaRes.statusCode, 200);
  const solanaJson = ensureSolanaRes.json();
  const solanaWallets = solanaJson.data?.wallets || solanaJson.wallets || [];
  const dbWalletsAfterSolana = await db.listUserWallets(userId);

  assert.equal(dbWalletsAfterSolana.length, 1, 'Must have exactly 1 wallet row in database after Solana intent');
  assert.equal(dbWalletsAfterSolana[0].chain, 'solana');
  const solanaAddress = dbWalletsAfterSolana[0].address;
  assert.ok(solanaAddress, 'Solana address must be defined');
  console.log(`✅ Verified: Solana intent creates exactly ONE wallet (${solanaAddress})`);

  // Step 5: Calling ensureChain=solana again is idempotent
  const repeatSolanaRes = await app.inject({
    method: 'GET',
    url: `/api/users/whatsapp-balance?whatsapp=${encodeURIComponent(testPhone)}&ensureChain=solana`,
    headers: { 'x-sivan-identity-link-secret': secret },
  });
  assert.equal(repeatSolanaRes.statusCode, 200);
  const dbWalletsAfterRepeat = await db.listUserWallets(userId);
  assert.equal(dbWalletsAfterRepeat.length, 1, 'Repeat ensureChain call must remain idempotent (1 row)');
  assert.equal(dbWalletsAfterRepeat[0].address, solanaAddress, 'Repeat call must return the exact same address');
  console.log('✅ Verified: ensureChain call is idempotent');

  // Step 6: Target resolution now sees the existing Solana wallet
  const resolveWithSolana = await app.inject({
    method: 'GET',
    url: `/api/identity/resolve-target?target=${encodeURIComponent(testPhone)}&chain=solana`,
    headers: { 'x-sivan-identity-link-secret': secret },
  });
  assert.equal(resolveWithSolana.statusCode, 200);
  const resolveWithSolanaJson = resolveWithSolana.json();
  assert.equal(resolveWithSolanaJson.data?.user?.targetAddress, solanaAddress, 'resolve-target returns the existing address');
  console.log('✅ Verified: resolve-target successfully returns existing wallet address without creating anything new');

  // Step 7: Telegram balance-status with ensureChain=celo
  const telegramCeloRes = await app.inject({
    method: 'POST',
    url: '/api/identity/balance-status',
    headers: { 'x-sivan-identity-link-secret': secret },
    payload: {
      channel: 'whatsapp',
      identity: testPhone,
      ensureChain: 'celo',
    },
  });
  assert.equal(telegramCeloRes.statusCode, 200);
  const dbWalletsAfterCelo = await db.listUserWallets(userId);
  assert.equal(dbWalletsAfterCelo.length, 2, 'Must have exactly 2 wallets now (solana and celo)');
  const celoWallet = dbWalletsAfterCelo.find((w) => w.chain === 'celo');
  assert.ok(celoWallet?.address, 'Celo wallet must be provisioned');
  console.log(`✅ Verified: Telegram balance-status on-demand ensures Celo wallet (${celoWallet.address})`);

  console.log('🎉 ALL INTENT-DRIVEN LAZY WALLET TESTS PASSED 100% GREEN!');
  await app.close();
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

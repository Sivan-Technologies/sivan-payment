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

  // Step 4: User shows crypto intent (ensureChain=solana)
  // Under our design, crypto intent provisions BOTH Solana and the unified EVM family (celo, base, bsc, arbitrum, arc),
  // while non-EVM rails like Stellar and Starknet remain uncreated.
  const ensureSolanaRes = await app.inject({
    method: 'GET',
    url: `/api/users/whatsapp-balance?whatsapp=${encodeURIComponent(testPhone)}&ensureChain=solana`,
    headers: { 'x-sivan-identity-link-secret': secret },
  });
  assert.equal(ensureSolanaRes.statusCode, 200);
  const dbWalletsAfterSolana = await db.listUserWallets(userId);

  const solanaWallet = dbWalletsAfterSolana.find((w) => w.chain === 'solana');
  assert.ok(solanaWallet?.address, 'Solana address must be defined');

  const celoWallet = dbWalletsAfterSolana.find((w) => w.chain === 'celo');
  assert.ok(celoWallet?.address, 'Celo EVM address must be defined');

  const baseWallet = dbWalletsAfterSolana.find((w) => w.chain === 'base');
  assert.equal(baseWallet?.address, celoWallet?.address, 'Base and Celo must share the exact same EVM 0x address');

  const bscWallet = dbWalletsAfterSolana.find((w) => w.chain === 'bsc');
  assert.equal(bscWallet?.address, celoWallet?.address, 'BSC must share the exact same EVM 0x address');

  const stellarWallet = dbWalletsAfterSolana.find((w) => w.chain === 'stellar');
  assert.equal(stellarWallet, undefined, 'Stellar must NOT be created during core crypto pair provisioning');

  const starknetWallet = dbWalletsAfterSolana.find((w) => w.chain === 'starknet');
  assert.equal(starknetWallet, undefined, 'Starknet must NOT be created during core crypto pair provisioning');

  console.log(`✅ Verified: Crypto intent created Solana (${solanaWallet.address}) and Unified EVM (${celoWallet.address})`);
  console.log('✅ Verified: Non-EVM chains (Stellar, Starknet) remain 0 (untouched)');

  // Step 5: Calling ensureChain=solana again is idempotent
  const repeatSolanaRes = await app.inject({
    method: 'GET',
    url: `/api/users/whatsapp-balance?whatsapp=${encodeURIComponent(testPhone)}&ensureChain=solana`,
    headers: { 'x-sivan-identity-link-secret': secret },
  });
  assert.equal(repeatSolanaRes.statusCode, 200);
  const dbWalletsAfterRepeat = await db.listUserWallets(userId);
  assert.equal(dbWalletsAfterRepeat.length, dbWalletsAfterSolana.length, 'Repeat ensureChain call must remain idempotent');
  console.log('✅ Verified: ensureChain call is idempotent');

  // Step 6: Target resolution sees existing Solana and EVM wallets
  const resolveSolana = await app.inject({
    method: 'GET',
    url: `/api/identity/resolve-target?target=${encodeURIComponent(testPhone)}&chain=solana`,
    headers: { 'x-sivan-identity-link-secret': secret },
  });
  assert.equal(resolveSolana.statusCode, 200);
  assert.equal(resolveSolana.json().data?.user?.targetAddress, solanaWallet.address);

  const resolveCelo = await app.inject({
    method: 'GET',
    url: `/api/identity/resolve-target?target=${encodeURIComponent(testPhone)}&chain=celo`,
    headers: { 'x-sivan-identity-link-secret': secret },
  });
  assert.equal(resolveCelo.statusCode, 200);
  assert.equal(resolveCelo.json().data?.user?.targetAddress, celoWallet.address);

  const resolveBase = await app.inject({
    method: 'GET',
    url: `/api/identity/resolve-target?target=${encodeURIComponent(testPhone)}&chain=base`,
    headers: { 'x-sivan-identity-link-secret': secret },
  });
  assert.equal(resolveBase.statusCode, 200);
  assert.equal(resolveBase.json().data?.user?.targetAddress, baseWallet.address);
  console.log('✅ Verified: resolve-target successfully returns Solana, Celo, and Base addresses without creating new rows');

  // Step 7: Telegram balance-status with ensureChain=stellar provisions Stellar on demand
  const telegramStellarRes = await app.inject({
    method: 'POST',
    url: '/api/identity/balance-status',
    headers: { 'x-sivan-identity-link-secret': secret },
    payload: {
      channel: 'whatsapp',
      identity: testPhone,
      ensureChain: 'stellar',
    },
  });
  assert.equal(telegramStellarRes.statusCode, 200);
  const dbWalletsAfterStellar = await db.listUserWallets(userId);
  const userStellar = dbWalletsAfterStellar.find((w) => w.chain === 'stellar');
  assert.ok(userStellar?.address, 'Stellar wallet must be provisioned on demand');
  console.log(`✅ Verified: On-demand Stellar provisioning works independently (${userStellar.address})`);

  console.log('🎉 ALL INTENT-DRIVEN LAZY WALLET TESTS PASSED 100% GREEN!');
  await app.close();
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

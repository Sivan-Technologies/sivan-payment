import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';

/**
 * AUTOMATED MULTI-CHAIN TEST SUITE: DEVELOPER API & AI AGENT GATEWAY
 */

async function main() {
  process.env.WALLET_PROVIDER = 'mock';
  process.env.DATABASE_PROVIDER = 'json';
  process.env.DATABASE_FILE = '.data/test-developer-gateway.json';
  process.env.BRIDGE_MOCK_MODE = 'true';
  console.log('\n==================================================');
  console.log('🚀 TESTING SIVAN MULTI-CHAIN DEVELOPER GATEWAY');
  console.log('==================================================\n');

  let passed = 0;
  let failed = 0;

  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });

  for (const u of [
    { id: 'usr_dev_test_agent', email: 'dev_agent@sivan.test', fullName: 'Dev Test Agent' },
    { id: 'usr_agent_buyer', email: 'agent_buyer@sivan.test', fullName: 'Agent Buyer' },
    { id: 'usr_freelancer_seller', email: 'freelancer_seller@sivan.test', fullName: 'Freelancer Seller' },
  ]) {
    await db.insertUserRecord({
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      primaryChannel: 'email',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve test server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  function recordPass(desc: string) {
    console.log(`  ✅ ok - ${desc}`);
    passed++;
  }

  function recordFail(desc: string, err: any) {
    console.error(`  ❌ FAIL - ${desc}`);
    console.error(`     Error: ${err.message}`);
    failed++;
  }

  try {
    // 1. Health Probe
    console.log('══ 1. Public Gateway Health & Multi-Chain Capability ══');
    const healthRes = await fetch(`${baseUrl}/api/v1/developer/health`);
    assert.equal(healthRes.status, 200);
    const healthBody: any = await healthRes.json();
    assert.equal(healthBody.status, 'healthy');
    assert.ok(healthBody.supportedChains.includes('stellar'));
    assert.ok(healthBody.supportedChains.includes('celo'));
    assert.ok(healthBody.supportedChains.includes('solana'));
    recordPass('public health probe returns supported chains list');

    // 2. Authentication Enforcement
    console.log('\n══ 2. API Key Authentication & Security Boundary ══');
    const unauthedRes = await fetch(`${baseUrl}/api/v1/developer/transfers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'usr_test_1',
        destinationAddress: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        network: 'stellar',
        amount: 25,
      }),
    });
    assert.equal(unauthedRes.status, 401);
    recordPass('rejects request with missing X-Sivan-Api-Key');

    const badKeyRes = await fetch(`${baseUrl}/api/v1/developer/transfers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sivan-api-key': 'invalid_secret_key_123',
      },
      body: JSON.stringify({
        userId: 'usr_test_1',
        destinationAddress: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        network: 'stellar',
        amount: 25,
      }),
    });
    assert.equal(badKeyRes.status, 401);
    recordPass('rejects request with unrecognized API key');

    // 3. Programmatic Stellar Transfer
    console.log('\n══ 3. Programmatic Multi-Chain Execution ══');
    const devKey = 'sk_test_sivan_developer_default';

    const stellarTransferRes = await fetch(`${baseUrl}/api/v1/developer/transfers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sivan-api-key': devKey,
        'x-idempotency-key': `idem_stl_${Date.now()}`,
      },
      body: JSON.stringify({
        userId: 'usr_dev_test_agent',
        destinationAddress: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        network: 'stellar',
        asset: 'usdc',
        amount: 25.0,
        memo: 'Agent task #101',
      }),
    });
    assert.equal(stellarTransferRes.status, 200);
    const stellarBody: any = await stellarTransferRes.json();
    assert.equal(stellarBody.success, true);
    assert.equal(stellarBody.network, 'stellar');
    assert.equal(stellarBody.feeSponsored, true);
    assert.ok(stellarBody.explorerUrl.includes('stellar.expert'));
    recordPass('executes programmatic Stellar transfer with CAP-0015 fee sponsorship');

    // 4. Programmatic Celo Transfer
    const celoTransferRes = await fetch(`${baseUrl}/api/v1/developer/transfers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sivan-api-key': devKey,
      },
      body: JSON.stringify({
        userId: 'usr_dev_test_agent',
        destinationAddress: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
        network: 'celo',
        asset: 'usdc',
        amount: 30.0,
      }),
    });
    assert.equal(celoTransferRes.status, 200);
    const celoBody: any = await celoTransferRes.json();
    assert.equal(celoBody.success, true);
    assert.equal(celoBody.network, 'celo');
    assert.ok(celoBody.explorerUrl.includes('celoscan.io'));
    recordPass('executes programmatic Celo transfer');

    // 5. Programmatic Solana Transfer
    const solanaTransferRes = await fetch(`${baseUrl}/api/v1/developer/transfers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sivan-api-key': devKey,
      },
      body: JSON.stringify({
        userId: 'usr_dev_test_agent',
        destinationAddress: '7v91N7iZ9mNicL8WfG6DmSA4Fphk4B3U7nZ3VfF7pQZ1',
        network: 'solana',
        asset: 'usdc',
        amount: 20.0,
      }),
    });
    assert.equal(solanaTransferRes.status, 200);
    const solanaBody: any = await solanaTransferRes.json();
    assert.equal(solanaBody.success, true);
    assert.equal(solanaBody.network, 'solana');
    assert.ok(solanaBody.explorerUrl.includes('solscan.io'));
    recordPass('executes programmatic Solana transfer');

    // 6. Programmatic Base Transfer
    const baseTransferRes = await fetch(`${baseUrl}/api/v1/developer/transfers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sivan-api-key': devKey,
      },
      body: JSON.stringify({
        userId: 'usr_dev_test_agent',
        destinationAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        network: 'base',
        asset: 'usdc',
        amount: 15.0,
      }),
    });
    assert.equal(baseTransferRes.status, 200);
    const baseBody: any = await baseTransferRes.json();
    assert.equal(baseBody.success, true);
    assert.equal(baseBody.network, 'base');
    assert.ok(baseBody.explorerUrl.includes('etherscan.io'));
    recordPass('executes programmatic Base EVM transfer');

    // 7. Programmatic Service Agreement Creation
    console.log('\n══ 4. AI Agent Service Agreement Lifecycle ══');
    const agreementRes = await fetch(`${baseUrl}/api/v1/developer/agreements`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sivan-api-key': devKey,
      },
      body: JSON.stringify({
        title: 'Dataset Classification Task',
        buyerUserId: 'usr_agent_buyer',
        sellerUserId: 'usr_freelancer_seller',
        network: 'stellar',
        amount: 25.0,
      }),
    });
    assert.equal(agreementRes.status, 201);
    const agreementBody: any = await agreementRes.json();
    assert.equal(agreementBody.success, true);
    assert.equal(agreementBody.status, 'PENDING_PAYMENT');
    assert.ok(agreementBody.agreementId.startsWith('SIV-'));
    assert.ok(agreementBody.paymentInstruction.depositAddress);
    recordPass('creates programmatic service agreement on Stellar');

    // 6. Programmatic Settlement
    const settleRes = await fetch(`${baseUrl}/api/v1/developer/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sivan-api-key': devKey,
      },
      body: JSON.stringify({
        agreementId: agreementBody.agreementId,
        actor: 'usr_agent_buyer',
        releaseNotes: 'Agent verified task quality',
      }),
    });
    assert.equal(settleRes.status, 200);
    const settleBody: any = await settleRes.json();
    assert.equal(settleBody.success, true);
    assert.equal(settleBody.status, 'RELEASED');
    recordPass('settles service agreement with fee deduction receipt');

    // 7. Unified Spendable Balance Query
    console.log('\n══ 5. Unified Agent Treasury Balance Query ══');
    const balanceRes = await fetch(`${baseUrl}/api/v1/developer/balance/usr_dev_test_agent`, {
      headers: {
        'x-sivan-api-key': devKey,
      },
    });
    assert.equal(balanceRes.status, 200);
    const balanceBody: any = await balanceRes.json();
    assert.equal(balanceBody.userId, 'usr_dev_test_agent');
    assert.equal(balanceBody.currency, 'USD');
    recordPass('returns unified spendable multi-chain balance');

  } catch (err: any) {
    recordFail('developer gateway suite error', err);
  } finally {
    await app.close();
  }

  console.log('\n==================================================');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('==================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

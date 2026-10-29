import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { db } from '../src/database/json-database.js';
import { getUserNgnBalance } from '../src/ngn/service/sivanUtilityService.js';

async function runSimulateInflowTest() {
  console.log('--- Starting Inflow Simulation Route Test ---');
  const app = await buildApp();
  await app.ready();

  const testUserId = `sim_user_${Date.now()}`;
  const now = new Date().toISOString();

  await db.insertUserRecord({
    id: testUserId,
    email: `${testUserId}@sivan.test`,
    fullName: 'Simulate User',
    primaryChannel: 'email',
    createdAt: now,
    updatedAt: now,
  });

  const customerId = `CUS_sim_${Date.now()}`;
  await db.upsertVirtualAccountRecord({
    id: `va_${testUserId}`,
    userId: testUserId,
    provider: 'paystack',
    providerAccountId: `act_${testUserId}`,
    currency: 'ngn',
    country: 'NG',
    bankName: 'Wema Bank',
    accountName: 'Sivan / Simulate User',
    accountNumberMasked: '****5678',
    status: 'active',
    customerId,
    createdAt: now,
    updatedAt: now,
  });

  // 1. Initial NGN balance should be 0
  const initialBal = await getUserNgnBalance(testUserId);
  assert.equal(initialBal, 0, 'Initial NGN balance is 0');

  // 2. Call simulate inflow
  const simRes = await app.inject({
    method: 'POST',
    url: '/api/virtual-accounts/sandbox/simulate-inflow',
    payload: {
      userId: testUserId,
      amount: 50000,
    },
  });

  assert.equal(simRes.statusCode, 200, `Simulate inflow succeeded: ${simRes.body}`);
  const simJson = simRes.json();
  assert.equal(simJson.status, 'success');
  assert.equal(simJson.simulation, true);
  assert.equal(simJson.mode, 'sandbox');
  assert.equal(simJson.environment, 'staging');
  assert.equal(simJson.webhookResult.status, 'processed');

  // 3. User NGN balance should now be credited
  const postBal = await getUserNgnBalance(testUserId);
  assert.ok(postBal > 0, `User balance credited: ${postBal} NGN`);
  console.log(`✅ Verified: Simulation route credited ${postBal} NGN (net of platform fee)`);

  // 4. Production guard check: When APP_ENV === 'production', route must be blocked with 403
  process.env.APP_ENV = 'production';
  const prodRes = await app.inject({
    method: 'POST',
    url: '/api/virtual-accounts/sandbox/simulate-inflow',
    payload: {
      userId: testUserId,
      amount: 50000,
    },
  });
  assert.equal(prodRes.statusCode, 403, 'Simulation route blocked with 403 in production');
  delete process.env.APP_ENV;
  console.log('✅ Verified: Strict 403 Forbidden production guard in place');

  console.log('🎉 ALL INFLOW SIMULATION ROUTE CHECKS PASSED 100%!');
  await app.close();
}

runSimulateInflowTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

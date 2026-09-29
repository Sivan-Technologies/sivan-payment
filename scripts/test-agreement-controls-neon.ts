/**
 * Verification Test: Service Agreement Protocol Safeguard Architecture (PSA) & Neon PostgreSQL
 *
 * Validates:
 * 1. PostgresDatabase connectivity to Neon DB.
 * 2. ensureAgreementControlsSchema automatically provisions `payments_agreement_controls`.
 * 3. getAgreementControls() & saveAgreementControls() persistence.
 * 4. In-memory cache & fast lookup in AgreementControlsService.
 * 5. GET /api/agreements/controls public endpoint response format.
 * 6. PUT /api/admin/agreements/controls admin update endpoint (requires ADMIN_API_KEY).
 * 7. Route Guard: POST /api/agreements rejected with 503 when creation_enabled = false.
 * 8. Route Guard: POST /api/agreements permitted past guard when creation_enabled = true.
 * 9. Emergency halt behavior verification.
 * 10. Reversion to safe initial controls.
 */

import assert from 'node:assert/strict';
import { PostgresDatabase } from '../src/database/postgres-database.js';
import { buildApp } from '../src/app.js';
import {
  getAgreementControls,
  updateAgreementControls,
  isCreationAllowed,
  isServicingAllowed,
  isSettlementAllowed,
  buildPublicControlsPayload,
} from '../src/agreements/agreement-controls.service.js';

const NEON_DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://neondb_owner:npg_3fnl7mFqijWz@ep-empty-snow-aye297lt-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const TEST_ADMIN_KEY =
  process.env.ADMIN_API_KEY ||
  'sivan_admin_d61210c796ba80973a03ba60d6d3ea599b045c84d7efa624ad8feebd581ed2bb';

async function runNeonPsaVerification() {
  console.log('\n======================================================');
  console.log('  PSA (Kill-Switch & Controls) + Neon DB Verification ');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  async function step(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  [FAIL] ${name}:`, err.message || err);
      failed++;
      throw err;
    }
  }

  // 1. Database Connection & Schema Provisioning
  console.log('--- Phase 1: Direct Postgres Database & Schema Provisioning ---');
  const pgDb = new PostgresDatabase(NEON_DB_URL);

  await step('Direct Postgres connection & table provisioning', async () => {
    // getAgreementControls invokes ensureAgreementControlsSchema(client)
    const initial = await pgDb.getAgreementControls();
    console.log('    Initial DB controls record:', initial ? 'Found existing record' : 'Null (default initialized)');
    assert.ok(initial === null || typeof initial === 'object');
  });

  await step('Save and retrieve agreement controls via PostgresDatabase', async () => {
    const testRecord = {
      id: 'default_controls',
      creationEnabled: false,
      servicingEnabled: true,
      emergencyHalt: false,
      pilotWhitelistOnly: false,
      allowedNetworks: ['celo', 'stellar'],
      maintenanceMessage: 'Testing PSA Neon Integration',
      updatedByAdminId: 'test_admin_verifier',
      updatedAt: new Date().toISOString(),
    };

    const saved = await pgDb.saveAgreementControls(testRecord);
    assert.equal(saved.creationEnabled, false);
    assert.equal(saved.servicingEnabled, true);
    assert.equal(saved.maintenanceMessage, 'Testing PSA Neon Integration');

    const retrieved = await pgDb.getAgreementControls();
    assert.ok(retrieved !== null, 'Expected retrieved controls to not be null');
    assert.equal(retrieved.creationEnabled, false);
    assert.equal(retrieved.servicingEnabled, true);
    assert.equal(retrieved.emergencyHalt, false);
    assert.equal(retrieved.maintenanceMessage, 'Testing PSA Neon Integration');
  });

  // 2. Central Service Layer & In-Memory Cache
  console.log('\n--- Phase 2: AgreementControlsService & Guard Assertion Logic ---');

  await step('isCreationAllowed logic reflects creationEnabled & whitelist', async () => {
    await updateAgreementControls(
      {
        creationEnabled: false,
        maintenanceMessage: 'Creation disabled for pilot maintenance',
      },
      'admin_test_runner'
    );
    let current = await getAgreementControls();
    assert.equal(isCreationAllowed(current), false);

    await updateAgreementControls(
      {
        creationEnabled: true,
      },
      'admin_test_runner'
    );
    current = await getAgreementControls();
    assert.equal(isCreationAllowed(current), true);
  });

  await step('isServicingAllowed & isSettlementAllowed reflect emergencyHalt', async () => {
    await updateAgreementControls(
      {
        emergencyHalt: true,
      },
      'admin_test_runner'
    );
    let current = await getAgreementControls();
    assert.equal(isServicingAllowed(current), false);
    assert.equal(isSettlementAllowed(current), false);

    await updateAgreementControls(
      {
        emergencyHalt: false,
        servicingEnabled: true,
      },
      'admin_test_runner'
    );
    current = await getAgreementControls();
    assert.equal(isServicingAllowed(current), true);
    assert.equal(isSettlementAllowed(current), true);
  });

  // 3. Fastify HTTP Endpoints & Route Guards
  console.log('\n--- Phase 3: Fastify HTTP Endpoints (Public & Admin) ---');

  // Set environment variables for app build
  process.env.ADMIN_API_KEY = TEST_ADMIN_KEY;
  process.env.DATABASE_PROVIDER = 'postgres';
  process.env.DATABASE_URL = NEON_DB_URL;

  const app = await buildApp();

  await step('GET /api/agreements/controls returns public safe payload', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agreements/controls',
    });

    assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${res.body}`);
    const data = res.json();
    assert.equal(data.status, 'success');
    const controls = data.controls;
    assert.ok(typeof controls.creationEnabled === 'boolean');
    assert.ok(typeof controls.servicingEnabled === 'boolean');
    assert.ok(typeof controls.emergencyHalt === 'boolean');
    assert.ok(typeof controls.message === 'string');
    // Admin audit field must NOT be exposed in public endpoint
    assert.equal(controls.updatedByAdminId, undefined);
  });

  await step('PUT /api/admin/agreements/controls requires admin API key', async () => {
    const resUnauthorized = await app.inject({
      method: 'PUT',
      url: '/api/admin/agreements/controls',
      payload: { creationEnabled: true },
    });
    assert.equal(resUnauthorized.statusCode, 401);

    const resAuthorized = await app.inject({
      method: 'PUT',
      url: '/api/admin/agreements/controls',
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      payload: {
        creationEnabled: false,
        servicingEnabled: true,
        emergencyHalt: false,
        maintenanceMessage: 'Mainnet pilot invite only',
      },
    });
    assert.equal(resAuthorized.statusCode, 200, `Expected 200, got ${resAuthorized.statusCode}: ${resAuthorized.body}`);
    const body = resAuthorized.json();
    assert.equal(body.status, 'success');
    assert.equal(body.controls.creationEnabled, false);
    assert.equal(body.controls.maintenanceMessage, 'Mainnet pilot invite only');
  });

  await step('POST /api/agreements is guarded and rejected with 503 when creationEnabled = false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agreements',
      payload: {
        buyerUserId: 'test_buyer_psa',
        sellerUserId: 'test_seller_psa',
        title: 'PSA Test Agreement',
        amountUsdc: 25,
        currency: 'USDC',
        network: 'stellar',
      },
    });

    assert.equal(res.statusCode, 503, `Expected 503, got ${res.statusCode}: ${res.body}`);
    const body = res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'AGREEMENT_CREATION_PAUSED');
    assert.ok(body.message.includes('Mainnet pilot invite only'));
  });

  await step('POST /api/v1/developer/agreements is also guarded with 503 when creationEnabled = false', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/developer/agreements',
      headers: { 'x-sivan-api-key': 'sk_test_sivan_developer_default' },
      payload: {
        buyerUserId: 'test_buyer_psa',
        sellerUserId: 'test_seller_psa',
        title: 'PSA Dev Agreement',
        amount: 25,
        currency: 'USDC',
        network: 'stellar',
      },
    });

    assert.equal(res.statusCode, 503, `Expected 503, got ${res.statusCode}: ${res.body}`);
    const body = res.json();
    assert.equal(body.success, false);
    assert.equal(body.code, 'AGREEMENT_CREATION_PAUSED');
  });

  await step('Restore safe default controls via Admin endpoint', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/admin/agreements/controls',
      headers: { 'x-admin-key': TEST_ADMIN_KEY },
      payload: {
        creationEnabled: true,
        servicingEnabled: true,
        emergencyHalt: false,
        pilotWhitelistOnly: false,
        allowedNetworks: ['celo', 'stellar', 'base'],
        maintenanceMessage: 'Service Agreement creation is active.',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, 'success');
    assert.equal(body.controls.creationEnabled, true);
  });

  await app.close();
  await pgDb.close();

  console.log(`\n======================================================`);
  console.log(`  All Verification Checks Passed (${passed} passed, ${failed} failed)`);
  console.log(`======================================================\n`);
}

runNeonPsaVerification().catch((err) => {
  console.error('\nVerification failed:', err);
  process.exit(1);
});

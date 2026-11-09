/**
 * End-to-End Test Suite for Developer API Portal and Multi-Tenant Key Management.
 *
 * Verifies:
 * 1. Cryptographic key issuance (one-time reveal, SHA-256 hash).
 * 2. Scope-based endpoint authorization.
 * 3. Monthly request quota enforcement.
 * 4. Immediate key revocation.
 * 5. Usage logging and analytics aggregation.
 * 6. Fastify middleware integration via requireDeveloperApiKey.
 * 7. Admin CRUD routes.
 */

import { buildApp } from '../src/app.js';
import { db } from '../src/database/json-database.js';
import { developerKeysService } from '../src/developer-gateway/developer-keys.service.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function run() {
  console.log('\n--- 1. Developer Key Generation and Lifecycle ---');
  await db.mutate((data) => {
    data.developerApiKeys = [];
    data.developerUsageLogs = [];
  });

  const { record, secretKey } = await developerKeysService.issueKey({
    developerName: 'Jonathan Partner Test',
    email: 'jonathan@partner.org',
    organization: 'FinTech Logistics',
    environment: 'live',
    permittedEndpoints: ['all'],
    monthlyLimit: 1000,
  });

  check('secret key has sk_live_sivan_ prefix', secretKey.startsWith('sk_live_sivan_'), secretKey);
  check('key prefix is stored accurately', record.keyPrefix === secretKey.slice(0, 20));
  check('masked key hides middle secret bytes', record.maskedKey.includes('...'));
  check('raw secret key is NOT stored in record', !record.keyHash.includes(secretKey));
  check('record status is active', record.status === 'active');

  console.log('\n--- 2. Key Authentication & Quota Enforcement ---');
  const authSuccess = await developerKeysService.authenticateKey(secretKey, '/api/v1/developer/transfers');
  check('valid secret key authenticates successfully', authSuccess.valid === true);
  check('developer name is returned in auth result', authSuccess.record?.developerName === 'Jonathan Partner Test');

  // Test bad key
  const authBad = await developerKeysService.authenticateKey('sk_live_sivan_invalid_key_123456');
  check('invalid secret key is rejected', authBad.valid === false);

  // Test scoped permissions
  const scopedKey = await developerKeysService.issueKey({
    developerName: 'Transfers Only Bot',
    email: 'bot@transfers.com',
    environment: 'live',
    permittedEndpoints: ['/api/v1/developer/transfers'],
    monthlyLimit: 5,
  });

  const allowedEndpoint = await developerKeysService.authenticateKey(scopedKey.secretKey, '/api/v1/developer/transfers');
  check('scoped key allows permitted endpoint', allowedEndpoint.valid === true);

  const blockedEndpoint = await developerKeysService.authenticateKey(scopedKey.secretKey, '/api/v1/developer/settle');
  check('scoped key blocks unauthorized endpoint', blockedEndpoint.valid === false);

  // Test quota enforcement
  const quotaKey = await developerKeysService.issueKey({
    developerName: 'Quota Limited Agent',
    email: 'quota@agent.com',
    environment: 'sandbox',
    monthlyLimit: 2,
  });

  const q1 = await developerKeysService.authenticateKey(quotaKey.secretKey);
  const q2 = await developerKeysService.authenticateKey(quotaKey.secretKey);
  const q3 = await developerKeysService.authenticateKey(quotaKey.secretKey);
  check('1st request passes quota', q1.valid === true);
  check('2nd request passes quota', q2.valid === true);
  check('3rd request exceeds quota and is rejected', q3.valid === false && q3.reason?.includes('quota'));

  console.log('\n--- 3. Immediate Key Revocation ---');
  const revokeSuccess = await developerKeysService.revokeKey(scopedKey.record.id, 'Compliance test revoke');
  check('revokeKey returns true', revokeSuccess === true);

  const authRevoked = await developerKeysService.authenticateKey(scopedKey.secretKey);
  check('revoked key is immediately refused', authRevoked.valid === false && authRevoked.reason?.includes('revoked'));

  console.log('\n--- 4. Request Logging and Analytics ---');
  await developerKeysService.recordUsageLog({
    keyId: record.id,
    endpoint: '/api/v1/developer/transfers',
    method: 'POST',
    statusCode: 200,
    latencyMs: 38,
    ipAddress: '127.0.0.1',
  });

  await developerKeysService.recordUsageLog({
    keyId: record.id,
    endpoint: '/api/v1/developer/transfers',
    method: 'POST',
    statusCode: 400,
    latencyMs: 15,
    ipAddress: '127.0.0.1',
  });

  const analytics = await developerKeysService.getAnalytics();
  check('analytics reports total keys', analytics.totalKeys >= 3);
  check('analytics reports active keys', analytics.activeKeys >= 2);
  check('analytics reports revoked keys', analytics.revokedKeys >= 1);
  check('analytics reports top endpoints', analytics.topEndpoints.some((e) => e.endpoint === '/api/v1/developer/transfers'));

  console.log('\n--- 5. Fastify End-to-End Route Integration ---');
  const app = await buildApp();

  // Test Admin List Keys
  const listRes = await app.inject({
    method: 'GET',
    url: '/api/admin/developer-keys',
    headers: { 'x-admin-api-key': process.env.ADMIN_API_KEY || 'test-admin-key' },
  });
  check('GET /api/admin/developer-keys returns 200', listRes.statusCode === 200);
  const listJson = JSON.parse(listRes.body);
  check('list response contains keys array', Array.isArray(listJson.keys) && listJson.keys.length >= 3);

  // Test Admin Issue Key via HTTP
  const issueRes = await app.inject({
    method: 'POST',
    url: '/api/admin/developer-keys',
    headers: {
      'x-admin-api-key': process.env.ADMIN_API_KEY || 'test-admin-key',
      'content-type': 'application/json',
    },
    payload: JSON.stringify({
      developerName: 'HTTP Issued Client',
      email: 'client@http.io',
      environment: 'live',
      permittedEndpoints: ['all'],
      monthlyLimit: 5000,
    }),
  });
  check('POST /api/admin/developer-keys returns 201', issueRes.statusCode === 201);
  const issueJson = JSON.parse(issueRes.body);
  check('HTTP issue returns secretKey once', typeof issueJson.secretKey === 'string' && issueJson.secretKey.startsWith('sk_live_sivan_'));

  // Test Developer Gateway endpoint with newly issued key
  const gatewayRes = await app.inject({
    method: 'GET',
    url: '/api/v1/developer/balance/u_test',
    headers: {
      'x-sivan-api-key': issueJson.secretKey,
    },
  });
  check('GET /api/v1/developer/balance/:userId with issued key returns 200', gatewayRes.statusCode === 200);

  // Test Admin Revoke via HTTP
  const revokeRes = await app.inject({
    method: 'POST',
    url: `/api/admin/developer-keys/${issueJson.key.id}/revoke`,
    headers: {
      'x-admin-api-key': process.env.ADMIN_API_KEY || 'test-admin-key',
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ reason: 'Admin revoked test' }),
  });
  check('POST /api/admin/developer-keys/:id/revoke returns 200', revokeRes.statusCode === 200);

  // Test Developer Gateway refusal after revocation
  const gatewayRefusedRes = await app.inject({
    method: 'GET',
    url: '/api/v1/developer/balance/u_test',
    headers: {
      'x-sivan-api-key': issueJson.secretKey,
    },
  });
  check('Gateway refuses revoked key with 401', gatewayRefusedRes.statusCode === 401);

  // Test Analytics via HTTP
  const analyticsRes = await app.inject({
    method: 'GET',
    url: '/api/admin/developer-analytics',
    headers: { 'x-admin-api-key': process.env.ADMIN_API_KEY || 'test-admin-key' },
  });
  check('GET /api/admin/developer-analytics returns 200', analyticsRes.statusCode === 200);

  console.log(`\n========================================`);
  console.log(`RESULTS: ${pass} passed, ${fail} failed.`);
  console.log(`========================================\n`);

  await app.close();
  if (fail > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal error during test:', err);
  process.exit(1);
});

import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { signUserJwt } from '../src/auth/jwt.js';
import { db } from '../src/database/json-database.js';

const now = new Date().toISOString();
await db.mutate((data) => {
  data.users = [{ id: 'usr_kyc_ngn', email: 'kyc-ngn@sivan.test', fullName: 'John Doe', createdAt: now, updatedAt: now } as any];
  data.customers = [];
});

const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
const token = signUserJwt({ userId: 'usr_kyc_ngn', email: 'kyc-ngn@sivan.test' });
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
const adminHeaders = { 'x-admin-api-key': process.env.ADMIN_API_KEY || 'kyc-admin-key' };

async function req(path: string, options: any = {}, expected = 200) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const json = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${path} expected ${expected}, got ${response.status}: ${JSON.stringify(json)}`);
  return json.data ?? json;
}

try {
  const health = await req('/api/admin/kyc/ngn/provider-health', { headers: adminHeaders });
  assert.equal(health.provider, 'mock');
  assert.equal(health.available, true);
  console.log('✓ NGN KYC provider health works');

  const level2 = await req('/api/users/usr_kyc_ngn/kyc/ngn-bvn/verify', {
    method: 'POST',
    headers,
    body: JSON.stringify({ bvn: '12345678901', firstName: 'John', lastName: 'Doe', dateOfBirth: '31-12-1990', mobileNo: '08012345678' })
  });
  assert.equal(level2.status, 'matched');
  assert.equal(level2.level, 'ngn_level_2');
  assert.equal(level2.bvnLast4, '8901');
  assert.equal(JSON.stringify(level2).includes('12345678901'), false);
  console.log('✓ Level 2 BVN information match returns customer-safe result');

  const missingBvn = await req('/api/users/usr_kyc_ngn/kyc/ngn-bvn/verify', {
    method: 'POST',
    headers,
    body: JSON.stringify({ bvn: '1234', firstName: 'John', lastName: 'Doe', dateOfBirth: '31-12-1990', mobileNo: '08012345678' })
  }, 400);
  assert.ok(JSON.stringify(missingBvn).includes('BVN must be 11 digits'));
  console.log('✓ Level 2 BVN input validation is enforced');


  await app.close();
  console.log(JSON.stringify({ ok: true, level2: level2.status, level2b: 'deferred' }, null, 2));
} catch (error) {
  await app.close();
  throw error;
}

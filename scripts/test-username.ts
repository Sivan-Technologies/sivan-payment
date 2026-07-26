import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let token = '';
  async function request(method: string, url: string, body?: unknown, expectedStatus = 200) {
    const res = await fetch(`${baseUrl}${url}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.status !== expectedStatus) throw new Error(`${method} ${url} expected ${expectedStatus} got ${res.status}: ${JSON.stringify(json)}`);
    return (json.data ?? json) as any;
  }
  async function signup(name: string) {
    const email = `${name}-${Date.now()}@sivan.test`;
    const start = await request('POST', '/api/auth/email/start', { email, fullName: name.replaceAll('-', ' '), intent: 'signup', legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' } });
    const verified = await request('POST', '/api/auth/email/verify', { email, code: start.devCode });
    return verified;
  }
  try {
    const first = await signup('username-one');
    token = first.token;
    const user = first.user;
    const setOne = await request('PUT', `/api/users/${user.id}/username`, { username: 'Sivan_User_01' });
    assert(setOne.username === 'sivan_user_01', 'username normalizes and saves');
    const availableOwn = await request('GET', `/api/users/${user.id}/username/availability?username=sivan_user_01`);
    assert(availableOwn.ownerIsCurrentUser === true, 'own username is recognized');
    const changed = await request('PUT', `/api/users/${user.id}/username`, { username: 'sivan_user_02' });
    assert(changed.username === 'sivan_user_02', 'unverified user can change username');
    await request('PUT', `/api/users/${user.id}/username`, { username: 'admin' }, 400);
    assert(true, 'reserved username is blocked');

    const second = await signup('username-two');
    token = second.token;
    await request('GET', `/api/users/${second.user.id}/username/availability?username=sivan_user_02`);
    await request('PUT', `/api/users/${second.user.id}/username`, { username: 'sivan_user_02' }, 409);
    assert(true, 'duplicate username is blocked');

    await request('POST', '/api/customers/kyc-link', { userId: second.user.id, type: 'individual' }, 201);
    const verifiedFirstUsername = await request('PUT', `/api/users/${second.user.id}/username`, { username: 'verified_user' });
    assert(verifiedFirstUsername.username === 'verified_user', 'verified user can set first username');
    await request('PUT', `/api/users/${second.user.id}/username`, { username: 'verified_user_2' }, 403);
    assert(true, 'verified username changes are locked');

    await app.close();
    console.log('\n✅ Username E2E passed');
  } catch (error) { await app.close(); throw error; }
}
function assert(condition: unknown, message: string) { if (!condition) throw new Error(`Assertion failed: ${message}`); console.log(`✓ ${message}`); }
main().catch((error) => { console.error(error); process.exit(1); });

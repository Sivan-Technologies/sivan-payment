import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

const legalAcceptance = {
  accepted: true,
  termsVersion: '2026-07-14',
  privacyVersion: '2026-07-14',
  riskDisclosureVersion: '2026-07-14'
};

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve test server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let token = '';

  async function request(method: string, url: string, body?: unknown, expect = 200) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.status !== expect) throw new Error(`${method} ${url} expected ${expect}, got ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  try {
    const blockedEmail = `legal-blocked+${Date.now()}@sivan.test`;
    await request('POST', '/api/auth/email/start', { email: blockedEmail, fullName: 'Blocked User', intent: 'signup' }, 400);
    console.log('✓ signup OTP start requires legal acceptance');

    await request('POST', '/api/users', { email: `direct-blocked+${Date.now()}@sivan.test`, fullName: 'Direct Blocked' }, 400);
    console.log('✓ direct user creation requires legal acceptance');

    const email = `legal+${Date.now()}@sivan.test`;
    const started = await request('POST', '/api/auth/email/start', { email, fullName: 'Legal User', intent: 'signup', legalAcceptance });
    console.log('✓ signup OTP start accepts versioned legal payload');

    const verified = await request('POST', '/api/auth/email/verify', { email, code: started.data.devCode });
    token = verified.data.token;
    const user = verified.data.user;
    console.log('✓ signup verification creates user');

    const acceptances = await request('GET', `/api/users/${user.id}/legal-acceptances`);
    assert(Array.isArray(acceptances.data) && acceptances.data.length === 1, 'one legal acceptance row stored');
    const acceptance = acceptances.data[0];
    assert(acceptance.termsVersion === legalAcceptance.termsVersion, 'terms version stored');
    assert(acceptance.privacyVersion === legalAcceptance.privacyVersion, 'privacy version stored');
    assert(acceptance.riskDisclosureVersion === legalAcceptance.riskDisclosureVersion, 'risk disclosure version stored');
    assert(Boolean(acceptance.acceptedAt), 'acceptedAt stored');
    assert(Boolean(acceptance.ipAddress), 'IP address stored');
    assert(acceptance.source === 'signup', 'source stored as signup');

    await app.close();
    console.log('\n✅ Legal acceptance E2E passed');
    console.log(JSON.stringify({ userId: user.id, acceptanceId: acceptance.id }, null, 2));
  } catch (error) {
    await app.close();
    throw error;
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

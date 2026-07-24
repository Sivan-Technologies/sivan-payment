import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

async function main() {
  const bridge = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v0/kyc_links') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'invalid_request', message: 'sandbox Bridge rejected this KYC request' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'not_found' }));
  });

  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const address = bridge.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve fake Bridge address');

  process.env.BRIDGE_MOCK_MODE = 'false';
  process.env.BRIDGE_API_KEY = 'bridge-sandbox-test-key';
  process.env.BRIDGE_BASE_URL = `http://127.0.0.1:${address.port}/v0`;
  process.env.DATABASE_PROVIDER = process.env.DATABASE_PROVIDER || 'json';
  process.env.DATABASE_FILE = process.env.DATABASE_FILE || '.data/test-bridge-kyc-no-mock-fallback.json';
  process.env.EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'console';
  process.env.SUPPORT_UPLOAD_PROVIDER = process.env.SUPPORT_UPLOAD_PROVIDER || 'mock';

  const { buildApp } = await import('../src/app.js');
  const { env } = await import('../src/config/env.js');

  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const appAddress = app.server.address();
  if (!appAddress || typeof appAddress === 'string') throw new Error('Could not resolve app address');
  const baseUrl = `http://127.0.0.1:${appAddress.port}`;
  let token = '';

  async function request(method: string, url: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  }

  try {
    const email = `bridge-no-mock-${Date.now()}@sivan.test`;
    const started: any = await request('POST', '/api/auth/email/start', {
      email,
      fullName: 'Bridge Only User',
      intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' }
    });
    assert(started.res.status === 200, 'signup OTP starts');

    const verified: any = await request('POST', '/api/auth/email/verify', { email, code: started.json.data.devCode });
    assert(verified.res.status === 200, 'signup OTP verifies');
    token = verified.json.data.token;
    const user = verified.json.data.user;

    const kyc = await request('POST', '/api/customers/kyc-link', {
      userId: user.id,
      type: 'individual',
      redirectUri: 'https://app.sivan.test/verification-complete'
    });
    assert(kyc.res.status === 400, 'Bridge sandbox KYC errors are returned instead of mock-approving the user');
    assert(kyc.json?.error?.code === 'bridge_api_error', 'Bridge error code is preserved for ops/debugging');

    const customer = await request('GET', `/api/customers/${user.id}`);
    assert(customer.res.status === 200, 'customer empty state remains readable');
    assert(customer.json.data === null, 'no mock customer record is created after Bridge KYC failure');

    console.log('\n✅ Bridge-only KYC no-mock-fallback test passed');
  } finally {
    await app.close();
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
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

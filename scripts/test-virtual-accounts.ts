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
  let authToken = '';

  async function request<T>(method: string, url: string, body?: unknown, headers: Record<string,string> = {}): Promise<T> {
    const res = await fetch(`${baseUrl}${url}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(json)}`);
    return (json.data ?? json) as T;
  }

  try {
    await request('GET', '/health');
    const email = `virtual-account+${Date.now()}@sivan.test`;
    const started: any = await request('POST', '/api/auth/email/start', { email, fullName: 'Virtual Account User', intent: 'signup', legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' } });
    const verified: any = await request('POST', '/api/auth/email/verify', { email, code: started.devCode });
    authToken = verified.token;
    const user = verified.user;
    const customer: any = await request('POST', '/api/customers/kyc-link', { userId: user.id, type: 'individual', redirectUri: 'https://app.sivan.test/kyc/complete' });
    assert(customer.kycStatus === 'kyc_approved', 'test user is KYC approved');

    const requested: any = await request('POST', `/api/users/${user.id}/virtual-accounts/request`, { currency: 'usd', useCase: 'Test USD funding account' });
    assert(requested.status === 'requested', 'user can request virtual account when request flag is enabled');
    assert(requested.currency === 'usd', 'request stores currency');

    const requests: any[] = await request('GET', '/api/admin/virtual-account-requests', undefined, { 'x-admin-api-key': 'virtual-account-test-admin-key' });
    assert(requests.some((item) => item.id === requested.id), 'admin can list virtual account requests');

    const approved: any = await request('POST', `/api/admin/virtual-account-requests/${requested.id}/approve`, {}, { 'x-admin-api-key': 'virtual-account-test-admin-key', 'x-sivan-admin-role': 'finance' });
    assert(approved.account.provider === 'mock', 'approval provisions through mock provider');
    assert(approved.account.status === 'active', 'mock virtual account is active');
    assert(Boolean(approved.account.accountNumberMasked), 'account number is masked');

    const userAccounts: any = await request('GET', `/api/users/${user.id}/virtual-accounts`);
    assert(userAccounts.accounts.length === 1, 'user can list provisioned virtual accounts');

    await app.close();
    console.log('\n✅ Virtual account adapter E2E passed');
    console.log(JSON.stringify({ requestId: requested.id, accountId: approved.account.id, provider: approved.account.provider, currency: approved.account.currency }, null, 2));
  } catch (error) {
    await app.close();
    throw error;
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
}

main().catch((error) => { console.error(error); process.exit(1); });

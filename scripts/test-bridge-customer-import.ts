import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const bridgeCustomerId = 'bridge_customer_import_test_123';

async function main() {
  const bridge = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === `/v0/customers/${bridgeCustomerId}`) {
      return json(res, 200, {
        id: bridgeCustomerId,
        status: 'active',
        type: 'individual',
        email: 'imported-bridge-user@sivan.test',
        first_name: 'Imported',
        last_name: 'Bridge',
        has_accepted_terms_of_service: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        endorsements: [
          {
            name: 'base',
            status: 'approved',
            requirements: {
              complete: ['terms_of_service_v1', 'first_name', 'last_name', 'email_address', 'date_of_birth', 'min_age_18', 'kyc_approval'],
              pending: [],
              missing: null,
              issues: [],
            },
            additional_requirements: [],
          },
        ],
      });
    }

    if (req.method === 'POST' && req.url === `/v0/customers/${bridgeCustomerId}/virtual_accounts`) {
      let rawBody = '';
      req.on('data', (chunk) => rawBody += chunk);
      req.on('end', () => {
        const body = rawBody ? JSON.parse(rawBody) : {};
        return json(res, 200, {
          id: 'bridge_va_import_test_001',
          status: 'activated',
          source_deposit_instructions: {
            currency: body?.source?.currency || 'usd',
            bank_name: 'Bridge Sandbox Bank',
            bank_beneficiary_name: 'Imported Bridge',
            bank_account_number: '1234567890123456',
            bank_routing_number: '021000021',
          },
          destination: body.destination,
        });
      });
      return;
    }

    return json(res, 404, { code: 'not_found', path: req.url });
  });

  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
  const address = bridge.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve fake Bridge address');

  process.env.BRIDGE_MOCK_MODE = 'false';
  process.env.BRIDGE_API_KEY = 'bridge-import-test-key';
  process.env.BRIDGE_BASE_URL = `http://127.0.0.1:${address.port}/v0`;
  process.env.DATABASE_PROVIDER = 'json';
  process.env.DATABASE_FILE = '.data/test-bridge-customer-import.json';
  process.env.EMAIL_PROVIDER = 'console';
  process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
  process.env.ADMIN_API_KEY = 'bridge-import-admin-key';
  process.env.VIRTUAL_ACCOUNTS_ENABLED = 'true';
  process.env.VIRTUAL_ACCOUNT_REQUESTS_ENABLED = 'true';
  process.env.VIRTUAL_ACCOUNT_PROVIDER = 'bridge';
  process.env.BRIDGE_VIRTUAL_ACCOUNTS_ENABLED = 'true';
  process.env.BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_CURRENCY = 'usdc';
  process.env.BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_PAYMENT_RAIL = 'base';

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

  async function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(json)}`);
    return (json.data ?? json) as any;
  }

  try {
    const email = `import-bridge-${Date.now()}@sivan.test`;
    const started = await request('POST', '/api/auth/email/start', {
      email,
      fullName: 'Imported Bridge',
      intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' },
    });
    const verified = await request('POST', '/api/auth/email/verify', { email, code: started.devCode });
    token = verified.token;
    const user = verified.user;
    assert(Boolean(user.id), 'Sivan user created for Bridge import');

    const imported = await request('POST', '/api/admin/customers/import-bridge-customer', {
      userId: user.id,
      providerCustomerId: bridgeCustomerId,
      customerType: 'individual',
      replaceExisting: false,
      reason: 'E2E import verified Bridge customer for virtual account reconciliation',
    }, { 'x-admin-api-key': 'bridge-import-admin-key' });
    assert(imported.customer.provider === 'bridge', 'import stores provider=bridge');
    assert(imported.customer.providerCustomerId === bridgeCustomerId, 'import links provider customer ID');
    assert(imported.customer.kycStatus === 'kyc_approved', 'import maps active Bridge customer to kyc_approved');
    assert(imported.customer.tosStatus === 'approved', 'import maps Bridge terms as approved');
    assert(imported.virtualAccountEligible === true, 'imported customer is virtual-account eligible');

    await request('PUT', '/api/admin/offramp/controls', {
      virtualAccounts: [{ currency: 'usd', enabled: true }],
    }, { 'x-admin-api-key': 'bridge-import-admin-key' });
    assert(true, 'admin enables USD virtual account controls');

    const requested = await request('POST', `/api/users/${user.id}/virtual-accounts/request`, { currency: 'usd', useCase: 'Imported Bridge customer VA test' });
    assert(requested.status === 'requested', 'imported Bridge user can request USD virtual account');

    const approved = await request('POST', `/api/admin/virtual-account-requests/${requested.id}/approve`, {}, { 'x-admin-api-key': 'bridge-import-admin-key' });
    assert(approved.account.provider === 'bridge', 'approval provisions through Bridge provider');
    assert(approved.account.providerAccountId === 'bridge_va_import_test_001', 'Bridge virtual account ID is stored');
    assert(approved.account.bankName === 'Bridge Sandbox Bank', 'Bridge bank details are mapped');
    assert(approved.account.accountNumberMasked === '••••3456', 'Bridge account number is masked');
    assert(approved.account.routingNumberMasked === '••••0021', 'Bridge routing number is masked');

    const visible = await request('GET', `/api/users/${user.id}/virtual-accounts`);
    assert(visible.accounts.length === 1, 'customer can list real Bridge virtual account');
    assert(visible.accounts[0].provider === 'bridge', 'customer-visible account is Bridge-backed');

    console.log('\n✅ Bridge customer import → Sivan verification reconciliation → Bridge virtual account E2E passed');
    console.log(JSON.stringify({ userId: user.id, customerId: imported.customer.id, requestId: requested.id, accountId: approved.account.id }, null, 2));
  } finally {
    await app.close();
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
  }
}

function json(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

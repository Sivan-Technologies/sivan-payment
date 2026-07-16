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
  if (!address || typeof address === 'string') throw new Error('Could not resolve test server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let token = '';

  async function request(method: string, url: string, body?: unknown, admin = false, expect = 200) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(admin ? { 'x-admin-api-key': env.ADMIN_API_KEY } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json: any = text;
    try { json = text ? JSON.parse(text) : {}; } catch {}
    if (res.status !== expect) throw new Error(`${method} ${url} expected ${expect}, got ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  try {
    const legalAcceptance = { accepted: true, termsVersion: '2026-07-14', privacyVersion: '2026-07-14', riskDisclosureVersion: '2026-07-14' };
    const email = `adminops+${Date.now()}@sivan.test`;
    const started = await request('POST', '/api/auth/email/start', { email, fullName: 'Admin Ops', intent: 'signup', legalAcceptance });
    const verified = await request('POST', '/api/auth/email/verify', { email, code: started.data.devCode });
    token = verified.data.token;
    const user = verified.data.user;
    const kyc = await request('POST', '/api/customers/kyc-link', { userId: user.id, customerType: 'individual' }, false, 201);
    const account = await request('POST', '/api/external-accounts', {
      userId: user.id,
      currency: 'usd',
      bankName: 'Lead Bank',
      accountOwnerName: 'Admin Ops',
      accountOwnerType: 'individual',
      firstName: 'Admin',
      lastName: 'Ops',
      accountType: 'us',
      paymentRail: 'ach',
      address: { street_line_1: '923 Folsom Street', country: 'USA', state: 'CA', city: 'San Francisco', postal_code: '94107' },
      account: { routing_number: '101019644', account_number: '215268129123', checking_or_savings: 'checking' }
    }, false, 201);
    const withdrawal = await request('POST', '/api/withdrawals', { userId: user.id, externalAccountId: account.data.id, sourceCurrency: 'usdc', sourceChain: 'avalanche_c_chain', destinationCurrency: 'usd' }, false, 201);

    const userDetail = await request('GET', `/api/admin/users/${user.id}/details`, undefined, true);
    assert(userDetail.data.legalAcceptances.length === 1, 'admin user detail includes legal acceptances');
    assert(userDetail.data.externalAccounts.length === 1, 'admin user detail includes bank accounts');
    assert(userDetail.data.withdrawals.length === 1, 'admin user detail includes withdrawals');

    const withdrawalDetail = await request('GET', `/api/admin/withdrawals/${withdrawal.data.withdrawal.id}/details`, undefined, true);
    assert(withdrawalDetail.data.liquidationAddress.address, 'withdrawal detail includes liquidation address');
    assert(Array.isArray(withdrawalDetail.data.timeline), 'withdrawal detail includes timeline');

    await request('POST', '/api/admin/notes', { resourceType: 'user', resourceId: user.id, note: 'Internal admin ops test note', visibility: 'internal' }, true);
    const userWithNote = await request('GET', `/api/admin/users/${user.id}/details`, undefined, true);
    assert(userWithNote.data.notes.length === 1, 'admin notes persist through audit log');

    const approval = await request('POST', '/api/admin/approvals', { action: 'system_status.update', resourceType: 'payments_system_status', resourceId: 'global', reason: 'Admin ops test maintenance approval', requestedBy: 'ops', riskLevel: 'high', requestedChange: { mode: 'maintenance', message: 'Admin ops test' } }, true);
    assert(approval.data.status === 'pending', 'approval request starts pending');
    const approved = await request('POST', `/api/admin/approvals/${approval.data.id}/approve`, { reviewer: 'owner', reason: 'Approved for admin ops test', apply: true }, true);
    assert(approved.data.status === 'approved', 'approval can be approved by checker');

    const limits = await request('PUT', '/api/admin/limits', { newUserDailyLimitUsd: 500, verifiedUserDailyLimitUsd: 5000, businessDailyLimitUsd: 0, minTransactionAmountUsd: 10, maxOnrampAmountUsd: 5000, maxOfframpAmountUsd: 5000, highValueApprovalThresholdUsd: 10000, monthlyUserLimitUsd: 25000, updatedBy: 'ops', reason: 'Admin ops test limits' }, true);
    assert(limits.data.verifiedUserDailyLimitUsd === 5000, 'limit controls save');

    const risk = await request('GET', '/api/admin/risk/cases', undefined, true);
    assert(Array.isArray(risk.data), 'risk cases endpoint returns list');
    const finance = await request('GET', '/api/admin/finance/dashboard', undefined, true);
    assert(finance.data.volume, 'finance dashboard loads');
    const legal = await request('GET', '/api/admin/legal/evidence', undefined, true);
    assert(legal.data.total === 1, 'legal evidence dashboard loads');

    const feeSettings = await request('GET', '/api/admin/fees/settings', undefined, true);
    assert(Array.isArray(feeSettings.data.feeTiers), 'fee settings load fee tiers');
    const updatedFeeSettings = await request('PUT', '/api/admin/fees/settings', { ...feeSettings.data, onrampFeePercent: 2.25, offrampFeePercent: 2.5, bridgeOfframpCostPercent: 0.5, updatedBy: 'ops', reason: 'Admin ops fee settings test' }, true);
    assert(updatedFeeSettings.data.offrampFeePercent === 2.5, 'fee settings save off-ramp percent');
    const publicOnrampFees = await request('GET', '/api/onramp/fees');
    assert(publicOnrampFees.data.percent === '2.25', 'public on-ramp fee reflects admin fee settings');
    const publicOfframpFees = await request('GET', '/api/fees/offramp');
    assert(publicOfframpFees.data.percent === '2.5', 'public off-ramp fee reflects admin fee settings');

    const forbiddenRbac = await fetch(`${baseUrl}/api/admin/fees/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-api-key': env.ADMIN_API_KEY, 'x-sivan-admin-role': 'guest', 'x-sivan-admin-email': 'guest@sivan.test' },
      body: JSON.stringify({ ...feeSettings.data, updatedBy: 'guest', reason: 'RBAC negative test' })
    });
    assert(forbiddenRbac.status === 403, 'backend RBAC blocks guest from changing fee settings');

    const settings = await request('GET', '/api/admin/settings/platform', undefined, true);
    assert(settings.data.newUserSignups === true, 'platform settings load with signups enabled by default');
    await request('PUT', '/api/admin/settings/platform', { ...settings.data, newUserSignups: false, onRampEnabled: false, offRampEnabled: false, updatedBy: 'ops', reason: 'Admin ops settings test' }, true);
    await request('POST', '/api/auth/email/start', { email: `blocked+${Date.now()}@sivan.test`, fullName: 'Blocked Signup', intent: 'signup', legalAcceptance }, false, 400);
    console.log('✓ settings disable new signups');
    await request('POST', '/api/withdrawals', { userId: user.id, externalAccountId: account.data.id, sourceCurrency: 'usdc', sourceChain: 'avalanche_c_chain', destinationCurrency: 'usd' }, false, 503);
    console.log('✓ settings disable off-ramp mutations');
    await request('POST', '/api/onramp/orders', { userId: user.id, sourceCurrency: 'usd', destinationCurrency: 'usdc', destinationChain: 'avalanche_c_chain', destinationAddress: '0x0000000000000000000000000000000000000000', amount: '100' }, false, 503);
    console.log('✓ settings disable on-ramp mutations');
    await request('POST', '/api/admin/settings/api-keys/bridgeApiKey/rotate', { requestedBy: 'ops', reason: 'Admin ops rotation test' }, true);
    console.log('✓ api key rotation request is audited');

    const csv = await request('GET', '/api/admin/exports/users.csv', undefined, true);
    assert(String(csv).includes('adminops'), 'CSV export returns user data');

    await app.close();
    console.log('\n✅ Admin ops E2E passed');
    console.log(JSON.stringify({ userId: user.id, customerId: (kyc.data.customer?.id ?? kyc.data.id), withdrawalId: withdrawal.data.withdrawal.id }, null, 2));
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

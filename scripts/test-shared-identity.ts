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

  let authToken = '';

  async function request<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(json)}`);
    return (json.data ?? json) as T;
  }

  async function requestExpect(method: string, url: string, expectedStatus: number, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    assert(res.status === expectedStatus, `${method} ${url} returns ${expectedStatus}`);
    return json;
  }

  async function createPaymentUser(label: string) {
    const email = `identity-${label}+${Date.now()}@sivan.test`;
    const started: any = await request('POST', '/api/auth/email/start', {
      email,
      fullName: `Identity ${label}`,
      intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' },
    });
    const verified: any = await request('POST', '/api/auth/email/verify', { email, code: started.devCode });
    assert(Boolean(verified.token), `${label} auth token returned`);
    assert(Boolean(verified.user?.id), `${label} payment user created`);
    return { email, token: verified.token as string, user: verified.user as any };
  }

  try {
    await request('GET', '/health');

    const first = await createPaymentUser('first');
    authToken = first.token;

    const initial: any = await request('GET', '/api/users/me/identity');
    assert(initial.linked === false, 'new payment user starts unlinked');

    const started: any = await request('POST', '/api/users/me/identity/link-whatsapp/start', {});
    assert(/^SVP-[A-Z]{4}-[0-9]{2}$/.test(started.token), 'start pairing returns SVP token');

    const activePending: any = await request('GET', '/api/users/me/identity');
    assert(activePending.pendingPairing?.status === 'pending', 'pending token appears in identity status');

    const canceled: any = await request('POST', '/api/users/me/identity/link-whatsapp/cancel', {});
    assert(canceled.canceled === true, 'cancel pending token works');

    const afterCancel: any = await request('GET', '/api/users/me/identity');
    assert(afterCancel.pendingPairing === null, 'canceled token no longer appears as pending');

    const secondStart: any = await request('POST', '/api/users/me/identity/link-whatsapp/start', {});
    const redeem: any = await request('POST', '/api/identity/link-whatsapp/redeem', {
      token: secondStart.token,
      whatsappNumber: 'whatsapp:+2348000000999',
      escrowUserId: 'escrow_user_identity_test',
    }, { 'x-sivan-identity-link-secret': 'identity-test-secret' });
    assert(redeem.linked === true, 'redeem with WhatsApp links identity');
    assert(redeem.link.whatsappNumber === 'whatsapp:+2348000000999', 'linked WhatsApp is normalized and stored');

    const linked: any = await request('GET', '/api/users/me/identity');
    assert(linked.linked === true, 'linked state is returned');
    assert(linked.link.escrowUserId === 'escrow_user_identity_test', 'escrow user id is stored');

    const updatedUser: any = await request('GET', `/api/users/${first.user.id}`);
    assert(updatedUser.whatsappNumber === 'whatsapp:+2348000000999', 'payment user stores linked WhatsApp');
    assert(updatedUser.primaryChannel === 'both', 'payment user primaryChannel becomes both');

    await requestExpect('POST', '/api/identity/link-whatsapp/redeem', 400, {
      token: secondStart.token,
      whatsappNumber: 'whatsapp:+2348000000999',
    }, { 'x-sivan-identity-link-secret': 'identity-test-secret' });

    const second = await createPaymentUser('second');
    authToken = second.token;
    const secondPair: any = await request('POST', '/api/users/me/identity/link-whatsapp/start', {});
    await requestExpect('POST', '/api/identity/link-whatsapp/redeem', 400, {
      token: secondPair.token,
      whatsappNumber: 'whatsapp:+2348000000999',
      escrowUserId: 'escrow_conflict',
    }, { 'x-sivan-identity-link-secret': 'identity-test-secret' });
    assert(true, 'duplicate WhatsApp link is rejected');

    await requestExpect('POST', '/api/identity/link-whatsapp/redeem', 403, {
      token: secondPair.token,
      whatsappNumber: 'whatsapp:+2348000000888',
    }, { 'x-sivan-identity-link-secret': 'wrong-secret' });
    assert(true, 'redeem requires service secret');

    authToken = first.token;
    const unlinked: any = await request('POST', '/api/users/me/identity/unlink-whatsapp', {});
    assert(unlinked.unlinked === true, 'unlink works');
    const afterUnlink: any = await request('GET', '/api/users/me/identity');
    assert(afterUnlink.linked === false, 'identity status is unlinked after unlink');

    const adminAudit: any = await request('GET', '/api/admin/audit-logs?limit=100', undefined, { 'x-admin-api-key': 'identity-test-admin-key' });
    const actions = (adminAudit as any[]).map((item) => item.action);
    assert(actions.includes('identity.whatsapp_pairing_started'), 'audit log records pairing start');
    assert(actions.includes('identity.whatsapp_linked'), 'audit log records link redemption');
    assert(actions.includes('identity.whatsapp_unlinked'), 'audit log records unlink');

    await app.close();
    console.log('\n✅ Shared customer identity E2E passed');
    console.log(JSON.stringify({ userId: first.user.id, linkedWhatsapp: 'whatsapp:+2348000000999', auditActions: actions.filter((action) => action.startsWith('identity.')) }, null, 2));
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

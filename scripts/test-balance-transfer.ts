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
  async function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(json)}`);
    return (json.data ?? json) as any;
  }

  try {
    const email = `balance-transfer-${Date.now()}@sivan.test`;
    const started = await request('POST', '/api/auth/email/start', { email, fullName: 'Balance User', intent: 'signup', legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' } });
    const verified = await request('POST', '/api/auth/email/verify', { email, code: started.devCode });
    token = verified.token;
    const user = verified.user;
    assert(Boolean(user.id), 'user is created');

    const disabledAttempt = await fetch(`${baseUrl}/api/users/${user.id}/balance/transfers`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ asset: 'usdc', network: 'base', amount: 10, destinationAddress: '0x0000000000000000000000000000000000000001' }) });
    assert(disabledAttempt.status === 403, 'transfer is blocked while controls are disabled');

    const controls = await request('PUT', '/api/admin/balance/controls', { transfersEnabled: true, minimumSendAmount: 5, manualReviewThreshold: 100, riskHoldsEnabled: true, supportedNetworks: ['base', 'solana'], updatedBy: 'test', reason: 'Enable test balance transfer controls' }, { 'x-admin-api-key': 'balance-admin-key' });
    assert(controls.transfersEnabled === true, 'admin enables balance transfers');

    const adjustment = await request('POST', '/api/admin/balance/adjustments', { userId: user.id, asset: 'usdc', network: 'solana', amount: 50, status: 'available', reason: 'Seed test available balance', adjustedBy: 'test' }, { 'x-admin-api-key': 'balance-admin-key' });
    assert(adjustment.kind === 'adjustment', 'admin adjustment creates ledger credit');

    const balance = await request('GET', `/api/users/${user.id}/balance`);
    const usdc = balance.balances.find((item: any) => item.asset === 'usdc');
    assert(Number(usdc.available) === 50, 'available balance is credited');

    const transfer = await request('POST', `/api/users/${user.id}/balance/transfers`, { asset: 'usdc', network: 'solana', amount: 20, destinationAddress: '8349DeWNxtDJDE5KzZ2NRuyzyNQzcvvpT8eeV4UGSY5t', note: 'Send from balance E2E' });
    assert(transfer.status === 'pending_review', 'transfer request is created with risk hold');

    const updated = await request('GET', `/api/users/${user.id}/balance`);
    const updatedUsdc = updated.balances.find((item: any) => item.asset === 'usdc');
    assert(Number(updatedUsdc.available) === 30, 'transfer hold reduces available balance');
    assert(Number(updatedUsdc.held) === 20, 'transfer hold increases held balance');

    const transfers = await request('GET', `/api/users/${user.id}/balance/transfers`);
    assert(transfers.some((item: any) => item.transferId === transfer.transferId), 'user can list balance transfer history');

    await app.close();
    console.log('\n✅ Balance ledger and transfer-from-balance E2E passed');
    console.log(JSON.stringify({ userId: user.id, transferId: transfer.transferId, available: updatedUsdc.available, held: updatedUsdc.held }, null, 2));
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

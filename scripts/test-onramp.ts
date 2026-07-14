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

  async function request<T>(method: string, url: string, body?: unknown, admin = false): Promise<T> {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(admin && env.ADMIN_API_KEY ? { 'x-admin-api-key': env.ADMIN_API_KEY } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  try {
    const email = `onramp+${Date.now()}@sivan.test`;
    const started: any = await request('POST', '/api/auth/email/start', { email, fullName: 'On Ramp', intent: 'signup' });
    const verified: any = await request('POST', '/api/auth/email/verify', { email, code: started.data.devCode });
    authToken = verified.data.token;
    const user = verified.data.user;
    assert(Boolean(user.id), 'created user for on-ramp test');

    const customer: any = await request('POST', '/api/customers/kyc-link', { userId: user.id, type: 'individual', redirectUri: 'https://app.sivan.test/verification-complete' });
    assert(customer.data.kycStatus === 'kyc_approved', 'mock KYC approved before on-ramp');

    const fee: any = await request('GET', '/api/onramp/fees');
    assert(Boolean(fee.data.percent), 'on-ramp fee endpoint returns percent');

    const orderResponse: any = await request('POST', '/api/onramp/orders', {
      userId: user.id,
      sourceCurrency: 'usd',
      destinationCurrency: 'usdc',
      destinationChain: 'base',
      destinationAddress: '0x0000000000000000000000000000000000000001',
      amount: 100
    });
    const order = orderResponse.data;
    assert(order.status === 'awaiting_payment', 'on-ramp order starts awaiting payment');
    assert(order.amount === '100.00', 'on-ramp order stores fiat amount');
    assert(Boolean(order.providerReference), 'on-ramp order has payment reference');
    assert(Boolean(order.sourceDepositInstructions), 'on-ramp order has source payment instructions');

    const list: any = await request('GET', `/api/users/${user.id}/onramp-orders`);
    assert(list.data.length === 1, 'user on-ramp order history returns order');

    const fetched: any = await request('GET', `/api/onramp/orders/${order.id}`);
    assert(fetched.data.id === order.id, 'on-ramp order can be fetched by id');

    const synced: any = await request('POST', `/api/onramp/orders/${order.id}/sync`);
    assert(['completed', 'awaiting_payment', 'processing', 'payment_received'].includes(synced.data.status), 'on-ramp sync returns valid status');

    const adminOrders: any = await request('GET', '/api/admin/onramp/orders', undefined, true);
    assert(adminOrders.data.some((item: any) => item.id === order.id), 'admin can list on-ramp orders');

    const adminReconciliation: any = await request('POST', '/api/admin/onramp/reconciliation/run', { dryRun: true }, true);
    assert(adminReconciliation.data.summary.checkedOrders >= 1, 'admin can run on-ramp reconciliation dry-run');

    await app.close();
    console.log('\n✅ On-ramp backend E2E passed');
    console.log(JSON.stringify({ userId: user.id, orderId: order.id, status: synced.data.status, reference: order.providerReference }, null, 2));
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

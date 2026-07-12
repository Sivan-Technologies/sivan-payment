import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

type Method = 'GET' | 'POST' | 'PUT';
type Currency = 'usd' | 'gbp' | 'eur';
type Asset = 'usdc' | 'usdt';
type Network = 'base' | 'polygon' | 'ethereum' | 'solana' | 'arbitrum' | 'avalanche_c_chain';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
}

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const adminKey = env.ADMIN_API_KEY;
  let token = '';

  async function request(method: Method, url: string, body?: unknown, opts: { admin?: boolean; noAuth?: boolean; expect?: number } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token && !opts.noAuth) headers.Authorization = `Bearer ${token}`;
    if (opts.admin) headers['x-admin-api-key'] = adminKey;
    const res = await fetch(`${baseUrl}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json: any = await res.json().catch(() => ({}));
    if (opts.expect && res.status !== opts.expect) throw new Error(`${method} ${url} expected ${opts.expect}, got ${res.status}: ${JSON.stringify(json)}`);
    if (!opts.expect && !res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(json)}`);
    return { status: res.status, json };
  }

  async function updateControls(payload: any, expect = 200) {
    return request('PUT', '/api/admin/offramp/controls', payload, { admin: true, noAuth: true, expect });
  }

  async function getControls() {
    return (await request('GET', '/api/offramp/controls', undefined, { noAuth: true })).json.data;
  }

  function accountPayload(currency: Currency, userId: string) {
    const base = {
      userId,
      currency,
      bankName: currency === 'usd' ? 'Lead Bank' : currency === 'gbp' ? 'Example UK Bank' : 'Example SEPA Bank',
      accountName: 'Ada Account',
      accountOwnerName: 'Ada Lovelace',
      accountOwnerType: 'individual',
      firstName: 'Ada',
      lastName: 'Lovelace'
    } as any;
    if (currency === 'usd') return { ...base, accountType: 'us', paymentRail: 'ach', address: { street_line_1: '923 Folsom Street', country: 'USA', state: 'CA', city: 'San Francisco', postal_code: '94107' }, account: { routing_number: '101019644', account_number: '215268129123', checking_or_savings: 'checking' } };
    if (currency === 'gbp') return { ...base, accountType: 'gb', paymentRail: 'faster_payments', address: { street_line_1: '1 King Street', country: 'GBR', city: 'London', postal_code: 'SW1A 1AA' }, account: { sort_code: '123456', account_number: '12345678' } };
    return { ...base, accountType: 'iban', paymentRail: 'sepa', address: { street_line_1: '2 Rue de la Paix', country: 'FRA', city: 'Paris', postal_code: '75002' }, iban: { account_number: 'FR7630006000011234567890189', bic: 'AGRIFRPP', country: 'FRA' } };
  }

  async function createWithdrawal(userId: string, externalAccountId: string, sourceCurrency: Asset = 'usdc', sourceChain: Network = 'base', destinationCurrency: Currency = 'usd', expect = 201) {
    return request('POST', '/api/withdrawals', {
      userId,
      externalAccountId,
      sourceCurrency,
      sourceChain,
      destinationCurrency,
      returnAddress: '0x0000000000000000000000000000000000000000'
    }, { expect });
  }

  try {
    const email = `controls+${Date.now()}@sivan.test`;
    const authStart = await request('POST', '/api/auth/email/start', { email, fullName: 'Ada Lovelace', intent: 'signup' }, { noAuth: true });
    await request('POST', '/api/auth/email/verify', { email, code: '000000' }, { noAuth: true, expect: 400 });
    assert(authStart.json.data.devCode, 'auth start returns dev OTP for local test');
    const verified = await request('POST', '/api/auth/email/verify', { email, code: authStart.json.data.devCode }, { noAuth: true });
    token = verified.json.data.token;
    const user = verified.json.data.user;
    assert(token && user.id, 'user JWT acquired');

    await request('POST', '/api/customers/kyc-link', { userId: user.id, type: 'individual' });
    assert(true, 'KYC created/approved in mock mode');

    const initial = await getControls();
    assert(initial.payoutCurrencies.length === 3, 'payout controls include USD, GBP, EUR');
    assert(initial.sourceAssets.some((x: any) => x.asset === 'usdc'), 'asset controls include USDC');
    assert(initial.sourceAssets.some((x: any) => x.asset === 'usdt'), 'asset controls include USDT');
    assert(initial.sourceNetworks.length === 6, 'network controls include all six supported networks');

    const accounts: Record<Currency, any> = {} as Record<Currency, any>;
    for (const currency of ['usd', 'gbp', 'eur'] as Currency[]) {
      const created = await request('POST', '/api/external-accounts', accountPayload(currency, user.id));
      accounts[currency] = created.json.data;
      assert(created.json.data.currency === currency, `${currency.toUpperCase()} account can be created while enabled`);
    }

    for (const currency of ['usd', 'gbp', 'eur'] as Currency[]) {
      await updateControls({ payoutCurrencies: [{ currency, enabled: false }] });
      let controls = await getControls();
      assert(controls.payoutCurrencies.find((x: any) => x.currency === currency).enabled === false, `${currency.toUpperCase()} disabled in public controls`);
      await request('POST', '/api/external-accounts', accountPayload(currency, user.id), { expect: 400 });
      assert(true, `${currency.toUpperCase()} external account creation blocked while disabled`);
      await createWithdrawal(user.id, accounts[currency].id, 'usdc', 'base', currency, 400);
      assert(true, `${currency.toUpperCase()} withdrawal creation blocked while disabled`);
      await updateControls({ payoutCurrencies: [{ currency, enabled: true }] });
      controls = await getControls();
      assert(controls.payoutCurrencies.find((x: any) => x.currency === currency).enabled === true, `${currency.toUpperCase()} re-enabled`);
    }

    await createWithdrawal(user.id, accounts.usd.id, 'usdt', 'base', 'usd', 400);
    assert(true, 'USDT withdrawal blocked while USDT default disabled');
    await updateControls({ sourceAssets: [{ asset: 'usdt', enabled: true }] });
    await createWithdrawal(user.id, accounts.usd.id, 'usdt', 'base', 'usd', 201);
    assert(true, 'USDT withdrawal succeeds after admin enables USDT');

    await updateControls({ sourceAssets: [{ asset: 'usdc', enabled: false }] });
    await createWithdrawal(user.id, accounts.usd.id, 'usdc', 'base', 'usd', 400);
    assert(true, 'USDC withdrawal blocked while USDC disabled');
    await updateControls({ sourceAssets: [{ asset: 'usdc', enabled: true }] });
    await createWithdrawal(user.id, accounts.usd.id, 'usdc', 'base', 'usd', 201);
    assert(true, 'USDC withdrawal succeeds after re-enable');
    await updateControls({ sourceAssets: [{ asset: 'usdt', enabled: false }] });

    for (const network of ['base', 'polygon', 'ethereum', 'solana', 'arbitrum', 'avalanche_c_chain'] as Network[]) {
      await updateControls({ sourceNetworks: [{ network, enabled: false }] });
      await createWithdrawal(user.id, accounts.usd.id, 'usdc', network, 'usd', 400);
      assert(true, `${network} withdrawal blocked while network disabled`);
      await updateControls({ sourceNetworks: [{ network, enabled: true }] });
      await createWithdrawal(user.id, accounts.usd.id, 'usdc', network, 'usd', 201);
      assert(true, `${network} withdrawal succeeds after re-enable`);
    }

    await updateControls({ payoutCurrencies: [{ currency: 'usd', enabled: false }, { currency: 'gbp', enabled: false }, { currency: 'eur', enabled: false }] }, 400);
    assert(true, 'cannot disable all payout currencies');
    await updateControls({ sourceAssets: [{ asset: 'usdc', enabled: false }, { asset: 'usdt', enabled: false }] }, 400);
    assert(true, 'cannot disable all deposit assets');
    await updateControls({ sourceNetworks: ['base', 'polygon', 'ethereum', 'solana', 'arbitrum', 'avalanche_c_chain'].map((network) => ({ network, enabled: false })) }, 400);
    assert(true, 'cannot disable all deposit networks');

    console.log('\n✅ Control system full test passed');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('\n❌ Control system test failed');
  console.error(error);
  process.exit(1);
});

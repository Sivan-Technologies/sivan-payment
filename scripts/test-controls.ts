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
    const authStart = await request('POST', '/api/auth/email/start', { email, fullName: 'Ada Lovelace', intent: 'signup', legalAcceptance: { accepted: true, termsVersion: '2026-07-14', privacyVersion: '2026-07-14', riskDisclosureVersion: '2026-07-14' } }, { noAuth: true });
    await request('POST', '/api/auth/email/verify', { email, code: '000000' }, { noAuth: true, expect: 400 });
    assert(authStart.json.data.devCode, 'auth start returns dev OTP for local test');
    const verified = await request('POST', '/api/auth/email/verify', { email, code: authStart.json.data.devCode }, { noAuth: true });
    token = verified.json.data.token;
    const user = verified.json.data.user;
    assert(token && user.id, 'user JWT acquired');

    await request('POST', '/api/customers/kyc-link', { userId: user.id, type: 'individual' });
    assert(true, 'KYC created/approved in mock mode');

    const initial = await getControls();
    assert(initial.customerTypes.length === 2, 'customer type controls include Individual and Business');
    assert(initial.customerTypes.find((x: any) => x.customerType === 'individual')?.enabled === true, 'individual verification is enabled by default');
    assert(initial.customerTypes.find((x: any) => x.customerType === 'business')?.enabled === false, 'business verification is disabled by default');
    await request('POST', '/api/customers/kyc-link', { userId: user.id, type: 'business' }, { expect: 400 });
    assert(true, 'business verification is blocked while disabled');
    await updateControls({ customerTypes: [{ customerType: 'business', enabled: true }] });
    const businessControls = await getControls();
    assert(businessControls.customerTypes.find((x: any) => x.customerType === 'business')?.enabled === true, 'business verification can be enabled by admin');
    await updateControls({ customerTypes: [{ customerType: 'business', enabled: false }] });

    /**
     * ASSERTS WHICH CURRENCIES, NOT HOW MANY.
     *
     * This was `length === 3` under the message "payout controls include USD,
     * GBP, EUR" - a count standing in for an identity check. The two are not
     * the same claim, and the gap showed the moment NGN was added: the message
     * stayed true (usd, gbp and eur are all still there) while the assertion
     * failed, so the failure text actively misdescribed the change. A count
     * also cannot catch the failure it exists to catch - swap 'eur' for 'chf'
     * and it still passes.
     */
    for (const currency of ['usd', 'gbp', 'eur', 'ngn']) {
      assert(
        initial.payoutCurrencies.some((x: any) => x.currency === currency),
        `payout controls include ${currency.toUpperCase()}`,
      );
    }
    // Naira is a Breet/NIP rail and must never claim a Bridge account shape -
    // createExternalAccountSchema is a discriminated union over us|gb|iban and
    // a NUBAN is none of them.
    assert(
      initial.payoutCurrencies.find((x: any) => x.currency === 'ngn')?.accountType === 'nuban',
      'the naira payout control uses the NUBAN shape, not a Bridge one',
    );
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

    // USDT does not exist on Base - Bridge supports USDB, USDC and EURC there.
    // Solana is used instead because it carries both USDC and USDT.
    await createWithdrawal(user.id, accounts.usd.id, 'usdt', 'solana', 'usd', 400);
    assert(true, 'USDT withdrawal blocked while USDT default disabled');
    await updateControls({ sourceAssets: [{ asset: 'usdt', enabled: true }], sourceNetworks: [{ network: 'solana', enabled: true }] });
    await createWithdrawal(user.id, accounts.usd.id, 'usdt', 'solana', 'usd', 201);
    assert(true, 'USDT withdrawal succeeds after admin enables USDT');

    // Even with both USDT and Base enabled, the pair itself is invalid and
    // must be rejected. Without this guard a user would be handed a Base
    // deposit address for a token that does not exist on Base.
    await updateControls({ sourceNetworks: [{ network: 'base', enabled: true }] });
    await createWithdrawal(user.id, accounts.usd.id, 'usdt', 'base', 'usd', 400);
    assert(true, 'USDT on Base rejected even when both are individually enabled');

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

    await updateControls({ customerTypes: [{ customerType: 'individual', enabled: false }, { customerType: 'business', enabled: false }] }, 400);
    assert(true, 'cannot disable all customer types');
    /**
     * ALL FOUR, because there are now four.
     *
     * With NGN added and left enabled, switching off usd/gbp/eur correctly
     * returned 200 - one payout rail was still open, so the guard had nothing
     * to refuse. The test failed while the SYSTEM was right, which is the
     * useful direction for a test to fail in: it noticed that "all" had
     * changed meaning. Enumerating the list rather than counting it is the
     * same fix applied above.
     */
    await updateControls({ payoutCurrencies: [{ currency: 'usd', enabled: false }, { currency: 'gbp', enabled: false }, { currency: 'eur', enabled: false }, { currency: 'ngn', enabled: false }] }, 400);
    assert(true, 'cannot disable all payout currencies');
    // And the naira rail alone is enough to keep the gate open - proves the
    // guard counts NGN as a real payout rail rather than ignoring it.
    await updateControls({ payoutCurrencies: [{ currency: 'usd', enabled: false }, { currency: 'gbp', enabled: false }, { currency: 'eur', enabled: false }, { currency: 'ngn', enabled: true }] }, 200);
    assert(true, 'naira alone keeps payouts open');
    await updateControls({ payoutCurrencies: [{ currency: 'usd', enabled: true }, { currency: 'gbp', enabled: true }, { currency: 'eur', enabled: true }] });
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

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

  async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  try {
    const email = `prefs+${Date.now()}@sivan.test`;
    const started: any = await request('POST', '/api/auth/email/start', { email, fullName: 'Prefs User', intent: 'signup' });
    const verified: any = await request('POST', '/api/auth/email/verify', { email, code: started.data.devCode });
    authToken = verified.data.token;
    const user = verified.data.user;
    assert(Boolean(user.id), 'created user for preference test');

    const defaults: any = await request('GET', `/api/users/${user.id}/preferences`);
    assert(defaults.data.language === 'en-US', 'default language is English US');
    assert(defaults.data.defaultFiatCurrency === 'usd', 'default fiat currency is USD');
    assert(defaults.data.transactionUpdates === true, 'transaction updates enabled by default');
    assert(defaults.data.marketingEmails === false, 'marketing emails disabled by default');
    assert(defaults.data.securityAlerts === true, 'security alerts enabled by default');

    const updated: any = await request('PUT', `/api/users/${user.id}/preferences`, {
      language: 'en-GB',
      defaultFiatCurrency: 'gbp',
      transactionUpdates: false,
      marketingEmails: true,
      securityAlerts: true,
      emailConfirmationsForHighValue: true
    });
    assert(updated.data.language === 'en-GB', 'language preference updates');
    assert(updated.data.defaultFiatCurrency === 'gbp', 'default fiat preference updates');
    assert(updated.data.transactionUpdates === false, 'transaction update preference saves off');
    assert(updated.data.marketingEmails === true, 'marketing email preference saves on');
    assert(updated.data.emailConfirmationsForHighValue === true, 'high-value confirmation preference saves on');

    const fetched: any = await request('GET', `/api/users/${user.id}/preferences`);
    assert(fetched.data.language === 'en-GB', 'updated preferences persist after reload');
    assert(fetched.data.marketingEmails === true, 'marketing setting persists after reload');

    await app.close();
    console.log('\n✅ User preferences E2E passed');
    console.log(JSON.stringify({ userId: user.id, preferences: fetched.data }, null, 2));
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

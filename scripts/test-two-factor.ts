import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(value: string) {
  let bits = '';
  for (const char of value.replace(/=+$/g, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret: string) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let token = '';
  async function request(method: string, url: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${url}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(json)}`);
    return (json.data ?? json) as any;
  }
  try {
    const email = `twofactor-${Date.now()}@sivan.test`;
    const started = await request('POST', '/api/auth/email/start', { email, fullName: 'Two Factor User', intent: 'signup', legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' } });
    const verified = await request('POST', '/api/auth/email/verify', { email, code: started.devCode });
    token = verified.token;
    const user = verified.user;
    assert(Boolean(token && user.id), 'user signs up before 2FA');

    const setup = await request('POST', `/api/users/${user.id}/2fa/setup`, {});
    assert(Boolean(setup.manualEntryKey && setup.otpauthUrl), '2FA setup returns manual key and otpauth URL');
    const enabled = await request('POST', `/api/users/${user.id}/2fa/enable`, { code: totp(setup.manualEntryKey) });
    assert(enabled.enabled === true && enabled.recoveryCodes.length === 10, '2FA enables with authenticator code and returns recovery codes');

    token = '';
    const signin = await request('POST', '/api/auth/email/start', { email, intent: 'signin' });
    const challenge = await request('POST', '/api/auth/email/verify', { email, code: signin.devCode });
    assert(challenge.requiresTwoFactor === true && challenge.twoFactorToken, 'signin requires second factor after email OTP');
    const login = await request('POST', '/api/auth/2fa/verify', { twoFactorToken: challenge.twoFactorToken, code: totp(setup.manualEntryKey) });
    assert(Boolean(login.token && login.user.id === user.id), '2FA login returns user JWT');
    token = login.token;

    const status = await request('GET', `/api/users/${user.id}/2fa`);
    assert(status.enabled === true, '2FA status is enabled');

    await app.close();
    console.log('\n✅ Two-factor authentication E2E passed');
  } catch (error) { await app.close(); throw error; }
}
function assert(condition: unknown, message: string) { if (!condition) throw new Error(`Assertion failed: ${message}`); console.log(`✓ ${message}`); }
main().catch((error) => { console.error(error); process.exit(1); });

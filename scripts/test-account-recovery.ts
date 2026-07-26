import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
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
  async function request(method: string, url: string, body?: unknown, admin = false, expectedStatus = 200) {
    const res = await fetch(`${baseUrl}${url}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-admin-api-key': 'recovery-admin-key', 'x-sivan-admin-role': 'compliance', 'x-sivan-admin-email': 'compliance@sivan.test' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.status !== expectedStatus) throw new Error(`${method} ${url} expected ${expectedStatus} got ${res.status}: ${JSON.stringify(json)}`);
    return (json.data ?? json) as any;
  }
  try {
    const email = `recovery-${Date.now()}@sivan.test`;
    const start = await request('POST', '/api/auth/email/start', { email, fullName: 'Recovery User', intent: 'signup', legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' } });
    const verify = await request('POST', '/api/auth/email/verify', { email, code: start.devCode });
    token = verify.token;
    const user = verify.user;
    await request('PUT', `/api/users/${user.id}/username`, { username: 'recovery_user' });
    await request('POST', `/api/users/${user.id}/avatar/confirm`, { objectKey: `avatars/${user.id}/fake.png`, publicUrl: 'https://uploads.sivantech.online/fake.png' });

    const controls = await request('GET', `/api/admin/users/${user.id}/account-controls`, undefined, true);
    assert(controls.user.id === user.id, 'admin can load account recovery controls');

    const renamed = await request('POST', `/api/admin/users/${user.id}/account-controls/username`, { username: 'recovered_user', reason: 'Support verified username correction', supportTicketId: 'sup_ticket_1' }, true);
    assert(renamed.username === 'recovered_user', 'admin can change username with support evidence');

    const removed = await request('POST', `/api/admin/users/${user.id}/account-controls/remove-avatar`, { reason: 'User requested avatar removal', supportTicketId: 'sup_ticket_1' }, true);
    assert(!removed.avatarUrl, 'admin can remove avatar');

    const nameReq = await request('POST', `/api/admin/users/${user.id}/account-controls/name-correction-request`, { requestedFullName: 'Recovery Corrected', reason: 'Legal document mismatch reported by customer', supportTicketId: 'sup_ticket_1', providerChecked: false }, true);
    assert(nameReq.requested === true, 'admin can request name correction');

    const emailReq = await request('POST', `/api/admin/users/${user.id}/account-controls/email-change-request`, { newEmail: `new-${email}`, reason: 'Customer lost email and passed support verification', supportTicketId: 'sup_ticket_1' }, true);
    assert(emailReq.started === true && emailReq.requestId && emailReq.devCode, 'admin can start email change request');
    assert(String(emailReq.confirmationUrl).includes('/email-recovery/confirm') && String(emailReq.confirmationUrl).includes(emailReq.requestId), 'email change request returns customer confirmation link');
    const changedEmailUser = await request('POST', `/api/users/${user.id}/email-change/confirm`, { requestId: emailReq.requestId, code: emailReq.devCode });
    assert(changedEmailUser.email === `new-${email}`, 'user can confirm admin-started email change');
    const postEmailControls = await request('GET', `/api/admin/users/${user.id}/account-controls`, undefined, true);
    assert(postEmailControls.recoveryAudit.some((log: any) => log.action === 'user.email_admin_changed'), 'old-email alert/admin-completed email change is audited');

    const setup2fa = await request('POST', `/api/users/${user.id}/2fa/setup`, {});
    await request('POST', `/api/users/${user.id}/2fa/enable`, { code: totp(setup2fa.manualEntryKey) });
    await request('PUT', `/api/users/${user.id}/2fa/recovery-questions`, { answers: [{ questionId: 'private_phrase', answer: 'Recovery phrase one' }, { questionId: 'mentor_name', answer: 'Mentor two' }] });
    token = '';
    const recoverySignin = await request('POST', '/api/auth/email/start', { email: `new-${email}`, intent: 'signin' });
    const recoveryChallenge = await request('POST', '/api/auth/email/verify', { email: `new-${email}`, code: recoverySignin.devCode });
    const recoveryVerification = await request('POST', '/api/auth/2fa/recovery-questions/verify', { twoFactorToken: recoveryChallenge.twoFactorToken, answers: [{ questionId: 'private_phrase', answer: 'recovery phrase one' }, { questionId: 'mentor_name', answer: 'mentor two' }] });
    assert(recoveryVerification.recoveryVerificationId, 'user recovery-question verification creates support reference');

    const reset = await request('POST', `/api/admin/users/${user.id}/account-controls/reset-2fa`, { reason: 'Customer lost authenticator and recovery codes', supportTicketId: 'sup_ticket_1', identityReverified: true, recoveryVerificationId: recoveryVerification.recoveryVerificationId, createTemporaryHold: true }, true);
    assert(reset.reset === true && reset.temporaryHoldCreated === true, 'admin can reset 2FA after recovery-question verification and create temporary hold');

    await app.close();
    console.log('\n✅ Account recovery admin E2E passed');
  } catch (error) { await app.close(); throw error; }
}
function assert(condition: unknown, message: string) { if (!condition) throw new Error(`Assertion failed: ${message}`); console.log(`✓ ${message}`); }
main().catch((error) => { console.error(error); process.exit(1); });

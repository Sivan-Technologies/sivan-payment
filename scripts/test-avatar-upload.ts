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
  async function request(method: string, url: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${url}`, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(json)}`);
    return (json.data ?? json) as any;
  }
  try {
    const email = `avatar-${Date.now()}@sivan.test`;
    const started = await request('POST', '/api/auth/email/start', { email, fullName: 'Avatar User', intent: 'signup', legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' } });
    const verified = await request('POST', '/api/auth/email/verify', { email, code: started.devCode });
    token = verified.token;
    const user = verified.user;
    assert(Boolean(user.id), 'user signs up');

    const upload = await request('POST', `/api/users/${user.id}/avatar/upload-url`, { fileName: 'avatar.png', contentType: 'image/png', sizeBytes: 1000 });
    assert(upload.objectKey.startsWith(`avatars/${user.id}/`), 'avatar upload key is user-scoped');
    assert(upload.publicUrl, 'avatar upload returns public URL in mock mode');

    const updated = await request('POST', `/api/users/${user.id}/avatar/confirm`, { objectKey: upload.objectKey, publicUrl: upload.publicUrl });
    assert(updated.avatarUrl === upload.publicUrl, 'avatar URL is saved on user');
    assert(updated.avatarObjectKey === upload.objectKey, 'avatar object key is saved on user');

    const removed = await request('DELETE', `/api/users/${user.id}/avatar`);
    assert(!removed.avatarUrl && !removed.avatarObjectKey, 'avatar can be removed');

    await app.close();
    console.log('\n✅ Avatar upload API E2E passed');
  } catch (error) { await app.close(); throw error; }
}
function assert(condition: unknown, message: string) { if (!condition) throw new Error(`Assertion failed: ${message}`); console.log(`✓ ${message}`); }
main().catch((error) => { console.error(error); process.exit(1); });

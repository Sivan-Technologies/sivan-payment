import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import worker from './cloudflare-worker-live-FIXED.js';

test('missing or invalid secret blocks requests without contacting upstreams', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Upstream must not be contacted');
  });
  for (const env of [undefined, {}, { PROXY_SECRET: '' }, { PROXY_SECRET: '   ' }, { PROXY_SECRET: 42 }]) {
    for (const path of ['/api/balances', '/health', '/health/deep', '/api/moneygram/health']) {
      const response = await worker.fetch(new Request(`https://gateway.example.test${path}`), env);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, 'gateway_not_configured');
    }
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('configured secret overrides caller-supplied proxy headers', async (t) => {
  const secret = randomBytes(32).toString('hex');
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.get('x-twilio-proxy-secret'), secret);
    assert.equal(options.headers.get('x-notify-secret'), secret);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const response = await worker.fetch(new Request('https://gateway.example.test/api/balances', {
    headers: { 'x-twilio-proxy-secret': 'untrusted', 'x-notify-secret': 'untrusted' },
  }), { PROXY_SECRET: secret });
  assert.equal(response.status, 200);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal((await response.text()).includes(secret), false);
});

test('liveness remains available without credentials', async () => {
  const response = await worker.fetch(new Request('https://gateway.example.test/ping'), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
});

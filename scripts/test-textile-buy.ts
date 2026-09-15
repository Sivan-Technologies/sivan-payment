import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { textileBuyRoutes } from '../src/offramp/api/textile-buy.routes.js';

const app = Fastify();
await textileBuyRoutes(app);
const original = globalThis.fetch;
const previous = process.env.TEXTILE_CREDIT_API_URL;
process.env.TEXTILE_CREDIT_API_URL = 'https://provider.invalid/v2';
let verified = false;
let creates = 0;
globalThis.fetch = async (input, options) => {
  const path = String(input);
  let data: unknown;
  if (path.includes('/providers?')) data = { providers: [{ provider: 'test', chainIds: [42220], sides: ['buy'] }] };
  else if (path.endsWith('/customers/kyc/status')) data = { kyc: { state: verified ? 'verified' : 'pending', canDeposit: verified } };
  else if (path.endsWith('/transfers')) {
    creates++;
    const body = JSON.parse(String(options?.body));
    assert.equal(body.side, 'buy'); assert.equal(body.token, 'CNGN');
    assert.equal(body.intentKey, 'test-intent-123');
    data = { transfer: { id: 'transfer123', status: 'AWAITING_FUNDS' }, claimToken: 'claim' };
  } else throw new Error(`Unexpected request ${path}`);
  return new Response(JSON.stringify(data), { status: 200 });
};
try {
  const body = { provider: 'test', wallet: `0x${'1'.repeat(40)}`, chainId: 42220, proof: { nonce: `0x${'2'.repeat(64)}`, signature: '0x1234', issuedAt: Date.now() }, amount: '1000', intentKey: 'test-intent-123', acceptedTerms: true };
  const pending = await app.inject({ method: 'POST', url: '/api/v1/buy-cngn/orders', payload: body });
  assert.equal(pending.statusCode, 422); assert.equal(creates, 0);
  verified = true;
  const unsupported = await app.inject({ method: 'POST', url: '/api/v1/buy-cngn/orders', payload: { ...body, chainId: 1 } });
  assert.equal(unsupported.statusCode, 422); assert.equal(creates, 0);
  const accepted = await app.inject({ method: 'POST', url: '/api/v1/buy-cngn/orders', payload: body });
  assert.equal(accepted.statusCode, 200); assert.equal(creates, 1);
  assert.equal(accepted.json().transfer.status, 'AWAITING_FUNDS');
  assert.equal(accepted.headers['cache-control'], 'no-store');
  console.log('Textile buy tests passed: KYC gate, chain gate, provider payload and status.');
} finally {
  globalThis.fetch = original;
  if (previous === undefined) delete process.env.TEXTILE_CREDIT_API_URL;
  else process.env.TEXTILE_CREDIT_API_URL = previous;
  await app.close();
}

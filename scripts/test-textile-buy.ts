import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { textileBuyRoutes } from '../src/offramp/api/textile-buy.routes.js';
import { PostgresBuyOrderStore } from '../src/offramp/service/textile-buy-store.js';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type pg from 'pg';

const app = Fastify();
const database = new PGlite();
await database.exec(await fs.readFile(new URL('../database/migrations/057_textile_buy_orders.sql', import.meta.url), 'utf8'));
const pool = { query: database.query.bind(database), connect: async () => ({ query: database.query.bind(database), release() {} }), end: async () => {} } as unknown as pg.Pool;
const oldKey = process.env.TEXTILE_BUY_STORAGE_KEY;
process.env.TEXTILE_BUY_STORAGE_KEY = crypto.randomBytes(32).toString('hex');
const store = new PostgresBuyOrderStore(pool);
await textileBuyRoutes(app, store);
const original = globalThis.fetch;
const previous = process.env.TEXTILE_CREDIT_API_URL;
process.env.TEXTILE_CREDIT_API_URL = 'https://provider.invalid/v2';
let verified = false;
let creates = 0;
let rejectProof = false;
let providerFailure = false;
globalThis.fetch = async (input, options) => {
  const path = String(input);
  let data: unknown;
  if (path.includes('/providers?')) data = { providers: [{ provider: 'test', chainIds: [42220], sides: ['buy'] }] };
  else if (path.endsWith('/customers/kyc/status')) {
    if (rejectProof) return new Response(JSON.stringify({ error: { code: 'invalid_proof', message: 'Signature expired', details: { reason: 'proof_of_control_expired', secret: 'must-not-escape' } } }), { status: 401 });
    data = { kyc: { state: verified ? 'verified' : 'pending', canDeposit: verified } };
  }
  else if (path.endsWith('/transfers')) {
    creates++;
    if (providerFailure) throw new Error('network response lost');
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
  const repeated = await app.inject({ method: 'POST', url: '/api/v1/buy-cngn/orders', payload: body });
  assert.equal(repeated.statusCode, 200); assert.equal(creates, 1);
  const mismatch = await app.inject({ method: 'POST', url: '/api/v1/buy-cngn/orders', payload: { ...body, amount: '2000' } });
  assert.equal(mismatch.statusCode, 409); assert.equal(creates, 1);
  const invalid = await app.inject({ method: 'POST', url: '/api/v1/buy-cngn/orders', payload: { ...body, amount: '-1' } });
  assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().error.code, 'invalid_input');
  const recover = () => app.inject({ method: 'POST', url: '/api/v1/buy-cngn/orders/recover', payload: body });
  const restored = await recover();
  assert.equal(restored.statusCode, 200); assert.equal(restored.json().orders[0].result.claimToken, 'claim');
  rejectProof = true;
  const denied = await recover();
  assert.equal(denied.statusCode, 401); assert.equal(denied.json().error.details.reason, 'proof_of_control_expired');
  assert.equal(denied.json().error.details.secret, undefined); assert.equal(denied.json().orders, undefined);
  rejectProof = false;
  const other = await app.inject({ method: 'POST', url: '/api/v1/buy-cngn/orders/recover', payload: { ...body, wallet: `0x${'3'.repeat(40)}` } });
  assert.deepEqual(other.json().orders, []);
  const stored = await database.query<{ encrypted_result: string }>('select encrypted_result from textile_buy_orders');
  assert(!stored.rows[0].encrypted_result.includes('claim'));
  // A new store instance recovers the same persisted row, independent of browser/session state.
  assert.equal((await new PostgresBuyOrderStore(pool).list(body))[0].result?.transfer.id, 'transfer123');
  providerFailure = true;
  const lost = await app.inject({ method: 'POST', url: '/api/v1/buy-cngn/orders', payload: { ...body, intentKey: 'lost-intent-123' } });
  assert.equal(lost.statusCode, 504);
  const pendingIntent = (await store.list(body)).find(row => row.intentKey === 'lost-intent-123');
  assert(pendingIntent); assert.equal(pendingIntent.result, null);
  assert.equal(pendingIntent.amount, '1000');
  const countBeforeStorageFailure = creates;
  const key = process.env.TEXTILE_BUY_STORAGE_KEY;
  delete process.env.TEXTILE_BUY_STORAGE_KEY;
  const noStorage = await app.inject({ method: 'POST', url: '/api/v1/buy-cngn/orders', payload: { ...body, intentKey: 'storage-test-123' } });
  assert.equal(noStorage.statusCode, 503); assert.equal(creates, countBeforeStorageFailure);
  process.env.TEXTILE_BUY_STORAGE_KEY = key;
  const missingClaim = await app.inject({ method: 'GET', url: '/api/v1/buy-cngn/orders/transfer123' });
  assert.equal(missingClaim.statusCode, 400);
  console.log('Passed: KYC/chain gates, encrypted SQL recovery, duplicate retry, amount conflict, validation 400, proof rejection, safe error details, wallet isolation, lost-response intent.');
} finally {
  globalThis.fetch = original;
  if (previous === undefined) delete process.env.TEXTILE_CREDIT_API_URL;
  else process.env.TEXTILE_CREDIT_API_URL = previous;
  await app.close();
  await database.close();
  if (oldKey === undefined) delete process.env.TEXTILE_BUY_STORAGE_KEY;
  else process.env.TEXTILE_BUY_STORAGE_KEY = oldKey;
}

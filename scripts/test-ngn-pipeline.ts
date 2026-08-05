import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { signUserJwt } from '../src/auth/jwt.js';
import { db } from '../src/database/json-database.js';

const now = new Date().toISOString();
const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;

async function req(path: string, options: any = {}, expected = 200) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const json = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${path} expected ${expected}, got ${response.status}: ${JSON.stringify(json)}`);
  return json.data ?? json;
}

const token = signUserJwt({ userId: 'usr_ngn', email: 'ngn@sivan.test' });
const authHeaders = { Authorization: `Bearer ${token}` };
const adminHeaders = { 'x-admin-api-key': process.env.ADMIN_API_KEY || 'ngn-admin' };

await db.mutate((data) => {
  data.users = [{ id: 'usr_ngn', email: 'ngn@sivan.test', fullName: 'NGN User', role: 'user', createdAt: now, updatedAt: now } as any];
  data.customers = [{ id: 'cus_ngn', userId: 'usr_ngn', provider: 'bridge', providerCustomerId: 'bridge_cus_ngn', kycStatus: 'kyc_approved', tosStatus: 'approved', createdAt: now, updatedAt: now } as any];
  // NGN access is now decided by Sivan's own verification, not by holding a
  // Bridge customer. A verified payout account is Level 1; this fixture quotes
  // NGN 150,000, which is above the Level 1 ceiling, so it relies on the Bridge
  // uplift - and that uplift requires Sivan's floor (bank + identity) to be met
  // as well, which is exactly what these two records represent.
  data.externalAccounts = [{ id: 'ext_ngn', userId: 'usr_ngn', customerId: 'cus_ngn', provider: 'bridge', providerExternalAccountId: 'bridge_ext_ngn', currency: 'ngn', status: 'verified', createdAt: now, updatedAt: now } as any];
  /**
   * A WALLET, because buying now requires somewhere to send the crypto.
   *
   * The on-ramp gained a guard - "Create your wallet before buying crypto, so
   * we have somewhere to send it" - and this fixture never seeded one, so the
   * quote step had been failing with a 400 ever since. The guard is correct:
   * an on-ramp with no destination address credits nobody. The fixture was
   * simply describing a user who can no longer exist.
   */
  data.userWallets = [{
    id: 'uw_ngn', userId: 'usr_ngn', customerId: 'cus_ngn', provider: 'mock',
    // SOLANA, matching BREET_DEFAULT_NETWORK - the quote resolves the
    // recipient wallet by network family, so a 'base' wallet does not satisfy
    // a Solana quote and the address would be silently omitted.
    providerWalletId: 'mock_ngn', chain: 'solana',
    address: 'EevL5P2e3j6p8vEkdxmaFPKf1pKrjigHBF3BGiD39nWm',
    status: 'active', custodial: false, createdAt: now, updatedAt: now,
  } as any];
  data.ngnControls = [];
  data.ngnQuotes = [];
  data.ngnTransfers = [];
  data.ngnWebhooks = [];
});

await req('/api/ngn/quote?userId=usr_ngn&direction=onramp&sourceCurrency=ngn&destinationCurrency=usdc&sourceAmount=150000', { headers: authHeaders }, 403);
console.log('✓ cannot quote NGN when disabled');

await req('/api/admin/ngn/controls', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ onrampEnabled: true, offrampEnabled: true, activeProvider: 'mock', mockProviderEnabled: true, bankSettlementEnabled: true, virtualAccountEnabled: true, updatedBy: 'ngn-test' }) });
console.log('✓ admin enables NGN on-ramp/off-ramp runtime controls');

const quote = await req('/api/ngn/quote?userId=usr_ngn&direction=onramp&sourceCurrency=ngn&destinationCurrency=usdc&sourceAmount=150000', { headers: authHeaders });
assert.equal(quote.direction, 'onramp');
assert.equal(quote.provider, 'mock');
assert.equal(quote.status, 'quote_created');
console.log('✓ user can request NGN quote');

const transfer = await req('/api/ngn/onramp/orders', { method: 'POST', headers: authHeaders, body: JSON.stringify({ userId: 'usr_ngn', quoteId: quote.id }) });
assert.equal(transfer.quoteId, quote.id);
assert.equal(transfer.status, 'awaiting_deposit');
assert.ok(transfer.timeline?.length >= 4);
console.log('✓ user can accept quote and mock provider creates transfer');
console.log('✓ status timeline exists');

const transfers = await req('/api/admin/ngn/transfers', { headers: adminHeaders });
assert.equal(transfers.length, 1);
console.log('✓ admin can view NGN transfers');

const health = await req('/api/admin/ngn/provider-health', { headers: adminHeaders });
assert.equal(health.active.provider, 'mock');
assert.equal(health.active.available, true);
console.log('✓ admin can view NGN provider health');

await app.close();
console.log(JSON.stringify({ ok: true, quoteId: quote.id, transferId: transfer.id, provider: transfer.provider }, null, 2));

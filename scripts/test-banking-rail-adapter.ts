/**
 * BANKING RAIL ADAPTER TEST SUITE
 *
 * Verifies Phase B (Mono) and Phase C (Gate 6 cashout) of the banking rail adapter.
 * All tests are hermetic — no real Paystack or Mono API calls.
 *
 * Run: npx tsx scripts/test-banking-rail-adapter.ts
 */

import crypto from 'node:crypto';
import assert from 'node:assert/strict';

// ─── Test utilities ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    passed++;
  } catch (err: any) {
    results.push({ name, ok: false, error: err?.message ?? String(err) });
    failed++;
  }
}

function printSection(title: string) {
  console.log(`\n══ ${title} ══`);
}

// ─── Setup env stubs (hermetic — no real API calls) ──────────────────────────

process.env.PAYSTACK_SECRET_KEY = 'sk_test_hermetic_test_suite_key_000000000000';
process.env.PAYSTACK_BASE_URL = 'http://127.0.0.1:19999';         // unreachable — tests don't call it
process.env.PAYSTACK_ALLOW_INSECURE_BASE_URL = 'true';
process.env.PAYSTACK_WEBHOOK_SECRET = 'test-webhook-secret-abcdef1234567890';
process.env.MONO_SECRET_KEY = 'mono_sk_test_hermetic_00000000000000000000000000';
process.env.MONO_WEBHOOK_SECRET = 'mono-webhook-secret-xyz9876543210';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5999/test';

// Import adapters AFTER env is set
const { PaystackBankingRailAdapter } = await import('../src/banking-rail/adapters/paystack.adapter.js');
const { MonoBankingRailAdapter } = await import('../src/banking-rail/adapters/mono.adapter.js');
const { getBankingRailAdapter, listRegisteredRails, getActiveBankingRailName } = await import('../src/banking-rail/banking-rail-registry.js');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Registry & Provider Switching
// ═══════════════════════════════════════════════════════════════════════════════

printSection('1. Banking Rail Registry & Provider Switching');

await test('registry returns paystack adapter by default', () => {
  const adapter = getBankingRailAdapter('paystack');
  assert.equal(adapter.name, 'paystack');
});

await test('registry returns mono adapter when requested', () => {
  const adapter = getBankingRailAdapter('mono');
  assert.equal(adapter.name, 'mono');
});

await test('listRegisteredRails includes paystack and mono', () => {
  const rails = listRegisteredRails();
  assert.ok(rails.includes('paystack'), 'paystack must be registered');
  assert.ok(rails.includes('mono'), 'mono must be registered');
});

await test('getActiveBankingRailName returns paystack by default', () => {
  delete process.env.BANKING_RAIL_PROVIDER;
  const name = getActiveBankingRailName();
  assert.equal(name, 'paystack');
});

await test('getActiveBankingRailName respects BANKING_RAIL_PROVIDER env var', () => {
  process.env.BANKING_RAIL_PROVIDER = 'mono';
  const name = getActiveBankingRailName();
  assert.equal(name, 'mono');
  delete process.env.BANKING_RAIL_PROVIDER;
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Paystack Adapter — verifyWebhookSignature
// ═══════════════════════════════════════════════════════════════════════════════

printSection('2. Paystack Adapter — Webhook Signature Verification');

const paystackAdapter = new PaystackBankingRailAdapter();
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET!;

function signPaystack(body: Buffer | string): string {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return crypto.createHmac('sha512', PAYSTACK_WEBHOOK_SECRET).update(raw).digest('hex');
}

await test('valid Paystack HMAC-SHA512 signature is accepted', () => {
  const body = Buffer.from(JSON.stringify({ event: 'charge.success' }));
  const sig = signPaystack(body);
  assert.ok(paystackAdapter.verifyWebhookSignature(body, { 'x-paystack-signature': sig }));
});

await test('tampered body fails Paystack signature check', () => {
  const body = Buffer.from(JSON.stringify({ event: 'charge.success' }));
  const sig = signPaystack(body);
  const tampered = Buffer.from(JSON.stringify({ event: 'transfer.success', amount: 9999999 }));
  assert.ok(!paystackAdapter.verifyWebhookSignature(tampered, { 'x-paystack-signature': sig }));
});

await test('missing signature header fails Paystack check', () => {
  const body = Buffer.from('{}');
  assert.ok(!paystackAdapter.verifyWebhookSignature(body, {}));
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Paystack Adapter — parseWebhookEvent
// ═══════════════════════════════════════════════════════════════════════════════

printSection('3. Paystack Adapter — parseWebhookEvent Typed Union');

await test('customeridentification.success maps to identity.success', () => {
  const payload = {
    event: 'customeridentification.success',
    data: {
      customer_code: 'CUS_test123',
      metadata: { sivanUserId: 'user_abc' },
    },
  };
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'identity.success');
  if (evt.type === 'identity.success') {
    assert.equal(evt.providerCustomerId, 'CUS_test123');
    assert.equal(evt.userId, 'user_abc');
  }
});

await test('customeridentification.failed maps to identity.failed', () => {
  const payload = {
    event: 'customeridentification.failed',
    data: {
      customer_code: 'CUS_test123',
      reason: 'BVN not found in NIBSS',
      metadata: { sivanUserId: 'user_abc' },
    },
  };
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'identity.failed');
  if (evt.type === 'identity.failed') {
    assert.equal(evt.reason, 'BVN not found in NIBSS');
  }
});

await test('charge.success dedicated_nuban NGN maps to deposit.received', () => {
  const payload = {
    event: 'charge.success',
    data: {
      channel: 'dedicated_nuban',
      currency: 'NGN',
      amount: 1000000, // 10,000 NGN in kobo
      reference: 'ref_abc123',
      customer: { customer_code: 'CUS_abc' },
    },
  };
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'deposit.received');
  if (evt.type === 'deposit.received') {
    assert.equal(evt.amountKobo, 1000000);
    assert.equal(evt.reference, 'ref_abc123');
    assert.equal(evt.currency, 'NGN');
    assert.equal(evt.providerCustomerId, 'CUS_abc');
  }
});

await test('charge.success non-NGN currency maps to ignored', () => {
  const payload = {
    event: 'charge.success',
    data: { channel: 'dedicated_nuban', currency: 'USD', amount: 5000, reference: 'ref_usd' },
  };
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'ignored');
});

await test('charge.success non-DVA channel maps to ignored', () => {
  const payload = {
    event: 'charge.success',
    data: { channel: 'card', currency: 'NGN', amount: 5000, reference: 'ref_card' },
  };
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'ignored');
});

await test('transfer.success maps to transfer.success', () => {
  const payload = {
    event: 'transfer.success',
    data: { reference: 'sivan_pay_ref_001', amount: 500000, transfer_code: 'TRF_abc' },
  };
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'transfer.success');
  if (evt.type === 'transfer.success') {
    assert.equal(evt.providerRef, 'sivan_pay_ref_001');
    assert.equal(evt.amountKobo, 500000);
  }
});

await test('transfer.failed maps to transfer.failed', () => {
  const payload = {
    event: 'transfer.failed',
    data: { reference: 'sivan_pay_ref_002', reason: 'Account number is invalid' },
  };
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'transfer.failed');
  if (evt.type === 'transfer.failed') {
    assert.equal(evt.reason, 'Account number is invalid');
  }
});

await test('transfer.reversed maps to transfer.reversed with correct kobo', () => {
  const payload = {
    event: 'transfer.reversed',
    data: { reference: 'sivan_pay_ref_003', amount: 250000 },
  };
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'transfer.reversed');
  if (evt.type === 'transfer.reversed') {
    assert.equal(evt.amountKobo, 250000);
  }
});

await test('unknown Paystack event maps to ignored', () => {
  const payload = { event: 'invoice.payment_failed', data: {} };
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'ignored');
  if (evt.type === 'ignored') assert.equal(evt.originalType, 'invoice.payment_failed');
});

await test('malformed JSON maps to ignored with parse_error', () => {
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from('not-json'));
  assert.equal(evt.type, 'ignored');
  if (evt.type === 'ignored') assert.equal(evt.originalType, 'parse_error');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Mono Adapter — verifyWebhookSignature
// ═══════════════════════════════════════════════════════════════════════════════

printSection('4. Mono Adapter — Webhook Signature Verification');

const monoAdapter = new MonoBankingRailAdapter();
const MONO_WEBHOOK_SECRET = process.env.MONO_WEBHOOK_SECRET!;

function signMono(body: Buffer | string): string {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return crypto.createHmac('sha512', MONO_WEBHOOK_SECRET).update(raw).digest('hex');
}

await test('valid Mono HMAC-SHA512 signature is accepted', () => {
  const body = Buffer.from(JSON.stringify({ event: 'mono.virtual_account.funded' }));
  const sig = signMono(body);
  assert.ok(monoAdapter.verifyWebhookSignature(body, { 'mono-webhook-signature': sig }));
});

await test('tampered body fails Mono signature check', () => {
  const body = Buffer.from(JSON.stringify({ event: 'mono.virtual_account.funded', data: { amount: 5000 } }));
  const sig = signMono(body);
  const tampered = Buffer.from(JSON.stringify({ event: 'mono.virtual_account.funded', data: { amount: 9999999 } }));
  assert.ok(!monoAdapter.verifyWebhookSignature(tampered, { 'mono-webhook-signature': sig }));
});

await test('wrong header name fails Mono signature check', () => {
  const body = Buffer.from('{}');
  const sig = signMono(body);
  // Using Paystack's header name — should fail
  assert.ok(!monoAdapter.verifyWebhookSignature(body, { 'x-paystack-signature': sig }));
});

await test('missing signature header fails Mono check', () => {
  assert.ok(!monoAdapter.verifyWebhookSignature(Buffer.from('{}'), {}));
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — Mono Adapter — parseWebhookEvent
// ═══════════════════════════════════════════════════════════════════════════════

printSection('5. Mono Adapter — parseWebhookEvent Typed Union');

await test('mono.virtual_account.funded maps to deposit.received with kobo amount', () => {
  const payload = {
    event: 'mono.virtual_account.funded',
    data: {
      id: 'mono_va_001',
      reference: 'user_xyz',
      currency: 'NGN',
      transaction: { amount: 750000, reference: 'mono_dep_ref_001' },
    },
  };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'deposit.received');
  if (evt.type === 'deposit.received') {
    assert.equal(evt.userId, 'user_xyz');
    assert.equal(evt.amountKobo, 750000);
    assert.equal(evt.reference, 'mono_dep_ref_001');
    assert.equal(evt.currency, 'NGN');
    assert.equal(evt.providerCustomerId, 'mono_va_001');
  }
});

await test('mono.virtual_account.funded with non-NGN currency is ignored', () => {
  const payload = {
    event: 'mono.virtual_account.funded',
    data: { id: 'va_001', reference: 'user_xyz', currency: 'USD', transaction: { amount: 5000 } },
  };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'ignored');
});

await test('mono.virtual_account.created maps to identity.success', () => {
  const payload = {
    event: 'mono.virtual_account.created',
    data: { id: 'mono_va_001', reference: 'user_abc' },
  };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'identity.success');
  if (evt.type === 'identity.success') {
    assert.equal(evt.userId, 'user_abc');
    assert.equal(evt.providerCustomerId, 'mono_va_001');
  }
});

await test('mono.virtual_account.bvn_verified maps to identity.success', () => {
  const payload = {
    event: 'mono.virtual_account.bvn_verified',
    data: { id: 'mono_va_002', reference: 'user_bvn_pass' },
  };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'identity.success');
});

await test('mono.virtual_account.bvn_failed maps to identity.failed', () => {
  const payload = {
    event: 'mono.virtual_account.bvn_failed',
    data: { id: 'mono_va_003', reference: 'user_bvn_fail', reason: 'BVN mismatch' },
  };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'identity.failed');
  if (evt.type === 'identity.failed') {
    assert.equal(evt.reason, 'BVN mismatch');
  }
});

await test('mono.transfer.successful maps to transfer.success', () => {
  const payload = {
    event: 'mono.transfer.successful',
    data: { reference: 'sivan_mono_ref_001', amount: 300000 },
  };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'transfer.success');
  if (evt.type === 'transfer.success') {
    assert.equal(evt.providerRef, 'sivan_mono_ref_001');
    assert.equal(evt.amountKobo, 300000);
  }
});

await test('mono.transfer.failed maps to transfer.failed', () => {
  const payload = {
    event: 'mono.transfer.failed',
    data: { reference: 'sivan_mono_ref_002', reason: 'Destination account inactive' },
  };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'transfer.failed');
});

await test('mono.transfer.reversed maps to transfer.reversed', () => {
  const payload = {
    event: 'mono.transfer.reversed',
    data: { reference: 'sivan_mono_ref_003', amount: 150000 },
  };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'transfer.reversed');
  if (evt.type === 'transfer.reversed') assert.equal(evt.amountKobo, 150000);
});

await test('mono.outward_payment.successful maps to transfer.success', () => {
  const payload = {
    event: 'mono.outward_payment.successful',
    data: { reference: 'sivan_mono_ref_004', amount: 200000 },
  };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'transfer.success');
});

await test('unknown Mono event maps to ignored', () => {
  const payload = { event: 'mono.some.other_event', data: {} };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'ignored');
  if (evt.type === 'ignored') assert.equal(evt.originalType, 'mono.some.other_event');
});

await test('malformed JSON maps to ignored', () => {
  const evt = monoAdapter.parseWebhookEvent(Buffer.from('{bad json'));
  assert.equal(evt.type, 'ignored');
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Phase C: Transfer Status Mapping (Paystack + Mono)
// ═══════════════════════════════════════════════════════════════════════════════

printSection('6. Phase C — Transfer Status Mapping Safety');

await test('Paystack transfer.success webhook produces transfer.success event', () => {
  const payload = { event: 'transfer.success', data: { reference: 'ref_001', amount: 100000 } };
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'transfer.success');
});

await test('Paystack transfer.reversed webhook produces transfer.reversed event with kobo', () => {
  const payload = { event: 'transfer.reversed', data: { reference: 'ref_002', amount: 50000 } };
  const evt = paystackAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'transfer.reversed');
  if (evt.type === 'transfer.reversed') assert.equal(evt.amountKobo, 50000);
});

await test('Mono transfer status mapping: "successful" → success', () => {
  const payload = { event: 'mono.transfer.successful', data: { reference: 'r', amount: 1000 } };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'transfer.success');
});

await test('Mono transfer status mapping: "reversed" → reversed with kobo amount', () => {
  const payload = { event: 'mono.transfer.reversed', data: { reference: 'r_rev', amount: 999 } };
  const evt = monoAdapter.parseWebhookEvent(Buffer.from(JSON.stringify(payload)));
  assert.equal(evt.type, 'transfer.reversed');
  if (evt.type === 'transfer.reversed') assert.equal(evt.amountKobo, 999);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — IBankingRailAdapter contract compliance check (structural)
// ═══════════════════════════════════════════════════════════════════════════════

printSection('7. IBankingRailAdapter Contract Compliance');

const REQUIRED_METHODS: Array<keyof import('../src/banking-rail/banking-rail.adapter.js').IBankingRailAdapter> = [
  'createCustomer',
  'verifyIdentity',
  'assignVirtualAccount',
  'listVirtualAccounts',
  'verifyWebhookSignature',
  'parseWebhookEvent',
  'createTransfer',
  'getTransfer',
  'health',
];

for (const method of REQUIRED_METHODS) {
  await test(`PaystackBankingRailAdapter implements ${method}()`, () => {
    assert.equal(typeof (paystackAdapter as any)[method], 'function', `${method} is not a function`);
  });
  await test(`MonoBankingRailAdapter implements ${method}()`, () => {
    assert.equal(typeof (monoAdapter as any)[method], 'function', `${method} is not a function`);
  });
}

await test('PaystackBankingRailAdapter.name is "paystack"', () => {
  assert.equal(paystackAdapter.name, 'paystack');
});

await test('MonoBankingRailAdapter.name is "mono"', () => {
  assert.equal(monoAdapter.name, 'mono');
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n');
for (const r of results) {
  if (r.ok) {
    console.log(`  ✅ ok - ${r.name}`);
  } else {
    console.log(`  ❌ FAIL - ${r.name}`);
    console.log(`         ${r.error}`);
  }
}

console.log(`\n📊 RESULTS: ${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);

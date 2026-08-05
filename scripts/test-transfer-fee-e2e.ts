/**
 * THE FEE, END TO END, OVER REAL HTTP.
 *
 * The policy suite proves the arithmetic and the ledger suite proves the money
 * balances. Neither proves the pieces are CONNECTED: that the admin control
 * actually reprices a transfer, that the quote endpoint answers the same number
 * the transfer charges, and that a change saved in the fee tab reaches the
 * send path without a redeploy.
 *
 * That last one is the whole point of the feature request - "add the control in
 * the fee tab where it can be dynamically changed" - and it is exactly the kind
 * of wiring that unit tests pass while the product does nothing.
 *
 * Boots the real app and drives it with fetch.
 *
 * Run: npm run test:transfer-fee-e2e
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const dbFile = path.join(root, '.data', 'test-transfer-fee-e2e.json');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const now = new Date().toISOString();
fs.writeFileSync(dbFile, JSON.stringify({
  users: [{ id: 'user_e2e', email: 'e2e@example.com', createdAt: now }],
  userWallets: [{
    id: 'wal_e2e', userId: 'user_e2e', provider: 'mock', providerWalletId: 'mock_e2e',
    chain: 'base', address: '0xE2E0000000000000000000000000000000000001',
    status: 'active', custodial: false, createdAt: now,
  }],
  walletControls: [{ id: 'singleton', activeProvider: 'mock', updatedAt: now }],
  auditLogs: [],
}));

const ADMIN_KEY = 'transfer-fee-e2e-admin-key';
Object.assign(process.env, {
  DATABASE_PROVIDER: 'json',
  DATABASE_FILE: dbFile,
  BALANCE_TRANSFERS_ENABLED: 'true',
  WALLET_PROVIDER: 'mock',
  ALLOW_MOCK_WALLETS: 'true',
  EMAIL_PROVIDER: 'console',
  BRIDGE_MOCK_MODE: 'true',
  ADMIN_API_KEY: ADMIN_KEY,
  AUTH_REQUIRE_USER: 'false',
  RATE_LIMIT_ENABLED: 'false',
  PORT: '3999',
});

const { buildApp } = await import('../src/app.js');
const { getWalletProvider } = await import('../src/wallets/provider/provider-registry.js');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

// Fund the mock wallet.
const provider = getWalletProvider('mock') as any;
provider.wallets?.set?.('mock_e2e', {
  providerWalletId: 'mock_e2e', chain: 'base',
  address: '0xE2E0000000000000000000000000000000000001',
  custodyModel: 'non_custodial',
  balances: [{ asset: 'usdc', chain: 'base', amount: '5000.000000' }],
});

const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;

const get = async (p: string, admin = false) => {
  // Admin reads are key-gated too, not just writes - app.ts checks
  // x-admin-api-key on the whole /api/admin surface.
  const r = await fetch(`${base}${p}`, admin ? { headers: { 'x-admin-api-key': ADMIN_KEY } } : undefined);
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
};
const post = async (p: string, body: unknown) => {
  const r = await fetch(`${base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
};
const put = async (p: string, body: unknown) => {
  const r = await fetch(`${base}${p}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-admin-api-key': ADMIN_KEY },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
};

try {
  console.log('\n── the quote endpoint answers ────────────────────────────────');

  const q100 = await get('/api/balance/transfers/quote?amount=100');
  check('GET quote returns 200', q100.status === 200, String(q100.status));
  check('a 100 transfer quotes a 0.50 fee', Number(q100.body?.data?.fee) === 0.5, JSON.stringify(q100.body?.data));
  check('and nets 99.50', Number(q100.body?.data?.netAmount) === 99.5);
  check('the effective rate is stated for the UI', q100.body?.data?.effectivePercent === '0.50',
    q100.body?.data?.effectivePercent);
  check('the applied rule is named', q100.body?.data?.appliedRule === 'percent');

  const q10 = await get('/api/balance/transfers/quote?amount=10');
  check('a 10 transfer hits the floor', Number(q10.body?.data?.fee) === 0.25, JSON.stringify(q10.body?.data));
  check('and reports 2.50% rather than the nominal 0.5%',
    q10.body?.data?.effectivePercent === '2.50',
    'the UI must show what is actually charged, not the headline rate');

  const q5000 = await get('/api/balance/transfers/quote?amount=5000');
  check('a 5000 transfer hits the cap', Number(q5000.body?.data?.fee) === 1, JSON.stringify(q5000.body?.data));

  const qBad = await get('/api/balance/transfers/quote?amount=abc');
  check('a nonsense amount does not 500', qBad.status === 200, String(qBad.status));
  check('and quotes zero rather than NaN', Number(qBad.body?.data?.fee) === 0, JSON.stringify(qBad.body?.data));

  console.log('\n── the new-recipient surcharge over HTTP ─────────────────────');

  /**
   * No destinationAddress: the quote cannot know whether the recipient exists,
   * so it returns the base fee and the UI shows the surcharge as conditional.
   */
  const qBase = await get('/api/balance/transfers/quote?amount=10');
  check('a quote with no destination returns the base fee only',
    Number(qBase.body?.data?.fee) === 0.25 && Number(qBase.body?.data?.newRecipientFee) === 0,
    JSON.stringify(qBase.body?.data));
  check('and says so explicitly', qBase.body?.data?.createsRecipientAccount === false);

  check('the base fee is reported separately from the total',
    qBase.body?.data?.baseFee !== undefined,
    'the UI needs both to explain the difference');

  console.log('\n── the published table, over HTTP ────────────────────────────');

  for (const [amount, expected] of [[10, 0.25], [50, 0.25], [100, 0.5], [1000, 1]] as const) {
    const q = await get(`/api/balance/transfers/quote?amount=${amount}`);
    check(`$${amount} quotes $${expected}`, Number(q.body?.data?.fee) === expected,
      `got ${q.body?.data?.fee}`);
  }

  console.log('\n── the quote matches what is actually charged ────────────────');

  const made = await post('/api/users/user_e2e/balance/transfers', {
    asset: 'usdc', network: 'base', amount: 100,
    destinationAddress: '0xAAA0000000000000000000000000000000000002',
  });
  check('the transfer is created', made.status === 200 || made.status === 201, String(made.status));
  check('the fee charged equals the fee quoted',
    Number(made.body?.data?.fee) === Number(q100.body?.data?.fee),
    `charged ${made.body?.data?.fee} vs quoted ${q100.body?.data?.fee}`);
  check('the net charged equals the net quoted',
    Number(made.body?.data?.netAmount) === Number(q100.body?.data?.netAmount));

  console.log('\n── the fee appears on the transfer record the UI reads ───────');

  const list = await get('/api/users/user_e2e/balance/transfers');
  const row = (list.body?.data ?? []).find((t: any) => t.transferId === made.body?.data?.transferId);
  check('the transfer list carries the fee', Number(row?.fee) === 0.5, JSON.stringify(row?.fee));
  check('and the net amount', Number(row?.netAmount) === 99.5, JSON.stringify(row?.netAmount));

  console.log('\n── THE POINT OF THE FEATURE: change it in admin, live ────────');

  /**
   * No redeploy, no restart. If this fails, the fee tab is decorative - which
   * is precisely what the balance-transfer controls looked like before this
   * work, and what networkFees still is.
   */
  const current = await get('/api/admin/fees/settings', true);
  check('admin fee settings are readable', current.status === 200, String(current.status));
  check('they expose the transfer fee', current.body?.data?.transferFeePercent === 0.5,
    JSON.stringify(current.body?.data?.transferFeePercent));

  const updated = await put('/api/admin/fees/settings', {
    ...current.body.data,
    transferFeePercent: 1.5,
    transferFeeMinimumUsd: 0.25,
    transferFeeMaximumUsd: 3,
    transferMinimumSendAmount: 8,
    updatedBy: 'e2e-test',
    reason: 'End-to-end verification that the control is live',
  });
  check('the update is accepted', updated.status === 200, JSON.stringify(updated.body).slice(0, 200));

  const q100after = await get('/api/balance/transfers/quote?amount=100');
  check('the quote reprices IMMEDIATELY, with no redeploy',
    Number(q100after.body?.data?.fee) === 1.5,
    `expected 1.50 at the new 1.5%, got ${q100after.body?.data?.fee}`);

  const made2 = await post('/api/users/user_e2e/balance/transfers', {
    asset: 'usdc', network: 'base', amount: 100,
    destinationAddress: '0xBBB0000000000000000000000000000000000003',
  });
  check('and a real transfer is charged the NEW fee',
    Number(made2.body?.data?.fee) === 1.5,
    `charged ${made2.body?.data?.fee}`);
  check('netting 98.50 to the recipient', Number(made2.body?.data?.netAmount) === 98.5);

  console.log('\n── the minimum send amount is live too ───────────────────────');

  const tooSmall = await post('/api/users/user_e2e/balance/transfers', {
    asset: 'usdc', network: 'base', amount: 7,
    destinationAddress: '0xCCC0000000000000000000000000000000000004',
  });
  check('a $7 send is refused under the new $8 minimum',
    tooSmall.status >= 400,
    `${tooSmall.status} - the admin minimum must gate the send path`);
  check('and the refusal names the limit',
    /8/.test(JSON.stringify(tooSmall.body)),
    JSON.stringify(tooSmall.body).slice(0, 160));

  console.log('\n── ethereum stays refused ────────────────────────────────────');

  const eth = await post('/api/users/user_e2e/balance/transfers', {
    asset: 'usdc', network: 'ethereum', amount: 100,
    destinationAddress: '0xDDD0000000000000000000000000000000000005',
  });
  check('an ethereum transfer is refused over HTTP', eth.status >= 400, String(eth.status));

  console.log('\n── switching the fee off entirely works ──────────────────────');

  await put('/api/admin/fees/settings', {
    ...current.body.data,
    transferFeePercent: 0, transferFeeMinimumUsd: 0, transferFeeMaximumUsd: 0,
    transferMinimumSendAmount: 5,
    updatedBy: 'e2e-test', reason: 'Verify the fee can be disabled',
  });
  const qFree = await get('/api/balance/transfers/quote?amount=100');
  check('a zeroed configuration charges nothing',
    Number(qFree.body?.data?.fee) === 0,
    `${qFree.body?.data?.fee} - an operator must be able to turn the fee off`);
  check('and the full amount reaches the recipient',
    Number(qFree.body?.data?.netAmount) === 100);
} finally {
  await app.close();
  fs.rmSync(dbFile, { force: true });
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

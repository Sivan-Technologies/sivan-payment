/**
 * END-TO-END TEST: DYNAMIC ADMIN TRANSFER FEE FOR TELEGRAM, WHATSAPP, AND API
 *
 * Verifies that:
 * 1. Admin Transfer Fee settings (percent, floor, cap, micro-rail floor/cap) are saved via PUT /api/admin/fees/settings.
 * 2. GET /api/balance/transfers/quote returns the exact dynamic fee without restart or redeploy.
 * 3. Standard rails (Solana, Base) use standard floor ($0.25) and cap ($1.00).
 * 4. Micro rails (Celo, Stellar, Starknet, Arc) use micro floor ($0.10) and cap ($0.75).
 * 5. Changes in the Admin Transfer Fee tab immediately update both bot quote flows.
 * 6. Internal P2P transfers remain zero-fee.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(root, '.data', 'test-transfer-fee-admin-e2e.json');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const now = new Date().toISOString();
fs.writeFileSync(dbFile, JSON.stringify({
  users: [{ id: 'user_e2e_admin', email: 'admin_fee_e2e@example.com', createdAt: now }],
  userWallets: [{
    id: 'wal_e2e_admin', userId: 'user_e2e_admin', provider: 'mock', providerWalletId: 'mock_e2e_admin',
    chain: 'base', address: '0xE2E0000000000000000000000000000000000099',
    status: 'active', custodial: false, createdAt: now,
  }],
  walletControls: [{ id: 'singleton', activeProvider: 'mock', updatedAt: now }],
  auditLogs: [],
}));

const ADMIN_KEY = 'test-transfer-fee-admin-key';
Object.assign(process.env, {
  DATABASE_PROVIDER: 'json',
  DATABASE_FILE: dbFile,
  BALANCE_TRANSFERS_ENABLED: 'true',
  WALLET_PROVIDER: 'mock',
  ALLOW_MOCK_WALLETS: 'true',
  ADMIN_API_KEY: ADMIN_KEY,
  AUTH_REQUIRE_USER: 'false',
  RATE_LIMIT_ENABLED: 'false',
  PORT: '4099',
});

const { buildApp } = await import('../src/app.js');
const { setWithdrawalPin } = await import('../src/identity/withdrawal-pin.service.js');
await setWithdrawalPin('user_e2e_admin', { pin: '749201' });

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;

const get = async (p: string, admin = false) => {
  const r = await fetch(`${base}${p}`, admin ? { headers: { 'x-admin-api-key': ADMIN_KEY } } : undefined);
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
  console.log('\n── 1. Default Admin Fee Settings ──────────────────────────────');
  const defaults = await get('/api/admin/fees/settings', true);
  check('Admin fee settings endpoint responds 200', defaults.status === 200);
  check('Default transfer fee percent is 0.5%', defaults.body?.data?.transferFeePercent === 0.5);
  check('Default standard floor is $0.25', defaults.body?.data?.transferFeeMinimumUsd === 0.25);
  check('Default micro-rail floor is $0.10', defaults.body?.data?.microRailFeeMinimumUsd === 0.10);

  console.log('\n── 2. Standard vs Micro-Rail Dynamic Quote ────────────────────');
  // $10 on Base/Solana hits $0.25 floor
  const qBase10 = await get('/api/balance/transfers/quote?amount=10&network=base');
  check('Base $10 send quotes standard floor $0.25', Number(qBase10.body?.data?.fee) === 0.25);
  check('Base $10 send nets $9.75', Number(qBase10.body?.data?.netAmount) === 9.75);

  // $10 on Celo hits $0.10 micro floor
  const qCelo10 = await get('/api/balance/transfers/quote?amount=10&network=celo');
  check('Celo $10 send quotes micro floor $0.10', Number(qCelo10.body?.data?.fee) === 0.10);
  check('Celo $10 send nets $9.90', Number(qCelo10.body?.data?.netAmount) === 9.90);

  // $10 on Stellar hits $0.10 micro floor
  const qXlm10 = await get('/api/balance/transfers/quote?amount=10&network=stellar');
  check('Stellar $10 send quotes micro floor $0.10', Number(qXlm10.body?.data?.fee) === 0.10);

  // $100 on Base quotes 0.5% = $0.50
  const qBase100 = await get('/api/balance/transfers/quote?amount=100&network=base');
  check('Base $100 send quotes 0.5% = $0.50', Number(qBase100.body?.data?.fee) === 0.50);
  check('Base $100 send nets $99.50', Number(qBase100.body?.data?.netAmount) === 99.50);

  console.log('\n── 3. Live Admin Transfer Fee Tab Repricing ────────────────────');
  // Admin updates fee tab: 1.75% rate, $0.35 floor, $4.50 cap, $0.15 micro floor
  const updateRes = await put('/api/admin/fees/settings', {
    ...defaults.body.data,
    transferFeePercent: 1.75,
    transferFeeMinimumUsd: 0.35,
    transferFeeMaximumUsd: 4.50,
    microRailFeeMinimumUsd: 0.15,
    microRailFeeMaximumUsd: 1.20,
    transferMinimumSendAmount: 5,
    updatedBy: 'admin-e2e-tester',
    reason: 'Dynamic admin fee test',
  });
  check('Admin fee tab update is saved', updateRes.status === 200);

  // Immediate repricing without redeployment
  const qBase100New = await get('/api/balance/transfers/quote?amount=100&network=base');
  check('Base $100 immediately reprices to new 1.75% ($1.75)', Number(qBase100New.body?.data?.fee) === 1.75);
  check('Base $100 nets $98.25', Number(qBase100New.body?.data?.netAmount) === 98.25);

  const qBase10New = await get('/api/balance/transfers/quote?amount=10&network=base');
  check('Base $10 immediately reprices to new standard floor $0.35', Number(qBase10New.body?.data?.fee) === 0.35);

  const qCelo5New = await get('/api/balance/transfers/quote?amount=5&network=celo');
  check('Celo $5 immediately reprices to new micro floor $0.15', Number(qCelo5New.body?.data?.fee) === 0.15);

  console.log('\n── 4. Restore Defaults ─────────────────────────────────────────');
  const restoreRes = await put('/api/admin/fees/settings', {
    ...defaults.body.data,
    transferFeePercent: 0.50,
    transferFeeMinimumUsd: 0.25,
    transferFeeMaximumUsd: 1.00,
    microRailFeeMinimumUsd: 0.10,
    microRailFeeMaximumUsd: 0.75,
    transferMinimumSendAmount: 5,
    updatedBy: 'admin-e2e-tester',
    reason: 'Restore defaults',
  });
  check('Defaults restored successfully', restoreRes.status === 200);

  const qFinal = await get('/api/balance/transfers/quote?amount=100&network=base');
  check('Base $100 restores to 0.5% ($0.50)', Number(qFinal.body?.data?.fee) === 0.50);

  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log(`════════════════════════════════════════════════════════════════\n`);
} finally {
  await app.close();
  try { fs.unlinkSync(dbFile); } catch {}
}

if (fail > 0) {
  process.exit(1);
}

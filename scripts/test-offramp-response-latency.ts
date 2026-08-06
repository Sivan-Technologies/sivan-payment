/**
 * CREATING AN OFF-RAMP ORDER MUST NOT WAIT FOR A BLOCKCHAIN.
 *
 * Reported from the console, with a screenshot of the Review screen:
 *
 *     POST /api/ngn/offramp/orders 503 (Service Unavailable)
 *     "The payments-api service did not respond. This was a POST request and
 *      it was NOT retried, because repeating it could duplicate the action.
 *      Check whether it took effect before trying again."
 *
 * That toast is the Cloudflare worker at UPSTREAM_TIMEOUT_MS = 12000 giving
 * up. It is NOT the API refusing - the order had already been created. The
 * user was shown a failure for something that had happened, on a money screen,
 * with no safe way to tell: retry and you may duplicate, wait and you cannot
 * confirm.
 *
 * Both endpoints were verified reachable and fast at the time (test API /ping
 * 0.12s, gateway /health 0.20s), so the slowness was inside this one handler.
 *
 * CAUSE: acceptNgnQuote awaited sweepToRail, which puts an ON-CHAIN TRANSFER
 * inside an HTTP request:
 *
 *     findUserWalletForNetwork    db
 *     getSpendable                reads EVERY wallet on EVERY network it
 *                                 serves - one EVM wallet means an ethereum
 *                                 read AND a base read, plus solana
 *     createTransfer              Privy signs and broadcasts
 *
 * Measured individually these are fast (Privy 0.21s, Solana 0.12s, Base
 * 0.14s), but they are serial and any one stalling spends the whole budget.
 *
 * FIX: schedule the sweep and return as soon as the ORDER exists. Safe because
 * the sweep was already designed to fail - it was already non-fatal, its
 * createTransfer is keyed `ngnsweep_${id}` so it cannot run twice, and
 * ngn-settlement-reconciler already polls and only moves a transfer forward.
 *
 * Run: npm run test:offramp-response-latency
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-offramp-latency.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'latency-admin-key';
process.env.USER_JWT_SECRET = 'latency-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.NGN_PROVIDER = 'mock';

import fs from 'node:fs';
fs.rmSync('.data/test-offramp-latency.json', { force: true });

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { updateNgnControls } = await import('../src/ngn/service/ngn-controls.service.js');
const { signUserJwt } = await import('../src/auth/jwt.js');

const now = new Date().toISOString();
await db.insertUserRecord({ id: 'usr_lat', email: 'lat@sivan.test', fullName: 'Sharafa Ogunmepon', country: 'NG', createdAt: now } as any);
await db.upsertNgnPayoutAccountRecord({
  id: 'ngnpa_lat', userId: 'usr_lat', bankId: '1', bankName: 'Access Bank',
  accountNumber: '1111111111', accountName: 'OGUNMEPON SHARAFA', accountLast4: '1111',
  status: 'verified', currency: 'ngn', createdAt: now, updatedAt: now,
} as any);
await db.insertUserWallet({
  id: 'uw_lat', userId: 'usr_lat', provider: 'mock', providerWalletId: 'mock_solana',
  chain: 'solana', address: 'EevL5P2e3j6p8vEkdxmaFPKf1pKrjigHBF3BGiD39nWm', status: 'active',
  custodial: false, delegatedSigningEnabled: true, createdAt: now, updatedAt: now,
} as any);
await updateNgnControls({ activeProvider: 'mock', offrampEnabled: true, onrampEnabled: true, mockProviderEnabled: true, updatedBy: 'test' } as any);

const { buildApp } = await import('../src/app.js');
const app = await buildApp();
const token = signUserJwt({ userId: 'usr_lat', email: 'lat@sivan.test' });
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

console.log('\n── the handler returns without awaiting the chain ────────────');

const quoteResponse = await app.inject({
  method: 'GET',
  url: '/api/ngn/quote?userId=usr_lat&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=20&network=solana',
  headers,
});
check('a quote is created', quoteResponse.statusCode === 200, String(quoteResponse.statusCode));
const quoteId = (quoteResponse.json() as any)?.data?.id;

const started = Date.now();
const orderResponse = await app.inject({
  method: 'POST',
  url: '/api/ngn/offramp/orders',
  headers,
  payload: { userId: 'usr_lat', quoteId, payoutAccountId: 'ngnpa_lat' },
});
const elapsedMs = Date.now() - started;

check('the order is created', orderResponse.statusCode === 200, String(orderResponse.statusCode));

/**
 * THE ASSERTION THAT MATTERS.
 *
 * The Cloudflare worker allows 12000ms. Asserting well under it rather than
 * at it, because the margin is the point: this budget is shared with cold
 * starts and a slow public RPC, and a handler that only just fits will fail
 * again the first time anything is slower than today.
 *
 * In-process against a mock wallet this should be a few hundred ms. The value
 * of the assertion is that it FAILS if anyone re-adds an await on the sweep,
 * because the mock provider still does real work.
 */
check(`the response returns in well under the 12s worker budget (${elapsedMs}ms)`,
  elapsedMs < 3000,
  `${elapsedMs}ms - UPSTREAM_TIMEOUT_MS is 12000 and POSTs are NOT retried`);

const order = (orderResponse.json() as any)?.data;
check('the response carries the order id', Boolean(order?.id), JSON.stringify(order).slice(0, 120));
check('and the deposit address the user needs', Boolean(order?.depositAddress),
  'this is what the 503 was hiding from them');

console.log('\n── the sweep is scheduled, not awaited ───────────────────────');

const src = fs.readFileSync('src/ngn/service/ngn-transfers.service.ts', 'utf8');
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * Scoped to acceptNgnQuote's OWN body. `await sweepToRail(...)` is still
 * correct INSIDE scheduleSweep - that is the detached task, and it must await
 * its own work. The first version of this assertion searched the whole file
 * and failed on that legitimate await, which would have pushed me to write
 * worse code to satisfy a bad test.
 */
const acceptBody = stripped.slice(
  stripped.indexOf('export async function acceptNgnQuote'),
  stripped.indexOf('function scheduleSweep')
);
check('acceptNgnQuote no longer awaits sweepToRail',
  !/await sweepToRail\(/.test(acceptBody),
  'awaiting an on-chain transfer inside an HTTP handler is the whole bug');
check('the sweep is scheduled instead',
  /scheduleSweep\(transfer\)/.test(stripped));
check('it runs on a later tick, after the response',
  /setImmediate\(/.test(stripped),
  'a floating promise started before the return can still delay it');

/**
 * A detached task that throws takes the process down in Node 15+. Losing the
 * API over a slow RPC would be a worse bug than the one being fixed.
 */
check('the detached task cannot crash the process',
  /catch \(error\)[\s\S]{0,400}ngn\.sweep_failed/.test(stripped),
  'an unhandled rejection in a detached task terminates Node');
check('even the audit write cannot rethrow',
  /\}\)\.catch\(\(\) =>/.test(stripped),
  'the last statement in the failure path is itself allowed to fail');

console.log('\n── the sweep still actually happens ──────────────────────────');

// Give the scheduled task a moment to run.
await new Promise((resolve) => setTimeout(resolve, 1500));

const auditLogs = await db.listAuditLogsByActions([
  'ngn.sweep_submitted', 'ngn.sweep_skipped', 'ngn.sweep_failed',
]);
check('the sweep ran after the response was sent',
  auditLogs.length > 0,
  'scheduling it must not mean silently dropping it');

/**
 * Idempotency is what makes scheduling safe: if this attempt is lost to a
 * restart, the reconciler retries, and the key stops a double send.
 */
check('the sweep transfer is keyed so it cannot run twice',
  /idempotencyKey: `ngnsweep_\$\{transfer\.id\}`/.test(src),
  'a retry that sweeps twice would send the user\'s money twice');

console.log('\n── the order survives a sweep failure ────────────────────────');

const stored = (await db.listNgnTransfers()).find((row: any) => row.id === order?.id);
check('the order exists in the database regardless', Boolean(stored),
  'the order must never be lost to a recoverable RPC error');
check('and it kept its deposit address',
  Boolean(stored?.depositAddress),
  'the manual route still works even when the sweep does not');

await app.close();

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

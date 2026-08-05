/**
 * "AN ERROR TOAST CAME BUT THE TRANSFER STILL WENT THROUGH."
 *
 * Reported with a 503 on POST .../balance/transfers, and the observation that
 * the send happened anyway.
 *
 * MEASURED, NOT GUESSED. The Cloudflare worker in front of this API aborts an
 * upstream request at UPSTREAM_TIMEOUT_MS = 12000 (cloudflare-worker-test-
 * DEPLOY.js:78). A POST is deliberately not retried, so the worker returns
 * 503 UPSTREAM_UNAVAILABLE "...it was NOT retried" - while the request
 * CONTINUES running on Render. The send really did happen; only the answer was
 * discarded.
 *
 * Why a send can exceed 12s: getSpendable reads the chain on every network the
 * wallet serves, getWallet is a privyRequest whose IN_PROGRESS backoff alone
 * sums to 9.45s (150+300+600+1200+2400+4800), buildSplTransfer makes another
 * RPC to check the recipient's token account, and only then does
 * signAndSendTransaction run.
 *
 * THE FIX: race the broadcast against a deadline BELOW the gateway's. The
 * broadcast is never cancelled - there is no way to un-send a signed
 * transaction - we simply stop waiting and report it as submitted.
 *
 * WHAT MUST NOT HAPPEN, and what this test exists to prevent:
 *   - releasing the hold on timeout. The old catch did, so a send about to
 *     succeed had its money handed back on paper while the coins left the
 *     wallet. The ledger and the chain disagreeing is worse than a slow reply.
 *   - reporting 'failed'. That makes a user send again, and there is no recall
 *     on chain for the duplicate.
 *
 * Run: npm run test:transfer-response-deadline
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';
import { getWalletProvider } from '../src/wallets/provider/provider-registry.js';
import { nowIso } from '../src/shared/id.js';

let p = 0, f = 0;
const ck = (n: string, ok: unknown, d = '') => { ok ? (p++, console.log('  ok   ' + n)) : (f++, console.log('  FAIL ' + n + (d ? ' -> ' + d : ''))); };

const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
await fs.rm(dbPath, { force: true });

const app = await buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const addr: any = app.server.address();
const base = `http://127.0.0.1:${addr.port}`;
let token = '';

async function req(m: string, u: string, b?: unknown, h: Record<string,string> = {}) {
  const r = await fetch(base + u, { method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...h }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) as any };
}

const email = `deadline-${Date.now()}@sivan.test`;
const s = await req('POST', '/api/auth/email/start', { email, fullName: 'Deadline Test', intent: 'signup', legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' } });
const v = await req('POST', '/api/auth/email/verify', { email, code: s.body.data.devCode });
token = v.body.data.token;
const userId = v.body.data.user.id;

await req('PUT', '/api/admin/balance/controls', { transfersEnabled: true, minimumSendAmount: 5, manualReviewThreshold: 1000, riskHoldsEnabled: true, supportedNetworks: ['base','solana','ethereum'], updatedBy: 'test', reason: 'Deadline behaviour test' }, { 'x-admin-api-key': 'deadline-admin-key' });

const provider: any = getWalletProvider('mock');
const pw = await provider.createWallet({ userId, chain: 'base', idempotencyKey: `dl-${userId}` });
await db.insertUserWallet({ id: `uw_${userId}`, userId, provider: 'mock', providerWalletId: pw.providerWalletId, chain: 'base', address: pw.address, status: 'active', custodial: false, delegatedSigningEnabled: true, createdAt: nowIso(), updatedAt: nowIso() } as any);
await provider.__seedBalance(pw.providerWalletId, { asset: 'usdc', chain: 'base', amount: '100' });

console.log('\n── a fast broadcast is unchanged ──────────────────────────────');
const fast = await req('POST', `/api/users/${userId}/balance/transfers`, { asset: 'usdc', network: 'base', amount: 10, destinationAddress: '0x6d7D2Eb4667395437739634D3382A90Fff238295' });
ck('returns 200', fast.status === 200, String(fast.status));
ck('reaches the provider', fast.body.data?.status === 'processing', String(fast.body.data?.status));
ck('and carries a provider id', Boolean(fast.body.data?.providerTransferId));

console.log('\n── a SLOW broadcast answers in time instead of 503-ing ────────');
// Make the provider slower than the deadline. This is exactly the Privy
// IN_PROGRESS backoff case, reproduced without waiting on a vendor.
const realCreate = provider.createTransfer.bind(provider);
provider.createTransfer = async (i: any) => { await new Promise((r) => setTimeout(r, 2500)); return realCreate(i); };

const started = Date.now();
const slow = await req('POST', `/api/users/${userId}/balance/transfers`, { asset: 'usdc', network: 'base', amount: 10, destinationAddress: '0x6d7D2Eb4667395437739634D3382A90Fff238295' });
const elapsed = Date.now() - started;
ck('still returns 200, not an error', slow.status === 200, String(slow.status));
ck(`answers within the 1s test deadline (took ${elapsed}ms)`, elapsed < 2000, `${elapsed}ms`);
ck('reports processing, NOT failed', slow.body.data?.status === 'processing', String(slow.body.data?.status));

// The whole point: the coins are leaving, so the hold must stay.
const led1 = await req('GET', `/api/users/${userId}/balance/ledger`);
const forSlow = (led1.body.data as any[]).filter((e) => e.transferId === slow.body.data.transferId);
ck('a hold was placed', forSlow.some((e) => e.kind === 'hold'));
ck('the hold is NOT released while the send is in flight',
  !forSlow.some((e) => e.kind === 'hold_release'),
  'releasing it would credit money that is leaving the wallet');

const logs1 = await db.read();
ck('a slow_broadcast warning is recorded for operators',
  (logs1.auditLogs ?? []).some((l) => l.action === 'balance.transfer_slow_broadcast'));
ck('it is NOT recorded as failed',
  !(logs1.auditLogs ?? []).some((l) => l.action === 'balance.transfer_failed' && (l.metadata as any)?.transferId === slow.body.data.transferId));

console.log('\n── and the send genuinely completes afterwards ────────────────');
await new Promise((r) => setTimeout(r, 3000));
const after = await db.read();
const submitted = (after.auditLogs ?? []).filter((l) => l.action === 'balance.transfer_submitted' && (l.metadata as any)?.transferId === slow.body.data.transferId);
ck('the broadcast was never cancelled - it finished', submitted.length === 1, `submitted events: ${submitted.length}`);
const led2 = await req('GET', `/api/users/${userId}/balance/ledger`);
const forSlow2 = (led2.body.data as any[]).filter((e) => e.transferId === slow.body.data.transferId);
ck('the hold became a debit once it landed', forSlow2.some((e) => e.kind === 'debit_transfer'));
const list = await req('GET', `/api/users/${userId}/balance/transfers`);
const row = (list.body.data as any[]).find((t) => t.transferId === slow.body.data.transferId);
ck('the list shows the finished state, not the timed-out one', row?.status === 'processing', String(row?.status));
ck('and it now carries the provider id it lacked at response time', Boolean(row?.providerTransferId));

console.log('\n── a genuinely failing broadcast still refunds ────────────────');
provider.createTransfer = async () => { throw new Error('provider exploded'); };
const bad = await req('POST', `/api/users/${userId}/balance/transfers`, { asset: 'usdc', network: 'base', amount: 10, destinationAddress: '0x6d7D2Eb4667395437739634D3382A90Fff238295' });
ck('a real failure is still an error', bad.status >= 400, String(bad.status));
const led3 = await req('GET', `/api/users/${userId}/balance/ledger`);
const failedRelease = (led3.body.data as any[]).filter((e) => e.kind === 'hold_release');
ck('and the hold IS released when it truly failed', failedRelease.length >= 1);

await app.close();
console.log(`\n${f === 0 ? '✅' : '❌'} ${p} passed, ${f} failed\n`);
process.exit(f === 0 ? 0 : 1);

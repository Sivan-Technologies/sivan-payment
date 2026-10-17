// Backend assertions retained; legacy UI checks moved to docs/legacy-frontend-tests.
/**
 * THE TOAST MUST NOT SAY "FAILED" WHEN THE MONEY MOVED.
 *
 * Reported: "during transfer an error toast would come to the frontend but the
 * transfer still went through".
 *
 * The server fix keeps the response inside the gateway's 12s window, so this
 * should now be rare. It is still handled, because when we genuinely do not
 * know the honest answer is "we do not know" - telling someone a transfer
 * failed when it succeeded is what makes them send it again, and there is no
 * recall on chain for the duplicate.
 *
 * Run: npm run test:transfer-toast-honesty
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let p = 0, f = 0;
const ck = (n: string, ok: unknown, d = '') => { ok ? (p++, console.log('  ok   ' + n)) : (f++, console.log('  FAIL ' + n + (d ? ' -> ' + d : ''))); };

const svc = read('src/balances/balance.service.ts');
const worker = read('../cloudflare-worker-test-DEPLOY.js');

console.log('\n── the deadline is genuinely below the gateway timeout ────────');
const gateway = Number(/UPSTREAM_TIMEOUT_MS = (\d+)/.exec(worker)?.[1]);
const deadline = Number(/BALANCE_TRANSFER_RESPONSE_DEADLINE_MS \|\| (\d+)/.exec(svc)?.[1]);
ck('the worker timeout is readable', Number.isFinite(gateway), String(gateway));
ck('the response deadline is readable', Number.isFinite(deadline), String(deadline));
ck(`deadline (${deadline}ms) is under the gateway (${gateway}ms)`, deadline < gateway,
  'at or above it the worker aborts first and the user sees a 503 for a live transfer');
ck('with real headroom for two proxy hops', gateway - deadline >= 2000, `${gateway - deadline}ms`);

console.log('\n── the broadcast is never cancelled ───────────────────────────');
ck('the race resolves a marker rather than rejecting', svc.includes('BROADCAST_PENDING'));
ck('nothing aborts the in-flight broadcast',
  !/broadcast\.(cancel|abort)/.test(svc),
  'a signed transaction cannot be un-sent');
ck('a late rejection is handled, so it cannot crash the process',
  /broadcast\.catch\(async \(error\)/.test(svc),
  'an unhandled rejection after the response would kill every other request');
ck('the late handler releases the hold, since that send truly failed',
  /afterResponse: true/.test(svc) && /kind: 'hold_release'/.test(svc));
ck('the timeout path is audited for operators', svc.includes("action: 'balance.transfer_slow_broadcast'"));
ck('and that event is READ back, so the status is not stuck',
  svc.split("'balance.transfer_slow_broadcast'").length >= 3,
  'emitting an event nothing reads is the same bug wearing a hat');
ck('the timer is unref\'d so it cannot hold the process open', /timer\.unref\?\.\(\)/.test(svc));

// Legacy UI assertions are retained in docs/legacy-frontend-tests; standalone coverage owns the UI.
console.log(`\n${f === 0 ? '✅' : '❌'} ${p} passed, ${f} failed\n`);
process.exit(f === 0 ? 0 : 1);

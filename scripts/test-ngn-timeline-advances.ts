/**
 * "IT GOT DELIVERED TO BREET BUT I KEPT SEEING WAITING FOR YOUR ASSET."
 *
 * Reported after a real sandbox off-ramp: the crypto was sent, Breet received
 * it, and the screen still said the deposit had never arrived - permanently.
 *
 * FOUND ON THE LIVE TEST API, not reasoned about. Transfer
 * ngnt_4f2d3ec0-9378-4784-95ba-238842185ccf:
 *
 *     status:   "blockchain_confirmed"      <- backend knows it arrived
 *     timeline: awaiting_crypto_deposit = "current"   <- what the UI renders
 *
 * The two disagreed, and the UI reads the TIMELINE. So the backend had
 * correctly detected the deposit and the user was still being told to wait for
 * it, with no way to tell the difference between "not received" and "received,
 * not shown".
 *
 * CAUSE: ngn-settlement-reconciler wrote `status` and never rebuilt
 * `timeline`. The word "timeline" did not appear in that file at all - the
 * timeline was baked once at order creation and then frozen while the status
 * moved underneath it.
 *
 * buildTimeline() was module-private to ngn-transfers.service, which is why
 * the reconciler could not call it even in principle. Now exported, and both
 * reconciler write paths - the settlement advance AND the unfunded expiry -
 * rebuild it.
 *
 * NOT the cause, checked and ruled out: Breet reuses one deposit address for
 * every off-ramp by the same user (confirmed on the test API - five transfers
 * all sharing ChtbSMd6...HnVN). matchTransfer already handles that by taking
 * the oldest non-completed candidate.
 *
 * Run: npm run test:ngn-timeline-advances
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-ngn-timeline.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'timeline-admin-key';
process.env.USER_JWT_SECRET = 'timeline-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.NGN_PROVIDER = 'mock';

import fs from 'node:fs';
fs.rmSync('.data/test-ngn-timeline.json', { force: true });

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { buildTimeline } = await import('../src/ngn/service/ngn-transfers.service.js');

/** The stuck transfer from the test API, reduced to what the timeline needs. */
const stuck = {
  id: 'ngnt_stuck',
  direction: 'offramp',
  status: 'blockchain_confirmed',
  updatedAt: '2026-08-06T05:56:57.793Z',
} as any;

console.log('\n── the reported state: status moved, timeline did not ────────');

const rebuilt = buildTimeline(stuck);
const current = rebuilt.find((step: any) => step.status === 'current');

check('buildTimeline is exported so the reconciler can call it',
  typeof buildTimeline === 'function',
  'it was module-private, which is why the reconciler could not rebuild it');
check('the current step follows the status, not the creation state',
  current?.key === 'blockchain_confirmed',
  `current is "${current?.key}" - the user saw "awaiting_crypto_deposit" forever`);
check('the earlier step is marked completed',
  rebuilt.find((step: any) => step.key === 'awaiting_crypto_deposit')?.status === 'completed',
  'the deposit DID arrive, so the wait step must close');
check('later steps stay pending',
  rebuilt.find((step: any) => step.key === 'completed')?.status === 'pending');

console.log('\n── every status renders the matching step ────────────────────');

for (const [status, expected] of [
  ['awaiting_crypto_deposit', 'awaiting_crypto_deposit'],
  ['blockchain_confirmed', 'blockchain_confirmed'],
  ['settlement_processing', 'settlement_processing'],
  ['bank_processing', 'bank_processing'],
  ['completed', 'completed'],
] as const) {
  const steps = buildTimeline({ ...stuck, status } as any);
  const now = steps.find((step: any) => step.status === 'current');
  check(`status "${status}" -> current step "${expected}"`,
    now?.key === expected,
    `got "${now?.key}"`);
}

console.log('\n── the reconciler rebuilds it on BOTH write paths ────────────');

const reconciler = fs.readFileSync('src/ngn/service/ngn-settlement-reconciler.ts', 'utf8');
const code = reconciler.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('the reconciler imports buildTimeline',
  /import \{ buildTimeline \} from '\.\/ngn-transfers\.service\.js'/.test(code),
  'the word "timeline" did not appear in this file at all before');
check('the settlement advance rebuilds the timeline',
  /updated\.timeline = buildTimeline\(updated\)/.test(code),
  'this is the path that left blockchain_confirmed showing as "waiting"');
check('the unfunded expiry rebuilds it too',
  /expiredRecord\.timeline = buildTimeline\(expiredRecord\)/.test(code),
  'an expired order still saying "waiting for crypto" tells the user to keep waiting');

/**
 * Both writes must be covered. One rebuilt and one not would leave a subset of
 * transfers stuck in exactly the reported way, which is harder to notice than
 * all of them being stuck.
 */
const writes = (code.match(/upsertNgnTransferRecord\(/g) ?? []).length;
const rebuilds = (code.match(/= buildTimeline\(/g) ?? []).length;
check('every status write is paired with a timeline rebuild',
  rebuilds >= writes,
  `${writes} writes, ${rebuilds} rebuilds`);

console.log('\n── status and timeline can no longer disagree ────────────────');

/**
 * The invariant, asserted directly: for any status the reconciler can set,
 * the rebuilt timeline's current step is that status.
 */
let consistent = true;
const details: string[] = [];
for (const status of ['awaiting_crypto_deposit', 'blockchain_confirmed', 'quote_accepted', 'settlement_processing', 'bank_processing', 'completed']) {
  const steps = buildTimeline({ ...stuck, status } as any);
  const now = steps.find((step: any) => step.status === 'current')
    ?? steps[steps.length - 1];
  if (now?.key !== status && status !== 'completed') { consistent = false; details.push(`${status}->${now?.key}`); }
}
check('the current step always equals the status', consistent, details.join(' '));

/**
 * A failed transfer must not render as still progressing. Checked because the
 * failure branch takes a different path through the same function.
 */
const failed = buildTimeline({ ...stuck, status: 'failed' } as any);
check('a failed transfer shows failed steps, not a cheerful current one',
  failed.some((step: any) => step.status === 'failed')
  && !failed.some((step: any) => step.status === 'current'),
  JSON.stringify(failed.map((s: any) => s.status)));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

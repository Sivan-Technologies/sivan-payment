/**
 * A SLOW SEND MUST ANSWER BEFORE THE GATEWAY GIVES UP ON IT.
 *
 * Reported twice, the second time after the first fix:
 *
 *   POST .../balance/transfers -> 503, "We lost the connection before
 *   confirming this transfer" - and the transfer went through anyway.
 *
 * The Cloudflare worker aborts an upstream request at UPSTREAM_TIMEOUT_MS
 * (12000) and deliberately does NOT retry a POST, because retrying a write
 * that may already have applied is how duplicates get made. So when the API
 * takes longer than 12s the browser gets a 503 while the send carries on
 * executing on Render. The money moves; only the answer is thrown away.
 *
 * raceBroadcastDeadline already existed to prevent that, and it was measuring
 * from the wrong moment: its 9s clock started when the BROADCAST started, by
 * which point the request had already spent an unbudgeted amount of time on
 * chain balance reads and a Solana RPC. On a slow provider the pre-flight
 * alone could reach the gateway's ceiling.
 *
 * These assertions are about ARITHMETIC on the budget, so they are fast and
 * deterministic - no sleeping for real seconds, and no dependency on how
 * quickly a test machine happens to run.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const checks: Array<[string, () => void | Promise<void>]> = [];
function test(name: string, fn: () => void | Promise<void>) { checks.push([name, fn]); }

/** Comments stripped, so prose about the fix cannot satisfy a check on it. */
const src = readFileSync('src/balances/balance.service.ts', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
const worker = readFileSync('infra/cloudflare/cloudflare-worker-test-DEPLOY.js', 'utf8');

/** The same computation raceBroadcastDeadline does. */
const BUDGET = 9000;
const FLOOR = 1000;
const remainingFor = (spentMs: number) => Math.max(BUDGET - spentMs, FLOOR);

// ───────────────────────────────────── the budget is shared, not restarted

test('a slow pre-flight shortens the broadcast wait', () => {
  // 7s of chain reads must leave 2s, not a fresh 9s. The whole bug in one line.
  assert.equal(remainingFor(7000), 2000);
});

test('a fast pre-flight leaves almost the whole budget', () => {
  assert.equal(remainingFor(200), 8800);
});

test('the total stays under the gateway ceiling', () => {
  const ceiling = Number(worker.match(/UPSTREAM_TIMEOUT_MS\s*=\s*(\d+)/)?.[1]);
  assert.equal(ceiling, 12000, 'the worker ceiling moved - re-check the budget');
  // The worst case: pre-flight burns everything, broadcast still gets the
  // floor. Must remain under the ceiling with room for two TLS hops.
  for (const spent of [0, 3000, 8999, 9000, 20000]) {
    const total = spent + remainingFor(spent);
    assert.ok(
      total < ceiling || spent >= ceiling,
      `pre-flight ${spent}ms + wait ${remainingFor(spent)}ms = ${total}ms, ceiling ${ceiling}ms`,
    );
  }
});

test('an exhausted budget still gives the broadcast a floor', () => {
  // Returning immediately would mean never even starting the send within the
  // request - the user would be told "submitted" for something that had not
  // begun.
  assert.equal(remainingFor(50_000), FLOOR);
  assert.ok(FLOOR > 0);
});

// ─────────────────────────────────────────── the wiring is actually in place

test('the clock starts at the top of the request', () => {
  assert.match(src, /const requestStartedAt = Date\.now\(\);/);
  // Before the first await, or it is not measuring the pre-flight at all.
  const startIdx = src.indexOf('const requestStartedAt');
  const controlsIdx = src.indexOf('await getBalanceTransferControls()', startIdx);
  assert.ok(startIdx > 0 && controlsIdx > startIdx, 'the clock starts after the pre-flight began');
});

test('the request clock is handed to the race', () => {
  assert.match(src, /raceBroadcastDeadline\(userId, transfer, requestStartedAt\)/);
});

test('the race spends the remaining budget, not a fresh one', () => {
  assert.match(src, /const remaining = Math\.max\(BROADCAST_RESPONSE_DEADLINE_MS - spent, MIN_BROADCAST_WAIT_MS\)/);
  assert.match(src, /setTimeout\(\(\) => resolve\(BROADCAST_PENDING\), remaining\)/);
});

// ────────────────────────────────── a timed-out send is not a failed send

test('the broadcast is never cancelled on timeout', () => {
  // There is no way to un-send a signed transaction. The promise must keep
  // running; we only stop waiting for it.
  assert.ok(!/controller\.abort\(\)/.test(src.split('raceBroadcastDeadline')[1] ?? ''),
    'something aborts the broadcast - the ledger and the chain will disagree');
});

test('a timed-out send reports processing, not failed', () => {
  /*
    SCOPED TO THE TIMEOUT PATH. My first version searched the whole function
    and passed even when the return was mutated to 'failed', because
    "status: 'failed'" appears legitimately in the rejection handler above it -
    so the regex found a match that had nothing to do with the branch under
    test. Caught by mutation, not by reading.

    Telling a user their transfer failed when it is mid-flight is what makes
    them send it again, and there is no recall on chain for the duplicate.
  */
  const race = src.slice(src.indexOf('async function raceBroadcastDeadline'));
  const timeoutPath = race.slice(
    race.indexOf('if (winner !== BROADCAST_PENDING)'),
    race.indexOf('export async function requestBalanceTransfer'),
  );
  assert.ok(timeoutPath.length > 0, 'could not locate the timeout path');
  assert.match(timeoutPath, /status: 'processing'/);
  assert.ok(!/status: 'failed'/.test(timeoutPath), 'a still-running send is reported as failed');
});

test('the hold is NOT released when the deadline wins', () => {
  /*
    Releasing it would hand the money back on paper while the coins leave the
    wallet - the ledger and the chain disagreeing, which is worse than any slow
    response.

    SCOPED TO THE TIMEOUT PATH ONLY. My first version searched the whole
    function and failed, because the broadcast's own .catch DOES release the
    hold - and should: that is a genuine failure, the send never happened, and
    the money must go back. Asserting over both paths conflated "timed out"
    with "failed", which is the exact distinction this design rests on.
  */
  const race = src.slice(src.indexOf('async function raceBroadcastDeadline'));
  const timeoutPath = race.slice(race.indexOf('if (winner !== BROADCAST_PENDING)'), race.indexOf('export async function requestBalanceTransfer'));
  assert.ok(timeoutPath.length > 0, 'could not locate the timeout path');
  assert.ok(!/hold_release/.test(timeoutPath), 'the timeout path releases the hold');
  // And the failure path must still release it.
  assert.match(race.slice(0, race.indexOf('const winner')), /hold_release/);
});

test('the audit log records what the send actually got', () => {
  // The constant alone is useless once the budget is shared - the interesting
  // number is how much was left after the pre-flight.
  assert.match(src, /preflightMs: spent/);
  assert.match(src, /deadlineMs: remaining/);
});

// ───────────────────────────────────────────────── the gateway's own rules

test('the worker still refuses to retry a POST', () => {
  // If this ever changes, a slow transfer becomes a DOUBLE transfer, which is
  // far worse than the 503 this whole file is about.
  assert.match(worker, /const maxAttempts = RETRYABLE_METHODS\.has\(method\) \? MAX_ATTEMPTS : 1;/);
  const retryables = worker.match(/RETRYABLE_METHODS\s*=\s*new Set\(\[([^\]]*)\]/)?.[1] ?? '';
  assert.ok(!/POST/i.test(retryables), `POST is retryable at the gateway: ${retryables}`);
});

let passed = 0;
for (const [name, fn] of checks) {
  try {
    const out = fn();
    if (out && typeof (out as Promise<void>).then === 'function') await out;
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${checks.length} passed`);
if (passed !== checks.length) process.exitCode = 1;

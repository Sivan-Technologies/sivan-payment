// Backend assertions retained; legacy UI checks moved to docs/legacy-frontend-tests.
/**
 * A BUSINESS REFUSAL MUST NOT END THE SESSION.
 *
 * Reported: pressing Send on the transfer screen returned
 *   POST /api/users/:id/balance/transfers -> 403
 * and the user was immediately signed out. Every attempt, same result.
 *
 * Two independent defects stacked into that one symptom.
 *
 * 1. shared/errors.ts `forbidden()` hardcodes the error code 'forbidden' for
 *    EVERY business refusal in the app - "Transfers from settled USDC balance
 *    are currently disabled", "Too many incorrect PIN attempts", "Verify your
 *    email before linking WhatsApp". The client listed that exact code as
 *    proof of a rejected token and logged out on it. Nothing was wrong with
 *    the session; the feature was switched off.
 *
 * 2. Nothing told the client the feature WAS switched off. transfersEnabled
 *    lived only inside getBalanceControls(), so the form stayed interactive,
 *    priced the transfer, took a wallet address and an amount, and refused
 *    only at the final confirm.
 *
 * The genuine "this token does not own that account" case keeps logging out -
 * it now carries its own code, 'user_mismatch'. These assertions check the two
 * are told apart, because collapsing them again is how this bug returns.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const checks: Array<[string, () => void]> = [];
function test(name: string, fn: () => void) { checks.push([name, fn]); }

/** Comments stripped, so a paragraph ABOUT the fix cannot satisfy a check on it. */
function code(path: string) {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const appTs = code('src/app.ts');

// ───────────────────────────────── the two 403s are distinguishable

test('the ownership check no longer emits the generic code', () => {
  // If this reverts to 'forbidden', every business refusal logs users out again.
  assert.match(appTs, /code: 'user_mismatch'/);
  assert.ok(
    !/code: 'forbidden', message: 'You cannot access another user account'/.test(appTs),
    'the mismatch is back on the shared code',
  );
});

// Legacy UI assertions are retained in docs/legacy-frontend-tests; standalone coverage owns the UI.
// ─────────────────── the client can know the feature is off, before confirming

test('transfersEnabled is served to the client', async () => {
  const { listPaymentControls } = await import('../src/controls/payment-controls.service.js');
  const controls: any = await listPaymentControls();
  assert.equal(typeof controls.transfersEnabled, 'boolean', 'the UI still cannot know');
});

test('it reports the SAME value the enforcement path reads', async () => {
  // One source. If these two ever disagree, the screen says one thing and the
  // 403 says another - which is the class of bug this whole fix is about.
  const { listPaymentControls } = await import('../src/controls/payment-controls.service.js');
  const { getBalanceTransferControls } = await import('../src/balances/balance.service.js');
  const [controls, balance]: [any, any] = await Promise.all([listPaymentControls(), getBalanceTransferControls()]);
  assert.equal(controls.transfersEnabled, balance.transfersEnabled);
});

test('an admin toggle moves BOTH the screen and the enforcement path', async () => {
  /*
    THE DRIFT THIS FIELD EXISTS TO PREVENT, IN THE OTHER DIRECTION.

    getBalanceTransferControls treats BALANCE_TRANSFERS_ENABLED as a fallback
    and lets a saved admin value override it. My first version of the controls
    payload read the env var directly, so an operator enabling transfers in the
    hub would have unblocked the 403 while the send form still said "paused".

    Exercised through the real update function, so this fails if either side is
    ever re-pointed at the raw variable.
  */
  const { updateBalanceTransferControls, getBalanceTransferControls } =
    await import('../src/balances/balance.service.js');
  const { listPaymentControls } = await import('../src/controls/payment-controls.service.js');

  await updateBalanceTransferControls({ transfersEnabled: true, updatedBy: 'test_transfer_gate' } as any);
  const [afterOn, enforcementOn]: [any, any] =
    await Promise.all([listPaymentControls(), getBalanceTransferControls()]);
  assert.equal(enforcementOn.transfersEnabled, true, 'setup: the admin value did not save');
  assert.equal(afterOn.transfersEnabled, true, 'the screen still says paused after an admin enabled it');

  await updateBalanceTransferControls({ transfersEnabled: false, updatedBy: 'test_transfer_gate' } as any);
  const afterOff: any = await listPaymentControls();
  assert.equal(afterOff.transfersEnabled, false, 'the screen did not follow the admin switching it off');
});

test('it fails CLOSED on the server', async () => {
  // Absent config must not read as "transfers are open".
  const prev = process.env.BALANCE_TRANSFERS_ENABLED;
  delete process.env.BALANCE_TRANSFERS_ENABLED;
  const { listPaymentControls } = await import('../src/controls/payment-controls.service.js');
  const controls: any = await listPaymentControls();
  assert.equal(controls.transfersEnabled, false);
  if (prev !== undefined) process.env.BALANCE_TRANSFERS_ENABLED = prev;
});

// Legacy UI assertions are retained in docs/legacy-frontend-tests; standalone coverage owns the UI.
test('serving the controls payload does not read the whole database', async () => {
  /*
    THE REGRESSION I CAUSED, AND A GUARD SO IT CANNOT RECUR.

    GET /api/offramp/controls is fetched by the app on every load. Adding
    getBalanceTransferControls() as a caller pulled a db.read() into it - 47
    sequential `select *` queries on Postgres, including the unbounded audit
    history. Measured on the deployed test gateway right after: 11.2s, 11.6s,
    and one 503 at 25s, against the Cloudflare worker's 12s ceiling.

    The comment above listPaymentControls documents someone removing a
    db.read() from that same function for that same reason. Counting call
    sites is cheap and would have caught it.
  */
  const balance = readFileSync('src/balances/balance.service.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const controlsFn = balance.slice(
    balance.indexOf('export async function getBalanceTransferControls'),
    balance.indexOf('export async function updateBalanceTransferControls'),
  );
  assert.ok(controlsFn.length > 0, 'could not locate getBalanceTransferControls');
  assert.ok(!/db\.read\(\)/.test(controlsFn),
    'getBalanceTransferControls reads the whole database - it is on the /offramp/controls hot path');
  assert.match(controlsFn, /latestAuditLogByAction/);

  // And the payload function itself must stay off db.read().
  const controls = readFileSync('src/controls/payment-controls.service.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/await db\.read\(\)/.test(controls),
    'listPaymentControls is back on db.read()');
});

// Legacy UI assertions are retained in docs/legacy-frontend-tests; standalone coverage owns the UI.
let passed = 0;
for (const [name, fn] of checks) {
  try {
    const out: any = fn();
    if (out && typeof out.then === 'function') await out;
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

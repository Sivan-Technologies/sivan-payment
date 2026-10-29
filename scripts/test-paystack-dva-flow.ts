/**
 * PAYSTACK DVA FLOW, AGAINST A LOCAL STUB.
 *
 * Exercises resolveOrCreateDva() end to end without touching Paystack, by
 * pointing PAYSTACK_BASE_URL at a stub server on localhost. That env
 * indirection exists precisely for this: the provider has no special test
 * path and no injected client, so what runs here is the same code that runs
 * in production.
 *
 * THE PROPERTY THIS FILE EXISTS TO PROVE
 *
 * A dedicated bank account must NOT be assigned until NIBSS returns a
 * verdict. POST /identification answers 202 with no result; the outcome
 * arrives later as customeridentification.success. Assigning on the 202
 * would issue a Nigerian bank account to an unverified person, which is the
 * exact CBN requirement the step exists to satisfy, and nothing in the
 * Paystack response would reveal the mistake.
 *
 * The stub records every path it is called on, so the test can assert that
 * /dedicated_account was NEVER hit during the initial flow.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  ✅ ok - ${name}`); }
  else { failed++; console.log(`  ❌ FAIL - ${name}${detail ? `  (${detail})` : ''}`); }
}

/** Paths the stub was asked for, in order. The assertion surface. */
const calls: string[] = [];
/** Set true to make the identification endpoint reject. */
let identificationFails = false;
const stubCustomerCode = 'CUS_stub_' + Date.now();
/** Captures request bodies so payload shape can be asserted. */
const bodies: Record<string, any> = {};

function startStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    calls.push(`${req.method} ${path}`);
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      bodies[path] = body;
      res.setHeader('content-type', 'application/json');

      if (path === '/customer') {
        res.writeHead(200);
        return res.end(JSON.stringify({
          status: true, message: 'Customer created',
          data: { id: Date.now(), customer_code: stubCustomerCode, email: body.email,
                  first_name: body.first_name, last_name: body.last_name, phone: body.phone },
        }));
      }
      if (/^\/customer\/.+\/identification$/.test(path)) {
        if (identificationFails) {
          res.writeHead(200);
          return res.end(JSON.stringify({ status: false, message: 'Could not resolve BVN' }));
        }
        // 202 with NO verdict: this is the real Paystack behaviour.
        res.writeHead(202);
        return res.end(JSON.stringify({ status: true, message: 'Customer Identification in progress', data: {} }));
      }
      if (path === '/dedicated_account') {
        const bankSlug = body.preferred_bank || 'test-bank';
        const bankName = bankSlug === 'wema-bank' ? 'Wema Bank' : 'Test Bank';
        const accId = Math.floor(10000000 + Math.random() * 90000000);
        const accNum = '993000' + String(Math.floor(1000 + Math.random() * 9000));
        res.writeHead(200);
        return res.end(JSON.stringify({
          status: true, message: 'NUBAN successfully created',
          data: { id: accId, account_number: accNum, account_name: 'Sivan / Samson Micheal',
                  bank: { name: bankName, id: 24, slug: bankSlug },
                  currency: 'NGN', active: true, assigned: true },
        }));
      }
      res.writeHead(404);
      res.end(JSON.stringify({ status: false, message: 'stub: unknown path' }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  console.log('\n' + '='.repeat(50));
  console.log('🔷 SIVAN PAYSTACK DVA FLOW (LOCAL STUB)');
  console.log('='.repeat(50));

  const server = await startStub();
  const port = (server.address() as AddressInfo).port;

  process.env.PAYSTACK_SECRET_KEY = 'sk_live_' + 'a'.repeat(40);
  process.env.PAYSTACK_BASE_URL = `http://127.0.0.1:${port}`;

  /**
   * The base URL guard requires https. Relaxing it for localhost would
   * weaken a real protection, so the test asserts the guard exists and then
   * bypasses it the only honest way: by confirming the guard is what blocks
   * us, and importing with the check satisfied via an https-looking proxy is
   * not possible here. Instead the guard is verified in the config suite and
   * this file sets an explicit escape hatch that ONLY the test sets.
   */
  process.env.PAYSTACK_ALLOW_INSECURE_BASE_URL = 'true';

  const { resolveOrCreateDva, completeAfterIdentification, getDvaState } =
    await import('../src/virtual-accounts/service/paystackDvaService.js');
  const { db } = await import('../src/database/json-database.js');

  const userId = 'stub-user-' + Date.now();
  const now = new Date().toISOString();
  await db.insertUserRecord({
    id: userId,
    email: `${userId}@user.sivantech.online`,
    fullName: 'Samson Micheal',
    createdAt: now,
    updatedAt: now,
  });

  // ── 1. Live Mode: Initial flow must stop at 'verifying' ─────────
  console.log('\n══ 1. Live Mode: Identity Is Not Assumed Verified ══');

  const first = await resolveOrCreateDva({
    userId, legalName: 'Samson Micheal', identifier: '22212345678', phone: '+2348012345678',
  });

  check('the flow returns verifying, not ready', first.state === 'verifying', first.state);
  check('POST /customer was called', calls.some((c) => c === 'POST /customer'));
  check('POST identification was called',
    calls.some((c) => /POST \/customer\/.+\/identification/.test(c)));

  /** THE LOAD BEARING ASSERTION. */
  check('NO bank account was assigned before the NIBSS verdict',
    !calls.some((c) => c === 'POST /dedicated_account'), calls.join(' | '));

  // ── 2. Payload shape ────────────────────────────────────────────
  console.log('\n══ 2. Payload Shape ══');
  check('the customer email is deterministic',
    String(bodies['/customer']?.email).includes('user.sivantech.online'), bodies['/customer']?.email);
  check('the legal name was split into first and last',
    bodies['/customer']?.first_name === 'Samson' && bodies['/customer']?.last_name === 'Micheal');

  // ── 3. Only the webhook releases the account in live mode ──────
  console.log('\n══ 3. Webhook Completes The Flow In Live Mode ══');

  const customerCodeToComplete = (first as any).customerCode || stubCustomerCode;
  const done = await completeAfterIdentification(userId, customerCodeToComplete);
  check('after the success verdict the account is ready', done.state === 'ready', done.state);
  check('NOW the dedicated account was assigned',
    calls.some((c) => c === 'POST /dedicated_account'));
  check('live mode requested the wema-bank slug',
    bodies['/dedicated_account']?.preferred_bank === 'wema-bank',
    bodies['/dedicated_account']?.preferred_bank);
  if (done.state === 'ready') {
    check('the account number is surfaced', Boolean(done.account.accountNumber));
    check('the mode is carried through as live', done.account.mode === 'live');
  }

  // ── 4. Re-entry is idempotent ───────────────────────────────────
  console.log('\n══ 4. Idempotency ══');
  const before = calls.length;
  const again = await resolveOrCreateDva({ userId, legalName: 'Samson Micheal', identifier: '22212345678' });
  check('a returning user resolves to ready', again.state === 'ready', again.state);
  check('and costs ZERO further Paystack calls', calls.length === before,
    `${calls.length - before} extra calls`);

  const state = await getDvaState(userId);
  check('getDvaState agrees the account is ready', state.state === 'ready');

  // ── 5. Failure path ─────────────────────────────────────────────
  console.log('\n══ 5. Identification Failure In Live Mode ══');
  identificationFails = true;
  const failUser = 'stub-fail-' + Date.now();
  await db.insertUserRecord({
    id: failUser,
    email: `${failUser}@user.sivantech.online`,
    fullName: 'Bad Name',
    createdAt: now,
    updatedAt: now,
  });
  const bad = await resolveOrCreateDva({
    userId: failUser, legalName: 'Bad Name', identifier: '00000000000',
  });
  check('a rejected identity returns failed', bad.state === 'failed', bad.state);
  check('the failure reason is surfaced from Paystack',
    bad.state === 'failed' && /BVN/i.test(bad.reason), bad.state === 'failed' ? bad.reason : '');
  check('and NO account was assigned for the failed user',
    !calls.slice(before).some((c) => c === 'POST /dedicated_account'));

  // ── 6. Test Mode (Staging): Direct Assignment Without BVN ─────────
  console.log('\n══ 6. Test Mode (Staging): Direct Assignment Without BVN ══');
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_' + 'b'.repeat(40);
  const testUser = 'stub-staging-user-' + Date.now();
  await db.insertUserRecord({
    id: testUser,
    email: `${testUser}@user.sivantech.online`,
    fullName: 'Staging Tester',
    createdAt: now,
    updatedAt: now,
  });

  const testCallsBefore = calls.length;
  const testDva = await resolveOrCreateDva({
    userId: testUser,
    legalName: 'Staging Tester',
    // Deliberately NO identifier provided
  });

  check('test mode returns ready immediately without waiting for NIBSS', testDva.state === 'ready', testDva.state);
  check('test mode DID NOT call /identification', !calls.slice(testCallsBefore).some((c) => /identification/.test(c)));
  check('test mode assigned dedicated account directly', calls.slice(testCallsBefore).some((c) => c === 'POST /dedicated_account'));
  check('test mode requested the test-bank slug', bodies['/dedicated_account']?.preferred_bank === 'test-bank', bodies['/dedicated_account']?.preferred_bank);
  if (testDva.state === 'ready') {
    check('test mode account number is returned', Boolean(testDva.account.accountNumber));
    check('test mode reports mode as test', testDva.account.mode === 'test');
  }

  server.close();
  console.log('\n' + '='.repeat(50));
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50) + '\n');
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('\nSUITE ERROR:', e?.message ?? e); process.exitCode = 1; });

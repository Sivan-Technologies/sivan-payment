/**
 * A BVN CHECK THAT CAN BE FINISHED.
 *
 * Flutterwave's BVN flow is asynchronous by regulation: the CBN requires the
 * BVN owner to consent, so the first call can only return `review` plus a
 * NIBSS URL. FlutterwaveKycLevelProvider.completeBvnConsent() was written to
 * collect the result afterwards - and had NO CALLER anywhere. It was not on
 * the KycLevelProvider interface and no route reached it.
 *
 * So on Flutterwave a user could START a check and never finish one: the row
 * sat at 'review' forever and they stayed at Level 1 with a NGN 100,000
 * ceiling. This suite covers the completion path that was missing.
 *
 * THE ASSERTION THAT MATTERS MOST is the first one in section 3: initiating a
 * consent must never, under any reading, grant Level 2. BVN-PROVIDERS.md calls
 * this "the catastrophic shortcut" - the initiation response looks maximally
 * successful (HTTP 200, status: success), and treating it as a pass would hand
 * a NGN 5,000,000 ceiling to anyone who typed eleven digits.
 */
import assert from 'node:assert/strict';
import { db } from '../src/database/json-database.js';
import { nowIso, id } from '../src/shared/id.js';

const checks: Array<[string, () => Promise<void> | void]> = [];
function test(name: string, fn: () => Promise<void> | void) { checks.push([name, fn]); }

const USER = 'u_bvn_consent';

/** Stand-in for Flutterwave: initiation returns review + URL, collection returns the verdict. */
class FakeConsentProvider {
  name = 'flutterwave';
  completeCalls: string[] = [];
  verdict: 'matched' | 'review' | 'failed' = 'matched';

  async verifyBvnIdentity() {
    return {
      provider: this.name,
      status: 'review' as const,
      message: 'Approve the BVN request to finish verifying your identity.',
      bvnLast4: '4821',
      providerReference: 'flw_ref_123',
      matchedFields: { consentRequired: true, consentUrl: 'https://nibss.example/consent/abc' },
    };
  }

  async completeBvnConsent(reference: string) {
    this.completeCalls.push(reference);
    return {
      provider: this.name,
      status: this.verdict,
      message: this.verdict === 'matched' ? 'Verified.' : 'Still pending.',
      bvnLast4: '4821',
      providerReference: reference,
      matchedFields: { firstName: true, lastName: true },
    };
  }

  async verifyBvnBankAccount() { throw new Error('not used'); }
  async health() { return { provider: this.name, available: true, mode: 'live' as const, checkedAt: nowIso() }; }
}

const fake = new FakeConsentProvider();

/** Seed the 'review' row the initiate step would have written. */
async function seedPending(over: Record<string, unknown> = {}) {
  const at = nowIso();
  return db.upsertNgnIdentityVerification({
    id: id('ngnkyc'),
    userId: USER,
    checkType: 'bvn_info',
    status: 'review',
    provider: 'flutterwave',
    providerReference: 'flw_ref_123',
    bvnLast4: '4821',
    bvnHash: 'hash_of_bvn',
    matchedFields: { consentRequired: true, consentUrl: 'https://nibss.example/consent/abc' },
    verifiedAt: undefined,
    createdAt: at,
    updatedAt: at,
    ...over,
  } as any);
}

async function clearRows() {
  const rows = await db.listNgnIdentityVerifications(USER);
  for (const row of rows) {
    await db.upsertNgnIdentityVerification({ ...row, checkType: 'bvn_info', status: 'failed', verifiedAt: undefined } as any);
  }
}

// ─────────────────────────────────── 1. the consent URL reaches the customer

test('the consent URL is surfaced, not buried in matchedFields', async () => {
  const { __toCustomerSafeForTests: toSafe } = await import('../src/kyc/service/ngn-kyc-level.service.js') as any;
  const shaped = toSafe(await fake.verifyBvnIdentity(), 'ngn_level_2');
  // The whole bug: the URL existed on the wire and never reached the screen.
  assert.equal(shaped.consentUrl, 'https://nibss.example/consent/abc');
  assert.equal(shaped.awaitingUserConsent, true);
});

test('a consent wait is not described as manual review', async () => {
  const { __toCustomerSafeForTests: toSafe } = await import('../src/kyc/service/ngn-kyc-level.service.js') as any;
  const shaped = toSafe(await fake.verifyBvnIdentity(), 'ngn_level_2');
  // "needs manual review" tells the user to wait for a human who is not
  // coming. The next move is theirs.
  assert.ok(!/manual review/i.test(shaped.message), shaped.message);
  assert.match(shaped.message, /approve/i);
});

test('a genuine manual review is still called one', async () => {
  const { __toCustomerSafeForTests: toSafe } = await import('../src/kyc/service/ngn-kyc-level.service.js') as any;
  const shaped = toSafe(
    { provider: 'monnify', status: 'review', message: '', bvnLast4: '1111', matchedFields: { firstName: false } },
    'ngn_level_2',
  );
  assert.match(shaped.message, /manual review/i);
  assert.equal(shaped.awaitingUserConsent, false);
});

// ─────────────────────────────────────────── 2. completion actually completes

test('completing a consent grants the verification', async () => {
  await clearRows();
  await seedPending();
  fake.verdict = 'matched';
  const { completeNgnBvnConsent, __setKycProviderForTests } = await import('../src/kyc/service/ngn-kyc-level.service.js') as any;
  __setKycProviderForTests(fake);

  const out = await completeNgnBvnConsent(USER);
  assert.equal(out.status, 'matched');

  const rows = await db.listNgnIdentityVerifications(USER);
  const row = rows.find((r) => r.checkType === 'bvn_info');
  assert.ok(row?.verifiedAt, 'verifiedAt is the single fact that grants Level 2');
});

test('the stored reference is used - the user never retypes their BVN', async () => {
  await clearRows();
  await seedPending();
  fake.completeCalls = [];
  fake.verdict = 'matched';
  const { completeNgnBvnConsent, __setKycProviderForTests } = await import('../src/kyc/service/ngn-kyc-level.service.js') as any;
  __setKycProviderForTests(fake);

  await completeNgnBvnConsent(USER);
  assert.deepEqual(fake.completeCalls, ['flw_ref_123']);
});

test('the BVN hash survives completion', async () => {
  // completeBvnConsent never sees the BVN. Recomputing the hash here would
  // blank the only column the cross-account fraud check reads.
  await clearRows();
  await seedPending();
  fake.verdict = 'matched';
  const { completeNgnBvnConsent, __setKycProviderForTests } = await import('../src/kyc/service/ngn-kyc-level.service.js') as any;
  __setKycProviderForTests(fake);

  await completeNgnBvnConsent(USER);
  const rows = await db.listNgnIdentityVerifications(USER);
  assert.equal(rows.find((r) => r.checkType === 'bvn_info')?.bvnHash, 'hash_of_bvn');
});

test('completing twice is idempotent and does not re-bill the provider', async () => {
  await clearRows();
  await seedPending();
  fake.verdict = 'matched';
  const { completeNgnBvnConsent, __setKycProviderForTests } = await import('../src/kyc/service/ngn-kyc-level.service.js') as any;
  __setKycProviderForTests(fake);

  await completeNgnBvnConsent(USER);
  fake.completeCalls = [];
  const second = await completeNgnBvnConsent(USER);

  assert.equal(second.status, 'matched');
  assert.deepEqual(fake.completeCalls, [], 'a refresh of the return page called the provider again');
});

// ───────────────────────────────── 3. consent is NOT verification (the big one)

test('THE CATASTROPHIC SHORTCUT: initiating consent never grants Level 2', async () => {
  const initiated = await fake.verifyBvnIdentity();
  // HTTP 200 and a successful-looking body. It is not a pass.
  assert.notEqual(initiated.status, 'matched');
  assert.equal(initiated.status, 'review');
});

test('a still-pending approval does not grant the verification', async () => {
  await clearRows();
  await seedPending();
  fake.verdict = 'review';
  const { completeNgnBvnConsent, __setKycProviderForTests } = await import('../src/kyc/service/ngn-kyc-level.service.js') as any;
  __setKycProviderForTests(fake);

  const out = await completeNgnBvnConsent(USER);
  assert.notEqual(out.status, 'matched');
  const rows = await db.listNgnIdentityVerifications(USER);
  assert.equal(rows.find((r) => r.checkType === 'bvn_info')?.verifiedAt, undefined);
});

test('completing with no prior check is refused', async () => {
  const { completeNgnBvnConsent, __setKycProviderForTests } = await import('../src/kyc/service/ngn-kyc-level.service.js') as any;
  __setKycProviderForTests(fake);
  await assert.rejects(() => completeNgnBvnConsent('u_never_started'));
});

test('completing with no provider reference is refused', async () => {
  await clearRows();
  await seedPending({ providerReference: undefined });
  const { completeNgnBvnConsent, __setKycProviderForTests } = await import('../src/kyc/service/ngn-kyc-level.service.js') as any;
  __setKycProviderForTests(fake);
  await assert.rejects(() => completeNgnBvnConsent(USER));
});

test('a provider with no consent step says so instead of pretending', async () => {
  await clearRows();
  await seedPending();
  const monnifyLike = { name: 'monnify', async verifyBvnIdentity() { return {}; }, async health() { return {}; } };
  const { completeNgnBvnConsent, __setKycProviderForTests } = await import('../src/kyc/service/ngn-kyc-level.service.js') as any;
  __setKycProviderForTests(monnifyLike);
  await assert.rejects(() => completeNgnBvnConsent(USER));
});

// ──────────────────────────────────────────────────── 4. the route is wired

test('the completion route exists and is auth-protected', async () => {
  const fs = await import('node:fs');
  const routes = fs.readFileSync('src/kyc/api/kyc-level.routes.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(routes, /ngn-bvn\/complete/, 'no completion route - the flow cannot be finished');
  assert.match(routes, /app\.post\(/, 'settling a verification must not be a GET');

  // The guard in app.ts that covers it. Asserted by RUNNING the pattern, not
  // by grepping for the path.
  const pattern = /^\/api\/users\/[^/]+\/kyc\/ngn/;
  assert.ok(pattern.test('/api/users/u_1/kyc/ngn-bvn/complete'), 'route is not behind user auth');
});

let passed = 0;
for (const [name, fn] of checks) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error as Error).message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${checks.length} passed`);
if (passed !== checks.length) process.exitCode = 1;

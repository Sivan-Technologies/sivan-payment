/**
 * DATE OF BIRTH: THE FIELD BRIDGE WOULD NOT APPROVE A CUSTOMER WITHOUT.
 *
 * Reported from the verification screen:
 *
 *     "Verification needs one more step
 *      Please complete your date of birth and age confirmation..."
 *
 * with nothing on screen to act on. Bridge blocks approval while the
 * `base`/`sepa` endorsements are missing `date_of_birth` and `min_age_18`.
 * Measured against the REAL sandbox - a stuck customer showed
 *
 *     base incomplete  missing: ["date_of_birth","min_age_18","post_processing"]
 *
 * and one PUT /v0/customers/{id} {"birth_date":"1990-01-15"} moved BOTH into
 * `complete`.
 *
 * THE TRAP THIS FILE EXISTS TO PIN DOWN:
 *
 *   POST /v0/kyc_links SILENTLY IGNORES birth_date.
 *
 * Measured: sent it, got HTTP 201, read the customer back and `birth_date` was
 * null with the requirement still missing. Accepted and dropped. So the
 * obvious fix - add the field to the create call - would look like it worked
 * and change nothing. It has to be a follow-up PUT.
 *
 * Run: npm run test:customer-dob
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-customer-dob.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'dob-admin-key';
process.env.USER_JWT_SECRET = 'dob-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-customer-dob.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { setUserDateOfBirth, ageInYears, MINIMUM_AGE_YEARS } =
  await import('../src/users/users.service.js');
const { AppError } = await import('../src/shared/errors.js');

const now = () => new Date().toISOString();
const yearsAgo = (n: number, offsetDays = 0) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

await db.mutate((d: any) => {
  d.users = [{ id: 'usr_dob', email: 'dob@t.test', emailVerifiedAt: now(), country: 'US',
    fullName: 'Dana Reed', createdAt: now(), updatedAt: now() }];
  return 1;
});

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the age calculation is calendar-correct ───────────────');

/**
 * Deliberately NOT (now - dob) / 365.25 days. That drifts around leap years
 * and can call someone 18 the day BEFORE their birthday - the kind of
 * off-by-one that becomes a compliance finding rather than a bug report.
 */
check('someone born exactly 18 years ago today is 18',
  ageInYears(yearsAgo(18)) === 18, String(ageInYears(yearsAgo(18))));
check('one day BEFORE their 18th birthday they are 17',
  ageInYears(yearsAgo(18, 1)) === 17, String(ageInYears(yearsAgo(18, 1))));
check('one day after, they are 18',
  ageInYears(yearsAgo(18, -1)) === 18, String(ageInYears(yearsAgo(18, -1))));
check('a leap-day birthday does not drift',
  ageInYears('2000-02-29', new Date('2026-02-28T00:00:00Z')) === 25,
  String(ageInYears('2000-02-29', new Date('2026-02-28T00:00:00Z'))));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. the server enforces 18+, not just the form ────────────');

const underage = await setUserDateOfBirth('usr_dob', { dateOfBirth: yearsAgo(17) })
  .then(() => null).catch((e: Error) => e);
check('an under-18 date is REFUSED', underage instanceof AppError, String(underage));
check('and the message says why',
  new RegExp(`${MINIMUM_AGE_YEARS}`).test(String((underage as any)?.message)),
  String((underage as any)?.message));
check('nothing was written for the refused date',
  !(await db.read()).users[0].dateOfBirth,
  'a refused date must not be stored - it would be pushed to Bridge later');

const dayBefore = await setUserDateOfBirth('usr_dob', { dateOfBirth: yearsAgo(18, 1) })
  .then(() => null).catch((e: Error) => e);
check('the day before their 18th is refused', dayBefore instanceof AppError);

const future = await setUserDateOfBirth('usr_dob', { dateOfBirth: '2099-01-01' })
  .then(() => null).catch((e: Error) => e);
check('a future date is refused', future instanceof AppError, String(future));

const nonsense = await setUserDateOfBirth('usr_dob', { dateOfBirth: '1990-13-45' })
  .then(() => null).catch((e: Error) => e);
check('a shape-valid but impossible date is refused', nonsense instanceof AppError, String(nonsense));

const ancient = await setUserDateOfBirth('usr_dob', { dateOfBirth: '1850-01-01' })
  .then(() => null).catch((e: Error) => e);
check('an implausible age is refused as a typo', ancient instanceof AppError, String(ancient));

const badShape = await setUserDateOfBirth('usr_dob', { dateOfBirth: '15-01-1990' } as any)
  .then(() => null).catch((e: Error) => e);
check('dd-MM-yyyy is refused - Bridge takes yyyy-MM-dd',
  badShape instanceof Error, String(badShape));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. a valid date is stored ───────────────────────────────');

const saved: any = await setUserDateOfBirth('usr_dob', { dateOfBirth: '1990-01-15' });
check('a valid date is accepted', saved.dateOfBirth === '1990-01-15', String(saved.dateOfBirth));
check('and it survives a re-read',
  (await db.read()).users[0].dateOfBirth === '1990-01-15');
check('exactly 18 today is allowed',
  Boolean(await setUserDateOfBirth('usr_dob', { dateOfBirth: yearsAgo(18) })));

// restore a known value for the next section
await setUserDateOfBirth('usr_dob', { dateOfBirth: '1990-01-15' });

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. startKyc pushes it to the provider ───────────────────');

const { startKyc } = await import('../src/customers/customers.service.js');
const { getOfframpProvider } = await import('../src/providers/provider-registry.js');

const provider: any = getOfframpProvider();
const patches: Array<{ id: string; patch: any }> = [];
provider.constructor.prototype.updateCustomer = async function (id: string, patch: any) {
  patches.push({ id, patch });
  return { id, ...patch };
};

await startKyc({ userId: 'usr_dob', type: 'individual' } as any);

check('a customer was created', (await db.read()).customers.length === 1);
check('and birth_date was PUT to the provider afterwards',
  patches.length === 1, `patches=${patches.length}`);
check('with the stored date, in Bridge\'s field name',
  patches[0]?.patch?.birth_date === '1990-01-15', JSON.stringify(patches[0]?.patch));
check('against the customer the link created',
  patches[0]?.id === (await db.read()).customers[0].providerCustomerId,
  `${patches[0]?.id} vs ${(await db.read()).customers[0].providerCustomerId}`);
check('the push is audited',
  ((await db.read()).auditLogs ?? []).some((a: any) => a.action === 'customer.birth_date_pushed'));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. a failed push must NOT lose the KYC link ──────────────');

await db.mutate((d: any) => {
  d.users.push({ id: 'usr_fail', email: 'fail@t.test', emailVerifiedAt: now(), country: 'US',
    fullName: 'Fail Case', dateOfBirth: '1990-01-15', createdAt: now(), updatedAt: now() });
  return 1;
});
provider.constructor.prototype.updateCustomer = async function () {
  throw new Error('Bridge: 503 service unavailable');
};

const survived: any = await startKyc({ userId: 'usr_fail', type: 'individual' } as any)
  .catch((e: Error) => ({ threw: e.message }));
check('the customer and link still exist despite the failure',
  Boolean(survived?.providerCustomerId) && !survived?.threw,
  JSON.stringify(survived?.threw ?? '').slice(0, 120));
check('and the failure is audited at error severity',
  ((await db.read()).auditLogs ?? []).some(
    (a: any) => a.action === 'customer.birth_date_push_failed' && a.severity === 'error'));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 6. no date on file -> nothing is pushed ──────────────────');

await db.mutate((d: any) => {
  d.users.push({ id: 'usr_nodob', email: 'nodob@t.test', emailVerifiedAt: now(), country: 'NG',
    fullName: 'No Dob', createdAt: now(), updatedAt: now() });
  return 1;
});
patches.length = 0;
provider.constructor.prototype.updateCustomer = async function (id: string, patch: any) {
  patches.push({ id, patch });
  return { id };
};
await startKyc({ userId: 'usr_nodob', type: 'individual' } as any);
check('a user with no date of birth triggers no PUT',
  patches.length === 0,
  'Nigerians verify by bank name and may never be asked - a missing date is normal');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 7. the backfill route ────────────────────────────────────');

const { syncCustomerDateOfBirth } = await import('../src/customers/customers.service.js');
patches.length = 0;
const backfilled: any = await syncCustomerDateOfBirth('usr_dob');
check('an existing customer can be patched without re-verifying',
  patches.length === 1 && patches[0].patch.birth_date === '1990-01-15',
  JSON.stringify(patches[0]?.patch));
check('and it reports what it did', backfilled.dateOfBirth === '1990-01-15');
check('backfill is audited as a backfill',
  ((await db.read()).auditLogs ?? []).some(
    (a: any) => a.action === 'customer.birth_date_pushed' && a.metadata?.backfill === true));

const noDate = await syncCustomerDateOfBirth('usr_nodob').then(() => null).catch((e: Error) => e);
check('backfilling a user with no date refuses clearly',
  noDate instanceof AppError && /date of birth/i.test(String((noDate as any).message)),
  String(noDate));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

/**
 * LEVEL 2 BVN VERIFICATION DID NOTHING. THE FEATURE WAS A NO-OP.
 *
 * The provider, service, route and even the frontend form all existed and
 * worked - a user could submit their BVN and Monnify would answer 'matched'.
 * Then:
 *
 *     $ grep -c "db\." src/kyc/service/ngn-kyc-level.service.ts
 *     0
 *
 * Nothing was written down. The verdict lived only in the HTTP response, so a
 * refresh put the user back at Level 1 with no record they had ever verified.
 * verification-state.ts hardcoded `const bvnStatus = CheckStatus.NOT_STARTED`,
 * so even a successful check reported as never attempted.
 *
 * The same shape as the deposit confirmer: machinery built, outcome never
 * persisted, feature structurally unable to take effect.
 *
 * Run: npm run test:ngn-bvn-level2
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-bvn-level2.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.NGN_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'bvn-admin-key';
process.env.USER_JWT_SECRET = 'bvn-jwt-secret-value-long-enough';
process.env.KYC_LEVEL_PROVIDER = 'mock';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-bvn-level2.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { verifyNgnBvnIdentity } = await import('../src/kyc/service/ngn-kyc-level.service.js');
const { getVerificationState } = await import('../src/kyc/service/verification-state.js');
const { getVerificationSummary } = await import('../src/kyc/service/verification-summary.service.js');
const { FLOW_LIMITS, VerificationLevel, CheckStatus } = await import('../src/kyc/types/verification.types.js');

const now = () => new Date().toISOString();
const GOOD = { bvn: '22222222222', firstName: 'John', lastName: 'Doe', dateOfBirth: '01-01-1990', mobileNo: '08012345678' };

async function seedBankVerified(userId: string) {
  await db.mutate((d: any) => {
    d.users = [...(d.users ?? []).filter((u: any) => u.id !== userId),
      { id: userId, email: `${userId}@t.test`, country: 'NG', fullName: 'John Doe', createdAt: now(), updatedAt: now() }];
    d.ngnPayoutAccounts = [...(d.ngnPayoutAccounts ?? []).filter((a: any) => a.userId !== userId),
      { id: `acct_${userId}`, userId, provider: 'mock', bankId: '1', bankName: 'Access Bank',
        accountNumber: '1111111111', accountName: 'John Doe', status: 'verified', createdAt: now(), updatedAt: now() }];
    return 1;
  });
}

console.log('\n── the ladder: Level 1 before, Level 2 after ─────────────────');

await seedBankVerified('u_bvn');
const before = await getVerificationState('u_bvn');
check('a bank-verified user starts at Level 1', before.level === VerificationLevel.BANK, String(before.level));
check('with bvnStatus not_started', before.bvnStatus === CheckStatus.NOT_STARTED, String(before.bvnStatus));

const result: any = await verifyNgnBvnIdentity('u_bvn', GOOD as any);
check('a matching BVN returns matched', result.status === 'matched', JSON.stringify(result).slice(0, 140));

const after = await getVerificationState('u_bvn');
check('the user is now Level 2', after.level === VerificationLevel.IDENTITY, String(after.level));
/**
 * bvnStatus was HARDCODED to NOT_STARTED. A user who had genuinely verified
 * was still told they had not, and any screen reading this field showed a
 * completed step as outstanding.
 */
check('and bvnStatus reflects reality', after.bvnStatus === CheckStatus.VERIFIED, String(after.bvnStatus));

console.log('\n── it PERSISTS - the bug was that it did not ─────────────────');

const stored = await db.listNgnIdentityVerifications('u_bvn');
check('a row was written', stored.length === 1, String(stored.length));
check('with verifiedAt set', Boolean(stored[0]?.verifiedAt));
check('and the provider recorded', Boolean(stored[0]?.provider), JSON.stringify(stored[0]).slice(0, 120));

/**
 * THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. A fresh read of the
 * whole state - what a page refresh does - must still say Level 2.
 */
const summary: any = await getVerificationSummary('u_bvn');
check('a fresh summary read still says Level 2', summary.level === VerificationLevel.IDENTITY, String(summary.level));
check('and reports the BVN check as verified', summary.checks.bvn === 'verified', String(summary.checks.bvn));

console.log('\n── the BVN itself is NOT stored ──────────────────────────────');

const raw = fs.readFileSync('.data/test-bvn-level2.json', 'utf8');
check('the 11-digit BVN appears nowhere in the database',
  !raw.includes(GOOD.bvn),
  'a BVN links every bank account a Nigerian holds - storing it turns a leak into identity theft');
check('only the last four digits are kept', stored[0]?.bvnLast4 === '2222', String(stored[0]?.bvnLast4));
check('and a non-reversible hash', (stored[0]?.bvnHash ?? '').length === 64, String(stored[0]?.bvnHash?.length));
check('the audit log does not carry the BVN either',
  !JSON.stringify(await db.listAuditLogsByActions(['kyc.ngn_bvn_verification'])).includes(GOOD.bvn));

console.log('\n── the ₦5,000,000 ceiling ────────────────────────────────────');

const l2 = FLOW_LIMITS.find((l: any) => l.flow === 'offramp' && l.rail === 'ngn' && l.level === VerificationLevel.IDENTITY);
check('Level 2 off-ramp is NGN 5,000,000', l2?.cumulativeNgn === 5_000_000, String(l2?.cumulativeNgn));
const offramp = summary.allowances.find((a: any) => a.flow === 'offramp' && a.rail === 'ngn');
check('and the user actually gets it', offramp?.limitNgn === 5_000_000, JSON.stringify(offramp));

/**
 * UNLIMITED WAS ASKED FOR AND DELIBERATELY NOT SHIPPED. One identity check is
 * not knowledge of where money comes from - that is Level 4. Asserted so a
 * later edit to null has to argue with this line.
 */
check('Level 2 is NOT uncapped', l2?.cumulativeNgn !== null,
  'a single identity check does not justify removing the blast-radius bound');

console.log('\n── a failed check grants nothing ─────────────────────────────');

await seedBankVerified('u_fail');
/**
 * The MOCK provider signals failure on a BVN ending 0000 - it does not check
 * names. An earlier version of this test passed a wrong surname and was
 * surprised to get 'matched'; the provider was right and the test was wrong.
 * Use the mock's actual failure contract.
 */
const bad: any = await verifyNgnBvnIdentity('u_fail', { ...GOOD, bvn: '11111110000' } as any);
const failState = await getVerificationState('u_fail');
check('a non-matching BVN does not reach Level 2',
  failState.level === VerificationLevel.BANK,
  `${failState.level} after status=${bad.status}`);
check('but the attempt IS recorded',
  (await db.listNgnIdentityVerifications('u_fail')).length === 1,
  'support needs to see the attempt when a user says "I tried and it failed"');
check('with no verifiedAt',
  !(await db.listNgnIdentityVerifications('u_fail'))[0]?.verifiedAt);

console.log('\n── one BVN across two accounts is flagged ────────────────────');

await seedBankVerified('u_dupe');
await verifyNgnBvnIdentity('u_dupe', GOOD as any);
const reuse = await db.listAuditLogsByActions(['kyc.bvn_reused_across_accounts']);
check('a second account using the same BVN raises a warning',
  reuse.length >= 1,
  'the fraud pattern this check exists to catch');
check('recorded, not blocked',
  (await getVerificationState('u_dupe')).level === VerificationLevel.IDENTITY,
  'a shared BVN has innocent explanations; refusing automatically strands a real user');

console.log('\n── the step is offered when a provider can answer ────────────');

const { isKycLevelProviderConfigured } = await import('../src/kyc/providers/kyc-level-provider-registry.js');
check('a configured provider makes Level 2 available', isKycLevelProviderConfigured() === true);

const summarySrc = fs.readFileSync('src/kyc/service/verification-summary.service.ts', 'utf8');
/**
 * The step was gated on identityVerificationEnabled - a DIFFERENT control,
 * which decides whether a check is REQUIRED. Conflating "mandatory" with
 * "possible" kept the button at "Coming soon" long after the provider worked.
 */
check('availability is gated on the provider, not the identity toggle',
  /nextStepFor\(path, state\.level, isKycLevelProviderConfigured\(\)\)/.test(summarySrc),
  'reading identityVerificationEnabled here conflates "required" with "possible"');
check('and the copy quotes the new ceiling',
  summarySrc.includes('₦5,000,000'),
  'telling a user 500,000 while granting 5,000,000 is a promise mismatch');


console.log('\n── the screen must agree with the server ─────────────────────');

/**
 * CAUGHT BY LOOKING AT THE SCREENSHOT, not by any assertion here.
 *
 * After a successful BVN check the API returned Level 2 with a NGN 5,000,000
 * ceiling while the page still showed "Level 1: Bank verified" and
 * "₦100,000 left". The success message and the refresh toast BOTH appeared,
 * and every test passed, because refreshKyc() refetches only the BRIDGE
 * customer - /api/customers/:id/kyc-status - and the level badge, step list
 * and naira allowance all come from the verification summary, which is loaded
 * by loadUserData().
 *
 * A Nigerian user has no Bridge customer at all, so the old refresh fetched
 * the one thing that could not have changed and skipped the one that had.
 */
const appSrc = fs.readFileSync('frontend/src/App.tsx', 'utf8');
/**
 * Sliced to the CLOSING BRACE, and with comments stripped.
 *
 * A fixed 1400-character window ended inside this function's own docstring,
 * so the regex matched the prose describing the fix rather than the fix - the
 * assertion passed with the bug reintroduced. Found by mutation-testing it.
 */
const refreshStart = appSrc.indexOf('async function refreshKyc()');
const refreshFn = appSrc
  .slice(refreshStart, appSrc.indexOf('\n  }', refreshStart))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
check('refreshKyc reloads the verification summary, not just the Bridge customer',
  /loadUserData\(\)/.test(refreshFn),
  'the level badge and naira allowance come from the summary; without this the screen contradicts the API');

const sectionsSrc = fs.readFileSync('frontend/src/components/AppSections.tsx', 'utf8');
check('a successful BVN submit triggers that refresh',
  /status === 'matched'\) onRefresh\(\)/.test(sectionsSrc),
  'otherwise the only way to see the new level is a manual page reload');
/**
 * The conditional itself is the assertion. An earlier version of this check
 * tried to prove the NEGATIVE - that no unconditional onRefresh() exists - with
 * a regex over the whole file, which matched unrelated handlers and failed
 * against correct code. Asserting that the call is GUARDED by the matched
 * status is the same guarantee and cannot be fooled by a neighbouring line.
 */
check('the refresh is conditional, not unconditional',
  /if \(\(result as any\)\?\.status === 'matched'\) onRefresh\(\);/.test(sectionsSrc),
  'review and failed change nothing about the level; refetching would just make the form flicker');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

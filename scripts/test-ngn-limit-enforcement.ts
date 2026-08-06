/**
 * NGN TIER LIMITS: ENFORCEMENT, PER-FLOW TOGGLES, AND THE IN-FLIGHT BYPASS.
 *
 * THE BUG THIS EXISTS FOR. getCumulativeNgnVolume counted only
 * `status in ('completed','settled')`, so money mid-flight counted as ZERO.
 * Measured before any code was written:
 *
 *     in-flight NGN 90,000 + completed NGN 15,000
 *     counted against the limit -> 15,000
 *
 * At the Level 2 ceiling of NGN 100,000 that is a real bypass: start a 90,000
 * withdrawal, and while it sits in settlement_processing start another. The
 * second quote sees 85,000 free and is approved. 180,000 in flight against a
 * 100,000 limit, and no single request broke a rule.
 *
 * Everything below goes through the REAL app over HTTP - real quotes, real
 * provider, real verification state. A limit asserted against a helper
 * function is a limit nobody has shown to refuse a request.
 *
 * Run: npm run test:ngn-limit-enforcement
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-ngn-limits.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.NGN_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'limits-admin-key';
process.env.USER_JWT_SECRET = 'limits-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.AUTH_REQUIRE_USER = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-ngn-limits.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { buildApp } = await import('../src/app.js');
const { db } = await import('../src/database/json-database.js');
const { nowIso, id } = await import('../src/shared/id.js');
const { NGN_LIMIT_CONSUMING_STATUSES, NGN_LIMIT_RELEASING_STATUSES } = await import('../src/ngn/types/ngn.types.js');
const { getCumulativeNgnVolume } = await import('../src/kyc/service/verification-state.js');

const app = await buildApp();
const ADMIN = { 'x-admin-api-key': 'limits-admin-key' };

/** A user at Level 1 (BANK): verified NGN payout account, ceiling NGN 100,000. */
async function seedUser(userId: string) {
  const at = nowIso();
  await db.mutate((d: any) => {
    d.users = d.users ?? [];
    if (!d.users.find((u: any) => u.id === userId)) {
      d.users.push({ id: userId, email: `${userId}@t.test`, country: 'NG', fullName: 'Test User', createdAt: at, updatedAt: at });
    }
    d.ngnPayoutAccounts = d.ngnPayoutAccounts ?? [];
    d.ngnPayoutAccounts.push({
      id: id('ngnacct'), userId, provider: 'mock', bankId: '1', bankName: 'Access Bank',
      accountNumber: '1111111111', accountName: 'OGUNMEPON SHARAFA', status: 'verified',
      createdAt: at, updatedAt: at,
    });
    d.ngnControls = [{
      id: 'global', onrampEnabled: true, offrampEnabled: true, mockProviderEnabled: true,
      bankSettlementEnabled: true, virtualAccountEnabled: false, activeProvider: 'mock',
      identityVerificationEnabled: false, externalFundingEnabled: false,
      limitEnforcementOfframp: true, limitEnforcementOnramp: true, limitEnforcementEscrow: true,
      maxTransactionNgn: '500000', dailyLimitNgn: '2000000', highValueReviewThresholdNgn: '1000000',
      updatedBy: 'seed', updatedAt: at,
    }];
    return 1;
  });
}

/** Add a transfer in a given status, worth a given amount of naira. */
async function addTransfer(userId: string, status: string, ngn: number) {
  const at = nowIso();
  await db.mutate((d: any) => {
    d.ngnTransfers = d.ngnTransfers ?? [];
    d.ngnTransfers.push({
      id: id('ngnt'), userId, direction: 'offramp', provider: 'mock',
      sourceCurrency: 'usdc', destinationCurrency: 'ngn',
      sourceAmount: String(ngn / 1500), destinationAmount: String(ngn),
      status, createdAt: at, updatedAt: at,
    });
    return 1;
  });
}

/** Ask the REAL quote endpoint for an off-ramp worth roughly `ngn` naira. */
async function quote(userId: string, usdc: number) {
  return app.inject({
    method: 'GET',
    url: `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=${usdc}&network=solana`,
  });
}

async function setControls(patch: Record<string, unknown>) {
  return app.inject({ method: 'PUT', url: '/api/admin/ngn/controls', headers: ADMIN, payload: patch });
}

console.log('\n── the two status sets are exhaustive and disjoint ────────────');

const overlap = [...NGN_LIMIT_CONSUMING_STATUSES].filter((s) => NGN_LIMIT_RELEASING_STATUSES.has(s));
check('no status both consumes and releases headroom', overlap.length === 0, overlap.join(','));
check('in-flight states consume',
  ['processing', 'settlement_processing', 'bank_processing', 'deposit_received'].every((s) => NGN_LIMIT_CONSUMING_STATUSES.has(s)),
  'this is the bypass being closed');
check('early cancellable states consume too',
  ['created', 'quote_accepted', 'awaiting_crypto_deposit'].every((s) => NGN_LIMIT_CONSUMING_STATUSES.has(s)),
  'two open deposit addresses are two ways over one ceiling');
check('terminal-failed states release',
  ['failed', 'expired', 'cancelled'].every((s) => NGN_LIMIT_RELEASING_STATUSES.has(s)),
  'abandonment must refund headroom, or a provider outage permanently costs a user');
check('completed still consumes', NGN_LIMIT_CONSUMING_STATUSES.has('completed'));

console.log('\n── the SHIPPED DEFAULT enforces, without being seeded ─────────');

/**
 * FOUND BY MUTATION TESTING. Flipping every default to false left this suite
 * at 40/40, because every case seeds ngnControls explicitly and none of them
 * ever exercised the shipped fallback. A deployment that never wrote a
 * controls row would have run with NO limits and no test would have noticed.
 *
 * getNgnControls() is called with the row absent, so this asserts the default
 * the code actually falls back to.
 */
await db.mutate((d: any) => { d.ngnControls = []; return 1; });
const { getNgnControls } = await import('../src/ngn/service/ngn-controls.service.js');
const shipped = await getNgnControls();
check('off-ramp enforcement defaults ON with no controls row',
  shipped.limitEnforcementOfframp === true,
  String(shipped.limitEnforcementOfframp) + ' - a control whose job is to refuse must refuse by default');
check('on-ramp enforcement defaults ON', shipped.limitEnforcementOnramp === true);
check('escrow enforcement defaults ON', shipped.limitEnforcementEscrow === true);

console.log('\n── THE BYPASS: in-flight money now counts ────────────────────');

await seedUser('usr_inflight');
await addTransfer('usr_inflight', 'completed', 15_000);
await addTransfer('usr_inflight', 'settlement_processing', 90_000);

const counted = await getCumulativeNgnVolume('usr_inflight', 30);
check('in-flight NGN 90,000 is counted, not ignored',
  counted === 105_000,
  `${counted} - was 15,000 before this fix, which let a second order through`);

/**
 * THE ASSERTION THAT MATTERS: the real endpoint must now REFUSE. Level 1
 * ceiling is NGN 100,000 and 105,000 is already consumed.
 */
const blocked = await quote('usr_inflight', 10);
check('a second quote is REFUSED over the ceiling',
  blocked.statusCode === 403,
  `${blocked.statusCode} ${blocked.body.slice(0, 120)}`);

console.log('\n── released states give the headroom back ────────────────────');

await seedUser('usr_released');
await addTransfer('usr_released', 'failed', 90_000);
await addTransfer('usr_released', 'cancelled', 90_000);
await addTransfer('usr_released', 'expired', 90_000);

const releasedVol = await getCumulativeNgnVolume('usr_released', 30);
check('failed/cancelled/expired count as zero', releasedVol === 0, String(releasedVol));
const allowed = await quote('usr_released', 10);
check('so a quote is ALLOWED', allowed.statusCode === 200, `${allowed.statusCode} ${allowed.body.slice(0, 120)}`);

console.log('\n── enforcement by TIER ───────────────────────────────────────');

/** Level 0: no verified bank. Ceiling is 0 - nothing moves. */
const at0 = nowIso();
await db.mutate((d: any) => {
  d.users.push({ id: 'usr_level0', email: 'l0@t.test', country: 'NG', fullName: 'L Zero', createdAt: at0, updatedAt: at0 });
  return 1;
});
const level0 = await quote('usr_level0', 10);
check('Level 0 (unverified) is refused at any amount',
  level0.statusCode === 403,
  `${level0.statusCode} - the NONE tier ceiling is 0`);

/** Level 1 (BANK), ceiling 100,000: under passes, over fails. */
await seedUser('usr_level1');
const under = await quote('usr_level1', 10);   // ~15,000 NGN
check('Level 1 under the ceiling is allowed', under.statusCode === 200, String(under.statusCode));

const over = await quote('usr_level1', 200);   // ~300,000 NGN
check('Level 1 over the ceiling is refused', over.statusCode === 403, String(over.statusCode));
check('and the refusal explains itself',
  /limit|ceiling|verif/i.test(over.body),
  over.body.slice(0, 160));

console.log('\n── an admin tier override is honoured by ENFORCEMENT ──────────');

await seedUser('usr_tier');
const rejectedBefore = await quote('usr_tier', 200);
check('300,000 refused at the default 100,000 ceiling', rejectedBefore.statusCode === 403);

const raise = await app.inject({
  method: 'PUT', url: '/api/admin/verification-limits', headers: ADMIN,
  payload: { flow: 'offramp', rail: 'ngn', level: 1, cumulativeNgn: 500_000, reason: 'test raise' },
});
check('admin can raise the tier ceiling', raise.statusCode === 200, String(raise.statusCode));

const afterRaise = await quote('usr_tier', 200);
check('the SAME quote now passes',
  afterRaise.statusCode === 200,
  `${afterRaise.statusCode} - the console and the block must agree`);

/**
 * PUT THE CEILING BACK.
 *
 * The raise above is GLOBAL - it is a tier override, not a per-user one - and
 * leaving it at 500,000 silently relaxed every assertion after this point.
 * Three later checks failed for that reason and not because the product was
 * wrong. Test isolation, not a product fix.
 */
const restore = await app.inject({
  method: 'DELETE', url: '/api/admin/verification-limits', headers: ADMIN,
  payload: { flow: 'offramp', rail: 'ngn', level: 1 },
});
check('the raised ceiling can be cleared again',
  restore.statusCode === 200,
  `${restore.statusCode} - later sections depend on the default 100,000`);

console.log('\n── PER-FLOW toggle, and no global off switch ─────────────────');

await setControls({ limitEnforcementOfframp: false });
const skipped = await quote('usr_level1', 200);
check('off-ramp enforcement OFF lets an over-limit quote through',
  skipped.statusCode === 200,
  String(skipped.statusCode));

/**
 * The point of per-flow: turning off-ramp off must NOT uncap on-ramp. A single
 * master switch is what this design exists to avoid.
 */
const controlsNow = (await app.inject({ method: 'GET', url: '/api/admin/ngn/controls', headers: ADMIN })).json().data;
check('on-ramp enforcement is untouched', controlsNow.limitEnforcementOnramp === true);
check('escrow enforcement is untouched', controlsNow.limitEnforcementEscrow === true);
/**
 * FOUND BY MUTATION TESTING. Making limitEnforcementEnabled() return the
 * OFF-RAMP flag for every flow - the exact "accidental global switch" this
 * design exists to prevent - left the suite green, because checking that the
 * on-ramp FLAG is still true says nothing about whether on-ramp still
 * REFUSES. Assert the behaviour, not the stored value.
 */
const onrampStillEnforced = await app.inject({
  method: 'GET',
  url: `/api/ngn/quote?userId=usr_level1&direction=onramp&sourceCurrency=ngn&destinationCurrency=usdc&sourceAmount=300000&network=solana`,
});
check('on-ramp STILL REFUSES while off-ramp enforcement is off',
  onrampStillEnforced.statusCode === 403,
  `${onrampStillEnforced.statusCode} - one flow's switch must never uncap another`);

check('there is no single global limits-off flag',
  !('limitEnforcementEnabled' in controlsNow) && !('limitsEnabled' in controlsNow),
  'one click must not uncap every flow at once');

await setControls({ limitEnforcementOfframp: true });
const reEnforced = await quote('usr_level1', 200);
check('turning it back ON refuses immediately',
  reEnforced.statusCode === 403,
  'usage kept accruing while it was off, so re-enabling needs no catch-up');

console.log('\n── GRANDFATHERING: in-flight is never blocked retroactively ───');

/**
 * The rule agreed with the founder: never retroactively block a transfer that
 * already exists; always count it against the NEXT one. Blocking mid-flight
 * would strand crypto that has already left the user's wallet.
 */
await seedUser('usr_grand');
await addTransfer('usr_grand', 'settlement_processing', 200_000);

// db.listNgnTransfers() takes NO filter - it returns everything. Passing one
// was my error and the assertion failed against correct product code.
const inflight = (await db.listNgnTransfers()) ?? [];
const stillMoving = inflight.filter((t: any) => t.userId === 'usr_grand' && t.status === 'settlement_processing');
check('the existing over-limit transfer is untouched',
  stillMoving.length === 1 && stillMoving[0].status === 'settlement_processing',
  'blocking it would hold settled crypto with no naira paid');

const nextOne = await quote('usr_grand', 10);
check('but their NEXT quote is refused',
  nextOne.statusCode === 403,
  'grandfathered on the way through, counted on the way in');

console.log('\n── admin visibility BEFORE switching enforcement on ───────────');

const consumption = await app.inject({
  method: 'GET', url: '/api/admin/limits/consumption?flow=offramp&rail=ngn', headers: ADMIN,
});
const cbody = consumption.json().data;
check('consumption endpoint answers', consumption.statusCode === 200, String(consumption.statusCode));
check('and reports who is consuming headroom',
  cbody.userCount >= 2 && cbody.users.some((u: any) => u.userId === 'usr_grand'),
  JSON.stringify(cbody).slice(0, 200));
check('with a total, so "who is over" is answerable at a glance',
  typeof cbody.totalNgn === 'number' && cbody.totalNgn > 0,
  'silent grandfathering is how a policy quietly fails to apply');

console.log('\n── BULK RESET for all users, and its three guards ────────────');

const noConfirm = await app.inject({
  method: 'POST', url: '/api/admin/limits/reset-all', headers: ADMIN,
  payload: { flow: 'offramp', rail: 'ngn', reason: 'oops' },
});
check('a reset without the confirmation phrase is rejected',
  noConfirm.statusCode >= 400,
  `${noConfirm.statusCode} - {confirm:true} is what a bad script sends by accident`);

const wrongPhrase = await app.inject({
  method: 'POST', url: '/api/admin/limits/reset-all', headers: ADMIN,
  payload: { flow: 'offramp', rail: 'ngn', reason: 'oops', confirm: 'yes' },
});
check('and the phrase must be exact', wrongPhrase.statusCode >= 400, String(wrongPhrase.statusCode));

const dry = await app.inject({
  method: 'POST', url: '/api/admin/limits/reset-all', headers: ADMIN,
  payload: { flow: 'offramp', rail: 'ngn', reason: 'preview', confirm: 'RESET_ALL_LIMITS' },
});
const dryBody = dry.json().data;
check('omitting dryRun DEFAULTS TO A PREVIEW', dryBody.dryRun === true, JSON.stringify(dryBody).slice(0, 140));
check('a dry run changes nothing', dryBody.resetCount === 0);

const stillBlocked = await quote('usr_grand', 10);
check('and the user is still blocked after the preview',
  stillBlocked.statusCode === 403,
  'a preview that silently reset would be the worst possible default');

const real = await app.inject({
  method: 'POST', url: '/api/admin/limits/reset-all', headers: ADMIN,
  payload: { flow: 'offramp', rail: 'ngn', reason: 'provider outage burned volume', confirm: 'RESET_ALL_LIMITS', dryRun: false },
});
const realBody = real.json().data;
check('an explicit dryRun:false performs the reset', realBody.dryRun === false && realBody.resetCount > 0, JSON.stringify(realBody).slice(0, 160));

const afterReset = await quote('usr_grand', 10);
check('the previously blocked user can now quote',
  afterReset.statusCode === 200,
  `${afterReset.statusCode} - the window was forgiven for everyone on this flow`);

const logs = await db.listAuditLogsByActions(['admin.user_limit_window_reset_all']);
check('the bulk action is audited as one decision',
  logs.length === 1 && (logs[0] as any).metadata?.resetCount > 0,
  'per-user rows alone would hide that one person did this once');
check('and recorded at warning severity',
  (logs[0] as any).severity === 'warning',
  'it forgives money that already moved - it should be easy to find');

console.log('\n── the enforcement skip is auditable ─────────────────────────');

await setControls({ limitEnforcementOfframp: false });
await quote('usr_level1', 200);
await setControls({ limitEnforcementOfframp: true });

const skipLogs = await db.listAuditLogsByActions(['ngn.limit_enforcement_skipped']);
check('a quote that bypassed the ceiling is logged',
  skipLogs.length >= 1,
  'the first question after an incident is "what got through while it was off"');
check('at warning severity', (skipLogs[0] as any).severity === 'warning');

console.log('\n── both database adapters agree on what consumes ─────────────');

/**
 * The Postgres predicate is hand-written SQL and cannot import the TS Set, so
 * they can drift - and a drift silently changes what a limit MEANS depending
 * on which database is deployed.
 */
const pgSrc = fs.readFileSync('src/database/postgres-database.ts', 'utf8');
const i = pgSrc.indexOf('listNgnTransfersByUserSince');
const pgQuery = pgSrc.slice(i, pgSrc.indexOf('}', pgSrc.indexOf('finally', i)));
const missing = [...NGN_LIMIT_CONSUMING_STATUSES].filter((s) => !pgQuery.includes(`'${s}'`));
check('every consuming status appears in the Postgres query',
  missing.length === 0,
  `missing from SQL: ${missing.join(', ')}`);
const leaked = [...NGN_LIMIT_RELEASING_STATUSES].filter((s) => pgQuery.includes(`'${s}'`));
check('and no releasing status leaked into it', leaked.length === 0, `wrongly in SQL: ${leaked.join(', ')}`);

await app.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * BVN PROVIDER FAILOVER — try Monnify, fall through to Flutterwave.
 *
 * WHY. Monnify has not approved the account for BVN validation, so Level 2
 * cannot ship on Monnify today. It should ship on Flutterwave now and move
 * itself to Monnify the moment approval lands - without a code change or a
 * deploy timed to somebody else's email.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE PROPERTY THIS FILE EXISTS TO DEFEND:
 *
 *     FALL OVER ON ERRORS. NEVER ON VERDICTS.
 *
 * An ERROR means "this provider could not answer" - revoked key, 503, account
 * not approved. Another vendor may legitimately answer. Fall through.
 *
 * A VERDICT means "it answered, and the answer is no" - `failed` on a name
 * mismatch, `review` pending a human. That IS the answer. Return it.
 *
 * Falling through on `failed` would mean asking each provider in turn until
 * one says `matched` - shopping for a yes. A user whose BVN belongs to someone
 * else would be refused by Monnify, then handed to Flutterwave for a second
 * opinion on identical facts, and any disagreement becomes a free pass to
 * Level 2 and a NGN 5,000,000 ceiling.
 *
 * Most of the assertions below are about that not happening.
 *
 * Run: npm run test:kyc-provider-failover
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-kyc-failover.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'failover-admin-key';
process.env.USER_JWT_SECRET = 'failover-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-kyc-failover.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { FailoverKycLevelProvider, buildKycProviderChain } =
  await import('../src/kyc/providers/failover-kyc-level.provider.js');
const { getKycLevelProvider, isKycLevelProviderConfigured } =
  await import('../src/kyc/providers/kyc-level-provider-registry.js');
const { env } = await import('../src/config/env.js');
const { db } = await import('../src/database/json-database.js');
const { AppError, forbidden, serviceUnavailable, badRequest } =
  await import('../src/shared/errors.js');

const CLAIM = {
  bvn: '22222222280', firstName: 'Ernest', lastName: 'Certifier',
  dateOfBirth: '30-11-1976', mobileNo: '08169835630',
};

/** A stand-in provider whose behaviour each test dictates. */
function stub(name: string, behaviour: () => any) {
  return {
    name,
    calls: 0,
    async verifyBvnIdentity() { (this as any).calls += 1; return behaviour(); },
    async verifyBvnBankAccount() { (this as any).calls += 1; return behaviour(); },
    async health() { return { provider: name, available: true, mode: 'live' as const, checkedAt: new Date().toISOString() }; },
  };
}

const ok = (provider: string, status = 'matched') => () => ({
  provider, status, message: `${provider} says ${status}`, bvnLast4: '2280',
});
const throws = (error: unknown) => () => { throw error; };

async function auditActions() {
  return ((await db.read()).auditLogs ?? []).map((a: any) => a.action);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the chain is built from what is CONFIGURED ────────────');

const originalMonnifyKey = env.MONNIFY_API_KEY;
const originalMonnifySecret = env.MONNIFY_SECRET_KEY;
const originalFlwKey = env.FLUTTERWAVE_SECRET_KEY;
const originalFlwV2 = env.FLUTTERWAVE_BVN_ALLOW_V2_DIRECT;
const originalPreferred = env.KYC_LEVEL_PROVIDER;

function configure(opts: { monnify: boolean; flutterwave: boolean; preferred?: string }) {
  (env as any).MONNIFY_API_KEY = opts.monnify ? 'MK_TEST' : '';
  (env as any).MONNIFY_SECRET_KEY = opts.monnify ? 'MS_TEST' : '';
  (env as any).FLUTTERWAVE_SECRET_KEY = opts.flutterwave ? 'FLWSECK_TEST' : '';
  (env as any).FLUTTERWAVE_BVN_ALLOW_V2_DIRECT = opts.flutterwave;
  if (opts.preferred) (env as any).KYC_LEVEL_PROVIDER = opts.preferred;
}

configure({ monnify: false, flutterwave: false });
check('nothing configured -> empty chain', buildKycProviderChain().length === 0);
check('and the registry falls back to mock', getKycLevelProvider().name === 'mock');

configure({ monnify: false, flutterwave: true, preferred: 'monnify' });
check('only Flutterwave configured -> chain of one',
  buildKycProviderChain().map((c: any) => c.name).join(',') === 'flutterwave',
  buildKycProviderChain().map((c: any) => c.name).join(','));
check('an unconfigured preferred vendor is NOT in the chain',
  !buildKycProviderChain().some((c: any) => c.name === 'monnify'),
  'attempting a vendor with no key turns one clean failure into two');

/**
 * TODAY'S ACTUAL SITUATION: Monnify unapproved, Flutterwave ready. The Level 2
 * button must be OFFERED - it read only KYC_LEVEL_PROVIDER before, so it
 * reported false and hid the step even though the chain could answer.
 */
check('Level 2 is offered when ANY vendor can answer',
  isKycLevelProviderConfigured() === true,
  'this is the Monnify-unapproved case and the step must not be hidden');

configure({ monnify: true, flutterwave: true, preferred: 'monnify' });
check('both configured -> Monnify first',
  buildKycProviderChain().map((c: any) => c.name).join(',') === 'monnify,flutterwave',
  buildKycProviderChain().map((c: any) => c.name).join(','));

configure({ monnify: true, flutterwave: true, preferred: 'flutterwave' });
check('the preferred vendor leads the chain',
  buildKycProviderChain().map((c: any) => c.name).join(',') === 'flutterwave,monnify',
  buildKycProviderChain().map((c: any) => c.name).join(','));
check('and no vendor appears twice',
  new Set(buildKycProviderChain().map((c: any) => c.name)).size === buildKycProviderChain().length);

check('asking for one vendor by name still gets exactly that vendor',
  getKycLevelProvider('monnify').name === 'monnify' &&
  getKycLevelProvider('flutterwave').name === 'flutterwave');

configure({ monnify: true, flutterwave: true, preferred: 'monnify' });
check('with two vendors the registry returns the failover chain',
  getKycLevelProvider().name === 'failover', getKycLevelProvider().name);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. it falls through on ERRORS ────────────────────────────');

const notApproved = forbidden('Monnify: account not approved for BVN validation.');
const primaryDown = stub('monnify', throws(notApproved));
const backup = stub('flutterwave', ok('flutterwave'));
const chain: any = new FailoverKycLevelProvider([
  { name: 'monnify', provider: primaryDown as any },
  { name: 'flutterwave', provider: backup as any },
]);

const failedOver = await chain.verifyBvnIdentity(CLAIM);
check('an unapproved primary falls through to the backup',
  failedOver.status === 'matched', JSON.stringify(failedOver));
check('the result is stamped with who ACTUALLY answered',
  failedOver.provider === 'flutterwave', failedOver.provider);
check('the primary was tried first', primaryDown.calls === 1);
check('the backup answered', backup.calls === 1);
check('the fall-through is audited',
  (await auditActions()).includes('kyc.provider_failover'));

const logs: any[] = ((await db.read()).auditLogs ?? []).filter((a: any) => a.action === 'kyc.provider_failover');
check('the audit records who answered and who was tried',
  logs[0].metadata.answeredBy === 'flutterwave' &&
  logs[0].metadata.attempted.join(',') === 'monnify,flutterwave',
  JSON.stringify(logs[0].metadata));
check('and it NEVER logs the full BVN',
  logs[0].metadata.bvnLast4 === '2280' && !JSON.stringify(logs[0].metadata).includes('22222222280'),
  JSON.stringify(logs[0].metadata));
check('it is warning severity, not info',
  logs[0].severity === 'warning',
  'running on the backup is a state somebody should notice');

// A 503 and a bare network error are both "could not answer".
for (const [label, error] of [
  ['a 503 upstream outage', serviceUnavailable('provider down')],
  ['a bare network error', new Error('fetch failed: ETIMEDOUT')],
] as const) {
  const p = stub('monnify', throws(error));
  const b = stub('flutterwave', ok('flutterwave'));
  const c: any = new FailoverKycLevelProvider([
    { name: 'monnify', provider: p as any }, { name: 'flutterwave', provider: b as any },
  ]);
  const r = await c.verifyBvnIdentity(CLAIM);
  check(`${label} falls through`, r.provider === 'flutterwave', JSON.stringify(r));
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. IT NEVER FAILS OVER ON A VERDICT ──────────────────────');

/**
 * THE ASSERTION THIS WHOLE FILE IS FOR.
 *
 * Monnify says `failed` - the name on the BVN is not this person. Flutterwave
 * is rigged to say `matched`. If the chain asks it, the user is handed Level 2
 * on a BVN that is not theirs.
 */
for (const verdict of ['failed', 'review'] as const) {
  const refuser = stub('monnify', ok('monnify', verdict));
  const yesMan = stub('flutterwave', ok('flutterwave', 'matched'));
  const c: any = new FailoverKycLevelProvider([
    { name: 'monnify', provider: refuser as any },
    { name: 'flutterwave', provider: yesMan as any },
  ]);
  const r = await c.verifyBvnIdentity(CLAIM);
  check(`a '${verdict}' verdict is RETURNED, not retried`, r.status === verdict, JSON.stringify(r));
  check(`  and the second provider is never asked for a better answer`,
    yesMan.calls === 0,
    'asking until someone says matched is shopping for a yes');
  check(`  the answering provider is recorded as monnify`, r.provider === 'monnify', r.provider);
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. a bad REQUEST is not retried against another vendor ───');

/**
 * A 400 is our request being wrong - a malformed BVN. Sending the identical
 * bad input to a second vendor cannot succeed and costs another N50.
 */
const rejecter = stub('monnify', throws(badRequest('A BVN is 11 digits.')));
const shouldNotRun = stub('flutterwave', ok('flutterwave'));
const c400: any = new FailoverKycLevelProvider([
  { name: 'monnify', provider: rejecter as any },
  { name: 'flutterwave', provider: shouldNotRun as any },
]);
const badReq = await c400.verifyBvnIdentity(CLAIM).then(() => null).catch((e: Error) => e);
check('a 400 is rethrown, not failed over',
  badReq instanceof AppError && (badReq as any).statusCode === 400, String(badReq));
check('and the second provider is never billed for it', shouldNotRun.calls === 0);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. when everybody is down ────────────────────────────────');

const down1 = stub('monnify', throws(forbidden('not approved')));
const down2 = stub('flutterwave', throws(serviceUnavailable('flutterwave down')));
const allDown: any = new FailoverKycLevelProvider([
  { name: 'monnify', provider: down1 as any },
  { name: 'flutterwave', provider: down2 as any },
]);
const exhausted = await allDown.verifyBvnIdentity(CLAIM).then(() => null).catch((e: Error) => e);
check('the chain surfaces a 503, not a 500',
  exhausted instanceof AppError && (exhausted as any).statusCode === 503, String(exhausted));
check('with a message a user can act on',
  /try again/i.test(String((exhausted as any)?.message)), String((exhausted as any)?.message));
check('both vendors were genuinely tried', down1.calls === 1 && down2.calls === 1);
check('exhaustion is audited at error severity',
  (await auditActions()).includes('kyc.provider_chain_exhausted'));

const exLog: any = ((await db.read()).auditLogs ?? []).find((a: any) => a.action === 'kyc.provider_chain_exhausted');
check('naming every vendor that was attempted',
  exLog.metadata.attempted.join(',') === 'monnify,flutterwave', JSON.stringify(exLog.metadata));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 6. no silent success when nothing is configured ──────────');

const empty: any = new FailoverKycLevelProvider([]);
const none = await empty.verifyBvnIdentity(CLAIM).then(() => null).catch((e: Error) => e);
check('an empty chain refuses rather than passing',
  none instanceof AppError, String(none));
check('and says no provider is configured',
  /no bvn verification provider/i.test(String((none as any)?.message)), String((none as any)?.message));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 7. health reports the whole chain ────────────────────────');

const upDown: any = new FailoverKycLevelProvider([
  { name: 'monnify', provider: { ...stub('monnify', ok('monnify')), health: async () => ({ provider: 'monnify', available: false, mode: 'live', message: 'not approved', checkedAt: '' }) } as any },
  { name: 'flutterwave', provider: stub('flutterwave', ok('flutterwave')) as any },
]);
const h = await upDown.health();
check('available is true while ANY vendor can answer', h.available === true, JSON.stringify(h));
check('the message names each vendor and its state',
  /monnify=down/.test(h.message) && /flutterwave=up/.test(h.message), h.message);
check('and it WARNS that the primary is down',
  /PRIMARY monnify IS DOWN/.test(h.message), h.message);

const bothDown: any = new FailoverKycLevelProvider([
  { name: 'monnify', provider: { ...stub('monnify', ok('monnify')), health: async () => ({ provider: 'monnify', available: false, mode: 'live', checkedAt: '' }) } as any },
  { name: 'flutterwave', provider: { ...stub('flutterwave', ok('flutterwave')), health: async () => ({ provider: 'flutterwave', available: false, mode: 'live', checkedAt: '' }) } as any },
]);
check('available is false only when every vendor is down',
  (await bothDown.health()).available === false);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 8. the Monnify-approval handover happens by itself ───────');

/**
 * The end state this was built for: today Flutterwave answers because Monnify
 * throws "not approved"; the day approval lands Monnify simply stops throwing,
 * and the chain uses it again with no deploy.
 */
let monnifyApproved = false;
const monnify = stub('monnify', () => {
  if (!monnifyApproved) throw forbidden('Monnify: account not approved for BVN validation.');
  return { provider: 'monnify', status: 'matched', message: 'ok', bvnLast4: '2280' };
});
const flutterwave = stub('flutterwave', ok('flutterwave'));
const handover: any = new FailoverKycLevelProvider([
  { name: 'monnify', provider: monnify as any },
  { name: 'flutterwave', provider: flutterwave as any },
]);

check('before approval, Flutterwave answers',
  (await handover.verifyBvnIdentity(CLAIM)).provider === 'flutterwave');

monnifyApproved = true;
const after = await handover.verifyBvnIdentity(CLAIM);
check('after approval, Monnify answers again with NO code change',
  after.provider === 'monnify', after.provider);
check('and Flutterwave is no longer called (or billed)',
  flutterwave.calls === 1, `flutterwave calls=${flutterwave.calls}`);

// restore
(env as any).MONNIFY_API_KEY = originalMonnifyKey;
(env as any).MONNIFY_SECRET_KEY = originalMonnifySecret;
(env as any).FLUTTERWAVE_SECRET_KEY = originalFlwKey;
(env as any).FLUTTERWAVE_BVN_ALLOW_V2_DIRECT = originalFlwV2;
(env as any).KYC_LEVEL_PROVIDER = originalPreferred;

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

/**
 * PER-USER LIMITS, AND THE BALANCE BANNER THAT LIED.
 *
 * Two reported problems, fixed together because both are about telling a user
 * a number that is not true.
 *
 * 1. "i see retry in my wallet balance why is that"
 *
 *    Screenshot: "YOUR BALANCE — / Could not reach the network / Retrying
 *    shortly", while IN PROGRESS showed 9 and the limit card rendered fine.
 *
 *    Reproduced against the real endpoints on 2026-08-05:
 *      mainnet.base.org               200
 *      api.mainnet-beta.solana.com    200  (6/6)
 *      eth.llamarpc.com               521  <-- the only ethereum fallback
 *
 *    Every EVM wallet is read on BOTH networks (one secp256k1 key serves
 *    them), unified-balance did `wallets.some(w => w.balancesUnavailable)`,
 *    and so a single dead endpoint blanked the whole balance. The insult:
 *    Ethereum is DISABLED for transfers - supportedNetworks is
 *    ['base','solana'] because Ethereum gas loses $2-3 per transfer - so an
 *    outage on a chain the product does not use hid the balance on the chains
 *    it does.
 *
 * 2. "i want that i can be able to update or reset individual limit"
 *
 *    Limits were tier-only, keyed (flow, rail, level). Raising one merchant's
 *    ceiling raised it for every user at that level.
 *
 * Run: npm run test:user-limits
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-user-limits.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'user-limits-admin-key';
process.env.USER_JWT_SECRET = 'user-limits-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = path.join(root, '.data/test-user-limits.json');
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
fs.rmSync(dataFile, { force: true });

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const {
  setUserLimit,
  clearUserLimit,
  resetUserWindow,
  getUserLimitDetail,
  userLimitOverrideFor,
  isOverrideActive,
  MAX_USER_LIMIT_NGN,
  setUserLimitSchema,
} = await import('../src/kyc/service/user-limits.service.js');
const { effectiveUsedNgn } = await import('../src/kyc/service/user-limit-usage.js');
const { decide } = await import('../src/kyc/service/verification-policy.js');
const { evmRpcEndpoints } = await import('../src/wallets/evm/evm-rpc.js');
const { VerificationLevel, CheckStatus } = await import('../src/kyc/types/verification.types.js');

/**
 * An INTACT Level 1 state. decide() proves the level before consulting any
 * ceiling, so a fixture with a missing bank check is refused as
 * 'verification needs attention' and never reaches the limit arithmetic -
 * which would make the override assertions below pass for the wrong reason.
 */
const bankVerified = {
  level: VerificationLevel.BANK,
  bankStatus: CheckStatus.VERIFIED,
  ninStatus: CheckStatus.NOT_STARTED,
  bvnStatus: CheckStatus.NOT_STARTED,
  identityStatus: CheckStatus.NOT_STARTED,
  proofOfAddressStatus: CheckStatus.NOT_STARTED,
} as any;

const USER = 'usr_limits_test';
await db.insertUserRecord({
  id: USER,
  email: 'limits@sivan.test',
  fullName: 'Limit Test',
  country: 'NG',
  createdAt: new Date().toISOString(),
} as any);

console.log('\n── 1. the balance banner: one dead chain must not blank the rest ──');

/**
 * The FIX, asserted at the level that broke. Ethereum had exactly one public
 * endpoint and it was down; there was nothing to fail over to.
 */
const ethEndpoints = evmRpcEndpoints('ethereum' as any, { production: true });
const baseEndpoints = evmRpcEndpoints('base' as any, { production: true });

check('ethereum has more than one endpoint to fall back to',
  ethEndpoints.length > 1,
  JSON.stringify(ethEndpoints));
check('base has more than one endpoint to fall back to',
  baseEndpoints.length > 1,
  JSON.stringify(baseEndpoints));
check('llamarpc is no longer the FIRST ethereum endpoint',
  !ethEndpoints[0].includes('llamarpc'),
  `first is ${ethEndpoints[0]} - it returned HTTP 521 for hours while others were fine`);
check('the endpoint list has no duplicates',
  new Set(ethEndpoints).size === ethEndpoints.length);
check('base and ethereum do not depend on the same single vendor',
  !(ethEndpoints.length === 1 && baseEndpoints.length === 1),
  'base.llamarpc.com and eth.llamarpc.com were BOTH 521 in the same test');

/**
 * The second half of the fix: only a chain the user can TRANSACT on may mark
 * the balance unreadable. Asserted through the real service.
 */
const { getUnifiedBalance } = await import('../src/balances/unified-balance.service.js');
const { getBalanceTransferControls } = await import('../src/balances/balance.service.js');

const controls = await getBalanceTransferControls();
check('ethereum is NOT a supported transfer network',
  !controls.supportedNetworks.map(String).includes('ethereum'),
  JSON.stringify(controls.supportedNetworks));

console.log('\n── 2. a per-user ceiling overrides the tier ──────────────────');

const before = await getUserLimitDetail(USER);
const offrampBefore = before.limits.find((row) => row.flow === 'offramp' && row.rail === 'ngn')!;
check('a user with no override falls back to their tier',
  offrampBefore.isOverridden === false && offrampBefore.effectiveLimitNgn === offrampBefore.tierLimitNgn,
  JSON.stringify(offrampBefore));

await setUserLimit({
  userId: USER,
  flow: 'offramp',
  rail: 'ngn',
  cumulativeNgn: 2_000_000,
  reason: 'Verified merchant, higher settlement volume this month',
  updatedBy: 'ops@sivan.test',
});

const after = await getUserLimitDetail(USER);
const offrampAfter = after.limits.find((row) => row.flow === 'offramp' && row.rail === 'ngn')!;
check('the override becomes the effective ceiling',
  offrampAfter.effectiveLimitNgn === 2_000_000,
  String(offrampAfter.effectiveLimitNgn));
check('and the tier default is still reported alongside it',
  offrampAfter.tierLimitNgn === offrampBefore.tierLimitNgn,
  'an admin cannot judge a ceiling without seeing what it was changed from');

/**
 * THE ASSERTION THAT MATTERS MOST. An override that only changes an admin
 * screen is decorative - it has to change what the user may actually do.
 */
const overrideForPolicy = await userLimitOverrideFor(USER, 'offramp', 'ngn');
const allowed = decide(
  bankVerified,
  { flow: 'offramp', rail: 'ngn', amountNgn: 900_000, priorVolumeNgn: 0 },
  [],
  overrideForPolicy
);
const refused = decide(
  bankVerified,
  { flow: 'offramp', rail: 'ngn', amountNgn: 900_000, priorVolumeNgn: 0 },
  [],
  undefined
);
check('decide() ALLOWS an amount the tier would refuse, given the override',
  allowed.allowed === true,
  allowed.reason);
check('and refuses the same amount without it',
  refused.allowed === false,
  'if this passes too, the override is not what allowed the transaction');

console.log('\n── 3. only the flow that was overridden changes ──────────────');

const onramp = after.limits.find((row) => row.flow === 'onramp' && row.rail === 'ngn')!;
check('an offramp override does not raise the onramp ceiling',
  onramp.isOverridden === false,
  'an exception is per (user, flow, rail), not a blanket uplift');

console.log('\n── 4. null is UNLIMITED and 0 is CLOSED, never confused ──────');

await setUserLimit({
  userId: USER, flow: 'onramp', rail: 'ngn', cumulativeNgn: null,
  reason: 'Institutional client, uncapped on-ramp', updatedBy: 'ops@sivan.test',
});
const unlimited = (await getUserLimitDetail(USER)).limits.find((r) => r.flow === 'onramp' && r.rail === 'ngn')!;
check('null survives the round trip as unlimited',
  unlimited.effectiveLimitNgn === null && unlimited.remainingNgn === null,
  JSON.stringify(unlimited));

await setUserLimit({
  userId: USER, flow: 'escrow', rail: 'ngn', cumulativeNgn: 0,
  reason: 'Risk restriction pending review', updatedBy: 'compliance@sivan.test',
});
const closed = (await getUserLimitDetail(USER)).limits.find((r) => r.flow === 'escrow' && r.rail === 'ngn')!;
check('0 closes the flow and is NOT read as unlimited',
  closed.effectiveLimitNgn === 0 && closed.remainingNgn === 0,
  JSON.stringify(closed));
check('a ceiling of 0 actually blocks a transaction',
  decide(
    bankVerified,
    { flow: 'escrow', rail: 'ngn', amountNgn: 1, priorVolumeNgn: 0 },
    [],
    { cumulativeNgn: 0 }
  ).allowed === false);

console.log('\n── 5. expiry is evaluated on READ, not by a sweeper ──────────');

check('an override with no expiry is active', isOverrideActive({ expiresAt: undefined }));
check('a future expiry is active',
  isOverrideActive({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
check('a past expiry is NOT active',
  !isOverrideActive({ expiresAt: new Date(Date.now() - 60_000).toISOString() }),
  'a cron that deletes expired rows would extend an exception whenever it failed to run');

/**
 * Written straight to the database with a past date, because setUserLimit
 * refuses one - which is itself the next assertion.
 */
await db.upsertUserLimitOverride({
  userId: USER, flow: 'offramp', rail: 'foreign', cumulativeNgn: 9_000_000,
  reason: 'lapsed', updatedBy: 'ops@sivan.test',
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
});
const lapsedDetail = await getUserLimitDetail(USER);
const lapsed = lapsedDetail.limits.find((r) => r.flow === 'offramp' && r.rail === 'foreign')!;
check('an expired override stops applying to the effective ceiling',
  lapsed.isOverridden === false && lapsed.effectiveLimitNgn !== 9_000_000,
  JSON.stringify(lapsed));
check('but it is still REPORTED, so the drop can be explained',
  lapsed.overrideExpired === true,
  '"why did this customer lose their limit overnight" must be answerable');
check('an expired override is invisible to the enforcement path',
  (await userLimitOverrideFor(USER, 'offramp', 'foreign')) === undefined);

let refusedPast = false;
try {
  await setUserLimit({
    userId: USER, flow: 'offramp', rail: 'foreign', cumulativeNgn: 1,
    reason: 'should not be stored', updatedBy: 'ops@sivan.test',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
} catch { refusedPast = true; }
check('setting an already-expired override is refused, not silently stored',
  refusedPast,
  'it would report success and change nothing - the worst outcome');

console.log('\n── 6. the input guards ──────────────────────────────────────');

check('a blank reason is rejected',
  !setUserLimitSchema.safeParse({ userId: USER, flow: 'offramp', rail: 'ngn', cumulativeNgn: 1, reason: '   ' }).success,
  'whitespace must not satisfy an audit field');
check('a missing reason is rejected',
  !setUserLimitSchema.safeParse({ userId: USER, flow: 'offramp', rail: 'ngn', cumulativeNgn: 1 }).success);
check('an absurd ceiling is rejected as a typo',
  !setUserLimitSchema.safeParse({ userId: USER, flow: 'offramp', rail: 'ngn', cumulativeNgn: MAX_USER_LIMIT_NGN + 1, reason: 'fat finger' }).success);
check('a negative ceiling is rejected',
  !setUserLimitSchema.safeParse({ userId: USER, flow: 'offramp', rail: 'ngn', cumulativeNgn: -1, reason: 'negative' }).success);
check('null passes the schema - it is unlimited, not missing',
  setUserLimitSchema.safeParse({ userId: USER, flow: 'offramp', rail: 'ngn', cumulativeNgn: null, reason: 'uncapped' }).success);

let refusedUnknownUser = false;
try {
  await setUserLimit({ userId: 'usr_does_not_exist', flow: 'offramp', rail: 'ngn', cumulativeNgn: 1, reason: 'typo', updatedBy: 'ops' });
} catch { refusedUnknownUser = true; }
check('a mistyped user id 404s instead of silently succeeding',
  refusedUnknownUser,
  'otherwise the admin believes a customer was unblocked when nothing changed');

console.log('\n── 7. reset forgives usage WITHOUT deleting transactions ─────');

const now = Date.now();
for (const [i, amount] of [50_000, 30_000].entries()) {
  await db.upsertNgnTransferRecord({
    id: `ngnt_test_${i}`,
    userId: USER,
    status: 'settled',
    sourceCurrency: 'ngn',
    sourceAmount: amount,
    destinationCurrency: 'usdc',
    destinationAmount: 30,
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
  } as any);
}

const usedBefore = await effectiveUsedNgn(USER, 'offramp', 'ngn');
check('settled volume counts toward the window', usedBefore >= 80_000, String(usedBefore));

const reset = await resetUserWindow({
  userId: USER, flow: 'offramp', rail: 'ngn',
  reason: 'Goodwill after a provider outage double-counted a transfer',
  createdBy: 'ops@sivan.test',
});
const usedAfter = await effectiveUsedNgn(USER, 'offramp', 'ngn');
check('after a reset the window reads as zero', usedAfter === 0, String(usedAfter));
check('the reset records WHAT was forgiven',
  reset.forgivenNgn === usedBefore,
  `${reset.forgivenNgn} vs ${usedBefore} - it cannot be recomputed once the window rolls`);

/**
 * THE POINT OF THE WATERMARK DESIGN. A reset must not destroy evidence.
 */
const transfersStillThere = await db.listNgnTransfersByUserSince(USER, new Date(now - 3_600_000).toISOString());
check('the underlying transactions still exist after a reset',
  transfersStillThere.length >= 2,
  `${transfersStillThere.length} - a reset that deletes rows destroys the AML trail`);
check('the reset is recorded as its own auditable row',
  (await db.listUserLimitResets(USER)).length === 1);

check('a reset on one flow does not forgive another',
  (await effectiveUsedNgn(USER, 'onramp', 'ngn')) >= 80_000,
  'the watermark is per (user, flow, rail)');

// New volume AFTER the watermark must count again, or a single reset would
// permanently exempt the user.
await db.upsertNgnTransferRecord({
  id: 'ngnt_test_after',
  userId: USER,
  status: 'settled',
  sourceCurrency: 'ngn',
  sourceAmount: 25_000,
  destinationCurrency: 'usdc',
  destinationAmount: 15,
  createdAt: new Date(Date.now() + 1000).toISOString(),
  updatedAt: new Date(Date.now() + 1000).toISOString(),
} as any);
check('volume recorded AFTER the reset counts again',
  (await effectiveUsedNgn(USER, 'offramp', 'ngn')) >= 25_000,
  'a reset forgives the past, it does not exempt the future');

console.log('\n── 8. clearing an override returns the user to their tier ────');

await clearUserLimit({ userId: USER, flow: 'offramp', rail: 'ngn', clearedBy: 'ops@sivan.test', reason: 'month ended' });
const cleared = (await getUserLimitDetail(USER)).limits.find((r) => r.flow === 'offramp' && r.rail === 'ngn')!;
check('the effective ceiling returns to the tier default',
  cleared.isOverridden === false && cleared.effectiveLimitNgn === cleared.tierLimitNgn,
  JSON.stringify(cleared));

console.log('\n── 9. every change is audited, with the previous value ───────');

const logs = await db.listAuditLogsByActions([
  'admin.user_limit_set', 'admin.user_limit_cleared', 'admin.user_limit_window_reset',
]);
const setLog = logs.find((l: any) => l.action === 'admin.user_limit_set' && l.actorId === 'ops@sivan.test');
const resetLog = logs.find((l: any) => l.action === 'admin.user_limit_window_reset');
const clearLog = logs.find((l: any) => l.action === 'admin.user_limit_cleared');

check('setting a limit is audited', Boolean(setLog));
check('the audit names the admin, not a generic identity',
  setLog?.actorId === 'ops@sivan.test',
  String(setLog?.actorId));
check('the audit carries the REASON', Boolean((setLog?.metadata as any)?.reason));
check('a reset is audited separately from an override',
  Boolean(resetLog) && resetLog!.action !== setLog!.action,
  'they carry different risk and must be distinguishable in the log');
check('the reset audit records how much was forgiven',
  Number((resetLog?.metadata as any)?.forgivenNgn) === usedBefore);
check('clearing records what the removed ceiling HAD been',
  Number((clearLog?.metadata as any)?.removedCumulativeNgn) === 2_000_000,
  'the row is gone, so the log is the only remaining record of it');
check('limit changes are severity warning, not info',
  setLog?.severity === 'warning' && resetLog?.severity === 'warning',
  'an AML-relevant act must not sink into routine traffic');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

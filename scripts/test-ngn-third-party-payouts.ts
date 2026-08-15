/**
 * PAYING SOMEONE ELSE'S NAIRA ACCOUNT IS OFF, AND THE SWITCH IS REAL.
 *
 * The withdraw screen is about to offer "Pay myself" and "Pay someone else".
 * This suite exists so the second one cannot quietly become reachable: the
 * control ships before the feature, closed, and enforced on the server.
 *
 * WHY THE RAIL CANNOT DO IT TODAY.
 *
 * Breet is deposit-address-centric. The destination bank is bound to the
 * user's PERMANENT wallet, not to a transfer:
 *
 *     PUT /trades/wallets/{id}/bank
 *     PUT /trades/wallets/{id}/auto-settlement
 *
 * Paying a third party would mean re-linking that wallet per transfer, and
 * because the address is reusable a late or duplicated deposit then settles to
 * whoever was linked last. One user's own withdrawal could land in a
 * stranger's account. So this is not an unbuilt feature behind a flag, it is
 * an unsafe path held shut.
 *
 * THE TRAP THIS SUITE IS BUILT AROUND.
 *
 * `status === 'verified'` and `matchVerdict === 'match'` are NOT the same
 * fact, and gating on the wrong one is the mistake worth catching:
 *
 *   - development force-verifies test accounts before the verdict is read
 *   - an admin can approve a 'review' row out of the queue
 *
 * Both produce a VERIFIED account that is not the user's own. Every case below
 * therefore uses a verified row, so a guard that only checked `status` would
 * pass all of them while paying strangers.
 *
 * Run: npm run test:ngn-third-party-payouts
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-ngn-third-party.json';
process.env.WALLET_PROVIDER = 'mock';
process.env.NGN_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'third-party-admin-key';
process.env.USER_JWT_SECRET = 'third-party-jwt-secret-long-enough-value';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-ngn-third-party.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const { createNgnQuote } = await import('../src/ngn/service/ngn-quotes.service.js');
const { getNgnControls, updateNgnControls, defaultNgnControls } = await import('../src/ngn/service/ngn-controls.service.js');

const now = () => new Date().toISOString();

function account(over: Record<string, unknown>) {
  return {
    userId: 'usr_t', provider: 'mock', bankId: '1', bankName: 'Access Bank',
    declaredName: 'OGUNMEPON SHARAFA', matchScore: 1, resolutionTrustworthy: true,
    status: 'verified', createdAt: now(), updatedAt: now(), ...over,
  };
}

async function seed() {
  await db.mutate((d: any) => {
    d.users = [{ id: 'usr_t', email: 't@t.test', emailVerifiedAt: now(), country: 'NG',
      fullName: 'OGUNMEPON SHARAFA', createdAt: now(), updatedAt: now() }];
    d.ngnPayoutAccounts = [
      // The user's own account: the bank's name matched their profile.
      account({ id: 'acct_self', accountNumber: '1111111111',
        accountName: 'OGUNMEPON SHARAFA', matchVerdict: 'match' }),
      // Verified, but NOT theirs - an admin approved it out of the review
      // queue. This is the row that separates a real guard from a fake one.
      account({ id: 'acct_other', accountNumber: '2222222222', bankId: '2', bankName: 'GTBank',
        accountName: 'CHIDINMA OKAFOR', matchVerdict: 'review', matchScore: 0.4,
        reviewedBy: 'admin@sivan.test', reviewedAt: now() }),
    ];
    d.ngnControls = [{ ...defaultNgnControls(), updatedBy: 'seed', updatedAt: now(),
      limitEnforcementOfframp: false, limitEnforcementOnramp: false, limitEnforcementEscrow: false,
      activeProvider: 'mock', identityVerificationEnabled: false }];
    return 1;
  });
}
await seed();

function quoteFor(payoutAccountId: string) {
  return createNgnQuote({
    userId: 'usr_t', direction: 'offramp', sourceCurrency: 'usdc',
    destinationCurrency: 'ngn', sourceAmount: '20', network: 'solana', payoutAccountId,
  } as any);
}

async function refuses(payoutAccountId: string): Promise<string> {
  try {
    await quoteFor(payoutAccountId);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

console.log('\n── the switch ships closed ───────────────────────────────────');

const controls = await getNgnControls();
check('third-party payouts are OFF by default',
  controls.thirdPartyPayoutsEnabled === false,
  `${controls.thirdPartyPayoutsEnabled} - a payout rail must not open itself`);

/**
 * A flag nothing reads is worse than no flag: it shows "off" in the admin hub
 * while the path stays open. bankSettlementEnabled in this same record is
 * exactly that, and is documented as inert. Prove this one is not, by
 * asserting on behaviour rather than on the stored value.
 */
console.log('\n── OFF: a stranger\'s account is refused ──────────────────────');

const blocked = await refuses('acct_other');
check('a verified account in someone else\'s name is refused',
  blocked.length > 0,
  'this row is status=verified, so a guard reading only status would pay it');
check('and the refusal says why, in the user\'s terms',
  /own name/i.test(blocked),
  blocked);
check('the refusal does not leak the account holder\'s name',
  !/CHIDINMA/i.test(blocked),
  `${blocked} - the payout screen already shows the name to the person who typed it`);

console.log('\n── OFF: the user\'s own account still works ───────────────────');

const selfQuote: any = await quoteFor('acct_self');
check('paying yourself is unaffected',
  Boolean(selfQuote?.id),
  'the control must close one path, not the product');
check('and the quote carries the right bank',
  (selfQuote.metadata as any)?.accountNumber === '1111111111',
  JSON.stringify((selfQuote.metadata as any)?.accountNumber));

console.log('\n── ON: an admin can open it deliberately ─────────────────────');

await updateNgnControls({ thirdPartyPayoutsEnabled: true, updatedBy: 'admin@sivan.test' });
const opened = await getNgnControls();
check('the admin toggle persists', opened.thirdPartyPayoutsEnabled === true);

const allowed: any = await quoteFor('acct_other');
check('with it on, the third-party quote prices',
  Boolean(allowed?.id),
  'a switch that cannot be switched is documentation, not a control');
check('and it carries the third party\'s bank, not the user\'s',
  (allowed.metadata as any)?.accountNumber === '2222222222',
  JSON.stringify((allowed.metadata as any)?.accountNumber));

console.log('\n── the switch closes again ──────────────────────────────────');

/**
 * An operator turning the flag back OFF during an incident is the entire
 * reason it exists. Asserting only that it opens would leave the important
 * direction untested.
 */
await updateNgnControls({ thirdPartyPayoutsEnabled: false, updatedBy: 'admin@sivan.test' });
const reblocked = await refuses('acct_other');
check('turning it off closes the path again', reblocked.length > 0, reblocked);

console.log('\n── a saved row predating the column fails CLOSED ─────────────');

/**
 * Migration 052 adds the column, but a row written before it has the key
 * ABSENT rather than false. `undefined` must read as closed - the opposite
 * would open third-party payouts on precisely the environments that have not
 * been migrated yet.
 */
await db.mutate((d: any) => {
  const row = { ...d.ngnControls[0] };
  delete row.thirdPartyPayoutsEnabled;
  d.ngnControls = [row];
  return 1;
});
const legacy = await getNgnControls();
check('an absent flag reads as OFF, not as unset',
  legacy.thirdPartyPayoutsEnabled === false,
  `${legacy.thirdPartyPayoutsEnabled}`);
const legacyBlocked = await refuses('acct_other');
check('and the path is genuinely closed on that row',
  legacyBlocked.length > 0,
  'read the behaviour, not the field - the field could be right and the guard absent');

console.log('\n── a verified row with NO verdict is the user\'s own ──────────');

/**
 * REGRESSION. The first version of this guard read `matchVerdict !== 'match'`,
 * which refuses a verified account that simply has no verdict recorded -
 * every row written before the field was stored. test:ngn-limit-enforcement
 * caught it: 4 legitimate self-payouts began returning 403 "can only go to an
 * account in your own name". On a real deploy that locks users out of their
 * own money, so it is pinned here rather than left to a suite that found it
 * by accident.
 */
await seed();
await db.mutate((d: any) => {
  const row = { ...d.ngnPayoutAccounts.find((a: any) => a.id === 'acct_self') };
  delete row.matchVerdict;
  d.ngnPayoutAccounts = [row];
  return 1;
});
const legacySelf: any = await quoteFor('acct_self');
check('a verified account with no recorded verdict is still payable',
  Boolean(legacySelf?.id),
  'absent is not the same as "not a match" - refusing it locks users out of their own money');

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

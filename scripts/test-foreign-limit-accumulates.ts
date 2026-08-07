/**
 * THE FOREIGN CEILING DID NOT ACCUMULATE, SO IT WAS NOT A CEILING.
 *
 * `offramp/foreign` has always had a real limit and has always been reported
 * by /verification-summary. Its USAGE, though, came from
 * getCumulativeNgnVolume(), which reads payments_ngn_transfers and counts only
 * legs denominated in naira.
 *
 * A Bridge withdrawal is USDC -> USD. It is not an NGN transfer, so it never
 * appeared in that query, so priorVolumeNgn for the foreign rail was
 * PERMANENTLY ZERO. Each withdrawal was therefore measured alone:
 *
 *     ten $9,000 withdrawals   -> all allowed
 *     one  $10,000 withdrawal  -> refused
 *
 * which is the wrong way round for a cumulative cap. The number in the admin
 * hub was decorative too - it read 0 no matter how much a user had withdrawn.
 *
 * Run: npm run test:foreign-limit-accumulates
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-foreign-accumulate.json';
process.env.WALLET_PROVIDER = 'mock';
process.env.NGN_PROVIDER = 'mock';
process.env.KYC_LEVEL_PROVIDER = 'mock';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'accum-admin-key';
process.env.USER_JWT_SECRET = 'accum-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';
// Pinned so the arithmetic below is exact rather than dependent on a machine's
// .env. 1 USD = 1000 NGN keeps every expected figure a round number.
process.env.LIMITS_USD_TO_NGN_RATE = '1000';

import fs from 'node:fs';
fs.rmSync('.data/test-foreign-accumulate.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { db } = await import('../src/database/json-database.js');
const now = () => new Date().toISOString();

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. seed a verified user with a foreign ceiling ───────────');

await db.mutate((d: any) => {
  d.users = [{ id: 'usr_a', email: 'a@t.test', emailVerifiedAt: now(), country: 'US',
    fullName: 'Dana Reed', createdAt: now(), updatedAt: now() }];
  d.customers = [{ id: 'cus_a', userId: 'usr_a', provider: 'bridge', providerCustomerId: 'mock_cust_a',
    customerType: 'individual', kycStatus: 'kyc_approved', createdAt: now(), updatedAt: now() }];
  d.externalAccounts = [{ id: 'ea_a', userId: 'usr_a', customerId: 'cus_a', provider: 'bridge',
    providerExternalAccountId: 'mock_ea_a', currency: 'usd', accountType: 'us', bankName: 'Chase',
    accountOwnerName: 'Dana Reed', accountLast4: '6789', paymentRail: 'ach', status: 'verified',
    createdAt: now(), updatedAt: now() }];
  return 1;
});

/**
 * PIN THE CEILING THROUGH THE SERVICE, not by hand-seeding the row.
 *
 * My first version wrote a userLimitOverrides record directly and it was
 * never read: the hand-written shape omitted fields upsertUserLimitOverride
 * sets, so userLimitOverrideFor() returned undefined and the user fell back
 * to their TIER limit - which, because this user clears Bridge KYC, is the
 * 10,000,000 uplift ceiling. Every "under-cap" amount in this file was
 * therefore trivially under it, and the accumulation assertion passed
 * vacuously in the wrong direction.
 *
 * Going through setUserLimit() means the test exercises the same path the
 * admin hub does, and cannot drift from it.
 *
 * NGN 1,000,000 == USD 1,000 at the pinned rate.
 */
const { setUserLimit: pinLimit } = await import('../src/kyc/service/user-limits.service.js');
await pinLimit({
  userId: 'usr_a', flow: 'offramp', rail: 'foreign', cumulativeNgn: 1_000_000,
  reason: 'pin an exact ceiling for this test', updatedBy: 'test',
} as any);

const { getCumulativeForeignVolumeNgn } = await import('../src/kyc/service/verification-state.js');
const { effectiveUsedNgn } = await import('../src/kyc/service/user-limit-usage.js');

check('a user with no withdrawals has zero foreign volume',
  (await getCumulativeForeignVolumeNgn('usr_a', 30)) === 0);

// The pinned ceiling must actually be READABLE, or every "under-cap" amount
// below is silently measured against the tier default instead.
const { userLimitOverrideFor: readOverride } = await import('../src/kyc/service/user-limits.service.js');
const pinned = await readOverride('usr_a', 'offramp', 'foreign');
check('the pinned ceiling is readable by the enforcement path',
  pinned?.cumulativeNgn === 1_000_000, JSON.stringify(pinned));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. a withdrawal now REGISTERS as foreign volume ──────────');

const { createWithdrawal } = await import('../src/offramp/service/withdrawals.service.js');

const first: any = await createWithdrawal({
  userId: 'usr_a', externalAccountId: 'ea_a', sourceCurrency: 'usdc',
  sourceChain: 'solana', destinationCurrency: 'usd',
  sourceAmount: 400, fundingSource: 'external',
} as any);
check('the withdrawal is created', Boolean(first?.withdrawal?.id));

const afterFirst = await getCumulativeForeignVolumeNgn('usr_a', 30);
check('USD 400 is counted as NGN 400,000', afterFirst === 400_000, String(afterFirst));
check('and effectiveUsedNgn reports it on the foreign rail',
  (await effectiveUsedNgn('usr_a', 'offramp', 'foreign')) === 400_000,
  String(await effectiveUsedNgn('usr_a', 'offramp', 'foreign')));

/**
 * THE CROSS-RAIL ASSERTION. A Bridge withdrawal must NOT show up as naira
 * volume - that would be the same class of bug in the other direction, and it
 * is what a naive "just add withdrawals to the existing sum" fix would cause.
 */
check('it does NOT leak into the naira rail',
  (await effectiveUsedNgn('usr_a', 'offramp', 'ngn')) === 0,
  String(await effectiveUsedNgn('usr_a', 'offramp', 'ngn')));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. THE BUG: volume accumulates across withdrawals ────────');

const second: any = await createWithdrawal({
  userId: 'usr_a', externalAccountId: 'ea_a', sourceCurrency: 'usdc',
  sourceChain: 'solana', destinationCurrency: 'usd',
  sourceAmount: 400, fundingSource: 'external',
} as any);
check('a second withdrawal is created', Boolean(second?.withdrawal?.id));

const afterSecond = await getCumulativeForeignVolumeNgn('usr_a', 30);
check('two USD 400 withdrawals sum to NGN 800,000', afterSecond === 800_000, String(afterSecond));

/**
 * THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG.
 *
 * Each of these three withdrawals is USD 400, comfortably under the USD 1,000
 * ceiling. Before this fix all three were allowed, because prior volume was
 * always 0 and every one of them was measured alone. The THIRD must now be
 * refused: 400 + 400 already consumes 800 of 1,000, leaving 200.
 */
const third = await createWithdrawal({
  userId: 'usr_a', externalAccountId: 'ea_a', sourceCurrency: 'usdc',
  sourceChain: 'solana', destinationCurrency: 'usd',
  sourceAmount: 400, fundingSource: 'external',
} as any).then(() => null).catch((e: Error) => e.message);

check('a THIRD under-cap withdrawal is REFUSED on cumulative volume',
  Boolean(third),
  'this is the whole bug: without accumulation, unlimited sub-cap withdrawals pass');
check('and the refusal explains the remaining headroom',
  /limit|left|higher/i.test(String(third)), String(third));

const afterThird = await getCumulativeForeignVolumeNgn('usr_a', 30);
check('the refused withdrawal consumed nothing', afterThird === 800_000, String(afterThird));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. what still FITS is still allowed ─────────────────────');

const fourth: any = await createWithdrawal({
  userId: 'usr_a', externalAccountId: 'ea_a', sourceCurrency: 'usdc',
  sourceChain: 'solana', destinationCurrency: 'usd',
  sourceAmount: 150, fundingSource: 'external',
} as any).catch((e: Error) => ({ refused: e.message }));
check('a withdrawal inside the remaining headroom still passes',
  Boolean(fourth?.withdrawal?.id), String((fourth as any).refused));
check('volume is now NGN 950,000',
  (await getCumulativeForeignVolumeNgn('usr_a', 30)) === 950_000,
  String(await getCumulativeForeignVolumeNgn('usr_a', 30)));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. failed and cancelled do NOT consume headroom ──────────');

const before = await getCumulativeForeignVolumeNgn('usr_a', 30);
await db.mutate((d: any) => {
  d.withdrawals.push({
    id: 'wd_failed', userId: 'usr_a', customerId: 'cus_a', externalAccountId: 'ea_a',
    liquidationAddressId: 'la_x', provider: 'bridge', sourceCurrency: 'usdc',
    destinationCurrency: 'usd', sourceAmount: '5000', status: 'failed',
    createdAt: now(), updatedAt: now(),
  });
  d.withdrawals.push({
    id: 'wd_cancelled', userId: 'usr_a', customerId: 'cus_a', externalAccountId: 'ea_a',
    liquidationAddressId: 'la_y', provider: 'bridge', sourceCurrency: 'usdc',
    destinationCurrency: 'usd', sourceAmount: '5000', status: 'cancelled',
    createdAt: now(), updatedAt: now(),
  });
  return 1;
});
check('a failed withdrawal adds nothing',
  (await getCumulativeForeignVolumeNgn('usr_a', 30)) === before,
  'charging a user for a provider outage would be punishing them for it');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 6. the window is respected ──────────────────────────────');

await db.mutate((d: any) => {
  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  d.withdrawals.push({
    id: 'wd_old', userId: 'usr_a', customerId: 'cus_a', externalAccountId: 'ea_a',
    liquidationAddressId: 'la_z', provider: 'bridge', sourceCurrency: 'usdc',
    destinationCurrency: 'usd', sourceAmount: '9000', status: 'completed',
    createdAt: old, updatedAt: old,
  });
  return 1;
});
check('a withdrawal from 90 days ago is outside a 30-day window',
  (await getCumulativeForeignVolumeNgn('usr_a', 30)) === before,
  String(await getCumulativeForeignVolumeNgn('usr_a', 30)));
check('but IS counted in a 120-day window',
  (await getCumulativeForeignVolumeNgn('usr_a', 120)) === before + 9_000_000,
  String(await getCumulativeForeignVolumeNgn('usr_a', 120)));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 7. the admin view reports the real figure ────────────────');

const { getUserLimitDetail } = await import('../src/kyc/service/user-limits.service.js');
const detail: any = await getUserLimitDetail('usr_a');
const foreignRow = detail.limits.find((r: any) => r.flow === 'offramp' && r.rail === 'foreign');
const ngnRow = detail.limits.find((r: any) => r.flow === 'offramp' && r.rail === 'ngn');

check('the admin detail shows real foreign usage, not 0',
  foreignRow.usedNgn === before, `${foreignRow.usedNgn} vs ${before}`);
check('the override ceiling is reported', foreignRow.effectiveLimitNgn === 1_000_000,
  String(foreignRow.effectiveLimitNgn));
check('remaining headroom is derived from it',
  foreignRow.remainingNgn === 1_000_000 - before, String(foreignRow.remainingNgn));
check('the naira row is still independent and zero',
  ngnRow.usedNgn === 0, String(ngnRow.usedNgn));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 8. an admin can raise ONE user\'s ceiling ─────────────────');

const { setUserLimit, clearUserLimit } = await import('../src/kyc/service/user-limits.service.js');

await setUserLimit({
  userId: 'usr_a', flow: 'offramp', rail: 'foreign', cumulativeNgn: 5_000_000,
  reason: 'merchant requested a higher cap for this month', updatedBy: 'ops@sivan',
} as any);

const raised: any = await getUserLimitDetail('usr_a');
const raisedRow = raised.limits.find((r: any) => r.flow === 'offramp' && r.rail === 'foreign');
check('the raised ceiling is in effect', raisedRow.effectiveLimitNgn === 5_000_000,
  String(raisedRow.effectiveLimitNgn));
check('and it is marked as an override, not a tier default', raisedRow.isOverridden === true);
check('the reason is retained for audit', /merchant requested/i.test(String(raisedRow.overrideReason)),
  String(raisedRow.overrideReason));

// The point of raising it: a withdrawal that was refused now passes.
const afterRaise: any = await createWithdrawal({
  userId: 'usr_a', externalAccountId: 'ea_a', sourceCurrency: 'usdc',
  sourceChain: 'solana', destinationCurrency: 'usd',
  sourceAmount: 400, fundingSource: 'external',
} as any).catch((e: Error) => ({ refused: e.message }));
check('a previously refused withdrawal now succeeds',
  Boolean(afterRaise?.withdrawal?.id), String((afterRaise as any).refused));

await clearUserLimit({ userId: 'usr_a', flow: 'offramp', rail: 'foreign',
  reason: 'restore the tier default', clearedBy: 'ops@sivan' } as any);
const cleared: any = await getUserLimitDetail('usr_a');
const clearedRow = cleared.limits.find((r: any) => r.flow === 'offramp' && r.rail === 'foreign');
check('clearing the override restores the tier ceiling', clearedRow.isOverridden === false,
  String(clearedRow.effectiveLimitNgn));

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

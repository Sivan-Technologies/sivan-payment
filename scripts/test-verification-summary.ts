/**
 * The verification summary the UI renders from, over real HTTP.
 *
 * WHAT THIS GUARDS
 *
 * The frontend used to compute verification itself:
 *
 *     isVerified = customer?.kycStatus === 'kyc_approved'
 *     hasBank    = externalAccounts.length > 0
 *
 * Both Bridge-only. A Nigerian who passed the bank check has neither, so the
 * UI showed 25% progress and blocked every action while the backend had
 * already granted Level 1. This endpoint is the single answer both sides use.
 *
 * THE LIMIT ASSERTIONS ARE THE POINT.
 *
 * Ceilings must come from the admin-overridable table, never a constant baked
 * into the response or the UI. The override tests below are what prove that:
 * an admin moves a number, and the user is told the new one with no deploy.
 *
 * Run: npm run test:verification-summary
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';
import { setVerificationLimit, clearVerificationLimit } from '../src/kyc/service/verification-limits.service.js';
import { VerificationLevel } from '../src/kyc/types/verification.types.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let token = '';
  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: (json as any).data ?? json };
  }

  async function signup(fullName: string) {
    const email = `${fullName.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@sivan.test`;
    const start = await call('POST', '/api/auth/email/start', {
      email, fullName, intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' }
    });
    const verified = await call('POST', '/api/auth/email/verify', { email, code: start.body.devCode });
    return verified.body;
  }

  const allowance = (summary: any, flow: string, rail: string) =>
    (summary.allowances as any[]).find((a) => a.flow === flow && a.rail === rail);

  try {
    const user = await signup('Sharafa Ogunmepon');
    token = user.token;
    const userId = user.user.id;

    console.log('\nA BRAND NEW USER');
    {
      const res = await call('GET', `/api/users/${userId}/verification-summary`);
      check('the summary is served', res.status === 200, JSON.stringify(res.body).slice(0, 160));
      check('level starts at 0', res.body.level === VerificationLevel.NONE, String(res.body.level));
      check('with a readable label', res.body.levelLabel === 'Level 0: Starter', res.body.levelLabel);
      check('no country yet, so the path is Bridge', res.body.path === 'bridge_kyc', res.body.path);
      check('nothing is complete', res.body.pathComplete === false);
      check('and there is no payout account', res.body.hasPayoutAccount === false);
      check('every NGN ceiling is 0 at level 0',
        allowance(res.body, 'offramp', 'ngn').limitNgn === 0,
        String(allowance(res.body, 'offramp', 'ngn').limitNgn));
      check('the window is reported so the UI need not guess',
        res.body.windowDays === 30, String(res.body.windowDays));
    }

    console.log('\nCOUNTRY DECIDES THE PATH, AND THE SUMMARY SAYS SO');
    {
      await call('PUT', `/api/users/${userId}/country`, { country: 'NG' });
      const ng = await call('GET', `/api/users/${userId}/verification-summary`);
      check('a Nigerian is routed to the bank check', ng.body.path === 'ngn_bank', ng.body.path);
      check('and the country is echoed back', ng.body.country === 'NG', ng.body.country);

      await call('PUT', `/api/users/${userId}/country`, { country: 'US' });
      const us = await call('GET', `/api/users/${userId}/verification-summary`);
      check('a US user is routed to Bridge', us.body.path === 'bridge_kyc', us.body.path);

      await call('PUT', `/api/users/${userId}/country`, { country: 'NG' });
    }

    console.log('\nA QUEUED PAYOUT ACCOUNT IS NOT A VERIFIED ONE');
    {
      // The mock provider always returns trustworthy:false, so even a perfect
      // name match is queued. The UI must not show that as done.
      await call('POST', '/api/ngn/payout-accounts', { userId, bankId: '2', accountNumber: '1111111111' });
      const res = await call('GET', `/api/users/${userId}/verification-summary`);
      check('the pending review is surfaced', res.body.hasPendingPayoutReview === true);
      check('but the path is NOT complete', res.body.pathComplete === false);
      check('the level has not moved', res.body.level === VerificationLevel.NONE, String(res.body.level));
      check('and no payout account counts yet', res.body.hasPayoutAccount === false);
    }

    console.log('\nA VERIFIED NUBAN LIFTS THE USER TO LEVEL 1');
    {
      const accounts = await db.listNgnPayoutAccounts(userId);
      for (const account of accounts) {
        await db.upsertNgnPayoutAccountRecord({ ...account, resolutionTrustworthy: true, status: 'verified' });
      }

      const res = await call('GET', `/api/users/${userId}/verification-summary`);
      check('the level is now BANK', res.body.level === VerificationLevel.BANK, String(res.body.level));
      check('the label says so', res.body.levelLabel === 'Level 1: Bank verified', res.body.levelLabel);
      check('the path reads complete', res.body.pathComplete === true);
      check('a payout account exists', res.body.hasPayoutAccount === true);
      check('nothing is pending any more', res.body.hasPendingPayoutReview === false);
      check('the bank check is verified', res.body.checks.bank === 'verified', res.body.checks.bank);

      // THE FIX FOR THE UI GAP: this user has no Bridge customer and no Bridge
      // external account, and is nonetheless verified with a payout route.
      const me = await call('GET', `/api/users/${userId}`);
      check('and they still have NO Bridge customer', me.body.customerId === undefined);

      const off = allowance(res.body, 'offramp', 'ngn');
      check('the NGN off-ramp ceiling is the Level 1 figure', off.limitNgn === 500_000, String(off.limitNgn));
      check('headroom is the full ceiling with no volume yet', off.remainingNgn === 500_000, String(off.remainingNgn));
      check('nothing has been used', off.usedNgn === 0, String(off.usedNgn));
      check('and the next level up is named', off.nextLevel === VerificationLevel.IDENTITY, String(off.nextLevel));

      const foreign = allowance(res.body, 'offramp', 'foreign');
      check('foreign rails stay closed at Level 1', foreign.limitNgn === 0, String(foreign.limitNgn));
      check('and IDENTITY is what opens them',
        foreign.nextLevel === VerificationLevel.IDENTITY, String(foreign.nextLevel));
    }

    console.log('\nTHE CEILING COMES FROM THE DATABASE, NOT FROM A CONSTANT');
    {
      // The whole reason this endpoint exists rather than the UI hardcoding
      // 50,000. An admin moves it; the user is told the new number.
      await setVerificationLimit({
        flow: 'offramp', rail: 'ngn', level: VerificationLevel.BANK,
        cumulativeNgn: 250_000, reason: 'test override', updatedBy: 'test'
      } as any);

      const res = await call('GET', `/api/users/${userId}/verification-summary`);
      const off = allowance(res.body, 'offramp', 'ngn');
      check('the overridden ceiling is what the user is shown',
        off.limitNgn === 250_000, String(off.limitNgn));
      check('and headroom follows it', off.remainingNgn === 250_000, String(off.remainingNgn));

      // Lowering it must work in the same direction.
      await setVerificationLimit({
        flow: 'offramp', rail: 'ngn', level: VerificationLevel.BANK,
        cumulativeNgn: 10_000, reason: 'test override down', updatedBy: 'test'
      } as any);
      const lowered = await call('GET', `/api/users/${userId}/verification-summary`);
      check('lowering the ceiling lowers what the user sees',
        allowance(lowered.body, 'offramp', 'ngn').limitNgn === 10_000,
        String(allowance(lowered.body, 'offramp', 'ngn').limitNgn));

      await clearVerificationLimit({ flow: 'offramp', rail: 'ngn', level: VerificationLevel.BANK } as any);
      const restored = await call('GET', `/api/users/${userId}/verification-summary`);
      check('clearing the override returns the shipped default',
        allowance(restored.body, 'offramp', 'ngn').limitNgn === 500_000,
        String(allowance(restored.body, 'offramp', 'ngn').limitNgn));
    }

    console.log('\nUSED VOLUME REDUCES HEADROOM, NOT THE CEILING');
    {
      const now = new Date().toISOString();
      // A COMPLETED transfer. Only settled volume counts - counting pending
      // ones would let a user shrink their own usage by abandoning a transfer.
      await db.upsertNgnTransferRecord({
        id: 'ngnt_used', userId, quoteId: 'q1', direction: 'offramp',
        sourceCurrency: 'usdc', destinationCurrency: 'ngn',
        sourceAmount: '20', destinationAmount: '30000',
        status: 'completed', provider: 'mock', createdAt: now, updatedAt: now
      } as any);

      const res = await call('GET', `/api/users/${userId}/verification-summary`);
      const off = allowance(res.body, 'offramp', 'ngn');
      check('used volume is reported', off.usedNgn === 30_000, String(off.usedNgn));
      check('the ceiling itself is unchanged by usage', off.limitNgn === 500_000, String(off.limitNgn));
      check('and headroom is ceiling minus used',
        off.remainingNgn === 470_000, String(off.remainingNgn));

      /**
       * A PENDING TRANSFER NOW *DOES* CONSUME HEADROOM. REVERSED DELIBERATELY.
       *
       * This asserted the opposite, and the opposite was a hole: a cumulative
       * ceiling that ignores money currently moving is not a ceiling. A user
       * could start a withdrawal and, while it sat in settlement_processing,
       * start another against headroom the first had not yet claimed.
       *
       * Only terminal FAILURE - failed, expired, cancelled - releases it now.
       * See NGN_LIMIT_CONSUMING_STATUSES.
       */
      await db.upsertNgnTransferRecord({
        id: 'ngnt_pending', userId, quoteId: 'q2', direction: 'offramp',
        sourceCurrency: 'usdc', destinationCurrency: 'ngn',
        sourceAmount: '10', destinationAmount: '15000',
        status: 'awaiting_crypto_deposit', provider: 'mock', createdAt: now, updatedAt: now
      } as any);
      const afterPending = await call('GET', `/api/users/${userId}/verification-summary`);
      check('a pending transfer DOES consume headroom',
        allowance(afterPending.body, 'offramp', 'ngn').usedNgn === 45_000,
        String(allowance(afterPending.body, 'offramp', 'ngn').usedNgn));

      // THE WINDOW IS A ROLLING 30 DAYS, AND THAT WAS NEVER ASSERTED.
      //
      // Found by mutation: deleting the cutoff comparison from
      // listNgnTransfersByUserSince - so every transfer the user had ever
      // completed counted - passed all 46 assertions. A user would have been
      // permanently capped by volume they moved a year ago, with no way to
      // recover their headroom, and the suite would have said fine.
      const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
      await db.upsertNgnTransferRecord({
        id: 'ngnt_expired', userId, quoteId: 'q3', direction: 'offramp',
        sourceCurrency: 'usdc', destinationCurrency: 'ngn',
        sourceAmount: '50', destinationAmount: '75000',
        status: 'completed', provider: 'mock', createdAt: longAgo, updatedAt: longAgo
      } as any);
      const afterOld = await call('GET', `/api/users/${userId}/verification-summary`);
      check('volume older than the window has expired out of it',
        allowance(afterOld.body, 'offramp', 'ngn').usedNgn === 45_000,
        String(allowance(afterOld.body, 'offramp', 'ngn').usedNgn));
      check('so headroom is not eaten by last year',
        allowance(afterOld.body, 'offramp', 'ngn').remainingNgn === 455_000,
        String(allowance(afterOld.body, 'offramp', 'ngn').remainingNgn));

      // ANOTHER USER'S VOLUME IS NOT YOURS.
      //
      // Also found by mutation: dropping the user filter went unnoticed. On a
      // shared table that is every customer's volume charged to one person.
      const stranger = await signup('Volume Stranger');
      await db.upsertNgnTransferRecord({
        id: 'ngnt_stranger', userId: stranger.user.id, quoteId: 'q4', direction: 'offramp',
        sourceCurrency: 'usdc', destinationCurrency: 'ngn',
        sourceAmount: '60', destinationAmount: '90000',
        status: 'completed', provider: 'mock', createdAt: now, updatedAt: now
      } as any);
      const afterStranger = await call('GET', `/api/users/${userId}/verification-summary`);
      // 45,000 is this user's own total (30,000 completed + 15,000 in flight),
      // UNCHANGED by the stranger's 90,000 - which is what this asserts.
      check('a stranger\'s completed transfer does not consume your headroom',
        allowance(afterStranger.body, 'offramp', 'ngn').usedNgn === 45_000,
        String(allowance(afterStranger.body, 'offramp', 'ngn').usedNgn));
    }

    console.log('\nONE USER\'S BANK EVIDENCE IS NOT ANOTHER\'S');
    {
      // Mutation-found: listExternalAccountsByUser returning every row passed
      // this suite. A single verified Bridge account anywhere in the table
      // would then have marked EVERY user as having a payout account - and,
      // through bridgeAccountVerified, granted them all Level 2.
      const loner = await signup('Unbanked Person');
      token = loner.token;
      await call('PUT', `/api/users/${loner.user.id}/country`, { country: 'US' });
      const now = new Date().toISOString();
      const richer = await signup('Well Banked Person');
      await db.insertExternalAccountRecord({
        id: 'ext_other', userId: richer.user.id, customerId: 'cus_other', provider: 'bridge',
        providerExternalAccountId: 'pe_other', currency: 'usd', accountType: 'us',
        accountOwnerName: 'Well Banked Person', paymentRail: 'ach', status: 'verified',
        createdAt: now, updatedAt: now
      } as any);

      token = loner.token;
      const res = await call('GET', `/api/users/${loner.user.id}/verification-summary`);
      check('someone else\'s verified account is not my payout account',
        res.body.hasPayoutAccount === false, String(res.body.hasPayoutAccount));
      check('and it does not grant me a level',
        res.body.level === VerificationLevel.NONE, String(res.body.level));
      check('nor mark my path complete',
        res.body.pathComplete === false, String(res.body.pathComplete));
    }

    console.log('\nA CUSTOMER RECORD MUST ACTUALLY BE FOUND');
    {
      // Mutation-found: findCustomerByUserId returning null unconditionally
      // failed 3 assertions here, which is the correct behaviour - a Bridge
      // user whose customer cannot be read must not silently read as Level 0.
      const bridgey = await signup('Lookup Person');
      token = bridgey.token;
      await call('PUT', `/api/users/${bridgey.user.id}/country`, { country: 'US' });
      const now = new Date().toISOString();
      await db.insertCustomerRecord({ id: 'cus_lookup', userId: bridgey.user.id, provider: 'bridge', providerCustomerId: 'pc_l', customerType: 'individual', kycStatus: 'kyc_approved', tosStatus: 'approved', createdAt: now, updatedAt: now } as any);
      await db.insertExternalAccountRecord({ id: 'ext_lookup', userId: bridgey.user.id, customerId: 'cus_lookup', provider: 'bridge', providerExternalAccountId: 'pe_l', currency: 'usd', accountType: 'us', accountOwnerName: 'Lookup Person', paymentRail: 'ach', status: 'verified', createdAt: now, updatedAt: now } as any);

      const res = await call('GET', `/api/users/${bridgey.user.id}/verification-summary`);
      check('the customer is found by userId, not by whole-table scan',
        res.body.level === VerificationLevel.IDENTITY, String(res.body.level));
      check('and their Bridge status reaches the summary',
        res.body.identitySource === 'bridge', String(res.body.identitySource));
    }

    console.log('\nA BRIDGE USER IS DESCRIBED BY THE SAME ENDPOINT');
    {
      const bridgeUser = await signup('Bridge Person');
      token = bridgeUser.token;
      const bid = bridgeUser.user.id;
      await call('PUT', `/api/users/${bid}/country`, { country: 'US' });

      const now = new Date().toISOString();
      await db.insertCustomerRecord({ id: 'cus_sum', userId: bid, provider: 'bridge', providerCustomerId: 'pc', customerType: 'individual', kycStatus: 'kyc_approved', tosStatus: 'approved', createdAt: now, updatedAt: now } as any);
      await db.insertExternalAccountRecord({ id: 'ext_sum', userId: bid, customerId: 'cus_sum', provider: 'bridge', providerExternalAccountId: 'pe', currency: 'usd', accountType: 'us', accountOwnerName: 'Bridge Person', paymentRail: 'ach', status: 'verified', createdAt: now, updatedAt: now } as any);

      const res = await call('GET', `/api/users/${bid}/verification-summary`);
      check('a Bridge user reaches IDENTITY', res.body.level === VerificationLevel.IDENTITY, String(res.body.level));
      check('their path is Bridge', res.body.path === 'bridge_kyc', res.body.path);
      check('and it reads complete', res.body.pathComplete === true);
      check('identity is attributed to Bridge', res.body.identitySource === 'bridge', String(res.body.identitySource));
      check('the uplift applies to them', res.body.upliftApplies === true);
      check('so their ceiling is the uplifted one, not the level table',
        allowance(res.body, 'offramp', 'ngn').limitNgn === 10_000_000,
        String(allowance(res.body, 'offramp', 'ngn').limitNgn));
      check('and above it they are asked for ENHANCED',
        allowance(res.body, 'offramp', 'ngn').nextLevel === VerificationLevel.ENHANCED);
      check('their foreign rails are open',
        allowance(res.body, 'offramp', 'foreign').limitNgn === 10_000_000,
        String(allowance(res.body, 'offramp', 'foreign').limitNgn));
    }

    console.log('\nTHE PAGE MUST BE ABLE TO SAY WHAT COMES NEXT');
    {
      /**
       * A FINISHED LEVEL IS NOT A FINISHED LADDER.
       *
       * Caught in a browser: a Nigerian at Level 1 saw "100% complete" and
       * nothing else. No mention that Level 2 exists, that it lifts the
       * ceiling from 100k to 500k, or what it would take. The honest read of
       * that screen is "this is as far as Sivan goes", and the ladder was
       * visible only to whoever read the limits table.
       *
       * The frontend cannot compute this itself without keeping a second copy
       * of the ladder - which is exactly how the two drift apart - so the
       * server states it.
       */
      const climber = await signup('Samuel Udochukwu');
      token = climber.token;
      await call('PUT', `/api/users/${climber.user.id}/country`, { country: 'NG' });

      const atZero = await call('GET', `/api/users/${climber.user.id}/verification-summary`);
      check('a Nigerian at level 0 is pointed at level 2 as the next rung',
        atZero.body.nextStep?.level === VerificationLevel.IDENTITY,
        JSON.stringify(atZero.body.nextStep));
      check('and it is described as NIN/BVN, not documents',
        atZero.body.nextStep?.action === 'nin_bvn', atZero.body.nextStep?.action);
      // Raised to 5,000,000 when BVN verification became a real persisted
      // check. Matching /500,?000/ would also match "5,000,000" by accident,
      // so the assertion is anchored on the full figure.
      check('the description names the actual ceiling it unlocks',
        /5,000,000/.test(atZero.body.nextStep?.description ?? ''),
        atZero.body.nextStep?.description);

      /**
       * AND IT IS HONEST ABOUT NOT BEING READY.
       *
       * No NIN/BVN provider is integrated - identityVerificationEnabled is off
       * for MVP. Offering a button that leads nowhere is worse than saying
       * "coming soon", because a user who clicks a dead button blames
       * themselves. So the rung is STATED and marked unavailable.
       */
      /**
       * NOW AVAILABLE - a BVN provider exists and is wired up.
       *
       * This asserted `available === false` because no provider was
       * integrated. That premise is gone: the Monnify/mock provider answers,
       * the result persists, and the step grants Level 2. Availability is also
       * no longer read from identityVerificationEnabled, which conflated "is a
       * check required" with "is a check possible".
       */
      check('and it is available, because a BVN provider is wired up',
        atZero.body.nextStep?.available === true,
        String(atZero.body.nextStep?.available));

      console.log('\n  A BRIDGE USER CLIMBS A DIFFERENT LADDER');
      const foreigner = await signup('Jonathan Benjamin Hart');
      token = foreigner.token;
      await call('PUT', `/api/users/${foreigner.user.id}/country`, { country: 'US' });
      const usSummary = await call('GET', `/api/users/${foreigner.user.id}/verification-summary`);
      check('a US user is pointed at level 2 as well',
        usSummary.body.nextStep?.level === VerificationLevel.IDENTITY,
        JSON.stringify(usSummary.body.nextStep));
      check('but via DOCUMENTS, not NIN/BVN',
        usSummary.body.nextStep?.action === 'bridge_kyc', usSummary.body.nextStep?.action);
      check('and that path IS available today',
        usSummary.body.nextStep?.available === true, String(usSummary.body.nextStep?.available));

      // The two ladders must not be the same object with a different label -
      // that would mean the country routing had collapsed.
      check('the two paths genuinely differ',
        atZero.body.nextStep?.action !== usSummary.body.nextStep?.action);
    }

    console.log('\nTHE ENDPOINT IS PRIVATE');
    {
      const other = await signup('Nosy Person');
      const victim = await signup('Private Person');
      token = other.token;
      const cross = await call('GET', `/api/users/${victim.user.id}/verification-summary`);
      check('one user cannot read another summary', cross.status === 403, String(cross.status));

      token = '';
      const anon = await call('GET', `/api/users/${victim.user.id}/verification-summary`);
      check('and it is not public', anon.status === 401, String(anon.status));
    }

    await app.close();
  } catch (error) {
    await app.close();
    throw error;
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });

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
      check('the NGN off-ramp ceiling is the Level 1 figure', off.limitNgn === 50_000, String(off.limitNgn));
      check('headroom is the full ceiling with no volume yet', off.remainingNgn === 50_000, String(off.remainingNgn));
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
        allowance(restored.body, 'offramp', 'ngn').limitNgn === 50_000,
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
      check('the ceiling itself is unchanged by usage', off.limitNgn === 50_000, String(off.limitNgn));
      check('and headroom is ceiling minus used',
        off.remainingNgn === 20_000, String(off.remainingNgn));

      // A PENDING transfer must not consume headroom.
      await db.upsertNgnTransferRecord({
        id: 'ngnt_pending', userId, quoteId: 'q2', direction: 'offramp',
        sourceCurrency: 'usdc', destinationCurrency: 'ngn',
        sourceAmount: '10', destinationAmount: '15000',
        status: 'awaiting_crypto_deposit', provider: 'mock', createdAt: now, updatedAt: now
      } as any);
      const afterPending = await call('GET', `/api/users/${userId}/verification-summary`);
      check('a pending transfer does not consume headroom',
        allowance(afterPending.body, 'offramp', 'ngn').usedNgn === 30_000,
        String(allowance(afterPending.body, 'offramp', 'ngn').usedNgn));
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

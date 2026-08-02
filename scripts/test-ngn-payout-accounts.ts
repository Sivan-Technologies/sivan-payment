/**
 * The Nigerian path actually grants Level 1 now - end to end, over HTTP.
 *
 * WHAT WAS BROKEN
 *
 * The name matcher had 42 passing assertions and was called by NOTHING. The
 * resolve endpoint returned a name, the modal displayed it, the user clicked
 * "Yes, that is me", and the account was never stored. So the Nigerian path
 * could not reach Level 1 at all, and the check that was supposed to stop a
 * user claiming a stranger's account never ran.
 *
 * WHAT THIS PROVES
 *
 *   1. A matched account persists and lifts the user to Level 1 (BANK).
 *   2. A partial match is queued, and queued does NOT grant the level.
 *   3. A stranger's account is rejected outright.
 *   4. A sandbox resolution never grants the level, however clean the match.
 *   5. The client cannot supply the account name - it is re-resolved server
 *      side, so a stranger's account cannot be claimed by posting your own.
 *   6. Resubmitting the same account updates one row instead of farming the
 *      review queue for a fresh reviewer.
 *
 * Run: npm run test:ngn-payout-accounts
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';
import { getVerificationState } from '../src/kyc/service/verification-state.js';
import { VerificationLevel } from '../src/kyc/types/verification.types.js';
import { payoutAccountStatusFor } from '../src/ngn/service/ngn-payout-accounts.service.js';
import { updateNgnControls } from '../src/ngn/service/ngn-controls.service.js';
import { levelIsIntact } from '../src/kyc/service/verification-policy.js';
import { defaultLimitFor } from '../src/kyc/service/verification-limits.service.js';

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
  if (!address || typeof address === 'string') throw new Error('Could not resolve server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let token = '';

  async function call(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders
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

  /**
   * Force a resolution to look production-grade.
   *
   * The mock provider always returns trustworthy:false, exactly like Breet's
   * sandbox - which is correct, and which also means NO test user could ever
   * reach 'verified' through the HTTP path. Flipping the stored flag directly
   * is the only way to exercise the granted-Level-1 branch without live
   * credentials, and it is confined to this helper so the production gate is
   * never weakened to make a test pass.
   */
  async function markResolutionTrustworthy(userId: string) {
    const accounts = await db.listNgnPayoutAccounts(userId);
    for (const account of accounts) {
      if (account.matchVerdict === 'match' && account.status === 'pending_review') {
        await db.upsertNgnPayoutAccountRecord({ ...account, resolutionTrustworthy: true, status: 'verified' });
      }
    }
  }

  try {
    console.log('\nTHE STATUS GATE HAS TWO INDEPENDENT CONDITIONS');
    {
      // Pure function, so every combination is cheap to state explicitly.
      check('a clean match on a real resolution verifies',
        payoutAccountStatusFor('match', true) === 'verified');
      check('a clean match on a SANDBOX resolution does not',
        payoutAccountStatusFor('match', false) === 'pending_review',
        payoutAccountStatusFor('match', false));
      check('a partial match queues even on a real resolution',
        payoutAccountStatusFor('review', true) === 'pending_review');
      check('a mismatch is rejected',
        payoutAccountStatusFor('mismatch', true) === 'rejected');
      check('a mismatch is rejected in sandbox too',
        payoutAccountStatusFor('mismatch', false) === 'rejected');
    }

    const user = await signup('Sharafa Ogunmepon');
    token = user.token;
    const userId = user.user.id;

    console.log('\nBEFORE ANY BANK ACCOUNT THE USER IS LEVEL 0');
    {
      const state = await getVerificationState(userId);
      check('level starts at NONE', state.level === VerificationLevel.NONE, String(state.level));
    }

    console.log('\nA MATCHING ACCOUNT IS SAVED AND MATCHED SERVER SIDE');
    {
      const saved = await call('POST', '/api/ngn/payout-accounts', {
        userId, bankId: '2', accountNumber: '1111111111'
      });
      check('the account is created', saved.status === 201, JSON.stringify(saved.body));
      check('the bank name is stored from the provider', saved.body.accountName === 'OGUNMEPON SHARAFA', saved.body.accountName);
      check('the declared name is captured for audit', saved.body.declaredName === 'Sharafa Ogunmepon', saved.body.declaredName);
      check('reversed name order still matches', saved.body.matchVerdict === 'match', saved.body.matchVerdict);
      check('the score is perfect', saved.body.matchScore === 1, String(saved.body.matchScore));
      check('the provider is recorded on the row', saved.body.provider === 'mock', saved.body.provider);

      // The gate that matters: a sandbox resolution must NOT verify.
      check('a sandbox resolution is flagged untrustworthy', saved.body.resolutionTrustworthy === false);
      check('so even a perfect match is only queued', saved.body.status === 'pending_review', saved.body.status);

      const state = await getVerificationState(userId);
      check('and a queued account does NOT grant Level 1',
        state.level === VerificationLevel.NONE, String(state.level));
    }

    console.log('\nA TRUSTWORTHY MATCH CLEARS THE BANK CHECK');
    {
      await markResolutionTrustworthy(userId);
      const state = await getVerificationState(userId);
      check('the bank check reads as verified', state.bankStatus === 'verified', String(state.bankStatus));

      /**
       * LEVEL 1 (BANK), NOT LEVEL 2. THIS IS THE WHOLE POINT.
       *
       * KYC-DESIGN.md: Level 1 is the bank/NIN tier; Level 2 is "Provider
       * verified - Bridge customer created and approved". A NUBAN name match
       * is Level 1 evidence and must stop there.
       *
       * It did NOT stop there when this table was first wired up.
       * verification-state read `identityVerified = bankVerified`, which was
       * sound while bankVerified could only come from a Bridge external
       * account - that user has done Bridge's document KYC. Making
       * bankVerified reachable from a bare NUBAN broke the premise, and a user
       * who typed ten digits was granted Level 2.
       *
       * Measured consequences of that bug, which is why this is asserted at
       * three levels rather than one:
       *   NGN off-ramp ceiling  50,000 -> 500,000   (10x)
       *   FOREIGN rails         0 -> 500,000        (opened outright)
       * with no documents, no selfie, and no $2 ever spent at Bridge.
       */
      check('a NUBAN match grants BANK, not IDENTITY',
        state.level === VerificationLevel.BANK, String(state.level));
      check('identity is NOT inherited from a bank name match',
        state.identityStatus === 'not_started', String(state.identityStatus));
      check('and no NIN is claimed',
        state.ninStatus === 'not_started', String(state.ninStatus));

      // The ceilings are the thing a user actually feels, so assert those too -
      // a level number that maps to the wrong limit is still a breach.
      check('the NGN off-ramp ceiling is the Level 1 one',
        defaultLimitFor('offramp', 'ngn', state.level) === 100_000,
        String(defaultLimitFor('offramp', 'ngn', state.level)));
      check('FOREIGN rails stay closed on a Nigerian bank match',
        defaultLimitFor('offramp', 'foreign', state.level) === 0,
        String(defaultLimitFor('offramp', 'foreign', state.level)));

      // The level must be INTACT, not merely low. A level whose evidence does
      // not back it makes levelIsIntact() reject every transaction with "one
      // of your verification checks needs attention" - true, and useless,
      // because there is no check the user can go and attend to.
      check('the level is intact, so transactions are not dead-locked',
        levelIsIntact(state) === true);

      // The toggle must not silently change the Nigerian answer either. It
      // governs whether identity is REQUIRED, and a NUBAN never satisfies it.
      await updateNgnControls({ identityVerificationEnabled: true } as any);
      const strict = await getVerificationState(userId);
      check('with identity required, a NUBAN match is still BANK',
        strict.level === VerificationLevel.BANK, String(strict.level));
      check('and still intact', levelIsIntact(strict) === true);
      await updateNgnControls({ identityVerificationEnabled: false } as any);
    }

    console.log('\nA BRIDGE-APPROVED USER IS UNAFFECTED BY THAT FIX');
    {
      // The fix narrowed identity inheritance to Bridge accounts. Confirm it
      // narrowed rather than removed it - stranding Bridge users at Level 1
      // would close the foreign rails they paid $2 to open.
      const now = new Date().toISOString();
      await db.insertUserRecord({ id: 'usr_bridge_probe', email: 'bridge@sivan.test', fullName: 'Bridge Person', createdAt: now, updatedAt: now } as any);
      await db.insertCustomerRecord({ id: 'cus_bridge_probe', userId: 'usr_bridge_probe', provider: 'bridge', providerCustomerId: 'pc_1', customerType: 'individual', kycStatus: 'kyc_approved', tosStatus: 'approved', createdAt: now, updatedAt: now } as any);
      await db.insertExternalAccountRecord({ id: 'ext_bridge_probe', userId: 'usr_bridge_probe', customerId: 'cus_bridge_probe', provider: 'bridge', providerExternalAccountId: 'pe_1', currency: 'usd', accountType: 'us', accountOwnerName: 'Bridge Person', paymentRail: 'ach', status: 'verified', createdAt: now, updatedAt: now } as any);

      const state = await getVerificationState('usr_bridge_probe');
      check('a Bridge-approved user still reaches IDENTITY',
        state.level === VerificationLevel.IDENTITY, String(state.level));
      check('their identity is verified', state.identityStatus === 'verified', String(state.identityStatus));
      check('their level is intact', levelIsIntact(state) === true);
      check('and their foreign rails are open',
        defaultLimitFor('offramp', 'foreign', state.level) === 500_000,
        String(defaultLimitFor('offramp', 'foreign', state.level)));
    }

    console.log('\nRESUBMITTING THE SAME ACCOUNT UPDATES ONE ROW');
    {
      const before = await db.listNgnPayoutAccounts(userId);
      const again = await call('POST', '/api/ngn/payout-accounts', {
        userId, bankId: '2', accountNumber: '1111111111'
      });
      const after = await db.listNgnPayoutAccounts(userId);
      check('no duplicate row is created', after.length === before.length, `${before.length} -> ${after.length}`);
      check('the id is stable, so a review link does not 404',
        again.body.id === before[0].id, `${before[0].id} vs ${again.body.id}`);
    }

    console.log('\nAN ACCOUNT HELD BY SOMEONE ELSE IS REJECTED');
    {
      const stranger = await signup('Tunde Bakare');
      token = stranger.token;
      const strangerId = stranger.user.id;

      const saved = await call('POST', '/api/ngn/payout-accounts', {
        userId: strangerId, bankId: '1', accountNumber: '3333333333'
      });
      check('the submission is accepted but judged', saved.status === 201, String(saved.status));
      check('the verdict is a mismatch', saved.body.matchVerdict === 'mismatch', saved.body.matchVerdict);
      check('and the account is rejected outright', saved.body.status === 'rejected', saved.body.status);
      check('the explanation names the real holder',
        /CHINEDU/i.test(saved.body.matchExplanation ?? ''), saved.body.matchExplanation);

      const state = await getVerificationState(strangerId);
      check('a rejected account grants nothing',
        state.level === VerificationLevel.NONE, String(state.level));
    }

    console.log('\nA PARTIAL MATCH GOES TO A HUMAN, NOT TO LEVEL 1');
    {
      const partial = await signup('Sharafa Ogunmepon');
      token = partial.token;
      const partialId = partial.user.id;

      // The bank holds a name the user did not declare. Could be an omitted
      // middle name; could be a different person sharing two common names.
      const saved = await call('POST', '/api/ngn/payout-accounts', {
        userId: partialId, bankId: '3', accountNumber: '2222222222'
      });
      check('an undeclared bank name queues for review',
        saved.body.status === 'pending_review', saved.body.status);
      check('the unexplained token is recorded for the reviewer',
        (saved.body.unmatchedBankTokens ?? []).includes('adebayo'),
        JSON.stringify(saved.body.unmatchedBankTokens));

      const state = await getVerificationState(partialId);
      check('and the user stays at Level 0 while it waits',
        state.level === VerificationLevel.NONE, String(state.level));

      // A single shared common first name is not identity.
      const weak = await signup('Sharafa Ogunmepon');
      token = weak.token;
      const weakSaved = await call('POST', '/api/ngn/payout-accounts', {
        userId: weak.user.id, bankId: '4', accountNumber: '4444444444'
      });
      check('one shared common first name does not auto-approve',
        weakSaved.body.status === 'pending_review', weakSaved.body.status);
      check('and it is not silently treated as a match',
        weakSaved.body.matchVerdict !== 'match', weakSaved.body.matchVerdict);
    }

    console.log('\nTHE CLIENT CANNOT SUPPLY THE NAME IT IS MATCHED AGAINST');
    {
      const attacker = await signup('Chinedu Emeka Okafor');
      token = attacker.token;

      // The attack: submit someone else's account number while claiming the
      // name matches. If the server trusted a posted accountName this would
      // verify, and the attacker would inherit a stranger's bank identity.
      const saved = await call('POST', '/api/ngn/payout-accounts', {
        userId: attacker.user.id,
        bankId: '2',
        accountNumber: '1111111111',
        accountName: 'CHINEDU EMEKA OKAFOR',
        status: 'verified',
        resolutionTrustworthy: true
      });
      check('the posted accountName is ignored',
        saved.body.accountName === 'OGUNMEPON SHARAFA', saved.body.accountName);
      check('the posted status is ignored',
        saved.body.status === 'rejected', saved.body.status);
      check('the posted trustworthy flag is ignored',
        saved.body.resolutionTrustworthy === false, String(saved.body.resolutionTrustworthy));
      check('and the real verdict is a mismatch',
        saved.body.matchVerdict === 'mismatch', saved.body.matchVerdict);
    }

    console.log('\nONE USER CANNOT ADD AN ACCOUNT FOR ANOTHER');
    {
      const a = await signup('Victim User');
      const b = await signup('Attacker User');
      token = b.token;
      const cross = await call('POST', '/api/ngn/payout-accounts', {
        userId: a.user.id, bankId: '2', accountNumber: '1111111111'
      });
      check('cross-user submission is forbidden', cross.status === 403, String(cross.status));

      token = '';
      const anon = await call('POST', '/api/ngn/payout-accounts', {
        userId: a.user.id, bankId: '2', accountNumber: '1111111111'
      });
      check('anonymous submission is rejected', anon.status === 401, String(anon.status));
      token = a.token;
      const list = await call('GET', `/api/ngn/payout-accounts?userId=${a.user.id}`);
      check('and the victim has no account', (list.body ?? []).length === 0, JSON.stringify(list.body));
    }

    console.log('\nMALFORMED INPUT NEVER REACHES THE PROVIDER');
    {
      const u = await signup('Format Test');
      token = u.token;
      for (const bad of ['123', '12345678901', 'abcdefghij', '']) {
        const res = await call('POST', '/api/ngn/payout-accounts', {
          userId: u.user.id, bankId: '2', accountNumber: bad
        });
        check(`"${bad}" is rejected with 400`, res.status === 400, String(res.status));
      }
      const unknownAccount = await call('POST', '/api/ngn/payout-accounts', {
        userId: u.user.id, bankId: '2', accountNumber: '9999999999'
      });
      check('an account that does not exist fails cleanly',
        unknownAccount.status === 400, String(unknownAccount.status));
    }

    console.log('\nTHE REVIEW QUEUE IS WORKABLE BY A HUMAN');
    {
      const adminKey = env.ADMIN_API_KEY || 'ngn-payout-admin-key';
      const adminHeaders = { 'x-admin-api-key': adminKey };
      token = '';

      const queue = await call('GET', '/api/admin/ngn/payout-accounts/reviews', undefined, adminHeaders);
      check('the queue is readable', queue.status === 200, JSON.stringify(queue.body).slice(0, 200));
      const pending = queue.body as any[];
      check('it contains only pending cases',
        pending.every((item) => item.status === 'pending_review'), JSON.stringify(pending.map((p) => p.status)));
      check('it is not empty', pending.length > 0, String(pending.length));

      // Oldest first: a queue worked newest-first strands the users who have
      // already waited longest.
      const times = pending.map((item) => Date.parse(item.createdAt));
      check('oldest cases come first',
        times.every((t, i) => i === 0 || times[i - 1] <= t), JSON.stringify(times));

      const target = pending[0];
      const approved = await call('PUT', `/api/admin/ngn/payout-accounts/${target.id}/review`,
        { decision: 'approve', note: 'Confirmed by phone' }, adminHeaders);
      check('an approval succeeds', approved.status === 200, JSON.stringify(approved.body));
      check('the account becomes verified', approved.body.status === 'verified', approved.body.status);
      check('the reviewer is recorded', Boolean(approved.body.reviewedBy), approved.body.reviewedBy);
      check('the note is kept', approved.body.reviewNote === 'Confirmed by phone', approved.body.reviewNote);

      // THE POINT OF THE WHOLE QUEUE: approval must actually unblock the user.
      // A queue that records a decision without changing what the user can do
      // is paperwork, not a control.
      const state = await getVerificationState(target.userId);
      check('and the reviewed user is no longer at Level 0',
        state.level > VerificationLevel.NONE, String(state.level));
      check('their bank check now reads verified',
        state.bankStatus === 'verified', String(state.bankStatus));

      const again = await call('PUT', `/api/admin/ngn/payout-accounts/${target.id}/review`,
        { decision: 'reject' }, adminHeaders);
      check('a second decision on the same case is refused',
        again.status === 400, String(again.status));

      const queueAfter = await call('GET', '/api/admin/ngn/payout-accounts/reviews', undefined, adminHeaders);
      check('the decided case leaves the queue',
        !(queueAfter.body as any[]).some((item) => item.id === target.id));
    }

    console.log('\nA REJECTION KEEPS THE USER BLOCKED');
    {
      const adminHeaders = { 'x-admin-api-key': env.ADMIN_API_KEY || 'ngn-payout-admin-key' };
      token = '';
      const queue = await call('GET', '/api/admin/ngn/payout-accounts/reviews', undefined, adminHeaders);
      const target = (queue.body as any[])[0];
      if (target) {
        const rejected = await call('PUT', `/api/admin/ngn/payout-accounts/${target.id}/review`,
          { decision: 'reject', note: 'Could not confirm' }, adminHeaders);
        check('a rejection succeeds', rejected.body.status === 'rejected', rejected.body.status);
        const state = await getVerificationState(target.userId);
        check('and the user does not get Level 1',
          state.level === VerificationLevel.NONE, String(state.level));
      } else {
        check('a pending case was available to reject', false, 'queue empty');
      }
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

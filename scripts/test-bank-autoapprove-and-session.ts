/**
 * A CLEAN NAME MATCH SHOULD NOT WAIT FOR A HUMAN — AND A SESSION SHOULD NOT
 * DIE WHILE THE USER IS USING IT.
 *
 * Two reported problems, one suite, because both were misdiagnosed the same
 * way: the visible symptom was not the cause.
 *
 * ---------------------------------------------------------------------------
 * 1. "JONATHAN BENJAMIN HART needs a quick manual check"
 * ---------------------------------------------------------------------------
 *
 * The matcher already auto-approves a clean match. What sent that user to a
 * queue was the SECOND gate: `resolutionTrustworthy`, which is false on any
 * non-production provider.
 *
 * And it is false for a real reason. Verified live against Breet's sandbox
 * during this session:
 *
 *   PalmPay 8102524846 -> Samuel Udochukwu
 *   PalmPay 0000000000 -> Samuel Udochukwu
 *   PalmPay 1234567890 -> Samuel Udochukwu
 *   Access  8102524846 -> Samuel Udochukwu
 *
 * Any ten digits, any bank, always the API key owner. Auto-approving on that
 * grants Level 1 - and a 100,000 NGN ceiling - to anyone who can type. So the
 * gate stays; it becomes an explicit switch
 * (NGN_TRUST_SANDBOX_BANK_RESOLUTION) that is REFUSED in production, and the
 * queue now says which of the two reasons is holding each case.
 *
 * ---------------------------------------------------------------------------
 * 2. "logged out every few minutes"
 * ---------------------------------------------------------------------------
 *
 * The token was never short. Measured against the deployed API, iat to exp is
 * exactly 3600 seconds. The causes were a sleeping backend producing
 * 401-shaped answers (a proxied call took 34s to fail with
 * UPSTREAM_UNAVAILABLE) and a hard 60-minute cliff mid-task. Fixed with a
 * sliding refresh and by only logging out on a token the SERVER rejected.
 *
 * Run: npm run test:bank-autoapprove
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';
import { payoutAccountDecision } from '../src/ngn/service/ngn-payout-accounts.service.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE)
    ? env.DATABASE_FILE
    : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${address.port}`;

  let token = '';
  const adminKey = process.env.ADMIN_API_KEY ?? '';
  async function call(method: string, url: string, body?: unknown, bearer?: string) {
    const auth = bearer === undefined ? token : bearer;
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(url.startsWith('/api/admin') ? { 'x-admin-api-key': adminKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    const unwrapped = Object.prototype.hasOwnProperty.call(json ?? {}, 'data') ? json.data : json;
    return { status: res.status, body: unwrapped, raw: json };
  }

  try {
    console.log('\nTHE DECISION TABLE: WHO IS BLOCKED, AND BY WHAT');
    {
      // A clean match against a REAL provider is the whole point. No queue.
      const verified = payoutAccountDecision('match', true);
      check('a clean match on a trustworthy resolution auto-verifies',
        verified.status === 'verified' && verified.reason === 'auto_verified', JSON.stringify(verified));
      check('and needs nobody', verified.needsHuman === false);

      // A partial match is a real judgement call - a middle name, a married
      // name. This is the ONLY thing that should reach an operator.
      const review = payoutAccountDecision('review', true);
      check('a partial match goes to a human',
        review.status === 'pending_review' && review.reason === 'name_needs_review', JSON.stringify(review));
      check('and is flagged as needing one', review.needsHuman === true);

      // A clean match on a sandbox resolution is NOT evidence, but it is also
      // not something an operator can decide - the names are identical.
      const untrusted = payoutAccountDecision('match', false);
      check('a clean match on an untrustworthy resolution is still held',
        untrusted.status === 'pending_review' && untrusted.reason === 'resolution_untrustworthy',
        JSON.stringify(untrusted));
      check('but is NOT put in front of a human, because no human can fix it',
        untrusted.needsHuman === false, JSON.stringify(untrusted));

      const mismatch = payoutAccountDecision('mismatch', true);
      check('an unrelated name is refused outright',
        mismatch.status === 'rejected' && mismatch.reason === 'name_mismatch', JSON.stringify(mismatch));
      check('and never reaches the queue', mismatch.needsHuman === false);
    }

    console.log('\nEND TO END: A MATCHED ACCOUNT IS APPROVED WITHOUT AN OPERATOR');
    let userId = '';
    {
      const email = `autoapprove-${Date.now()}@sivan.test`;
      const start = await call('POST', '/api/auth/email/start', {
        email,
        // MATCHES the mock bank's account holder for 1111111111 exactly, in
        // the reversed order a Nigerian bank actually returns. The mock
        // resolver is used deliberately: it refuses unknown numbers rather
        // than inventing a name, so it can express both outcomes.
        fullName: 'Sharafa Ogunmepon',
        intent: 'signup',
        legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
      });
      const verified = await call('POST', '/api/auth/email/verify', { email, code: start.body.devCode });
      token = verified.body.token;
      userId = verified.body.user.id;
      await call('PUT', `/api/users/${userId}/country`, { country: 'NG' });

      const saved = await call('POST', '/api/ngn/payout-accounts', {
        userId, bankId: '2', accountNumber: '1111111111',
      });
      check('the account saves', saved.status === 201 || saved.status === 200,
        `${saved.status} ${JSON.stringify(saved.body).slice(0, 160)}`);
      check('the name matched cleanly', saved.body?.matchVerdict === 'match',
        `${saved.body?.matchVerdict} score=${saved.body?.matchScore}`);
      check('and it is VERIFIED immediately, with no manual check',
        saved.body?.status === 'verified',
        `${saved.body?.status} reason=${saved.body?.reviewReason}`);
      check('recorded as auto-verified', saved.body?.reviewReason === 'auto_verified',
        String(saved.body?.reviewReason));

      // THE POINT OF THE WHOLE FEATURE: verification actually moves.
      const summary = await call('GET', `/api/users/${userId}/verification-summary`);
      check('the user reaches Level 1 on the bank check alone',
        Number(summary.body?.level) >= 1, `level ${summary.body?.level}`);

      const queue = await call('GET', '/api/admin/ngn/payout-accounts/reviews', undefined, '');
      check('and nothing was added to the review queue',
        Array.isArray(queue.body) && queue.body.length === 0,
        `${Array.isArray(queue.body) ? queue.body.length : queue.status} in queue`);
    }

    console.log('\nTHE ADMIN QUEUE SEPARATES "DECIDE THIS" FROM "FIX YOUR CONFIG"');
    {
      const now = new Date().toISOString();
      // A genuine judgement call.
      await db.upsertNgnPayoutAccountRecord({
        id: 'ngnacct_needs_human', userId, provider: 'mock', bankId: '26', bankName: 'PalmPay',
        accountNumber: '5555555555', accountName: 'Samuel Udochukwu Chinedu',
        declaredName: 'Samuel Udochukwu', matchVerdict: 'review', matchScore: 0.7,
        resolutionTrustworthy: true, status: 'pending_review',
        reviewReason: 'name_needs_review', needsHumanReview: true,
        createdAt: now, updatedAt: now,
      } as any);
      // Held only by the environment.
      await db.upsertNgnPayoutAccountRecord({
        id: 'ngnacct_config', userId, provider: 'mock', bankId: '26', bankName: 'PalmPay',
        accountNumber: '6666666666', accountName: 'Samuel Udochukwu',
        declaredName: 'Samuel Udochukwu', matchVerdict: 'match', matchScore: 1,
        resolutionTrustworthy: false, status: 'pending_review',
        reviewReason: 'resolution_untrustworthy', needsHumanReview: false,
        createdAt: now, updatedAt: now,
      } as any);

      const summary = await call('GET', '/api/admin/ngn/payout-accounts/review-summary', undefined, '');
      check('the summary endpoint answers', summary.status === 200, String(summary.status));
      check('both cases are in the queue', summary.body?.total === 2, String(summary.body?.total));
      check('but only ONE is counted as needing a person',
        summary.body?.needsHumanReview === 1, String(summary.body?.needsHumanReview));
      check('and the other is named as blocked by the provider environment',
        summary.body?.blockedByUntrustworthyResolution === 1,
        String(summary.body?.blockedByUntrustworthyResolution));
    }

    console.log('\nHISTORICAL ROWS ARE CLASSIFIED, NOT LEFT BLANK');
    {
      // Written before reviewReason existed. Without a derivation these show an
      // empty column and all pile into "someone must decide".
      const now = new Date().toISOString();
      await db.upsertNgnPayoutAccountRecord({
        id: 'ngnacct_legacy', userId, provider: 'mock', bankId: '26', bankName: 'PalmPay',
        accountNumber: '7777777777', accountName: 'Samuel Udochukwu',
        declaredName: 'Samuel Udochukwu', matchVerdict: 'match', matchScore: 1,
        resolutionTrustworthy: false, status: 'pending_review',
        createdAt: now, updatedAt: now,
      } as any);

      const queue = await call('GET', '/api/admin/ngn/payout-accounts/reviews', undefined, '');
      const legacy = (queue.body as any[]).find((item) => item.id === 'ngnacct_legacy');
      check('a legacy row is classified from what it does have',
        legacy?.reviewReason === 'resolution_untrustworthy', String(legacy?.reviewReason));
      check('and is not put in front of an operator',
        legacy?.needsHumanReview === false, String(legacy?.needsHumanReview));
    }

    console.log('\nTHE SESSION SLIDES INSTEAD OF EXPIRING MID-TASK');
    {
      const decode = (jwt: string) => {
        const part = jwt.split('.')[1];
        return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
      };

      const before = decode(token);
      check('the issued token really does last a full hour',
        before.exp - before.iat === env.USER_JWT_EXPIRES_MINUTES * 60,
        `${(before.exp - before.iat) / 60} minutes`);

      // One second, so the new token's iat is provably later. Without this the
      // two tokens can be byte-identical and "it refreshed" proves nothing.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const refreshed = await call('POST', '/api/auth/refresh');
      check('a valid token can be exchanged for a fresh one', refreshed.status === 200,
        `${refreshed.status} ${JSON.stringify(refreshed.body).slice(0, 140)}`);
      const after = decode(refreshed.body.token);
      check('and the new token expires LATER than the old one',
        after.exp > before.exp, `${after.exp} vs ${before.exp}`);
      check('it belongs to the same user', after.sub === before.sub);
      check('the user is returned so the client can stay in sync',
        refreshed.body?.user?.id === userId, String(refreshed.body?.user?.id));

      // The refreshed token must actually work, or the slide is cosmetic.
      const used = await call('GET', `/api/users/${userId}/verification-summary`, undefined, refreshed.body.token);
      check('the refreshed token is accepted on a protected route', used.status === 200, String(used.status));
    }

    console.log('\nBUT REFRESH IS NOT A WAY IN');
    {
      const anonymous = await call('POST', '/api/auth/refresh', undefined, '');
      check('refresh without a token is refused', anonymous.status === 401, String(anonymous.status));

      const forged = await call('POST', '/api/auth/refresh', undefined, 'not.a.token');
      check('a malformed token is refused', forged.status === 401, String(forged.status));

      /**
       * A tampered payload with a valid-looking shape. This is the attack the
       * endpoint would enable if it did not verify the signature.
       *
       * The subject is swapped to a REAL SECOND USER, not to a made-up id.
       * With a made-up id this passes even when signature verification is
       * removed entirely - getUser simply fails to find the user - so the
       * assertion proved nothing about the signature. Mutation-testing caught
       * that: replacing verifyUserJwt with a bare base64 decode left this
       * green. Against a user who genuinely exists, only the signature check
       * can refuse it.
       */
      const victimEmail = `victim-${Date.now()}@sivan.test`;
      const victimStart = await call('POST', '/api/auth/email/start', {
        email: victimEmail, fullName: 'Victim User', intent: 'signup',
        legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
      }, '');
      const victim = await call('POST', '/api/auth/email/verify',
        { email: victimEmail, code: victimStart.body.devCode }, '');
      const victimId = victim.body.user.id;
      check('a second real user exists to impersonate', Boolean(victimId), String(victimId));

      const parts = token.split('.');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      payload.sub = victimId;
      payload.email = victimEmail;
      const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${parts[2]}`;
      const swapped = await call('POST', '/api/auth/refresh', undefined, tampered);
      check('a token re-pointed at another REAL user is refused',
        swapped.status === 401, `${swapped.status} ${JSON.stringify(swapped.body).slice(0, 120)}`);
      check('and no token was minted for them',
        !swapped.body?.token, String(swapped.body?.token).slice(0, 40));

      // An EXPIRED token must not be revivable, or the 60-minute lifetime and
      // the idle timeout both become meaningless.
      const expiredPayload = { ...payload, sub: userId, iat: 1, exp: 2 };
      const expired = `${parts[0]}.${Buffer.from(JSON.stringify(expiredPayload)).toString('base64url')}.${parts[2]}`;
      const revived = await call('POST', '/api/auth/refresh', undefined, expired);
      check('an expired token cannot be revived', revived.status === 401, String(revived.status));
    }

    console.log('\nTHE FRONTEND ONLY LOGS OUT ON A TOKEN THE SERVER REJECTED');
    {
      // Asserted against source: the bug is structural. A sleeping backend
      // returns 401-shaped answers that are nothing to do with the token, and
      // a runtime test of this API cannot reproduce the gateway's behaviour.
      const source = await fs.readFile(path.join(process.cwd(), 'frontend/src/App.tsx'), 'utf8');
      check('the 401 handler checks the error CODE, not just the status',
        /tokenIsRejected/.test(source) &&
          /invalid_token|auth_required/.test(source) &&
          /response\.status === 401 && authToken && tokenIsRejected/.test(source),
        'App.tsx still logs out on any 401');

      const hook = await fs.readFile(path.join(process.cwd(), 'frontend/src/hooks/useAuth.ts'), 'utf8');
      check('the client refreshes on a timer', /REFRESH_INTERVAL_MS/.test(hook));
      check('a failed refresh does NOT log the user out',
        /if \(!response\.ok\) return;/.test(hook), 'a non-ok refresh still ends the session');
      check('the idle timeout is 8 hours, not 30 minutes',
        /IDLE_TIMEOUT_MS = 8 \* 60 \* 60 \* 1000/.test(hook));
    }

    console.log('\nAND THE SANDBOX OVERRIDE CANNOT BE LEFT ON IN PRODUCTION');
    {
      const appSource = await fs.readFile(path.join(process.cwd(), 'src/app.ts'), 'utf8');
      check('buildApp refuses to start with it set in production',
        /APP_ENV === 'production' && env\.NGN_TRUST_SANDBOX_BANK_RESOLUTION/.test(appSource) &&
          /throw new Error/.test(appSource.slice(appSource.indexOf('NGN_TRUST_SANDBOX_BANK_RESOLUTION'))),
        'no production guard on NGN_TRUST_SANDBOX_BANK_RESOLUTION');
    }

    await app.close();
  } catch (error) {
    await app.close();
    throw error;
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

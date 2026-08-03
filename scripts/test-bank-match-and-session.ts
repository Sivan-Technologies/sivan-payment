/**
 * A CLEAN BANK MATCH SHOULD NOT WAIT FOR A HUMAN — AND A SESSION SHOULD NOT
 * DIE UNDER AN ACTIVE USER.
 *
 * Two reported problems, both reproduced live before being fixed.
 *
 * 1. "when user is verifying with bank and it clearly match, approve it"
 *
 *    It already did — in production. On the test rig it could not, and the
 *    reason matters: Breet's sandbox returns a plausible name for ANY ten
 *    digits. Verified live against PalmPay just now:
 *
 *      0000000000 -> "Samuel Udochukwu"
 *      1234567890 -> "Samuel Udochukwu"
 *      9999999999 -> "Samuel Udochukwu"
 *
 *    So a sandbox match is a match against a fabrication, and the
 *    resolutionTrustworthy gate correctly refuses to grant Level 1 from it.
 *    The consequence nobody noticed: the auto-approve branch became
 *    UNREACHABLE outside production. 38 perfect matches sat in the review
 *    queue on api-test, every one of them "Samuel Udochukwu" vs "Samuel
 *    Udochukwu" at score 1.0.
 *
 *    An untestable branch is an untested branch. NGN_TRUST_SANDBOX_BANK_RESOLUTION
 *    makes it reachable, and is refused at boot in production.
 *
 * 2. "user account logout too frequent"
 *
 *    The token is 60 minutes, so the complaint reads as exaggeration until you
 *    look for the refresh endpoint: there wasn't one. A hard expiry with no
 *    renewal means every session ends by dying mid-use, and a session that
 *    dies on a half-filled form feels constant.
 *
 * Run: npm run test:bank-match-session
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { payoutAccountStatusFor, payoutReviewReasonFor } from '../src/ngn/service/ngn-payout-accounts.service.js';

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

  async function call(method: string, url: string, body?: unknown, token?: string) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // Admin routes fail CLOSED without this, and a 401 body has no
        // .length - the first run died on `queued.some is not a function`
        // rather than reporting an auth problem.
        ...(url.startsWith('/api/admin') ? { 'x-admin-api-key': process.env.ADMIN_API_KEY ?? '' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    const unwrapped = Object.prototype.hasOwnProperty.call(json ?? {}, 'data') ? json.data : json;
    return { status: res.status, body: unwrapped, raw: json };
  }

  async function signup(fullName: string) {
    const email = `bm-${Math.random().toString(36).slice(2, 10)}@sivan.test`;
    const start = await call('POST', '/api/auth/email/start', {
      email,
      fullName,
      intent: 'signup',
      legalAcceptance: {
        accepted: true,
        termsVersion: 't',
        privacyVersion: 'p',
        riskDisclosureVersion: 'r',
      },
    });
    const verified = await call('POST', '/api/auth/email/verify', {
      email,
      code: start.body.devCode,
    });
    const token = verified.body.token as string;
    const userId = verified.body.user.id as string;
    await call('PUT', `/api/users/${userId}/country`, { country: 'NG' }, token);
    return { token, userId, email };
  }

  try {
    // The mock directory resolves 1111111111 to "OGUNMEPON SHARAFA".
    const EXACT = '1111111111';
    // "OGUNMEPON SHARAFA ADEBAYO" - a middle name the user did not declare.
    const PARTIAL = '2222222222';
    // "CHINEDU EMEKA OKAFOR" - somebody else entirely.
    const STRANGER = '3333333333';

    console.log('\n1. THE DECISION TABLE, DIRECTLY');
    {
      check('a clean match on a trustworthy resolution is VERIFIED, no human',
        payoutAccountStatusFor('match', true) === 'verified',
        payoutAccountStatusFor('match', true));
      check('a clean match on an UNTRUSTWORTHY resolution still waits',
        payoutAccountStatusFor('match', false) === 'pending_review',
        payoutAccountStatusFor('match', false));
      check('a partial match waits even when the source is real',
        payoutAccountStatusFor('review', true) === 'pending_review',
        payoutAccountStatusFor('review', true));
      check('a stranger is rejected outright, not queued',
        payoutAccountStatusFor('mismatch', true) === 'rejected',
        payoutAccountStatusFor('mismatch', true));

      // The queue is two different jobs wearing one badge.
      check('a queued perfect match is labelled as an environment problem',
        payoutReviewReasonFor({ matchVerdict: 'match', resolutionTrustworthy: false }) === 'unverified_source');
      check('a queued partial match is labelled as a name problem',
        payoutReviewReasonFor({ matchVerdict: 'review', resolutionTrustworthy: true }) === 'name');
    }

    console.log('\n2. END TO END: A CLEAN MATCH AUTO-APPROVES AND UNLOCKS LEVEL 1');
    {
      const user = await signup('Sharafa Ogunmepon');
      const saved = await call('POST', '/api/ngn/payout-accounts',
        { userId: user.userId, bankId: '1', accountNumber: EXACT }, user.token);

      check('the account saved', saved.status === 200 || saved.status === 201, String(saved.status));
      check('the bank name matched exactly', saved.body?.matchVerdict === 'match',
        `${saved.body?.declaredName} vs ${saved.body?.accountName}`);
      check('the resolution counts as evidence in this environment',
        saved.body?.resolutionTrustworthy === true, String(saved.body?.resolutionTrustworthy));
      check('AND IT IS VERIFIED WITHOUT A HUMAN',
        saved.body?.status === 'verified', String(saved.body?.status));

      // The point of verifying at all: the user can now transact.
      const summary = await call('GET', `/api/users/${user.userId}/verification-summary`, undefined, user.token);
      check('the user reaches Level 1', Number(summary.body?.level) >= 1, String(summary.body?.level));
      check('and has a usable payout account',
        summary.body?.hasPayoutAccount === true, String(summary.body?.hasPayoutAccount));

      const reviews = await call('GET', '/api/admin/ngn/payout-accounts/reviews', undefined);
      const queued = (reviews.body as any[]) ?? [];
      check('and NOTHING was added to the review queue',
        !queued.some((item) => item.userId === user.userId), `${queued.length} in queue`);
    }

    console.log('\n3. A PARTIAL MATCH STILL WAITS FOR A PERSON');
    {
      const user = await signup('Sharafa Ogunmepon');
      const saved = await call('POST', '/api/ngn/payout-accounts',
        { userId: user.userId, bankId: '1', accountNumber: PARTIAL }, user.token);

      check('the verdict is review, not match', saved.body?.matchVerdict === 'review',
        `${saved.body?.accountName} (${saved.body?.matchScore})`);
      check('so it is queued, NOT auto-approved',
        saved.body?.status === 'pending_review', String(saved.body?.status));

      const summary = await call('GET', `/api/users/${user.userId}/verification-summary`, undefined, user.token);
      check('and the user is NOT yet Level 1', Number(summary.body?.level) < 1, String(summary.body?.level));

      const reviews = await call('GET', '/api/admin/ngn/payout-accounts/reviews', undefined);
      const mine = ((reviews.body as any[]) ?? []).find((item) => item.userId === user.userId);
      check('it appears in the admin queue', Boolean(mine));
      check('labelled as a NAME judgement, not environment noise',
        mine?.reviewReason === 'name', String(mine?.reviewReason));
      check('and the unmatched token is surfaced for the operator',
        (mine?.unmatchedBankTokens ?? []).length > 0,
        JSON.stringify(mine?.unmatchedBankTokens));
    }

    console.log("\n4. SOMEBODY ELSE'S ACCOUNT IS REFUSED, NOT QUEUED");
    {
      const user = await signup('Sharafa Ogunmepon');
      const saved = await call('POST', '/api/ngn/payout-accounts',
        { userId: user.userId, bankId: '1', accountNumber: STRANGER }, user.token);
      check('a stranger account is rejected', saved.body?.status === 'rejected',
        `${saved.body?.accountName} -> ${saved.body?.status}`);

      const reviews = await call('GET', '/api/admin/ngn/payout-accounts/reviews', undefined);
      check('and it does NOT waste a human review slot',
        !((reviews.body as any[]) ?? []).some((item) => item.userId === user.userId));

      const summary = await call('GET', `/api/users/${user.userId}/verification-summary`, undefined, user.token);
      check('the user is not verified by it', Number(summary.body?.level) < 1, String(summary.body?.level));
    }

    console.log('\n5. THE TRUST OVERRIDE CANNOT REACH A LIVE MONEY RAIL');
    {
      /**
       * Boot-time refusal, not a comment.
       *
       * KEYED ON A LIVE PROVIDER, NOT ON APP_ENV. The first version of this
       * guard refused on APP_ENV=production OR staging - and api-test runs
       * APP_ENV=staging, so it would have crash-looped the very environment
       * the override exists for. Found by curling /health/operational on the
       * deployed test API and reading back `environment: staging`.
       *
       * env is parsed once at import, so the running snapshot is poked
       * directly - otherwise this would be testing module caching rather than
       * app.ts.
       */
      const mutable = env as any;
      const beforeEnvLabel = mutable.APP_ENV;
      const beforeBreet = mutable.BREET_ENV;
      const beforeTrust = mutable.NGN_TRUST_SANDBOX_BANK_RESOLUTION;
      mutable.BREET_ENV = 'production';
      mutable.NGN_TRUST_SANDBOX_BANK_RESOLUTION = true;

      let refused = false;
      let message = '';
      try {
        const doomed = await buildApp();
        await doomed.close();
      } catch (error) {
        refused = true;
        message = String((error as Error).message);
      }

      mutable.BREET_ENV = beforeBreet;
      mutable.NGN_TRUST_SANDBOX_BANK_RESOLUTION = beforeTrust;

      check('the service REFUSES TO BOOT against a LIVE provider with the override on',
        refused, message);
      check('and the error names the variable, so the fix is obvious',
        /NGN_TRUST_SANDBOX_BANK_RESOLUTION/.test(message), message);

      /**
       * AND api-test MUST STILL BOOT. It runs APP_ENV=staging with the
       * override ON, which the first version of this guard would have
       * crash-looped. This is the assertion that would have caught that
       * before a deploy rather than after one.
       */
      mutable.APP_ENV = 'staging';
      mutable.BREET_ENV = 'development';
      mutable.NGN_TRUST_SANDBOX_BANK_RESOLUTION = true;
      let stagingBooted = false;
      try {
        const staging = await buildApp();
        await staging.close();
        stagingBooted = true;
      } catch (error) {
        message = String((error as Error).message);
      }
      mutable.APP_ENV = beforeEnvLabel;
      mutable.BREET_ENV = beforeBreet;
      mutable.NGN_TRUST_SANDBOX_BANK_RESOLUTION = beforeTrust;
      check('but a SANDBOX staging rig still boots with the override on',
        stagingBooted, message);
    }

    console.log('\n6. AN ACTIVE SESSION RENEWS INSTEAD OF DYING');
    {
      const user = await signup('Sharafa Ogunmepon');

      const decode = (token: string) => {
        const part = token.split('.')[1];
        return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
      };
      const original = decode(user.token);

      // A second of real time, so the new token's iat genuinely differs.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const refreshed = await call('POST', '/api/auth/session/refresh', undefined, user.token);
      check('the refresh endpoint exists and answers 200', refreshed.status === 200,
        `${refreshed.status} ${JSON.stringify(refreshed.body).slice(0, 120)}`);
      check('it returns a token', typeof refreshed.body?.token === 'string' && refreshed.body.token.length > 20);

      const next = decode(refreshed.body.token);
      check('the new token expires LATER than the old one',
        next.exp > original.exp, `${original.exp} -> ${next.exp}`);
      check('it is still the same user',
        next.sub === original.sub, `${original.sub} -> ${next.sub}`);
      check('and the full window is restored, not the remainder',
        Math.round((next.exp - next.iat) / 60) === env.USER_JWT_EXPIRES_MINUTES,
        String((next.exp - next.iat) / 60));

      // The renewed token must actually work, or the refresh is theatre.
      const used = await call('GET', `/api/users/${user.userId}/verification-summary`,
        undefined, refreshed.body.token);
      check('the refreshed token is accepted on a protected route',
        used.status === 200, String(used.status));
    }

    console.log('\n7. BUT REFRESH IS NOT A WAY AROUND AUTHENTICATION');
    {
      const anonymous = await call('POST', '/api/auth/session/refresh');
      check('refresh with no token is refused', anonymous.status === 401, String(anonymous.status));

      const garbage = await call('POST', '/api/auth/session/refresh', undefined, 'not.a.token');
      check('refresh with a forged token is refused', garbage.status === 401, String(garbage.status));

      // A token signed with the wrong secret - the shape is right, the
      // signature is not. This is the one an attacker actually tries.
      const user = await signup('Sharafa Ogunmepon');
      const [header, payload] = user.token.split('.');
      const tampered = `${header}.${payload}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
      const forged = await call('POST', '/api/auth/session/refresh', undefined, tampered);
      check('refresh with a tampered signature is refused',
        forged.status === 401, String(forged.status));

      // An EXPIRED token must not be renewable, or expiry means nothing.
      const { signUserJwt } = await import('../src/auth/jwt.js');
      const realToken = signUserJwt({ userId: user.userId, email: user.email });
      const parts = realToken.split('.');
      const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      body.exp = Math.floor(Date.now() / 1000) - 60;
      const staleUnsigned = `${parts[0]}.${Buffer.from(JSON.stringify(body)).toString('base64url')}.${parts[2]}`;
      const stale = await call('POST', '/api/auth/session/refresh', undefined, staleUnsigned);
      check('an expired token cannot be renewed', stale.status === 401, String(stale.status));
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

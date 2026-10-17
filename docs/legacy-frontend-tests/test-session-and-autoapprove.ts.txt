/**
 * THREE THINGS A USER FEELS DIRECTLY.
 *
 * 1. A SLIDING SESSION.
 *    signUserJwt stamped exp = iat + 60 minutes and NOTHING renewed it, so a
 *    user was signed out exactly an hour after logging in regardless of what
 *    they were doing - mid-withdrawal included. There was no refresh endpoint
 *    at all. Now an active session renews; an idle one still dies.
 *
 * 2. A CLEAN BANK MATCH AUTO-APPROVES.
 *    Two independent gates had to pass, and on the test environment the second
 *    could not: `trustworthy` was hardcoded to (BREET_ENV === 'production'),
 *    so EVERY account - including a perfect name match - was parked at
 *    pending_review behind "needs a quick manual check". The auto-approval
 *    path could not be exercised end to end at all.
 *
 * 3. THAT RELAXATION MUST NEVER REACH PRODUCTION.
 *    A sandbox resolver invents a plausible person for any ten digits
 *    (verified live: 0000000000 at UBA returned "Samuel Udochukwu"), so
 *    honouring it in production would hand Level 1 to anyone. buildApp()
 *    refuses to start.
 *
 * Run: npm run test:session-autoapprove
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';

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

function claims(token: string): any {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE)
    ? env.DATABASE_FILE
    : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const base = `http://127.0.0.1:${addr.port}`;

  let token = '';
  async function call(method: string, url: string, body?: unknown, bearer?: string) {
    const auth = bearer === undefined ? token : bearer;
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    const has = Object.prototype.hasOwnProperty.call(json ?? {}, 'data');
    return { status: res.status, body: has ? json.data : json, raw: json };
  }

  try {
    const email = `sess-${Date.now()}@sivan.test`;
    const start = await call('POST', '/api/auth/email/start', {
      email,
      fullName: 'Jonathan Hart',
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
    token = verified.body.token;
    const userId = verified.body.user.id;
    await call('PUT', `/api/users/${userId}/country`, { country: 'NG' });

    console.log('\nAN ACTIVE SESSION CAN BE RENEWED');
    {
      const before = claims(token);
      check(
        'the issued token really does expire',
        Number.isFinite(before.exp) && before.exp > before.iat,
        `${before.exp - before.iat}s`
      );

      // One second, so the new token's iat is strictly later and the extension
      // is observable rather than an identical string.
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const refreshed = await call('POST', '/api/auth/session/refresh');
      check('refresh succeeds for a live token', refreshed.status === 200, String(refreshed.status));
      check('and returns a token', typeof refreshed.body?.token === 'string');

      const after = claims(refreshed.body.token);
      check(
        'the new token expires LATER than the old one',
        after.exp > before.exp,
        `${before.exp} -> ${after.exp}`
      );
      check('it is the same user', after.sub === before.sub);
      check('and the full window is restored, not topped up',
        after.exp - after.iat === before.exp - before.iat,
        `${after.exp - after.iat}s vs ${before.exp - before.iat}s`);

      const withNew = await call('GET', `/api/users/${userId}/verification-summary`, undefined, refreshed.body.token);
      check('the renewed token actually works', withNew.status === 200, String(withNew.status));
    }

    console.log('\nBUT RENEWAL IS NOT A BACK DOOR');
    {
      const anonymous = await call('POST', '/api/auth/session/refresh', undefined, '');
      check('no token cannot refresh', anonymous.status === 401, String(anonymous.status));

      const garbage = await call('POST', '/api/auth/session/refresh', undefined, 'not.a.token');
      check('a malformed token cannot refresh', garbage.status === 401, String(garbage.status));

      /**
       * AN EXPIRED TOKEN CANNOT RESURRECT ITSELF.
       *
       * This is the entire security boundary of the feature. If a lapsed token
       * could renew, the session would be immortal and the idle timeout would
       * mean nothing. Forged with an exp in the past, signed with the REAL
       * secret, so the only thing being tested is the expiry check.
       */
      const crypto = await import('node:crypto');
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: userId,
          email,
          roles: ['user'],
          typ: 'user',
          iat: now - 7200,
          exp: now - 60,
          iss: 'sivan-payments-api',
          aud: 'sivan-payments-user',
        })
      ).toString('base64url');
      const sig = crypto
        .createHmac('sha256', env.USER_JWT_SECRET)
        .update(`${header}.${payload}`)
        .digest('base64url');
      const expired = `${header}.${payload}.${sig}`;

      const dead = await call('POST', '/api/auth/session/refresh', undefined, expired);
      check('an EXPIRED token cannot refresh itself', dead.status === 401, String(dead.status));
      check('and it is reported as an invalid token, not a missing one',
        dead.raw?.error?.code === 'invalid_token', JSON.stringify(dead.raw?.error));
    }

    console.log('\nTHE FRONTEND ONLY LOGS OUT ON A BAD CREDENTIAL');
    {
      /**
       * "Logged out every few minutes" was not the token expiring. Every 401
       * tore down the session, and a 401 is also what an endpoint returns when
       * it needs auth and none was sent - several calls fire independently of
       * the token. The two are distinguishable by error code, and the frontend
       * now honours that.
       */
      const anonymous = await call('GET', '/api/ngn/networks?asset=usdc', undefined, '');
      check('an unauthenticated call reports auth_required',
        anonymous.raw?.error?.code === 'auth_required', JSON.stringify(anonymous.raw?.error));

      const bad = await call('GET', `/api/users/${userId}/verification-summary`, undefined, 'a.b.c');
      check('a BAD token reports invalid_token',
        bad.raw?.error?.code === 'invalid_token', JSON.stringify(bad.raw?.error));
      check('so the two cases are genuinely distinguishable',
        anonymous.raw?.error?.code !== bad.raw?.error?.code);

      /**
       * The merged rule is NARROWER than either draft, and measured rather
       * than reasoned: only the two codes that name the CREDENTIAL end a
       * session. api-live sleeps on Render's free tier, and a proxied call was
       * measured taking 34 seconds to fail with UPSTREAM_UNAVAILABLE - the
       * gateway can answer 401-shaped for reasons that have nothing to do with
       * the token, and killing a valid session over infrastructure is how an
       * hour-long token feels like minutes.
       */
      const source = await fs.readFile(path.join(process.cwd(), 'frontend/src/App.tsx'), 'utf8');
      check('the frontend only logs out on a token the server named',
        /authCode === 'invalid_token' \|\| authCode === 'auth_required'/.test(source));
      check('and infrastructure 401s do not end the session',
        /tokenIsRejected/.test(source));

      const hook = await fs.readFile(path.join(process.cwd(), 'frontend/src/hooks/useAuth.ts'), 'utf8');
      check('the idle timeout matches the server window (60 minutes)',
        /IDLE_TIMEOUT_MS = 60 \* 60 \* 1000/.test(hook));
      check('and the client renews well before the token lapses',
        /REFRESH_INTERVAL_MS = 20 \* 60 \* 1000/.test(hook));
      /**
       * A SLEEPING LAPTOP IS THE CASE AN INTERVAL ALONE MISSES.
       *
       * setInterval is throttled in a background tab and does not run at all
       * while the machine is asleep, so a 20-minute tick can be skipped
       * entirely and the token expires before the next attempt. Refreshing on
       * return to the tab is what closes that, and it is the difference
       * between "renews every 20 minutes" and "is actually still signed in
       * when you come back to it".
       */
      check('and it also renews on returning to the tab',
        /visibilitychange/.test(hook) && /void refreshToken\(\)/.test(hook));
    }

    console.log('\nA CLEAN BANK MATCH AUTO-APPROVES, NO HUMAN NEEDED');
    {
      // NGN_PROVIDER=mock + NGN_TRUST_SANDBOX_BANK_RESOLUTION=true, so the
      // resolution counts as evidence exactly as it would in production.
      // 1111111111 resolves to "OGUNMEPON SHARAFA".
      const sharafa = `auto-${Date.now()}@sivan.test`;
      const s2 = await call('POST', '/api/auth/email/start', {
        email: sharafa,
        fullName: 'Sharafa Ogunmepon',
        intent: 'signup',
        legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
      });
      const v2 = await call('POST', '/api/auth/email/verify', { email: sharafa, code: s2.body.devCode });
      const sharafaToken = v2.body.token;
      const sharafaId = v2.body.user.id;
      await call('PUT', `/api/users/${sharafaId}/country`, { country: 'NG' }, sharafaToken);

      const saved = await call(
        'POST',
        '/api/ngn/payout-accounts',
        { userId: sharafaId, bankId: '1', accountNumber: '1111111111' },
        sharafaToken
      );
      check('the account saves', saved.status === 200 || saved.status === 201, String(saved.status));
      check('an exact match is VERIFIED immediately, not pending_review',
        saved.body?.status === 'verified', String(saved.body?.status));
      check('the verdict is a full match', saved.body?.matchVerdict === 'match');
      check('and it does not sit in the admin queue',
        !(await db.listNgnPayoutAccounts(sharafaId)).some((a: any) => a.status === 'pending_review'));

      // The whole point: Level 1, so a payout is possible without waiting.
      const summary = await call('GET', `/api/users/${sharafaId}/verification-summary`, undefined, sharafaToken);
      check('the user reaches Level 1 on the bank check alone',
        Number(summary.body?.level) >= 1, JSON.stringify(summary.body?.level));
    }

    console.log('\nAND A GENUINELY AMBIGUOUS ONE STILL WAITS FOR A HUMAN');
    {
      // 2222222222 resolves to "OGUNMEPON SHARAFA ADEBAYO" - an unexplained
      // TRAILING surname, which is the different-person shape.
      const risky = `risky-${Date.now()}@sivan.test`;
      const s3 = await call('POST', '/api/auth/email/start', {
        email: risky,
        fullName: 'Sharafa Ogunmepon',
        intent: 'signup',
        legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
      });
      const v3 = await call('POST', '/api/auth/email/verify', { email: risky, code: s3.body.devCode });
      const riskyToken = v3.body.token;
      const riskyId = v3.body.user.id;
      await call('PUT', `/api/users/${riskyId}/country`, { country: 'NG' }, riskyToken);

      const saved = await call(
        'POST',
        '/api/ngn/payout-accounts',
        { userId: riskyId, bankId: '1', accountNumber: '2222222222' },
        riskyToken
      );
      check('an unexplained surname is held for review',
        saved.body?.status === 'pending_review', String(saved.body?.status));

      // AND IT IS VISIBLE. A queue nobody can see is the same as no queue -
      // the user is blocked either way.
      const queue = await fetch(`${base}/api/admin/ngn/payout-accounts/reviews`, {
        headers: { 'x-admin-api-key': process.env.ADMIN_API_KEY ?? '' },
      });
      const queueBody: any = await queue.json();
      check('the admin review queue lists it', queue.status === 200 &&
        (queueBody.data ?? []).some((a: any) => a.userId === riskyId),
        `${queue.status} ${JSON.stringify(queueBody).slice(0, 160)}`);
      check('and the queue explains WHY it is held',
        (queueBody.data ?? []).find((a: any) => a.userId === riskyId)?.matchExplanation?.length > 25);

      // A stranger's account is still refused outright, not queued.
      const stranger = await call(
        'POST',
        '/api/ngn/payout-accounts',
        { userId: riskyId, bankId: '2', accountNumber: '3333333333' },
        riskyToken
      );
      check('a stranger account is rejected, not queued',
        stranger.body?.status === 'rejected', String(stranger.body?.status));
    }

    await app.close();
  } catch (error) {
    await app.close();
    throw error;
  }

  console.log('\nTHE SANDBOX RELAXATION CANNOT REACH PRODUCTION');
  {
    /**
     * Run in a SEPARATE PROCESS, because env.ts parses process.env exactly
     * once at import and caches the result. Re-importing app.js with a cache-
     * busting query string does NOT re-parse it - the first attempt at this
     * test did that, buildApp() saw the already-parsed development snapshot,
     * booted happily, and the assertion failed for a reason that had nothing
     * to do with the guard. A fresh process is the only honest way to test
     * behaviour that depends on import-time configuration.
     */
    const { spawnSync } = await import('node:child_process');
    const attempt = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', 'const m = await import("./src/app.js"); await m.buildApp();'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          APP_ENV: 'production',
          NGN_TRUST_SANDBOX_BANK_RESOLUTION: 'true',
          ADMIN_API_KEY: 'production-guard-key',
        },
      }
    );
    const output = `${attempt.stdout ?? ''}${attempt.stderr ?? ''}`;
    check('production refuses to boot with the sandbox relaxation on',
      attempt.status !== 0, `exit=${attempt.status} ${output.slice(0, 200)}`);
    check('and says why',
      /NGN_TRUST_SANDBOX_BANK_RESOLUTION/.test(output), output.slice(0, 300));

    // The same process WITHOUT the flag must boot, or the assertion above
    // would pass for any startup failure at all - a missing database, a typo,
    // anything. This is what makes it specific to the guard.
    const control = spawnSync(
      process.execPath,
      ['--import', 'tsx', '-e', 'const m = await import("./src/app.js"); const a = await m.buildApp(); await a.close();'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          APP_ENV: 'production',
          NGN_TRUST_SANDBOX_BANK_RESOLUTION: 'false',
          ADMIN_API_KEY: 'production-guard-key',
        },
      }
    );
    check('but production boots fine without it',
      control.status === 0,
      `exit=${control.status} ${`${control.stdout ?? ''}${control.stderr ?? ''}`.slice(-300)}`);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

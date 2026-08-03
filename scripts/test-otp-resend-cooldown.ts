/**
 * THE OTP RESEND COOLDOWN, WHICH EXISTS TO PROTECT THE EMAIL QUOTA.
 *
 * There is already an IP+email rate limiter: 5 starts per 15 minutes. That is
 * a correct abuse control and a useless budget control. Five per window, four
 * windows an hour, twenty-four hours, is 480 emails a day from a SINGLE
 * address - against a Resend free tier of 100 a day.
 *
 * So one person holding down "resend" exhausts the platform's entire email
 * allowance, and the next real user cannot receive a sign-in code at all.
 *
 * The 60-second cooldown the UI showed was CLIENT-SIDE ONLY - React state in
 * `resendAvailableAt`. Any caller not using our frontend ignored it.
 *
 * Run: npm run test:otp-cooldown
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

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

  async function start(email: string, intent: 'signup' | 'signin' = 'signup') {
    const res = await fetch(`${baseUrl}/api/auth/email/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email, intent,
        ...(intent === 'signup' ? {
          fullName: 'Cooldown Person',
          legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' }
        } : {})
      })
    });
    const json = await res.json().catch(() => ({})) as any;
    return { status: res.status, body: json.data ?? json };
  }

  try {
    console.log('\nTHE FIRST CODE ALWAYS SENDS');
    const email = `cooldown-${Date.now()}@sivan.test`;
    {
      const first = await start(email);
      check('a new address gets a code', first.status === 200, String(first.status));
      check('and the code is issued', Boolean(first.body?.devCode), JSON.stringify(first.body).slice(0, 120));
    }

    console.log('\nAN IMMEDIATE RESEND IS REFUSED');
    {
      const second = await start(email);
      check('a second request within the cooldown is rejected',
        second.status === 400, String(second.status));
      const message = String(second.body?.error?.message ?? second.body?.message ?? '');
      check('and it says a code was already sent',
        /just sent|already/i.test(message), message);
      check('and it tells the user how long to wait',
        /\d+\s*second/i.test(message), message);
      check('and it points at the spam folder, which is the real cause',
        /spam/i.test(message), message);
      check('NO second code was issued', !second.body?.devCode,
        JSON.stringify(second.body).slice(0, 120));
    }

    console.log('\nCASE DOES NOT BYPASS IT');
    {
      // Holding shift must not buy another email.
      //
      // TWO guards enforce this: the schema's toLowerCase transform, and the
      // lookup's own comparison. Mutation-tested - removing either alone
      // leaves this green because the other still catches it; removing both
      // fails here. A bypass guard should require two mistakes to reopen.
      const shouted = await start(email.toUpperCase());
      check('the same address in different case is still throttled',
        shouted.status === 400, `${shouted.status} for ${email.toUpperCase()}`);
    }

    console.log('\nA DIFFERENT ADDRESS IS UNAFFECTED');
    {
      const other = await start(`other-${Date.now()}@sivan.test`);
      check('an unrelated address still gets its code',
        other.status === 200 && Boolean(other.body?.devCode), String(other.status));
    }

    console.log('\nTHE COOLDOWN EXPIRES');
    {
      // Rather than sleep 60s, prove the boundary by backdating the stored
      // challenge - the cooldown is computed from createdAt.
      const { db } = await import('../src/database/json-database.js');
      const data: any = await (db as any).read();
      const mine = (data.authChallenges ?? []).filter((c: any) => c.email.toLowerCase() === email.toLowerCase());
      check('the challenge is on record to age', mine.length > 0, String(mine.length));
      for (const c of mine) c.createdAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

      const third = await start(email);
      check('once the cooldown has passed, a resend is allowed',
        third.status === 200, String(third.status));
      check('and a fresh code is issued', Boolean(third.body?.devCode));
    }

    console.log('\nSIGN-IN IS THROTTLED TOO, NOT JUST SIGN-UP');
    {
      // Sign-in is the higher-volume path: no password means an email per
      // session. If only signup were covered the quota would still drain.
      const signinEmail = `signin-${Date.now()}@sivan.test`;
      const created = await start(signinEmail, 'signup');
      const code = created.body?.devCode;
      await fetch(`${baseUrl}/api/auth/email/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: signinEmail, code })
      });

      const { db } = await import('../src/database/json-database.js');
      const data: any = await (db as any).read();
      for (const c of (data.authChallenges ?? [])) {
        if (c.email.toLowerCase() === signinEmail.toLowerCase()) {
          c.createdAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        }
      }

      const firstSignin = await start(signinEmail, 'signin');
      check('a returning user can request a sign-in code',
        firstSignin.status === 200, String(firstSignin.status));
      const secondSignin = await start(signinEmail, 'signin');
      check('but not two in a row', secondSignin.status === 400, String(secondSignin.status));
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

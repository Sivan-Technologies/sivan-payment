/**
 * Country is set from the verification modal, over real HTTP.
 *
 * This exists because the country field is the ONLY thing standing between a
 * user and the wrong verification flow, and three separate things have to be
 * true for it to work - the route must exist, it must reject rubbish before it
 * reaches a Postgres check constraint, and it must be behind auth so one user
 * cannot re-route another. Compiling proves none of those.
 *
 * The auth assertion is the important one. requiresUserAuth() in app.ts works
 * off a list of regexes, and a route that is not on that list is silently
 * public - no error, no warning, it just answers anyone. The only way to know
 * is to call it without a token and look at the status code.
 *
 * Run: npm run test:user-country
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { db } from '../src/database/json-database.js';

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

  async function call(method: string, url: string, body?: unknown, useToken = true) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(useToken && token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: (json as any).data ?? json };
  }

  async function signup(name: string) {
    const email = `${name}-${Date.now()}@sivan.test`;
    const start = await call('POST', '/api/auth/email/start', {
      email,
      fullName: name.replaceAll('-', ' '),
      intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' }
    }, false);
    const verified = await call('POST', '/api/auth/email/verify', { email, code: start.body.devCode }, false);
    return verified.body;
  }

  try {
    const first = await signup('country-one');
    token = first.token;
    const userId = first.user.id;

    console.log('\nA NEW USER HAS NO COUNTRY, AND THAT ROUTES TO BRIDGE');
    {
      check('signup does not set a country', first.user.country === undefined || first.user.country === null,
        JSON.stringify(first.user.country));
      const plan = await call('GET', `/api/users/${userId}/verification-plan`);
      check('plan is served', plan.status === 200, String(plan.status));
      check('no country routes to bridge, not the NUBAN check', plan.body.path === 'bridge_kyc', plan.body.path);
      check('and it is flagged as a fallback, not a choice', plan.body.isFallback === true);
    }

    console.log('\nSETTING NIGERIA SWITCHES THE PATH');
    {
      const saved = await call('PUT', `/api/users/${userId}/country`, { country: 'NG' });
      check('country saves', saved.status === 200, JSON.stringify(saved.body));
      check('and is stored uppercase', saved.body.country === 'NG', saved.body.country);

      const plan = await call('GET', `/api/users/${userId}/verification-plan`);
      check('the plan now routes to the bank check', plan.body.path === 'ngn_bank', plan.body.path);
      check('it is no longer a fallback', plan.body.isFallback === false);
      check('and the Nigerian path costs us nothing', plan.body.costsProviderFee === false);
    }

    console.log('\nCASE AND WHITESPACE CANNOT PRODUCE TWO NIGERIAS');
    {
      // 'ng' and 'NG' stored separately would route identically today and
      // diverge the moment anything does an equality check on the raw value.
      const lower = await call('PUT', `/api/users/${userId}/country`, { country: 'ng' });
      check('lowercase is accepted and normalized', lower.body.country === 'NG', lower.body.country);
      const spaced = await call('PUT', `/api/users/${userId}/country`, { country: '  ng  ' });
      check('whitespace is trimmed', spaced.body.country === 'NG', spaced.body.country);
    }

    console.log('\nCHANGING COUNTRY IS ALLOWED AND RE-ROUTES');
    {
      const us = await call('PUT', `/api/users/${userId}/country`, { country: 'US' });
      check('a user can change their country', us.body.country === 'US', us.body.country);
      const plan = await call('GET', `/api/users/${userId}/verification-plan`);
      check('and the path follows them to Bridge', plan.body.path === 'bridge_kyc', plan.body.path);
      check('this one is not a fallback - it is their answer', plan.body.isFallback === false);

      // Idempotency: reopening the modal and picking the same country again
      // is a normal thing to do and must not error.
      const again = await call('PUT', `/api/users/${userId}/country`, { country: 'US' });
      check('setting the same country twice is not an error', again.status === 200, String(again.status));
    }

    console.log('\nRUBBISH IS REJECTED AS 400, NOT PASSED TO POSTGRES');
    {
      // The users_country_iso2 check constraint would reject these too, but as
      // a 500 the user cannot act on. They have to fail here.
      for (const bad of ['NGA', 'N', '', '12', 'n1', '  ', '!!']) {
        const res = await call('PUT', `/api/users/${userId}/country`, { country: bad });
        check(`"${bad}" is rejected with 400`, res.status === 400, String(res.status));
      }
      const missing = await call('PUT', `/api/users/${userId}/country`, {});
      check('a missing country is rejected', missing.status === 400, String(missing.status));

      const stillUs = await call('GET', `/api/users/${userId}`);
      check('and none of that corrupted the stored value', stillUs.body.country === 'US', stillUs.body.country);
    }

    console.log('\nTHE ROUTE IS BEHIND AUTH');
    {
      const saved = token;
      token = '';
      const anon = await call('PUT', `/api/users/${userId}/country`, { country: 'NG' }, false);
      check('no token is rejected', anon.status === 401, String(anon.status));
      const anonPlan = await call('GET', `/api/users/${userId}/verification-plan`, undefined, false);
      check('the plan is not readable anonymously either', anonPlan.status === 401, String(anonPlan.status));
      token = saved;
    }

    console.log('\nONE USER CANNOT RE-ROUTE ANOTHER');
    {
      const second = await signup('country-two');
      const victimId = userId;
      token = second.token;
      // The attack this blocks: flipping a US user to NG so they are offered a
      // check their account cannot pass, or a Nigerian user to US to force a
      // $2 Bridge charge on Sivan.
      const cross = await call('PUT', `/api/users/${victimId}/country`, { country: 'NG' });
      check('setting another user country is forbidden', cross.status === 403, String(cross.status));
      const crossRead = await call('GET', `/api/users/${victimId}/verification-plan`);
      check('reading another user plan is forbidden', crossRead.status === 403, String(crossRead.status));

      token = first.token;
      const untouched = await call('GET', `/api/users/${victimId}`);
      check('the victim country is unchanged', untouched.body.country === 'US', untouched.body.country);
    }

    console.log('\nTHE NAME IS EDITABLE UNTIL IT BECOMES EVIDENCE');
    {
      const u = await signup('name-lock');
      token = u.token;
      const id = u.user.id;

      const renamed = await call('PUT', `/api/users/${id}/name`, { fullName: 'Samuel Udochukwu' });
      check('an unverified user can fix their name', renamed.status === 200, JSON.stringify(renamed.body));
      check('and it is stored', renamed.body.fullName === 'Samuel Udochukwu', renamed.body.fullName);

      check('whitespace is trimmed',
        (await call('PUT', `/api/users/${id}/name`, { fullName: '  Ada Lovelace  ' })).body.fullName === 'Ada Lovelace');

      for (const bad of ['', ' ', 'A']) {
        const res = await call('PUT', `/api/users/${id}/name`, { fullName: bad });
        check(`"${bad}" is rejected`, res.status === 400, String(res.status));
      }
    }

    console.log('\nA PENDING REVIEW FREEZES THE NAME MID-DECISION');
    {
      const u = await signup('name-pending');
      token = u.token;
      const id = u.user.id;
      // Must match the mock bank's holder for 1111111111 ("OGUNMEPON SHARAFA"),
      // or the verdict is a mismatch and the account is rejected rather than
      // queued - and there would be no pending review to test against.
      await call('PUT', `/api/users/${id}/name`, { fullName: 'Sharafa Ogunmepon' });
      await call('PUT', `/api/users/${id}/country`, { country: 'NG' });

      // Mock resolutions are never trustworthy, so a perfect match queues.
      const saved = await call('POST', '/api/ngn/payout-accounts', {
        userId: id, bankId: '2', accountNumber: '1111111111'
      });
      check('the account is queued for review', saved.body.status === 'pending_review', saved.body.status);

      // Editing now would change the comparison under the reviewer's feet -
      // they would approve a pairing that no longer exists.
      const blocked = await call('PUT', `/api/users/${id}/name`, { fullName: 'Someone Else' });
      check('the name cannot be changed while a review is pending',
        blocked.status === 400, String(blocked.status));
      check('and the message says why', /reviewed/i.test(blocked.body?.error?.message ?? ''),
        JSON.stringify(blocked.body));
    }

    console.log('\nONCE VERIFIED THE NAME IS LOCKED, SERVER SIDE');
    {
      const u = await signup('name-locked');
      token = u.token;
      const id = u.user.id;
      await call('PUT', `/api/users/${id}/name`, { fullName: 'Sharafa Ogunmepon' });
      await call('PUT', `/api/users/${id}/country`, { country: 'NG' });
      await call('POST', '/api/ngn/payout-accounts', { userId: id, bankId: '2', accountNumber: '1111111111' });

      // Promote to verified, as a reviewer approving would.
      for (const account of await db.listNgnPayoutAccounts(id)) {
        await db.upsertNgnPayoutAccountRecord({ ...account, resolutionTrustworthy: true, status: 'verified' });
      }

      // THE ATTACK THIS CLOSES: submit a stranger's account, get rejected on
      // the name, then edit the name to match and resubmit. Without this the
      // matcher is decorative - anyone passes it by copying what it showed.
      const attempt = await call('PUT', `/api/users/${id}/name`, { fullName: 'Stranger Name' });
      check('a verified user cannot change their name', attempt.status === 400, String(attempt.status));
      check('the reason names the bank match',
        /bank account|verified/i.test(attempt.body?.error?.message ?? ''), JSON.stringify(attempt.body));

      const after = await call('GET', `/api/users/${id}`);
      check('and the stored name is untouched',
        after.body.fullName === 'Sharafa Ogunmepon', after.body.fullName);

      // The lock must not leak into unrelated fields.
      const country = await call('PUT', `/api/users/${id}/country`, { country: 'GB' });
      check('country is still editable after verification', country.status === 200, String(country.status));
    }

    console.log('\nTHE NAME ROUTE IS PRIVATE');
    {
      const victim = await signup('name-victim');
      const attacker = await signup('name-attacker');
      token = attacker.token;
      const cross = await call('PUT', `/api/users/${victim.user.id}/name`, { fullName: 'Hijacked' });
      check('one user cannot rename another', cross.status === 403, String(cross.status));

      token = '';
      const anon = await call('PUT', `/api/users/${victim.user.id}/name`, { fullName: 'Hijacked' });
      check('anonymous rename is rejected', anon.status === 401, String(anon.status));

      token = victim.token;
      const unchanged = await call('GET', `/api/users/${victim.user.id}`);
      check('the victim name is unchanged',
        unchanged.body.fullName === 'name victim', unchanged.body.fullName);
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

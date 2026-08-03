/**
 * THE NORMAL CASE MUST NOT LOOK LIKE A FAILURE.
 *
 * Two errors were appearing in the browser console for users doing nothing
 * wrong:
 *
 *   GET /api/ngn/networks?asset=usdc              401 (Unauthorized)
 *   GET /api/customers/usr_.../kyc-status         404 (Not Found)  x2
 *
 * Neither was harmless-but-cosmetic:
 *
 *   The 401 was an authenticated endpoint being called from the bootstrap
 *   effect on the LANDING page, before anybody could possibly have a token.
 *   Guaranteed to fail, result thrown away, one wasted round trip per load.
 *
 *   The 404 is the state of every Nigerian user in the product - they verify
 *   by bank check and never get a Bridge customer - reported as an error. The
 *   frontend compensated by regex-matching the error PROSE. The sibling route
 *   GET /api/customers/:userId had already decided this is an absence and
 *   returns null; this one disagreed, and the inconsistency was the bug.
 *
 * A console that cries wolf on the first screen is how a real error gets
 * ignored, so this is a correctness test, not a tidiness one.
 *
 * Run: npm run test:console-clean
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

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
  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    // `json.data ?? json` is WRONG when data is legitimately null - it falls
    // back to the whole envelope and a null answer reads as an object. That is
    // precisely the value under test here, so unwrap on key presence instead.
    const unwrapped = Object.prototype.hasOwnProperty.call(json ?? {}, 'data') ? json.data : json;
    return { status: res.status, body: unwrapped, raw: json };
  }

  try {
    const email = `console-${Date.now()}@sivan.test`;
    const start = await call('POST', '/api/auth/email/start', {
      email,
      fullName: 'Samuel Udochukwu',
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

    console.log('\nA NIGERIAN WITH NO BRIDGE CUSTOMER IS AN ABSENCE, NOT A 404');
    {
      const status = await call('GET', `/api/customers/${userId}/kyc-status`);
      check(
        'kyc-status answers 200 for a user with no Bridge customer',
        status.status === 200,
        `${status.status} ${JSON.stringify(status.body).slice(0, 120)}`
      );
      check('and the body states the absence as null', status.body === null, JSON.stringify(status.body));

      // The sibling route is what this was made consistent WITH. If that ever
      // regresses to a 404 the two are out of step again and the frontend has
      // to grow the prose-matching hack back.
      const sibling = await call('GET', `/api/customers/${userId}`);
      check(
        'and it agrees with GET /api/customers/:userId',
        sibling.status === status.status,
        `${sibling.status} vs ${status.status}`
      );
    }

    console.log('\nBUT A REAL FAILURE IS STILL A REAL FAILURE');
    {
      /**
       * ONLY not_found becomes null. Everything else must still surface.
       *
       * Mutation-proven necessary: replacing the guard with a bare
       * `return { data: null }` - swallowing EVERY error as an absence - is a
       * genuinely dangerous change. It would turn a Bridge outage into "you
       * have no verification record" for users who ARE verified, and the UI
       * would then offer them the start-verification flow again.
       *
       * ASSERTED AGAINST THE SOURCE, not by provoking it.
       *
       * The runtime attempt is not possible here and pretending otherwise
       * would be worse than not testing it: this suite runs with
       * BRIDGE_MOCK_MODE=true, so the mock provider resolves ANY kycLinkId
       * happily and no non-not_found error can be produced. A first draft
       * seeded a customer with an unresolvable link, asserted the call did not
       * return null, and passed - against the mutation as well as the fix. A
       * test that cannot fail is worse than no test, because it is read as
       * coverage.
       *
       * So the narrowing is checked where it is real: in the code.
       */
      const routeSource = await fs.readFile(
        path.join(process.cwd(), 'src/customers/customers.routes.ts'),
        'utf8'
      );
      const kycStatusHandler = routeSource.slice(
        routeSource.indexOf("app.get('/api/customers/:userId/kyc-status'")
      );
      check(
        'the kyc-status catch is narrowed to not_found, so a provider outage still errors',
        /error instanceof AppError && error\.code === 'not_found'/.test(
          kycStatusHandler.slice(0, 600)
        ) && /throw error;/.test(kycStatusHandler.slice(0, 600)),
        kycStatusHandler.slice(0, 400)
      );

      const other = await call('GET', '/api/customers/usr_someone_else/kyc-status');
      check(
        'reading another user kyc-status is refused, not nulled',
        other.status === 403 || other.status === 401,
        `${other.status} ${JSON.stringify(other.body).slice(0, 120)}`
      );
    }

    console.log('\n/api/ngn/networks IS AUTHENTICATED, WHICH IS WHY IT MUST NOT BE CALLED LOGGED-OUT');
    {
      const saved = token;
      token = '';
      const anonymous = await call('GET', '/api/ngn/networks?asset=usdc');
      token = saved;
      check(
        'it really does 401 without a token',
        anonymous.status === 401,
        `${anonymous.status}`
      );

      const authed = await call('GET', '/api/ngn/networks?asset=usdc');
      check(
        'and answers 200 with one',
        authed.status === 200,
        `${authed.status} ${JSON.stringify(authed.body).slice(0, 120)}`
      );
      check(
        'with both directions, because Base can off-ramp but not on-ramp',
        Array.isArray(authed.body?.offramp) && Array.isArray(authed.body?.onramp),
        JSON.stringify(Object.keys(authed.body ?? {}))
      );
    }

    console.log('\nTHE FRONTEND DOES NOT CALL IT BEFORE IT HAS A TOKEN');
    {
      // Asserted against the SOURCE, because the bug was structural - the call
      // sat in the unconditional bootstrap effect next to genuinely public
      // ones. A runtime test of the API cannot see that; only the wiring can.
      const source = await fs.readFile(
        path.join(process.cwd(), 'frontend/src/App.tsx'),
        'utf8'
      );
      const gated = /if \(!authToken\) return;\s*\n\s*void loadNgnNetworks\(\);/.test(source);
      check('loadNgnNetworks is gated on authToken', gated);

      const bootstrap = /void loadFee\(\);\s*\n\s*void loadControls\(\);\s*\n\s*void loadUserData\(\);/.test(
        source
      );
      check(
        'and it is no longer in the unauthenticated bootstrap effect',
        bootstrap,
        'loadNgnNetworks still sits beside loadFee/loadControls'
      );
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

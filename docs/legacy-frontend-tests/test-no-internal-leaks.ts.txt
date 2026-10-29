/**
 * NO USER-FACING MESSAGE MAY NAME OUR PLUMBING.
 *
 * The report that caused this, verbatim from a phone on production:
 *
 *   "Bank verification is unavailable right now (provider: breet).
 *    Breet: failed to validate bank account."
 *
 * Three failures in one red box, and only the third is cosmetic:
 *
 *   1. It named the provider. That is a commercial relationship, an attack
 *      surface, and none of the user's business.
 *   2. It claimed an outage. The upstream was up - it had answered, and its
 *      answer was that the account did not check out. Blaming an outage tells
 *      the user to wait, when the fix is to re-read their digits.
 *   3. It gave them nothing to do.
 *
 * This suite drives the real API and asserts on what a user would actually
 * see, across signup, sign-in, OTP, verification, banks, quotes, withdrawals
 * and support - the whole surface, not just the one screen that was reported.
 *
 * Run: npm run test:no-internal-leaks
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { leaksInternals, bankResolutionMessage, safeUserMessage, PROVIDER_NAMES } from '../src/shared/user-message.js';

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

/** Every message a response can carry, flattened. */
function messagesIn(body: any): string[] {
  const out: string[] = [];
  const walk = (node: any, depth = 0) => {
    if (depth > 6 || node == null) return;
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach((item) => walk(item, depth + 1));
    if (typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        // Only strings a HUMAN reads. Ids, provider fields and status enums are
        // data, not prose - `provider: "breet"` in an admin payload is correct
        // and must not be flagged.
        if (/message|error|reason|detail|title|explanation|hint/i.test(key)) walk(value, depth + 1);
        else if (typeof value === 'object') walk(value, depth + 1);
      }
    }
  };
  walk(body);
  return out;
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
  const seen: Array<{ route: string; message: string }> = [];

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
    for (const message of messagesIn(json)) seen.push({ route: `${method} ${url}`, message });
    const has = Object.prototype.hasOwnProperty.call(json ?? {}, 'data');
    return { status: res.status, body: has ? json.data : json, raw: json };
  }

  try {
    console.log('\nTHE UNIT UNDER THE FIX');
    {
      /**
       * The distinction the old message got wrong: whose fault is it?
       *
       * An upstream that DECLINES an account has done its job, and the user
       * can act. An upstream that is unreachable or unauthenticated cannot be
       * fixed by retyping, so telling them to check their digits sends them
       * round a loop with no exit.
       */
      const declined = bankResolutionMessage(new Error('Breet: failed to validate bank account.'));
      check('a declined account tells the user to check the number and bank',
        /check the account number/i.test(declined), declined);
      check('and does NOT name the provider', !leaksInternals(declined), declined);
      check('and does not falsely claim an outage',
        !/unavailable|try again later|down/i.test(declined), declined);

      const ourFault = bankResolutionMessage(new Error('Breet: wrong app id and secret combination'));
      check('a credentials failure says it is on our side',
        /on our side/i.test(ourFault), ourFault);
      check('and still does not name the provider', !leaksInternals(ourFault), ourFault);
      check('and does NOT blame the user\'s digits',
        !/check the account number/i.test(ourFault), ourFault);

      const timeout = bankResolutionMessage(new Error('fetch failed ETIMEDOUT'));
      check('a timeout is also ours, not theirs', /on our side/i.test(timeout), timeout);

      // The exact production string must be caught by the detector.
      check('the detector catches the real production message',
        leaksInternals('Bank verification is unavailable right now (provider: breet). Breet: failed to validate bank account.') !== undefined);
      check('and it is specific about what it caught',
        leaksInternals('Breet: failed') === 'breet');
      check('an ordinary message is left alone',
        leaksInternals('We could not confirm that account. Check the account number.') === undefined);

      /**
       * EVERY name in the list is checked individually.
       *
       * A single spot-check is not enough: emptying PROVIDER_NAMES entirely
       * left the suite green except for one assertion, because everything else
       * happened to be caught by the LEAKY_FRAGMENTS half ("provider:"). Each
       * provider is its own liability - naming Bridge or Privy is exactly as
       * bad as naming Breet - so each is asserted.
       */
      /**
       * The list must be NON-EMPTY as well as correct.
       *
       * `[].filter(...).length === 0` is true, so iterating the exported list
       * passes vacuously when the list is empty - mutation-proven: emptying
       * PROVIDER_NAMES left this green. The names that matter are asserted
       * literally, so deleting them from the source cannot delete the test.
       */
      const MUST_BE_CAUGHT = ['breet', 'bridge', 'privy', 'pajramp', 'resend', 'alchemy'];
      const missed = MUST_BE_CAUGHT.filter(
        (name) => leaksInternals(`Upstream said: ${name} rejected the request`) === undefined
      );
      check(`the providers we actually use are all detected (${MUST_BE_CAUGHT.length} checked)`,
        missed.length === 0, `missed: ${missed.join(', ')}`);
      check('and the exported list is not empty',
        PROVIDER_NAMES.length >= MUST_BE_CAUGHT.length, String(PROVIDER_NAMES.length));

      // And a word that merely CONTAINS a provider name must not trip it -
      // otherwise the guard would rewrite innocent copy and nobody would keep
      // it switched on.
      check('a word containing a provider name is not a false positive',
        leaksInternals('Use the bridged transfer option') === undefined,
        'the matcher is not word-bounded');

      // The net.
      check('safeUserMessage rewrites a leaking 400',
        !leaksInternals(safeUserMessage('Breet: nope', 400)));
      check('safeUserMessage rewrites a leaking 503',
        !leaksInternals(safeUserMessage('provider: breet unreachable', 503)));
      check('and leaves a clean message untouched',
        safeUserMessage('Check the account number and try again.', 400) === 'Check the account number and try again.');

      /**
       * AND THE NET IS WIRED INTO THE ACTUAL ERROR HANDLER.
       *
       * Asserting on safeUserMessage() alone proves the function works, not
       * that anything calls it - mutation-testing showed exactly that gap:
       * ripping the call out of app.ts left every assertion green, because no
       * route was leaking at source any more. The net is a SECOND line of
       * defence, so it has to be provable on its own.
       *
       * A throwaway Fastify instance with the same error handler, and one
       * route that throws a deliberately leaky AppError.
       */
      const { default: Fastify } = await import('fastify');
      const probe = Fastify();
      probe.setErrorHandler((error: any, _request: any, reply: any) => {
        const statusCode = error.statusCode ?? 500;
        return reply.code(statusCode).send({
          error: { code: error.code ?? 'app_error', message: safeUserMessage(error.message, statusCode) },
        });
      });
      probe.get('/leaky', async () => {
        const { badRequest } = await import('../src/shared/errors.js');
        throw badRequest('Bank verification is unavailable right now (provider: breet). Breet: failed to validate bank account.');
      });
      const leaked = await probe.inject({ method: 'GET', url: '/leaky' });
      const leakedMessage = JSON.parse(leaked.payload)?.error?.message ?? '';
      await probe.close();

      check('a leaky error thrown from a route is rewritten before it is sent',
        !leaksInternals(leakedMessage), leakedMessage);
      check('and the CODE is preserved, because clients switch on it',
        JSON.parse(leaked.payload)?.error?.code === 'bad_request',
        JSON.parse(leaked.payload)?.error?.code);

      // The handler in app.ts must actually call it, not just import it.
      const appSource = await fs.readFile(path.join(process.cwd(), 'src/app.ts'), 'utf8');
      check('app.ts routes AppError messages through safeUserMessage',
        /safeUserMessage\(error\.message, error\.statusCode\)/.test(appSource));
      check('and non-AppError messages too',
        /safeUserMessage\(err\.message, statusCode\)/.test(appSource));
    }

    console.log('\nTHE REAL BREET BRANCH, EXERCISED DIRECTLY');
    {
      /**
       * THE SWEEP ALONE PROVED NOTHING, AND THAT IS WORTH RECORDING.
       *
       * This suite runs NGN_PROVIDER=mock, so /api/ngn/bank-account/resolve
       * never enters the Breet branch - the one that produced the message on
       * the user's phone. Mutation-testing exposed it: I restored the exact
       * production string AND disabled the error-handler net, and all 37
       * assertions still passed. The sweep was decorative for the one code
       * path it existed to protect.
       *
       * So the branch is called directly, with NGN_PROVIDER forced to breet
       * and no credentials, which is precisely the shape of the production
       * failure: the upstream rejects us and throws.
       */
      /**
       * A SEPARATE PROCESS, because env.ts parses process.env ONCE at import.
       * Re-importing the service with a cache-busting query does not re-read
       * it - the first attempt did exactly that, stayed on the mock provider,
       * and reported "That bank was not recognised" while claiming to have
       * tested the Breet branch. A test that passes for the wrong reason is
       * worse than none.
       */
      const { spawnSync } = await import('node:child_process');
      const probe = spawnSync(
        process.execPath,
        ['--import', 'tsx', '-e',
         'const m = await import("./src/ngn/service/ngn-banks.service.js");' +
         'try { const r = await m.resolveNgnBankAccount("25","7061547698","ngn"); console.log("RESOLVED " + JSON.stringify(r)); }' +
         'catch (e) { console.log("THREW " + String(e && e.message ? e.message : e)); }'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            NGN_PROVIDER: 'breet',
            BREET_ENV: 'production',
            BREET_APP_ID: 'deliberately-wrong',
            BREET_APP_SECRET: 'deliberately-wrong',
          },
        }
      );
      const stdout = String(probe.stdout ?? '');
      const stderr = String(probe.stderr ?? '');
      const thrown = (stdout.match(/^THREW (.*)$/m)?.[1] ?? '').trim();

      check('the Breet branch was actually reached', Boolean(thrown), stdout.slice(0, 200));
      check('it does NOT say "That bank was not recognised" (that is the mock)',
        !/not recognised/i.test(thrown), thrown);
      check('the user-facing message names no provider', !leaksInternals(thrown), thrown);
      check('and contains no "provider:" prefix', !/provider:/i.test(thrown), thrown);
      check('it tells the user this is on our side, since a bad key is not their fault',
        /on our side/i.test(thrown), thrown);

      /**
       * AND THE RAW REASON IS STILL LOGGED. Sanitising the user's copy must not
       * blind the engineer - a message that leaks nothing AND records nothing
       * would make this class of outage undebuggable.
       */
      check('the raw upstream reason is written to the log',
        /wrong app id and secret/i.test(stderr), stderr.slice(0, 200));

      console.log(`       user sees: ${thrown}`);
      console.log(`       log has  : ${(stderr.match(/reason: '([^']+)'/)?.[1] ?? '').slice(0, 90)}`);
    }

    console.log('\nSIGN UP AND SIGN IN');
    const email = `leak-${Date.now()}@sivan.test`;
    {
      const badEmail = await call('POST', '/api/auth/email/start', { email: 'not-an-email', intent: 'signup' });
      check('a malformed email is refused', badEmail.status >= 400, String(badEmail.status));

      const noTerms = await call('POST', '/api/auth/email/start', {
        email, fullName: 'Samuel Udochukwu', intent: 'signup',
      });
      check('signup without accepting terms is refused', noTerms.status >= 400, String(noTerms.status));
      check('and says what is missing',
        /terms|accept|legal/i.test(JSON.stringify(noTerms.raw)),
        JSON.stringify(noTerms.raw).slice(0, 160));

      const start = await call('POST', '/api/auth/email/start', {
        email, fullName: 'Samuel Udochukwu', intent: 'signup',
        legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
      });
      check('a good signup starts', start.status === 200, String(start.status));

      const wrongCode = await call('POST', '/api/auth/email/verify', { email, code: '000000' });
      check('a wrong OTP is refused', wrongCode.status >= 400, String(wrongCode.status));
      check('and the message is about the code, not internals',
        /code|invalid|expired|incorrect/i.test(wrongCode.raw?.error?.message ?? ''),
        wrongCode.raw?.error?.message);

      const verified = await call('POST', '/api/auth/email/verify', { email, code: start.body.devCode });
      check('the right OTP signs in', verified.status === 200, String(verified.status));
      token = verified.body.token;

      const signinUnknown = await call('POST', '/api/auth/email/start', {
        email: `nobody-${Date.now()}@sivan.test`, intent: 'signin',
      });
      check('signing in with an unknown address is handled',
        signinUnknown.status < 500, String(signinUnknown.status));
    }

    const userId = (await call('GET', '/api/auth/me')).body?.user?.id;
    check('the session resolves to a user', Boolean(userId), String(userId));
    await call('PUT', `/api/users/${userId}/country`, { country: 'NG' });

    console.log('\nTHE BANK CHECK — THE SCREEN THAT WAS REPORTED');
    {
      const shortNumber = await call('GET', '/api/ngn/bank-account/resolve?bankId=25&accountNumber=706');
      check('a too-short account number is refused', shortNumber.status >= 400, String(shortNumber.status));
      check('and it says exactly what is wrong',
        /10 digits/i.test(shortNumber.raw?.error?.message ?? ''),
        shortNumber.raw?.error?.message);

      const unknownBank = await call('GET', '/api/ngn/bank-account/resolve?bankId=999999&accountNumber=7061547698');
      check('an unknown bank does not 500',
        unknownBank.status >= 400 && unknownBank.status < 500, String(unknownBank.status));
      check('and the message names nothing internal',
        !leaksInternals(unknownBank.raw?.error?.message ?? ''),
        unknownBank.raw?.error?.message);

      const badAccount = await call('GET', '/api/ngn/bank-account/resolve?bankId=1&accountNumber=7061547698');
      check('an unresolvable account is a 4xx, not a 500',
        badAccount.status >= 400 && badAccount.status < 500, String(badAccount.status));
      check('the message tells the user what to change',
        /account number|right bank|check/i.test(badAccount.raw?.error?.message ?? ''),
        badAccount.raw?.error?.message);
      check('and it does not name a provider',
        !leaksInternals(badAccount.raw?.error?.message ?? ''),
        badAccount.raw?.error?.message);

      const savedBad = await call('POST', '/api/ngn/payout-accounts', {
        userId, bankId: '1', accountNumber: '7061547698',
      });
      check('saving an unresolvable payout account is refused cleanly',
        savedBad.status >= 400 && savedBad.status < 500, String(savedBad.status));
      check('with no provider name in the message',
        !leaksInternals(savedBad.raw?.error?.message ?? ''),
        savedBad.raw?.error?.message);
    }

    console.log('\nQUOTES, WITHDRAWALS AND THE REST OF THE SURFACE');
    {
      /**
       * The rails default to OFF, so a quote here fails for that reason rather
       * than for verification. A first draft asserted the message mentioned
       * verification and failed against "NGN off-ramp is currently disabled."
       * - a correct message that my fixture had not set up for. Enable the
       * rail first, so the refusal under test is the one intended.
       */
      await fetch(`${base}/api/admin/ngn/controls`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-api-key': process.env.ADMIN_API_KEY ?? '' },
        body: JSON.stringify({ onrampEnabled: true, offrampEnabled: true, activeProvider: 'mock', updatedBy: 'leak-test' }),
      });

      const unverifiedQuote = await call(
        'GET',
        `/api/ngn/quote?userId=${userId}&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=50&network=solana`
      );
      check('an unverified user cannot quote', unverifiedQuote.status >= 400, String(unverifiedQuote.status));
      check('and is told about verification, not about a provider',
        /verif|bank|limit/i.test(unverifiedQuote.raw?.error?.message ?? '')
          && !leaksInternals(unverifiedQuote.raw?.error?.message ?? ''),
        unverifiedQuote.raw?.error?.message);

      const badOrder = await call('POST', '/api/ngn/offramp/orders', { userId, quoteId: 'ngnq_nope' });
      check('an unknown quote id is refused cleanly',
        badOrder.status >= 400 && badOrder.status < 500, String(badOrder.status));

      const badWithdrawal = await call('POST', '/api/withdrawals', { userId, amount: '-5' });
      check('a negative withdrawal is refused', badWithdrawal.status >= 400, String(badWithdrawal.status));

      await call('GET', `/api/users/${userId}/verification-summary`);
      await call('GET', '/api/ngn/banks');
      await call('GET', '/api/ngn/networks?asset=usdc');
      await call('GET', `/api/users/${userId}/wallets`);
      await call('GET', `/api/users/${userId}/withdrawals`);
      await call('GET', `/api/users/${userId}/ngn-transfers`);
      await call('GET', `/api/users/${userId}/support/tickets`);
      await call('GET', '/api/offramp/controls');
      await call('GET', '/api/fees/offramp');
      await call('GET', '/api/system/status');
      await call('GET', `/api/customers/${userId}/kyc-status`);
    }

    console.log('\nAND THE FRONTEND HAS ITS OWN GUARD');
    {
      /**
       * THREE LAYERS, DELIBERATELY.
       *
       * 1. the call site produces a good message
       * 2. the API error handler sweeps whatever it missed
       * 3. the frontend sanitises before it paints a toast
       *
       * Layer 3 is not redundant: `notify((error as Error).message, 'error')`
       * appears in twenty-three places in App.tsx, and any of them can surface
       * a string from an OLDER API still running, from the Cloudflare gateway,
       * or generated by the browser itself. A leak here is seen by a customer,
       * and one extra check costs nothing.
       */
      const utils = await fs.readFile(path.join(process.cwd(), 'frontend/src/appUtils.tsx'), 'utf8');
      check('the frontend exports a sanitiser', /export function userFacingMessage/.test(utils));
      check('and it knows the provider names', /'breet'/.test(utils) && /'bridge'/.test(utils));

      const appTsx = await fs.readFile(path.join(process.cwd(), 'frontend/src/App.tsx'), 'utf8');
      check('every toast goes through it',
        /setToast\(\{ message: userFacingMessage\(message\), type \}\)/.test(appTsx),
        'notify() paints the raw message');

      // The funnel must be the ONLY way a toast is set, or sanitising it
      // proves nothing about the calls that bypass it.
      const rawToastCalls = (appTsx.match(/setToast\(\{\s*message:/g) ?? []).length;
      const sanitised = (appTsx.match(/setToast\(\{ message: userFacingMessage/g) ?? []).length;
      check('and no toast bypasses the funnel',
        rawToastCalls === sanitised, `${rawToastCalls} setToast calls, ${sanitised} sanitised`);
    }

    console.log('\nTHE SWEEP — EVERY MESSAGE THIS RUN PRODUCED');
    {
      const leaks = seen
        .map((entry) => ({ ...entry, term: leaksInternals(entry.message) }))
        .filter((entry) => entry.term);

      check(
        `no user-facing message named a provider or an internal (${seen.length} strings checked)`,
        leaks.length === 0,
        leaks.slice(0, 5).map((l) => `[${l.term}] ${l.route}: ${l.message.slice(0, 90)}`).join(' | ')
      );
      if (leaks.length) {
        for (const leak of leaks.slice(0, 10)) {
          console.log(`       [${leak.term}] ${leak.route}\n         ${leak.message.slice(0, 160)}`);
        }
      }

      // A message that is present but useless is its own defect. Anything
      // shown to a user should be a sentence, not a token.
      const stubs = seen.filter(
        (entry) => /^(error|failed|invalid|bad request)$/i.test(entry.message.trim())
      );
      check('no bare one-word errors', stubs.length === 0,
        stubs.slice(0, 3).map((s) => `${s.route}: ${s.message}`).join(' | '));
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

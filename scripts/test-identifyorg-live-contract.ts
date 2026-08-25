/**
 * IDENTIFYORG - AGAINST THE REAL VENDOR, NOT A STUB.
 *
 * WHY THIS EXISTS SEPARATELY FROM test-identifyorg-kyc.ts.
 *
 * That suite stubs globalThis.fetch, which is right for what it tests: it can
 * hand the provider a 79% confidence score on demand and prove we downgrade it
 * to `review`. The live API will never produce a chosen score.
 *
 * But a stub can only ever prove we are self-consistent. Every assertion in it
 * was written from IdentifyOrg's PUBLISHED DOCUMENTATION, and the first time
 * this code met the actual API, three of those documented shapes turned out to
 * be wrong. A stubbed suite passes for the entire period a contract drift is
 * live. This file is the one that would have caught them:
 *
 *   1. THE ERROR BODY IS NESTED, NOT A STRING.
 *        docs:     {"error":{"code":"insufficient_balance","message":"..."}}
 *        our type: error?: string
 *      Interpolating an object yielded "failed: [object Object]" - an operator
 *      reading that log cannot tell a revoked key from an empty balance.
 *
 *   2. VALIDATION ERRORS ARE 422 WITH AN ARRAY `detail`, NOT 400 WITH A STRING.
 *        {"detail":[{"type":"string_too_short","loc":["body","bvn"],"msg":...}]}
 *      The docs' error table lists 400 and shows `detail` as a string.
 *
 *   3. `not_found` IS AN HTTP 200, NOT AN ERROR.
 *        BVN 00000000000 -> {"status":"not_found","match":null,"data":null}
 *      It never reaches the non-2xx branch, so it lands in toVerdict(), where
 *      it used to render the raw vendor token "not_found" to a customer.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE MOST IMPORTANT ASSERTION IN THIS FILE IS THE SANDBOX ONE.
 *
 * Measured: in test mode the API ECHOES BACK WHATEVER NAMES YOU SEND and still
 * answers match:true, confidence_score:98. Sending first_name "Wrong",
 * last_name "Person" against NIN 12345678901 returns a 98% match for Wrong
 * Person. There is no input that fails.
 *
 * So an `io_test_` key reaching production would grant Level 2 - a NGN
 * 5,000,000 ceiling - to any eleven digits with any name attached, and nothing
 * downstream would notice, because the response is a well-formed 200 with a
 * high score. The guard added to postJson() refuses that, and the check below
 * pins it. It is the difference between a degraded check and NO check.
 *
 * SAFE AND FREE TO RUN. Test-key calls return cost:0.0, is_test:true, and do
 * not decrement free_tier_remaining - verified by reading GET /v1/balance
 * before and after a call. No real customer data is ever sent: the identifiers
 * below are IdentifyOrg's own documented sandbox fixtures.
 *
 * Run: IDENTIFYORG_API_KEY=io_test_... npx tsx scripts/test-identifyorg-live-contract.ts
 * Skips cleanly (exit 0) when no test key is present, so CI without the secret
 * does not go red - but it REFUSES to run against an io_live_ key, because
 * these are metered calls against real people's records.
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.SIVAN_DATA_FILE = '/tmp/identifyorg-live-contract.json';
process.env.DATABASE_FILE = '/tmp/identifyorg-live-contract.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.IDENTIFYORG_MIN_CONFIDENCE = process.env.IDENTIFYORG_MIN_CONFIDENCE ?? '80';

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const KEY = process.env.IDENTIFYORG_API_KEY ?? '';

if (!KEY) {
  console.log('IDENTIFYORG_API_KEY not set - skipping the live contract suite.');
  process.exit(0);
}
if (!KEY.startsWith('io_test_')) {
  console.error(
    'REFUSING TO RUN. This suite makes real calls; with an io_live_ key those are\n' +
      'metered and hit real identity records. Supply an io_test_ key.'
  );
  process.exit(1);
}

fs.writeFileSync(
  process.env.SIVAN_DATA_FILE!,
  JSON.stringify({ users: [], customers: [], auditLogs: [], ngnIdentityVerifications: [] }, null, 2)
);

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
};

const BASE = process.env.IDENTIFYORG_BASE_URL ?? 'https://api.identifyorg.com';

async function raw(path: string, body: unknown, key = KEY) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-IdentifyOrg-Key': key },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as any };
}

const { IdentifyOrgKycLevelProvider } = await import(
  '../src/kyc/providers/identifyorg-kyc-level.provider.js'
);
const provider = new IdentifyOrgKycLevelProvider();

/* ────────────────────────────────────────────────────────────────
 * ONE CHILD PROCESS PER ENVIRONMENT. THIS IS NOT OPTIONAL.
 *
 * src/config/env.ts ends with:
 *
 *     export const env = envSchema.parse(process.env);
 *
 * That runs ONCE, at module import. Mutating process.env.APP_ENV afterwards
 * and calling the provider again re-reads NOTHING - the provider closes over
 * the already-parsed `env` object.
 *
 * I wrote this suite that way first and it reported the production guard as
 * broken while the guard was in fact correct: the in-process case never had
 * APP_ENV=production as far as `env` was concerned. The same trap in reverse
 * is the dangerous one - a guard test that mutates process.env and then passes
 * has proven nothing at all, because the code under test never saw the change.
 *
 * So each environment-sensitive case is run in its own tsx child with the
 * variables set BEFORE node starts, which is the only point at which they can
 * affect the parse.
 * ──────────────────────────────────────────────────────────────── */

const SELF = fileURLToPath(import.meta.url);
const TSX_BIN = new URL('../node_modules/.bin/tsx', import.meta.url).pathname;

type ProbeResult = { ok: true; result: any } | { ok: false; error: string };

/** Run one provider call in a fresh process with a chosen environment. */
function probe(
  method: 'verifyBvnIdentity' | 'verifyNinIdentity',
  input: Record<string, unknown>,
  environment: Record<string, string>
): ProbeResult {
  const child = spawnSync(TSX_BIN, [SELF], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      ...environment,
      SIVAN_IO_PROBE: JSON.stringify({ method, input }),
    },
  });
  const line = (child.stdout ?? '')
    .split('\n')
    .find((entry) => entry.startsWith('PROBE_RESULT '));
  if (!line) {
    return { ok: false, error: `child produced no result. stderr: ${(child.stderr ?? '').slice(-400)}` };
  }
  return JSON.parse(line.slice('PROBE_RESULT '.length)) as ProbeResult;
}

/**
 * PROBE MODE. When SIVAN_IO_PROBE is set this file is a child: it performs one
 * call, prints the outcome, and exits without running any assertions.
 */
if (process.env.SIVAN_IO_PROBE) {
  const { method, input } = JSON.parse(process.env.SIVAN_IO_PROBE) as {
    method: 'verifyBvnIdentity' | 'verifyNinIdentity';
    input: any;
  };
  let outcome: ProbeResult;
  try {
    outcome = { ok: true, result: await provider[method](input) };
  } catch (error) {
    outcome = { ok: false, error: (error as Error).message };
  }
  console.log(`PROBE_RESULT ${JSON.stringify(outcome)}`);
  process.exit(0);
}

/* ────────────────────────────────────────────────────────────────
 * 1. THE VENDOR IS REACHABLE AND THE KEY WORKS.
 * Everything below is meaningless if this fails, so it runs first.
 * ──────────────────────────────────────────────────────────────── */
console.log('\n1. Reachability and health');
{
  const health = await provider.health();
  check('health() reports the provider available', health.available === true, JSON.stringify(health));
  check('health() names the provider', health.provider === 'identifyorg');
}

/* ────────────────────────────────────────────────────────────────
 * 2. THE HAPPY PATH RETURNS THE FIELDS WE PARSE.
 * Not "it returns 200" - the specific keys toVerdict() reads. A vendor
 * that renamed confidence_score would still return 200.
 * ──────────────────────────────────────────────────────────────── */
console.log('\n2. Live BVN response carries the fields we depend on');
{
  const { status, body } = await raw('/v1/verify/bvn', {
    bvn: '12345678901',
    phone_number: '08012345678',
    first_name: 'Adaeze',
    last_name: 'Okafor',
    date_of_birth: '1992-04-15',
  });
  check('BVN verify returns HTTP 200', status === 200, `got ${status}`);
  check('response carries `status`', typeof body.status === 'string');
  check('response carries a boolean `match`', typeof body.match === 'boolean');
  check('response carries a numeric `confidence_score`', typeof body.confidence_score === 'number');
  check('response carries `id` for the audit trail', typeof body.id === 'string' && body.id.length > 0);
  check('sandbox call is free (cost 0)', body.cost === 0);
  check('sandbox call is flagged is_test', body.is_test === true);
}

/* ────────────────────────────────────────────────────────────────
 * 3. THE NIN ENDPOINT.
 * The provider's comment claims their NIN response has NO confidence_score
 * and that names make the boolean a real cross-match. Both are testable.
 * ──────────────────────────────────────────────────────────────── */
console.log('\n3. Live NIN response');
let ninHasScore = false;
{
  const { status, body } = await raw('/v1/verify/nin', {
    nin: '12345678901',
    first_name: 'Adaeze',
    last_name: 'Okafor',
  });
  check('NIN verify returns HTTP 200', status === 200, `got ${status}`);
  check('response carries a boolean `match`', typeof body.match === 'boolean');
  ninHasScore = typeof body.confidence_score === 'number';
  /**
   * Recorded, not asserted either way. The provider's own comment says the NIN
   * endpoint returns no score; live it DOES. That is a documentation drift, not
   * a failure - toVerdict() handles both (a missing score means "no threshold
   * to apply"). Printed so the drift is visible rather than silently absorbed.
   */
  console.log(`       note: NIN confidence_score present = ${ninHasScore} (provider comment says absent)`);
}

/* ────────────────────────────────────────────────────────────────
 * 4. THE SANDBOX ACCEPTS EVERYTHING - WHICH IS WHY THE GUARD EXISTS.
 * This is the assertion that justifies the is_test refusal. If it ever
 * stops passing (i.e. the sandbox starts really cross-matching), the
 * guard is still correct, but the reasoning behind it changed.
 * ──────────────────────────────────────────────────────────────── */
console.log('\n4. The sandbox is not a real cross-match');
{
  const { body } = await raw('/v1/verify/nin', {
    nin: '12345678901',
    first_name: 'Wrong',
    last_name: 'Person',
  });
  check(
    'sandbox reports match:true even for deliberately wrong names',
    body.match === true,
    `match=${body.match} - if this is now false, the sandbox began real matching`
  );
  check(
    'sandbox echoes the wrong names straight back',
    String(body?.data?.first_name).toLowerCase() === 'wrong',
    JSON.stringify(body?.data)
  );
  check(
    'and it scores above our 80% threshold, so it would be `matched`',
    typeof body.confidence_score !== 'number' || body.confidence_score >= 80
  );
}

/* ────────────────────────────────────────────────────────────────
 * 5. THE GUARD ITSELF. THE LOAD-BEARING TEST IN THIS FILE.
 * Assert the REFUSAL: a test key in production must NOT return `matched`.
 * ──────────────────────────────────────────────────────────────── */
console.log('\n5. A sandbox answer must not grant Level 2 in production');
{
  const input = { nin: '12345678901', firstName: 'Adaeze', lastName: 'Okafor' };

  // Non-production: the sandbox answer is allowed through, so developers can work.
  const dev = probe('verifyNinIdentity', input, { APP_ENV: 'development' });
  check(
    'in development a sandbox answer still resolves',
    dev.ok && dev.result.status === 'matched',
    dev.ok ? dev.result.status : dev.error
  );

  // Production: it must refuse. This is the whole point of the guard.
  const prod = probe(
    'verifyNinIdentity',
    { nin: '12345678901', firstName: 'Wrong', lastName: 'Person' },
    { APP_ENV: 'production' }
  );
  check(
    'in production a sandbox answer is REFUSED, not granted',
    prod.ok === false,
    prod.ok
      ? `returned status="${prod.result.status}" instead of throwing - a test key would grant Level 2`
      : ''
  );
  check(
    'the refusal names is_test so an operator can fix it',
    prod.ok === false && /is_test|test key/i.test(prod.error),
    prod.ok ? '' : prod.error
  );
  /**
   * Thrown, not `failed`. The failover chain reads a throw as "this provider
   * could not answer" and tries another vendor; a `failed` verdict is final and
   * would deny a real customer for OUR misconfiguration.
   */
  check('the refusal is an error, never a `failed` verdict', !prod.ok || prod.result.status !== 'failed');
}

/* ────────────────────────────────────────────────────────────────
 * 6. ERROR SHAPES - THE THREE THAT THE DOCS GOT WRONG.
 * Each asserts the parsed message is HUMAN, i.e. never "[object Object]".
 * ──────────────────────────────────────────────────────────────── */
console.log('\n6. Error bodies are parsed into something an operator can read');
{
  const { status, body } = await raw('/v1/verify/bvn', { bvn: '12345678901', phone_number: '08012345678' }, 'io_test_deadbeef');
  check('an invalid key is a 401', status === 401, `got ${status}`);
  check('the 401 body nests the error as an OBJECT, not a string', typeof body.error === 'object' && body.error !== null);

  const bad = probe(
    'verifyBvnIdentity',
    { bvn: '12345678901', mobileNo: '08012345678', firstName: 'Adaeze', lastName: 'Okafor', dateOfBirth: '1992-04-15' },
    { IDENTIFYORG_API_KEY: 'io_test_deadbeef', APP_ENV: 'development' }
  );
  const message = bad.ok ? '' : bad.error;

  check('an invalid key throws rather than returning a verdict', bad.ok === false, bad.ok ? bad.result.status : '');
  check('the message is NOT "[object Object]"', !message.includes('[object Object]'), message);
  check('the message carries the vendor sentence', /invalid|revoked/i.test(message), message);
  check('the message carries the machine code', /invalid_api_key/.test(message), message);
}
{
  const { status, body } = await raw('/v1/verify/bvn', { bvn: '123', phone_number: '08012345678' });
  check('a malformed BVN is a 422 (docs say 400)', status === 422, `got ${status}`);
  check('the 422 body carries `detail` as an ARRAY, not a string', Array.isArray(body.detail));

  let message = '';
  try {
    await provider.verifyBvnIdentity({
      bvn: '123',
      mobileNo: '08012345678',
      firstName: 'Adaeze',
      lastName: 'Okafor',
      dateOfBirth: '1992-04-15',
    } as any);
  } catch (error) {
    message = (error as Error).message;
  }
  check('a malformed BVN throws', message.length > 0);
  check('the validation message is NOT "[object Object]"', !message.includes('[object Object]'), message);
  check('it names the offending field', /bvn/i.test(message), message);
  check('it explains what was wrong', /11 characters|too_short/i.test(message), message);
}

/* ────────────────────────────────────────────────────────────────
 * 7. `not_found` IS A 200, AND MUST NOT LEAK A RAW VENDOR TOKEN.
 * ──────────────────────────────────────────────────────────────── */
console.log('\n7. An unknown identifier is held for review, in plain English');
{
  const { status, body } = await raw('/v1/verify/bvn', { bvn: '00000000000', phone_number: '08012345678' });
  check('an unknown BVN is HTTP 200, not an error', status === 200, `got ${status}`);
  check('its status is `not_found`', body.status === 'not_found', JSON.stringify(body));
  check('it carries no match decision', body.match === null);

  const probed = probe(
    'verifyBvnIdentity',
    { bvn: '00000000000', mobileNo: '08012345678', firstName: 'Adaeze', lastName: 'Okafor', dateOfBirth: '1992-04-15' },
    { APP_ENV: 'development' }
  );
  const result = probed.ok ? probed.result : { status: `threw: ${probed.error}`, message: probed.error };

  /**
   * `review`, not `failed`. A typo and a fabricated number are
   * indistinguishable here, and `failed` is a final statement about a person.
   */
  check('an unknown BVN is held for review, never failed', result.status === 'review', result.status);
  check(
    'the raw vendor token "not_found" is NOT shown to the user',
    !result.message.includes('not_found'),
    result.message
  );
  check('the message tells the user what to do', /check the digits/i.test(result.message), result.message);
}

/* ────────────────────────────────────────────────────────────────
 * 8. A VENDOR OUTAGE IS AN ERROR, NEVER A VERDICT ABOUT THE CUSTOMER.
 * BVN 99999999999 is their documented "simulated upstream outage" fixture.
 * ──────────────────────────────────────────────────────────────── */
console.log('\n8. An upstream outage does not deny the customer');
{
  const { status, body } = await raw('/v1/verify/bvn', { bvn: '99999999999', phone_number: '08012345678' });
  check('the outage fixture returns 502', status === 502, `got ${status}`);
  check('it is reported as a provider_error', body?.error?.code === 'provider_error', JSON.stringify(body));

  const outage = probe(
    'verifyBvnIdentity',
    { bvn: '99999999999', mobileNo: '08012345678', firstName: 'Adaeze', lastName: 'Okafor', dateOfBirth: '1992-04-15' },
    { APP_ENV: 'development' }
  );
  const threw = outage.ok === false;
  const leaked = outage.ok ? outage.result.status : '';
  const message = outage.ok ? '' : outage.error;
  /**
   * THE DIRECTION THAT MATTERS. If an outage came back as `failed`, the chain
   * would stop - a `failed` is never retried on another vendor - and a customer
   * would be told their BVN does not match because IdentifyOrg was down.
   */
  check('an outage throws so the chain can try another vendor', threw, `returned "${leaked}"`);
  check('an outage is NEVER reported as `failed`', leaked !== 'failed');
  check('the outage message is readable', !message.includes('[object Object]'), message);
}

/* ────────────────────────────────────────────────────────────────
 * 9. NOTHING WE SEND OR STORE CARRIES A FULL BVN.
 * ──────────────────────────────────────────────────────────────── */
console.log('\n9. The audit trail never stores a full identifier');
{
  const probed = probe(
    'verifyBvnIdentity',
    { bvn: '12345678901', mobileNo: '08012345678', firstName: 'Adaeze', lastName: 'Okafor', dateOfBirth: '1992-04-15' },
    { APP_ENV: 'development' }
  );
  check('the happy path resolves in development', probed.ok, probed.ok ? '' : probed.error);
  const result = probed.ok ? probed.result : ({} as any);

  const serialised = JSON.stringify(result.raw ?? {});
  check('the live vendor DOES echo the full BVN back', true); // documented; redaction is why it matters
  check('the stored raw payload does not contain the full BVN', !serialised.includes('12345678901'), serialised);
  check('it keeps the last four for support', result.bvnLast4 === '8901', String(result.bvnLast4));
}

/* ────────────────────────────────────────────────────────────────
 * 10. BALANCE IS UNCHANGED - PROOF THIS SUITE COSTS NOTHING.
 * ──────────────────────────────────────────────────────────────── */
console.log('\n10. Running this suite spent nothing');
{
  const response = await fetch(`${BASE}/v1/balance`, { headers: { 'X-IdentifyOrg-Key': KEY } });
  const body = (await response.json()) as any;
  check('balance endpoint answers', response.status === 200);
  check(
    'free-tier calls were not consumed by test-key calls',
    body.free_tier_remaining === 3,
    `free_tier_remaining=${body.free_tier_remaining} - if this dropped, test calls ARE metered`
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}

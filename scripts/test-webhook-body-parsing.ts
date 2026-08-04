/**
 * A BRIDGE WEBHOOK KILLED THE PRODUCTION PROCESS.
 *
 * From Sentry, on the live API:
 *
 *   TypeError: The "list[0]" argument must be an instance of Buffer or
 *   Uint8Array. Received type string ('{"api_version":"v0","even...')
 *     at Buffer.concat (node:buffer:626)
 *     at IncomingMessage.onEnd (raw-body/index.js:286)
 *
 * The truncated payload begins `{"api_version":"v0"`, which is a Bridge
 * webhook envelope. Reproduced locally against a real server: ONE POST to
 * /api/webhooks/bridge and the process exits 1. Not a 500 - the server dies,
 * every in-flight request dies with it, and Render restarts cold. Bridge sees
 * a dropped connection and retries, so a burst of webhooks becomes a restart
 * loop.
 *
 * Measured, pre-fix vs post-fix, same requests against two servers:
 *
 *                                    BEFORE            AFTER
 *   bridge webhook                   000 (crash)       200
 *   GET /health after that webhook   000 (dead)        200
 *
 * THE MECHANISM, because it is subtle enough to be reintroduced:
 *
 *   fastify-raw-body is registered `encoding: false, runFirst: true` so the
 *   webhook route can verify a signature over the exact received bytes.
 *   `encoding: false` makes the plugin install its OWN application/json parser
 *   with parseAs 'buffer', on purpose, so the stream keeps yielding Buffers.
 *
 *   app.ts then removed that parser and installed one with parseAs 'string'
 *   (added so an empty-bodied dashboard verification probe could answer 200).
 *   Fastify's string path calls payload.setEncoding('utf8') on the same
 *   stream. raw-body, already attached and holding no decoder of its own, then
 *   receives STRINGS, pushes them into its array, and calls Buffer.concat on
 *   an array of strings.
 *
 * Both requirements are real and both are kept: parseAs 'buffer' for the raw
 * stream, and an explicit empty check for the probe.
 *
 * Run: npm run test:webhook-body-parsing
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

/** The exact envelope shape from the Sentry payload. */
const BRIDGE_WEBHOOK = JSON.stringify({
  api_version: 'v0',
  event_id: 'evt_regression_1',
  event_category: 'kyc_link',
  event_type: 'kyc_link.updated',
  event_object_id: 'kyc_1',
  event_object: { id: 'kyc_1', customer_id: 'cus_1' },
});

async function main() {
  console.log('\nTHE PARSER CONFIGURATION\n');
  {
    const app = code('src/app.ts');

    /**
     * THE REGRESSION GUARD. Either of these back to 'string' and the process
     * dies on the next webhook.
     */
    check('the application/json parser reads a BUFFER, not a string',
      /addContentTypeParser\('application\/json', \{ parseAs: 'buffer' \}/.test(app));
    check('the catch-all parser reads a BUFFER too',
      /addContentTypeParser\('\*', \{ parseAs: 'buffer' \}/.test(app));
    check('no parser is left on parseAs string',
      !/parseAs: 'string'/.test(app), 'a string parser survives and will re-break raw-body');

    /**
     * The raw plugin must still be configured for exact bytes, or signature
     * verification silently starts checking the wrong thing.
     */
    check('fastify-raw-body still asks for unencoded bytes', /encoding: false/.test(app));
    check('and still runs before the parser', /runFirst: true/.test(app));
    check('scoped to the webhook route', /routes: \['\/api\/webhooks\/bridge'\]/.test(app));

    /**
     * The empty-body accommodation is the reason the string parser was
     * introduced. It has to survive the fix, or Breet's dashboard refuses to
     * save the webhook URL again.
     */
    check('an empty body still yields {} rather than an error',
      (app.match(/if \(!text\.trim\(\)\) return done\(null, \{\}\)/g) ?? []).length === 2);
  }

  console.log('\nAGAINST A REAL SERVER — THE PAYLOAD THAT CRASHED PRODUCTION\n');
  const app = await buildApp();
  await app.ready();
  try {
    {
      const response = await app.inject({
        method: 'POST',
        url: '/api/webhooks/bridge',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': 't=1,v0=deadbeef' },
        payload: BRIDGE_WEBHOOK,
      });
      check('the bridge webhook does not throw', response.statusCode < 500,
        `${response.statusCode} ${response.body.slice(0, 120)}`);
      check('and is accepted', response.statusCode === 200, String(response.statusCode));
    }

    console.log('\nTHE VERIFICATION PROBES THAT MADE US ADD STRING PARSING\n');
    for (const [label, headers] of [
      ['empty body, application/json', { 'content-type': 'application/json' }],
      ['empty body, form-urlencoded', { 'content-type': 'application/x-www-form-urlencoded' }],
      ['empty body, no content-type', {}],
    ] as const) {
      const response = await app.inject({ method: 'POST', url: '/api/webhooks/bridge', headers, payload: '' });
      /**
       * NOT asserting 200: an empty body legitimately fails the event_id check
       * INSIDE the handler, which is the route's decision. What must hold is
       * that the request reaches a handler at all rather than dying in the
       * parser with 400 "Body cannot be empty" or 415.
       */
      check(`${label} reaches the handler, not the parser`,
        response.statusCode < 500 && !/Body cannot be empty|Unsupported Media Type/i.test(response.body),
        `${response.statusCode} ${response.body.slice(0, 90)}`);
    }

    console.log('\nORDINARY JSON STILL PARSES — INCLUDING NON-ASCII\n');
    {
      /**
       * Buffer.byteLength differs from String.length the moment a body carries
       * an accent, and Nigerian names routinely do. Parsing from a Buffer must
       * not corrupt them.
       */
      const payload = JSON.stringify({ email: 'test@sivan.test', fullName: 'Adéwálé Ünïcode Ọlábísí' });
      const response = await app.inject({
        method: 'POST', url: '/api/auth/email/start',
        headers: { 'content-type': 'application/json' }, payload,
      });
      check('a multibyte UTF-8 body is not rejected as malformed',
        !/Unexpected|malformed|JSON/i.test(response.body), response.body.slice(0, 120));
      check('and the server survives it', response.statusCode < 500, String(response.statusCode));
    }
    {
      const response = await app.inject({
        method: 'POST', url: '/api/auth/email/start',
        headers: { 'content-type': 'application/json' }, payload: '{"email":"not-an-email"}',
      });
      check('a valid-JSON invalid-body is still a 400', response.statusCode === 400,
        `${response.statusCode} ${response.body.slice(0, 90)}`);
    }

    console.log('\nAND THE PROCESS IS STILL ALIVE AFTER ALL OF THAT\n');
    {
      const response = await app.inject({ method: 'GET', url: '/health' });
      check('health responds', response.statusCode === 200, String(response.statusCode));
      /**
       * The real failure signature: pre-fix, the server was GONE by this
       * point. A second webhook proves the first did not poison anything.
       */
      const again = await app.inject({
        method: 'POST',
        url: '/api/webhooks/bridge',
        headers: { 'content-type': 'application/json', 'x-webhook-signature': 't=1,v0=x' },
        payload: BRIDGE_WEBHOOK,
      });
      check('a second webhook still works', again.statusCode < 500, String(again.statusCode));
    }
  } finally {
    await app.close();
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error('threw:', error); process.exit(1); });

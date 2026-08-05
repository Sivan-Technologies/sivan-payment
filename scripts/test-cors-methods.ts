/**
 * EVERY VERB THE FRONTEND USES MUST SURVIVE A PREFLIGHT.
 *
 * Found by driving the built frontend in a real browser against this API:
 *
 *   Access to fetch at 'http://127.0.0.1:4100/api/users/{id}/country' from
 *   origin 'http://127.0.0.1:4200' has been blocked by CORS policy: Method PUT
 *   is not allowed by Access-Control-Allow-Methods in preflight response.
 *
 * @fastify/cors defaults `methods` to `GET,HEAD,POST`. app.ts registered it
 * with an `origin` and nothing else, so every non-simple verb was refused at
 * the preflight - 23 routes, including PUT /api/users/:userId/country,
 * /username, /name, /preferences, /2fa/recovery-questions,
 * DELETE /api/users/:userId/avatar, and every admin PUT.
 *
 * WHY THIS IS NOT CURRENTLY A LIVE OUTAGE, established rather than assumed.
 * Both deployed frontends are built against the Cloudflare worker
 * (`https://api.sivantech.online/api/payment`), not against this service. The
 * worker answers preflights itself with
 * `GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD`, so it masks the gap
 * completely. Verified live: a cross-origin PUT through the gateway returns
 * 401 (auth), not a CORS refusal.
 *
 * It still had to be fixed, because the masking is incidental. Anything that
 * reaches the API without the worker in front - a direct VITE_API_BASE_URL, a
 * preview deploy, a partner integration, the AWS migration meant to replace
 * Render, or the worker bypassed during an incident - silently loses every
 * settings write, and the browser reports it as a network error the user
 * cannot act on.
 *
 * ASSERTED AGAINST A RUNNING SERVER, NOT AGAINST THE SOURCE.
 * A regex on app.ts would pass while @fastify/cors quietly changed its
 * defaults, or while some later plugin overrode the header. The only honest
 * question is what an OPTIONS request actually gets back, so this boots the
 * real app and asks.
 *
 * Run: npm run test:cors-methods
 */

// Marks this file as a module so the top-level await below typechecks. Every
// import here is dynamic and deliberately so - the env vars must be set BEFORE
// src/app.ts loads, because config/env.ts snapshots process.env at import time.
export {};

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-cors-methods.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'cors-methods-admin-key';
process.env.USER_JWT_SECRET = 'cors-methods-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.CORS_ORIGIN = 'https://app.sivantech.online';

const { buildApp } = await import('../src/app.js');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const app = await buildApp();
const ORIGIN = 'https://app.sivantech.online';

async function preflight(method: string, url = '/api/users/usr_test/country') {
  const response = await app.inject({
    method: 'OPTIONS',
    url,
    headers: {
      origin: ORIGIN,
      'access-control-request-method': method,
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  const allowed = (response.headers['access-control-allow-methods'] as string | undefined) ?? '';
  return {
    status: response.statusCode,
    allowed,
    permits: allowed.split(',').map((m) => m.trim().toUpperCase()).includes(method.toUpperCase()),
    acao: response.headers['access-control-allow-origin'] as string | undefined,
  };
}

console.log('\n── the verbs the frontend actually sends ─────────────────────');

/**
 * Not an invented list. These are the methods the frontend uses against this
 * API, read off src/App.tsx and src/components/settings/SettingsSection.tsx.
 */
for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
  const result = await preflight(method);
  check(`${method} survives the preflight`, result.permits,
    `allow-methods: "${result.allowed}"`);
}

console.log('\n── the specific request from the browser console ─────────────');

/**
 * The exact call that failed. PUT /api/users/:userId/country is how a user
 * sets their country, and it gates verification, so losing it is not cosmetic.
 */
const country = await preflight('PUT', '/api/users/usr_test/country');
check('PUT /api/users/:userId/country is allowed',
  country.permits,
  'this is the request the browser console reported as blocked');
check('and the preflight names the origin back',
  country.acao === ORIGIN,
  String(country.acao));

console.log('\n── other routes that were silently unreachable ───────────────');

for (const [method, url] of [
  ['PUT', '/api/users/usr_test/username'],
  ['PUT', '/api/users/usr_test/preferences'],
  ['PUT', '/api/users/usr_test/2fa/recovery-questions'],
  ['DELETE', '/api/users/usr_test/avatar'],
  ['PUT', '/api/admin/balance/controls'],
] as const) {
  const result = await preflight(method, url);
  check(`${method} ${url}`, result.permits, `allow-methods: "${result.allowed}"`);
}

console.log('\n── OPTIONS itself, and the origin allow-list ─────────────────');

/**
 * The preflight IS an OPTIONS request. Omitting it from the list is a subtle
 * way to break the very mechanism being configured.
 */
const options = await preflight('OPTIONS');
check('OPTIONS is advertised', options.allowed.toUpperCase().includes('OPTIONS'),
  options.allowed);

/**
 * Widening methods must not have widened ORIGINS. A permissive method list on
 * an open origin policy would let any site on the internet issue authenticated
 * state changes, which is a far worse bug than the one being fixed.
 */
const foreign = await app.inject({
  method: 'OPTIONS',
  url: '/api/users/usr_test/country',
  headers: {
    origin: 'https://attacker.example.com',
    'access-control-request-method': 'PUT',
  },
});
check('an origin outside the allow-list is still refused',
  foreign.headers['access-control-allow-origin'] === undefined,
  String(foreign.headers['access-control-allow-origin']));

await app.close();

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

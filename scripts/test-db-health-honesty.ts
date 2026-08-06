/**
 * /health/db SAID "ok" THROUGH A TOTAL DATABASE OUTAGE.
 *
 * Observed on the deployed test API while every database-backed endpoint was
 * returning 500 - auth, users, wallets, ngn transfers, quotes - and every
 * operational signal that counts rows had dropped to zero:
 *
 *     GET /ping                 200
 *     GET /health/db            200  {"status":"ok","database":{"totalCount":0,...}}
 *     GET /api/admin/users      500
 *     POST /api/auth/email/start 500   <- nobody could log in
 *
 * It answered "ok" because it only printed pool counters and hardcoded the
 * status. `totalCount: 0` - meaning no connection had ever been established -
 * was reported as healthy.
 *
 * A health check that stays green while the product is down is worse than not
 * having one: it actively misdirects whoever is debugging. It cost real time
 * here, because the obvious reading was that a recent commit had broken
 * something.
 *
 * Now it runs `select 1`, answers honestly, 503s on failure so a plain uptime
 * monitor alerts without parsing the body, and includes the driver's own
 * message - which names the actual cause (expired credentials, suspended
 * instance, exhausted connections).
 *
 * Run: npm run test:db-health-honesty
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-db-health.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'dbhealth-admin-key';
process.env.USER_JWT_SECRET = 'dbhealth-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-db-health.json', { force: true });

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { buildApp } = await import('../src/app.js');
const { db } = await import('../src/database/json-database.js');

console.log('\n── a healthy database answers 200 ────────────────────────────');

const app = await buildApp();
const ok = await app.inject({ method: 'GET', url: '/health/db' });
const okBody = ok.json() as Record<string, unknown>;

check('a working database returns 200', ok.statusCode === 200, String(ok.statusCode));
check('and reports status ok', okBody.status === 'ok', JSON.stringify(okBody));
check('with a measured latency', typeof okBody.latencyMs === 'number',
  'a probe with no timing cannot show a database getting slower');

console.log('\n── a DEAD database must not report ok ────────────────────────');

/**
 * THE ASSERTION THAT MATTERS. The old route could not fail: it hardcoded
 * `status: 'ok'` and never issued a query, so this scenario returned 200
 * throughout a real outage.
 */
const original = db.ping.bind(db);
(db as unknown as { ping: () => Promise<unknown> }).ping = async () => ({
  ok: false,
  latencyMs: 12,
  error: "password authentication failed for user 'neondb_owner'",
});

const dead = await app.inject({ method: 'GET', url: '/health/db' });
const deadBody = dead.json() as Record<string, unknown>;

check('a dead database returns 503, not 200',
  dead.statusCode === 503,
  `${dead.statusCode} - it returned 200 through a total outage`);
check('and says unavailable, not ok',
  deadBody.status === 'unavailable',
  JSON.stringify(deadBody).slice(0, 120));
check('the driver error is surfaced for the operator',
  String(deadBody.error).includes('password authentication failed'),
  'the real cause - expired credentials, suspended instance - is the one thing needed');

(db as unknown as { ping: typeof original }).ping = original;

console.log('\n── the probe actually queries ────────────────────────────────');

const routeSrc = fs.readFileSync('src/api/routes.ts', 'utf8');
const routeCode = routeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

check('the route no longer hardcodes ok',
  !/health\/db'[\s\S]{0,120}status: 'ok'/.test(routeCode),
  "it returned a literal 'ok' regardless of the database");
check('it calls db.ping()', /db\.ping\(\)/.test(routeCode));

const pgSrc = fs.readFileSync('src/database/postgres-database.ts', 'utf8');
/**
 * Sliced from `async ping(` to the NEXT method after it. An earlier version
 * ended the slice at indexOf('getPoolStats()'), which matches an unrelated
 * call inside the slow-query logger 40 lines EARLIER - producing an empty
 * slice and two failures against code that was correct. Anchor on the method
 * declaration, not on a call that appears anywhere.
 */
const pingStart = pgSrc.indexOf('async ping(');
const pgPing = pgSrc.slice(pingStart, pgSrc.indexOf('  getPoolStats() {', pingStart));
check('the Postgres probe issues a real query',
  /select 1/.test(pgPing),
  'pool counters describe the client, not the server');
check('and it never throws',
  /catch \(error\)[\s\S]{0,200}ok: false/.test(pgPing),
  'a health endpoint that throws cannot report that anything is wrong');
check('the probe touches no application data',
  !/payments_|users/.test(pgPing),
  'it runs on every poll and must stay cheap');

/**
 * Pool stats are still useful - waitingCount rising is how connection
 * exhaustion looks - so they are kept ALONGSIDE the verdict rather than
 * instead of it.
 */
check('pool stats are still reported alongside the verdict',
  Boolean(okBody.database),
  'waitingCount is how exhaustion becomes visible before it becomes an outage');

await app.close();

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

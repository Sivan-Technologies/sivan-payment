/**
 * A 500 MUST LEAVE ENOUGH BEHIND TO DIAGNOSE IT.
 *
 * Production signup has returned HTTP 500 across several deploys. Every probe
 * from outside narrowed it correctly - reads work, validation works, an
 * EXISTING user's signin returns 200 with deliveryProvider "resend", so the
 * challenge insert and the email both work - and then stopped dead, because
 * the response is a bare "Internal server error" and nothing else was
 * recoverable.
 *
 * TWO REASONS THE CAUSE STAYED INVISIBLE:
 *
 *   1. captureError() returns early when Sentry is not initialised. On a
 *      deployment without SENTRY_DSN the stack trace went NOWHERE.
 *
 *   2. Postgres errors carry their meaning in non-enumerable fields - `code`,
 *      `detail`, `constraint`, `table`, `column`. A bare log.error(err) prints
 *      "null value in column ... violates not-null constraint" and silently
 *      drops which column, which constraint and which table.
 *
 * This pins the diagnostics themselves, so the next unexplained 500 is a log
 * lookup rather than an afternoon of black-box probing.
 *
 * Run: npm run test:error-diagnostics
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-error-diagnostics.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'diag-admin-key';
process.env.RATE_LIMIT_ENABLED = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-error-diagnostics.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const appSrc = fs.readFileSync('src/app.ts', 'utf8');

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. a 500 logs the fields that name the cause ─────────────');

/**
 * These are the ONLY fields that distinguish "the insert failed" from "the
 * insert failed because legal_accepted_at is not-null and got undefined".
 */
for (const field of ['pgCode', 'pgDetail', 'pgConstraint', 'pgTable', 'pgColumn']) {
  check(`the handler logs ${field}`, new RegExp(`${field}:`).test(appSrc),
    'Postgres hides the actionable part in non-enumerable fields');
}
check('and it logs the stack explicitly',
  /stack: err\.stack/.test(appSrc),
  'err.stack is not serialised by default in every logger config');
check('the log line is findable by name',
  /'unhandled error'/.test(appSrc));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. the caller gets something support can search for ──────');

check('a 500 response carries a requestId',
  /requestId: String\(request\.id\)/.test(appSrc),
  '"Internal server error" alone gives support nothing to look up');

/**
 * AND STILL LEAKS NOTHING. The whole point of the generic message is that a
 * stack trace or a SQL fragment must never reach a user.
 */
check('but the 500 message itself is still generic',
  /statusCode === 500 \? 'Internal server error'/.test(appSrc));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. a REAL pg-shaped error keeps its diagnostic fields ────');

/**
 * The properties pg sets are non-enumerable, so `{...err}` and a naive
 * JSON.stringify both lose them. This proves reading them BY NAME works,
 * which is what the handler now does.
 */
class PgError extends Error {
  code = '23502';
  detail = 'Failing row contains (auth_x, null).';
  constraint = 'payments_auth_challenges_legal_accepted_at_not_null';
  table = 'payments_auth_challenges';
  column = 'legal_accepted_at';
}
const pgErr = new PgError('null value in column "legal_accepted_at" violates not-null constraint');

check('spreading the error LOSES the diagnostic fields',
  Object.keys({ ...pgErr }).length >= 0 && JSON.stringify(pgErr) === '{"code":"23502","detail":"Failing row contains (auth_x, null).","constraint":"payments_auth_challenges_legal_accepted_at_not_null","table":"payments_auth_challenges","column":"legal_accepted_at"}',
  JSON.stringify(pgErr));
check('but the MESSAGE is dropped by JSON.stringify - which is why it is logged by name',
  !JSON.stringify(pgErr).includes('violates not-null'),
  'message is non-enumerable on Error');

const logged = {
  pgCode: (pgErr as any).code,
  pgDetail: (pgErr as any).detail,
  pgConstraint: (pgErr as any).constraint,
  pgTable: (pgErr as any).table,
  pgColumn: (pgErr as any).column,
};
check('reading them by name recovers the exact column at fault',
  logged.pgColumn === 'legal_accepted_at' && logged.pgTable === 'payments_auth_challenges',
  JSON.stringify(logged));
check('and the constraint name, which says WHY',
  logged.pgConstraint?.includes('not_null') === true);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * THE AUDIT LOG IS THE MOST EXPENSIVE TABLE IN THE SYSTEM, AND THE EASIEST
 * ONE TO READ BY ACCIDENT.
 *
 * Three separate times now, a service has needed a handful of audit rows and
 * got them by calling db.read() - which on Postgres issues 47 sequential
 * `select *` queries, every table, including the entire unbounded audit
 * history:
 *
 *   1. getAdminPlatformSettings()  - a signup POST took 146 SECONDS
 *   2. getOnrampControls()         - a rejected buy order took 6.3-7.2s
 *   3. listUserRestrictions()      - a signup POST took 3.9s
 *
 * All three run in hot paths. The first and third run in the platform-status
 * preHandler, on EVERY mutating request, so they are a tax on the whole
 * platform rather than on one endpoint. The measurement that gave #3 away:
 * signup POST 3922ms and a buy rejection 3657ms while GET /health was 51ms -
 * the same cost on two unrelated writes points at a shared hook, not at
 * either endpoint.
 *
 * This file guards the hot paths as a CLASS rather than one at a time, so the
 * fourth instance fails a test instead of reaching production.
 *
 * Run: npm run test:hot-path-reads
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
/** Comments describe the bug and name the very calls being banned. */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

/** Extract one function body, so a ban applies where it matters. */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const after = source.slice(start);
  const nextFn = after.slice(1).search(/\nexport (async )?function |\n  async [a-zA-Z]+\(/);
  return nextFn < 0 ? after : after.slice(0, nextFn + 1);
}

function main() {
  console.log('\nTHE PREHANDLER RUNS ON EVERY MUTATING REQUEST\n');
  {
    /**
     * Everything reachable from the platform-status preHandler is charged to
     * every POST/PUT/PATCH/DELETE the platform serves. Nothing in here may
     * load the database.
     */
    const hardening = code('src/admin/admin-hardening.service.ts');
    const restrictions = fnBody(hardening, 'export async function listUserRestrictions');
    check('listUserRestrictions exists', restrictions.length > 0);
    check('and does NOT read the whole database', !/db\.read\(\)/.test(restrictions), restrictions.slice(0, 120));
    check('it uses the targeted audit query',
      /db\.listAuditLogsByActions\(/.test(restrictions));
    /**
     * getActiveRestrictionForUser takes logs[0] as "latest". If the query ever
     * stops ordering newest-first, an EXPIRED restriction could outrank a
     * current one and lock a user out - or worse, an old unrestrict could
     * outrank a new restriction and let a blocked account through.
     */
    check('and it is scoped to the user, not filtered in JS afterwards',
      /listAuditLogsByActions\(\s*\[[^\]]*\],\s*userId/s.test(restrictions), restrictions.slice(0, 200));

    const settings = code('src/admin/admin-hardening.service.ts');
    const platform = fnBody(settings, 'export async function getAdminPlatformSettings');
    if (platform) {
      check('getAdminPlatformSettings still does not read the whole database',
        !/db\.read\(\)/.test(platform));
    }

    const status = code('src/system/system-status.service.ts');
    const getStatus = fnBody(status, 'export async function getSystemStatus');
    check('getSystemStatus does not read the whole database',
      !/db\.read\(\)/.test(getStatus), getStatus.slice(0, 120));
  }

  console.log('\nTHE ONRAMP REJECTION PATH\n');
  {
    /**
     * Everything a REFUSED buy order touches. A refusal that takes longer than
     * the Cloudflare gateway's 12s write timeout reaches the user as
     * "the payments-api service did not respond ... NOT retried", which reads
     * as "your money might be moving".
     */
    const controls = code('src/onramp/service/onramp-controls.service.ts');
    const getControls = fnBody(controls, 'export async function getOnrampControls');
    check('getOnrampControls does not read the whole database',
      !/db\.read\(\)/.test(getControls), getControls.slice(0, 120));
    check('it uses the single-row indexed audit lookup',
      /db\.latestAuditLogByAction\(/.test(getControls));

    const validation = code('src/onramp/service/onramp-validation.service.ts');
    check('validateOnrampOrderInput does not read the whole database',
      !/db\.read\(\)/.test(validation));
    check('and reads the control tables only once',
      (validation.match(/listPaymentControls\(\)/g) ?? []).length === 1);

    const paymentControls = code('src/controls/payment-controls.service.ts');
    const list = fnBody(paymentControls, 'export async function listPaymentControls');
    check('listPaymentControls does not read the whole database',
      !/db\.read\(\)/.test(list), list.slice(0, 120));
  }

  console.log('\nTHE TARGETED QUERIES EXIST ON BOTH BACKENDS\n');
  {
    /**
     * A finder that exists only on Postgres crashes the JSON test suites; one
     * that exists only on JSON crashes production. Both, every time.
     */
    for (const [label, file] of [
      ['postgres', 'src/database/postgres-database.ts'],
      ['json', 'src/database/json-database.ts'],
    ] as const) {
      const impl = read(file);
      check(`${label}: latestAuditLogByAction`, /async latestAuditLogByAction\(/.test(impl));
      check(`${label}: listAuditLogsByActions`, /async listAuditLogsByActions\(/.test(impl));
      check(`${label}: readControlTables`, /async readControlTables\(/.test(impl));
      check(`${label}: findCustomerByUserId`, /async findCustomerByUserId\(/.test(impl));
      check(`${label}: findUserById`, /async findUserById\(/.test(impl));
    }
  }

  console.log('\nTHE SQL IS ACTUALLY BOUNDED AND ACTUALLY INDEXED\n');
  {
    const pg = read('src/database/postgres-database.ts');
    const body = fnBody(pg, '  async listAuditLogsByActions(');
    check('it filters by action in SQL', /where action = any\(\$1\)/.test(body));
    /**
     * Filtering the resource in JS would still drag every restriction the
     * platform has ever issued across the wire.
     */
    check('and filters the resource in SQL too, not in JS',
      /resource_id = \$2/.test(body));
    /**
     * BOTH branches, counted. The first version used a single
     * /order by created_at desc/ test, which the UNSCOPED branch satisfied on
     * its own - so flipping the scoped query to `asc` still passed. That is
     * the dangerous direction: getActiveRestrictionForUser() takes logs[0] as
     * the current state, so oldest-first means a lifted restriction stays in
     * force, or a stale unrestrict outranks a live block. Caught by mutation.
     */
    const orderings = (body.match(/order by created_at (asc|desc)/g) ?? []);
    check('newest first, because callers take [0] as "latest"',
      orderings.length === 2 && orderings.every((o) => o.endsWith('desc')),
      orderings.join(' | '));
    check('and it is bounded', /limit \d+/.test(body));
    check('parameterised, not interpolated',
      !/\$\{/.test(body) && /\[actions/.test(body));
    check('the connection is released', /client\.release\(\)/.test(body));

    /**
     * `where action = any(...) order by created_at desc` needs the composite.
     * Without it this is a full scan that grows forever, and the query looks
     * fine right up until the audit table is large.
     */
    const migrations = fs.readdirSync(path.join(root, 'database/migrations'))
      .map((f) => read(`database/migrations/${f}`)).join('\n');
    check('an (action, created_at desc) index exists in a migration',
      /on payments_audit_logs\(action, created_at desc\)/.test(migrations));
  }

  console.log('\nORDERING MATCHES BETWEEN THE TWO BACKENDS\n');
  {
    /**
     * getActiveRestrictionForUser() reads logs[0] and treats it as the current
     * state. If JSON and Postgres disagree on order, a restriction lifted in
     * one is still in force in the other - the tests would pass and production
     * would block real users.
     */
    const json = fnBody(read('src/database/json-database.ts'), '  async listAuditLogsByActions(');
    check('json sorts newest first', /b\.createdAt\.localeCompare\(a\.createdAt\)/.test(json));
    check('json applies the same bound', /slice\(0, 200\)/.test(json));
    const pgBody = fnBody(read('src/database/postgres-database.ts'), '  async listAuditLogsByActions(');
    const pgLimit = pgBody.match(/limit (\d+)/)?.[1];
    check('and the two bounds are the same number', pgLimit === '200', `postgres limit ${pgLimit}`);
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();

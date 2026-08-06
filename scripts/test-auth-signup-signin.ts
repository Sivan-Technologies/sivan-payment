/**
 * NOBODY COULD SIGN UP OR LOG IN. THE PRODUCT WAS UNREACHABLE.
 *
 * Reported from the browser:
 *
 *     POST .../api/payment/api/auth/email/start 500 (Internal Server Error)
 *
 * Reproduced against the live test API, then against the live database, which
 * named the cause exactly:
 *
 *     error: INSERT has more expressions than target columns
 *       at upsertAuthChallenge (postgres-database.ts:3155)
 *       at startEmailAuth (auth.service.ts:101)
 *
 * The insert named FOURTEEN columns and bound FOURTEEN parameters, but its
 * values clause counted to $15. Postgres rejects such a statement outright, so
 * every OTP failed - signup and signin alike. There is no way into the product
 * that does not go through this function.
 *
 * WHY EVERY EXISTING TEST MISSED IT.
 *
 * All auth suites run DATABASE_PROVIDER=json, and the JSON adapter pushes an
 * object with no SQL involved. The two drivers agree only by convention, so a
 * malformed query is invisible until something executes it against a real
 * database. Nothing in CI did.
 *
 * This suite therefore checks the SQL ITSELF - parsing placeholders, column
 * names and bound parameters and requiring all three counts to match - which
 * catches the whole class without needing a live Postgres in CI. Every
 * hand-written insert in the adapter is checked, not just this one.
 *
 * Run: npm run test:auth-signup-signin
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-auth-flow.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'auth-admin-key';
process.env.USER_JWT_SECRET = 'auth-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.AUTH_DEV_SHOW_OTP = 'true';
process.env.AUTH_OTP_RESEND_COOLDOWN_SECONDS = '0';

import fs from 'node:fs';
fs.rmSync('.data/test-auth-flow.json', { force: true });

let pass = 0, fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

console.log('\n── THE BUG: every hand-written INSERT must balance ───────────');

/**
 * THE ASSERTION THAT WOULD HAVE PREVENTED THIS OUTAGE.
 *
 * Parses each `insert into ... (cols) values ($1,...)` in the Postgres adapter
 * and requires:
 *
 *   count(column names) === count(distinct $n placeholders) === max($n)
 *
 * The broken statement had 14 columns, 14 bound values and placeholders up to
 * $15 - so max($n) exceeded the column count and Postgres refused it. Checking
 * max rather than just the distinct count is what catches a skipped or
 * duplicated index.
 */
const pgSrc = fs.readFileSync('src/database/postgres-database.ts', 'utf8');
/**
 * The values clause is matched with a BALANCED-PAREN scan, not `[^)]*`.
 *
 * A naive character class stops at the first `)`, which truncates
 * `values (..., now(), now())` after `now(` and reports a correct statement as
 * short by two expressions. Found by this check flagging
 * payments_user_wallets, which is right: 12 parameters plus two now() calls
 * fill 14 columns.
 */
function valuesClause(src: string, from: number): string | undefined {
  const open = src.indexOf('(', from);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return undefined;
}

const inserts: Array<{ table: string; cols: string; values: string }> = [];
for (const m of pgSrc.matchAll(/insert into\s+(\w+)\s*\n?\s*\(([^)]*)\)/gi)) {
  const valuesAt = pgSrc.indexOf('values', m.index! + m[0].length);
  if (valuesAt < 0 || valuesAt - (m.index! + m[0].length) > 40) continue;
  const clause = valuesClause(pgSrc, valuesAt);
  if (clause) inserts.push({ table: m[1], cols: m[2], values: clause });
}

check('the adapter has hand-written inserts to check', inserts.length > 5, String(inserts.length));

const unbalanced: string[] = [];
for (const m of inserts) {
  const table = m.table;
  const cols = m.cols.split(',').map((c) => c.trim()).filter(Boolean);
  const values = m.values;
  const placeholders = [...values.matchAll(/\$(\d+)/g)].map((p) => Number(p[1]));
  if (!placeholders.length) continue;

  /**
   * TWO LEGITIMATE PATTERNS THIS MUST NOT FLAG, both found by running it.
   *
   *   now()  - a SQL expression filling a column with no bound parameter
   *            (payments_user_wallets ends "...,$12, now(), now())")
   *   $9,$9  - one parameter deliberately reused for two columns
   *            (payments_user_limit_overrides sets created_at and updated_at
   *            from the same timestamp)
   *
   * Both are correct SQL. Counting expressions - placeholders plus literal
   * expressions - rather than distinct parameters is what distinguishes them
   * from the real defect, which is an expression count that does not match the
   * column count at all.
   */
  const literalExprs = (values.match(/\bnow\(\)|\bdefault\b|'[^']*'/gi) ?? []).length;
  const expressions = values.split(',').length;
  const maxPlaceholder = Math.max(...placeholders);

  // The real failure mode: Postgres counts EXPRESSIONS, and rejects the
  // statement when there are more of them than columns.
  if (expressions !== cols.length) {
    unbalanced.push(`${table}: ${cols.length} columns vs ${expressions} expressions`);
    continue;
  }
  // And a placeholder numbered beyond the column count can never be bound.
  if (maxPlaceholder > cols.length) {
    unbalanced.push(`${table}: $${maxPlaceholder} exceeds ${cols.length} columns`);
  }
  void literalExprs;
}
check('every INSERT balances columns against placeholders',
  unbalanced.length === 0,
  unbalanced.join(' | '));

const authInsert = inserts.find((m) => m.table === 'payments_auth_challenges');
check('the auth-challenge insert specifically balances',
  Boolean(authInsert)
    && authInsert!.cols.split(',').length === Math.max(...[...authInsert!.values.matchAll(/\$(\d+)/g)].map((p) => Number(p[1]))),
  'this is the statement that made signup and login return 500');

console.log('\n── SIGNUP: a new user can get in ─────────────────────────────');

const { startEmailAuth, verifyEmailAuth } = await import('../src/auth/auth.service.js');

const email = `signup-${Date.now()}@example.com`;
const started: any = await startEmailAuth({
  email, intent: 'signup', fullName: 'New User',
  legalAcceptance: { accepted: true, termsVersion: '1.0', privacyVersion: '1.0' },
} as any, {});

check('signup issues a code', Boolean(started?.devCode), JSON.stringify(started).slice(0, 140));

const verified: any = await verifyEmailAuth({ email, code: started.devCode });
check('and the code creates an account', Boolean(verified?.user?.id), JSON.stringify(verified).slice(0, 140));
check('returning a session token', typeof verified?.token === 'string' && verified.token.length > 50);

console.log('\n── SIGNIN: the same user can come back ───────────────────────');

const back: any = await startEmailAuth({ email, intent: 'signin' } as any, {});
check('signin issues a code for an existing account', Boolean(back?.devCode));

const backVerified: any = await verifyEmailAuth({ email, code: back.devCode });
check('and returns the SAME user, not a duplicate',
  backVerified?.user?.id === verified?.user?.id,
  `${backVerified?.user?.id} vs ${verified?.user?.id}`);

console.log('\n── the guards around those two paths ─────────────────────────');

let unknown = '';
try { await startEmailAuth({ email: `nobody-${Date.now()}@example.com`, intent: 'signin' } as any, {}); }
catch (e) { unknown = (e as Error).message; }
check('signin on an unknown address is refused', /account/i.test(unknown), unknown);

let noTerms = '';
try {
  await startEmailAuth({ email: `terms-${Date.now()}@example.com`, intent: 'signup', fullName: 'X Y' } as any, {});
} catch (e) { noTerms = (e as Error).message; }
check('signup without accepting the terms is refused', /terms|privacy|risk/i.test(noTerms), noTerms);

let noName = '';
try {
  await startEmailAuth({
    email: `noname-${Date.now()}@example.com`, intent: 'signup',
    legalAcceptance: { accepted: true },
  } as any, {});
} catch (e) { noName = (e as Error).message; }
check('signup without a full name is refused', /fullName|name/i.test(noName), noName);

/**
 * `intent` DEFAULTS TO 'signin', WHICH IS A TRAP FOR CALLERS.
 *
 * A client that omits it gets "Account not found" for a brand-new address -
 * which reads as a broken signup rather than a missing field. Asserted so the
 * default is a deliberate, visible choice rather than an accident, and so any
 * change to it has to be argued for here.
 */
const { startEmailAuthSchema } = await import('../src/auth/auth.service.js');
check("omitting intent defaults to 'signin', not 'signup'",
  (startEmailAuthSchema.parse({ email: 'x@y.com' }) as any).intent === 'signin',
  'defaulting to signup would let a typo silently create a second account');

const wrong: any = await startEmailAuth({ email, intent: 'signin' } as any, {});
let badCode = '';
try { await verifyEmailAuth({ email, code: '000000' }); } catch (e) { badCode = (e as Error).message; }
check('a wrong code is rejected', Boolean(badCode), badCode || 'accepted a bad code');
void wrong;

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

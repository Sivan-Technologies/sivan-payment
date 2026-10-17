// Backend assertions retained; legacy UI checks moved to docs/legacy-frontend-tests.
/**
 * "I'LL SEND CRYPTO MYSELF" IS NOW ADMIN-CONTROLLED, AND OFF.
 *
 * Requested for launch: run withdrawals from the Sivan balance only. The
 * manual-funding button is the path that produced "its got delivered to the
 * breet sandbox but i kept seeing waiting for your asset till now" - it shows
 * a bare deposit address with no balance check, while the balance path shows a
 * concrete "60.00 USDC available to withdraw".
 *
 * WHAT THIS FLAG HONESTLY DOES.
 *
 * It hides the manual-funding INSTRUCTIONS. There is no separate server path
 * to disable: both buttons POST the same /api/ngn/offramp/orders, the server
 * mints a deposit address either way, and ngn-transfers.service.ts always
 * calls scheduleSweep() from the user's balance. The deposit address stays
 * valid and still settles - its own comment says so. Refusing externally
 * funded deposits would mean rejecting money already settled on chain, which
 * loses user funds; that is not a pre-launch change.
 *
 * Run: npm run test:external-funding-toggle
 */

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-external-funding.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.WALLET_PROVIDER = 'mock';
process.env.APP_ENV = 'development';
process.env.ADMIN_API_KEY = 'extfund-admin-key';
process.env.USER_JWT_SECRET = 'extfund-jwt-secret-value-long-enough';
process.env.RATE_LIMIT_ENABLED = 'false';
/**
 * /api/ngn/* is user-authenticated (app.ts requiresUserAuth), and correctly so.
 * This suite is about the VALUE of the flag, not about who may read it, so the
 * user gate is lifted rather than minting a token - the auth behaviour has its
 * own coverage and duplicating it here would test the wrong thing.
 */
process.env.AUTH_REQUIRE_USER = 'false';

import fs from 'node:fs';
fs.rmSync('.data/test-external-funding.json', { force: true });

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const { buildApp } = await import('../src/app.js');
const { getNgnControls, updateNgnControls } = await import('../src/ngn/service/ngn-controls.service.js');

const app = await buildApp();
const ADMIN = { 'x-admin-api-key': 'extfund-admin-key' };

console.log('\n── the launch default is OFF ─────────────────────────────────');

const defaults = await getNgnControls();
check('externalFundingEnabled defaults to false',
  defaults.externalFundingEnabled === false,
  String(defaults.externalFundingEnabled) + ' - an unseeded deployment must not expose the withdrawn flow');

const netOff = await app.inject({ method: 'GET', url: '/api/ngn/networks?asset=usdc' });
const bodyOff = netOff.json().data as Record<string, unknown>;
check('GET /api/ngn/networks reports it to the client',
  'externalFundingEnabled' in bodyOff,
  'the withdraw form already awaits this call; a second endpoint would be a second thing that fails');
check('and reports false',
  bodyOff.externalFundingEnabled === false,
  JSON.stringify(bodyOff.externalFundingEnabled));

console.log('\n── an admin can turn it back on, no deploy ───────────────────');

await updateNgnControls({ externalFundingEnabled: true } as any);
const netOn = await app.inject({ method: 'GET', url: '/api/ngn/networks?asset=usdc' });
check('flipping the control flips the served value',
  (netOn.json().data as any).externalFundingEnabled === true,
  'the whole point is that this is reversible from the admin hub');

const roundTrip = await app.inject({ method: 'GET', url: '/api/admin/ngn/controls', headers: ADMIN });
check('and it round-trips through the admin controls endpoint',
  (roundTrip.json().data as any).externalFundingEnabled === true);

await updateNgnControls({ externalFundingEnabled: false } as any);
check('and back off again',
  ((await app.inject({ method: 'GET', url: '/api/ngn/networks?asset=usdc' })).json().data as any).externalFundingEnabled === false);

// Legacy UI assertions are retained in docs/legacy-frontend-tests; standalone coverage owns the UI.
console.log('\n── it fails CLOSED ───────────────────────────────────────────');

const routes = fs.readFileSync('src/ngn/api/ngn.routes.ts', 'utf8');
check('a failed controls read hides the button rather than showing it',
  /getNgnControls\(\)\.catch\(\(\) => null\)/.test(routes)
  && /externalFundingEnabled: ngnControls\?\.externalFundingEnabled \?\? false/.test(routes),
  'a database blip must not surface the one flow the founders withdrew');

// Legacy UI assertions are retained in docs/legacy-frontend-tests; standalone coverage owns the UI.
console.log('\n── persistence ───────────────────────────────────────────────');

const migration = fs.readFileSync('database/migrations/045_add_ngn_external_funding_toggle.sql', 'utf8');
check('the column is not null default false',
  /external_funding_enabled boolean not null default false/.test(migration),
  'existing rows must adopt launch behaviour with no backfill');
check('the migration is idempotent',
  /add column if not exists/.test(migration));

const pg = fs.readFileSync('src/database/postgres-database.ts', 'utf8');
check('postgres reads the column',
  pg.includes('externalFundingEnabled: Boolean(row.external_funding_enabled)'));
check('postgres writes the column',
  pg.includes('external_funding_enabled=excluded.external_funding_enabled'),
  'a read without a write silently reverts the toggle on next save');

await app.close();

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

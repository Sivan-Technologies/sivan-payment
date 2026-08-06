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

console.log('\n── the UI hides rather than disables ─────────────────────────');

const form = fs.readFileSync('frontend/src/components/sell/NgnPayoutForm.tsx', 'utf8');

check('the funding toggle is wrapped in the flag',
  /\{canFundExternally && \(\s*<div className="seg"/.test(form),
  'it must not render at all - a greyed button asks "why can\'t I click this?"');
check('the flag is read with === true, never truthiness',
  form.includes('externalFundingEnabled === true'),
  'an older API omits the field; undefined must read as OFF, and `!!undefined` is not the danger - a default-on would be');
/**
 * The DISABLED-instead-of-hidden regression, asserted directly. Someone
 * "fixing" this later by adding `disabled={!canFundExternally}` would satisfy
 * a naive test while reintroducing the support ticket this avoids.
 */
check('the manual button is not merely disabled',
  !/I'll send crypto myself[\s\S]{0,200}disabled=/.test(form) && !/disabled=\{!canFundExternally\}/.test(form),
  'hidden, not disabled - see the comment above the group');

/**
 * FOUND BY GREPPING THE BUILT BUNDLE, NOT THE SOURCE DIFF.
 *
 * The over-balance error unconditionally said 'or choose "I'll send crypto
 * myself"'. With that button hidden, the message names a control the user
 * cannot see, which reads as the app being broken - worse than saying nothing.
 */
const overBalanceMsg = form.slice(form.indexOf('if (overBalance)'), form.indexOf('setQuoting(true)'));
check('the over-balance error does not name a hidden button',
  /canFundExternally/.test(overBalanceMsg) && /Lower the amount to continue/.test(overBalanceMsg),
  'advice must match the buttons actually on screen');

/**
 * CAUGHT BY LOOKING AT THE SCREENSHOT, not by any assertion.
 *
 * "Send USDC on the network you actually hold it on" is manual-funding
 * language - it instructs a transfer. Under balance funding the user sends
 * nothing. Code and tests were both green while the screen told the user to
 * do something the flow no longer asks of them.
 */
check('the network hint does not instruct a manual send when funding from balance',
  /canFundExternally[\s\S]{0,400}Choose the network holding your/.test(form),
  'the hint must describe the flow the user is actually in');

console.log('\n── the external code path is KEPT, not deleted ───────────────');

/**
 * Explicitly asserted because the obvious way to satisfy "turn this off" is to
 * delete the branch, and then turning it back on is a rewrite rather than a
 * toggle.
 */
check("the 'external' branch still exists in the form",
  form.includes("fundingSource === 'external'"),
  'gated, not removed - it works and comes back when deposit-address UX is solid');
check('the review screen still handles external funding',
  fs.readFileSync('frontend/src/components/AppSections.tsx', 'utf8').includes("review.fundingSource !== 'balance'"));

console.log('\n── it fails CLOSED ───────────────────────────────────────────');

const routes = fs.readFileSync('src/ngn/api/ngn.routes.ts', 'utf8');
check('a failed controls read hides the button rather than showing it',
  /getNgnControls\(\)\.catch\(\(\) => null\)/.test(routes)
  && /externalFundingEnabled: ngnControls\?\.externalFundingEnabled \?\? false/.test(routes),
  'a database blip must not surface the one flow the founders withdrew');

const rails = fs.readFileSync('frontend/src/rails.ts', 'utf8');
check('the client type marks it optional, so an old API reads as off',
  /externalFundingEnabled\?: boolean/.test(rails));

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

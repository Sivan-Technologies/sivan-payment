/**
 * THE TERMS STEP, ON THE ACTUAL SCREEN.
 *
 * "Tos should not be hidden and let put it in the verification page as one of
 * the cateria to do so once user finish verification they should sign the Tos
 * as well"
 *
 * The unit tests prove the server refuses and the summary reports. Neither can
 * see what the page RENDERS, and every previous bug on this screen - the
 * disabled "Start verification" button beside a ✓, the Level-1 badge next to a
 * Level-2 API response - was invisible in the code and obvious in a
 * screenshot.
 *
 * WHAT THIS HAS TO CATCH:
 *   - the Terms row exists at all (it was hidden for Nigerians)
 *   - its control is CLICKABLE (it was a disabled button for everyone)
 *   - the page does not claim the user is finished while terms are pending
 *   - and it flips to done once accepted
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const API = process.env.API || 'http://127.0.0.1:4720';
const APP = process.env.APP || 'http://127.0.0.1:4173';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const j = { 'content-type': 'application/json' };
const post = (p, b, h = {}) => fetch(`${API}${p}`, { method: 'POST', headers: { ...j, ...h }, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, h = {}) => fetch(`${API}${p}`, { method: 'PUT', headers: { ...j, ...h }, body: JSON.stringify(b) }).then(r => r.json());
const ADM = { 'x-admin-api-key': 'e2e-admin-key' };

/**
 * THE SEEDED USER. See terms-step-journey.sh for why the state is written to
 * the database file rather than built over HTTP: the mock Bridge provider
 * approves everything, so "KYC approved but terms outstanding" cannot be
 * reached through the API.
 *
 * A NIGERIAN, deliberately - country NG makes `isNgnPath` true, which is the
 * exact condition the old page used to HIDE this row. They then took the
 * Bridge route (the documented way to reach USD/GBP/EUR rails, offered by a
 * button on this very page), so they have a Bridge customer and a real terms
 * obligation the screen refused to show.
 */
const USER_ID = 'usr_terms';
const EMAIL = 'terms-journey@example.com';

const start = await post('/api/auth/email/start', { email: EMAIL, intent: 'signin' });
const v = await post('/api/auth/email/verify', { email: EMAIL, code: start.data.devCode });
const user = v.data.user;
const token = v.data.token;
if (!token) { console.error('sign-in failed', JSON.stringify(v).slice(0, 300)); process.exit(1); }

let cust = await fetch(`${API}/api/customers/${USER_ID}`).then(r => r.json());
console.log(`  customer: kyc=${cust?.data?.kycStatus} tos=${cust?.data?.tosStatus} link=${cust?.data?.tosLink ? 'yes' : 'no'}`);

const summaryPending = await fetch(`${API}/api/users/${USER_ID}/verification-summary`).then(r => r.json());
console.log(`  summary.terms: ${JSON.stringify(summaryPending?.data?.terms ?? summaryPending?.terms)}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(APP);
await page.evaluate(([t, u]) => {
  localStorage.setItem('sivan.authToken', t);
  localStorage.setItem('sivan.user', u);
}, [token, JSON.stringify(user)]);
await page.goto(`${APP}/verification`);
await page.waitForTimeout(3500);
fs.mkdirSync('e2e/shots', { recursive: true });
await page.screenshot({ path: 'e2e/shots/terms-pending.png', fullPage: true });

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the step is VISIBLE, to the user who was denied it ────');

let text = await page.locator('body').innerText();
check('the verification page mentions the provider terms at all',
  /provider terms/i.test(text),
  text.split('\n').filter((l) => /term/i.test(l)).join(' | ') || '(no line mentions terms)');

const termsRow = page.locator('.verification-step', { hasText: /Accept provider terms/i });
check('a Terms row is rendered in the step list', await termsRow.count() > 0);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. and it is ACTIONABLE, not a disabled label ────────────');

/**
 * THE ORIGINAL BUG. VerificationStep renders `<button disabled>` always, so
 * the step existed on the Bridge path and could not be used. An assertion that
 * only checked "a Terms row exists" would have passed against the broken
 * build.
 */
const acceptLink = termsRow.locator('a', { hasText: /Accept terms/i });
const acceptCount = await acceptLink.count();
check('the row offers a clickable "Accept terms" control', acceptCount > 0,
  `found ${acceptCount}; the old row rendered a permanently disabled button`);

if (acceptCount > 0) {
  const href = await acceptLink.first().getAttribute('href');
  check('and it points at a real terms URL', Boolean(href && /^https?:/.test(href)), String(href));
  check('and opens in a new tab rather than losing the page',
    (await acceptLink.first().getAttribute('target')) === '_blank');
  check('the control is genuinely enabled',
    await acceptLink.first().isEnabled());
}

// The disabled-button regression, stated directly.
const disabledTerms = await termsRow.locator('button:disabled').count();
check('the row does NOT render a disabled button as its only control',
  acceptCount > 0 || disabledTerms === 0,
  `${disabledTerms} disabled button(s) in the terms row`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. the page does not claim the user is finished ──────────');

check('a banner tells the user terms are outstanding',
  /Accept the provider terms/i.test(text),
  'without this the only cue is a row far down the page');
check('the page does NOT say the account is ready',
  !/Account ready/i.test(text),
  'KycOutcomeNotice renders a green ready card off kycStatus alone');
/**
 * The progress percentage is the headline claim on this screen. Terms are one
 * of four steps, so an outstanding acceptance cannot read as 100%.
 */
const pctMatch = text.match(/(\d+)% complete/);
check('progress is under 100% while terms are pending',
  pctMatch && Number(pctMatch[1]) < 100, pctMatch ? pctMatch[0] : '(no percentage found)');

/**
 * THE EXACT FIGURE, because "< 100" hid a real bug.
 *
 * This user has email, identity and payout bank done, and only terms
 * outstanding: 3 of 4, so 75%. The first version of this change reported 50%
 * - the page derived its identity tick from `pathComplete`, which now
 * includes terms, so a verified identity was counted as unfinished. Every
 * assertion here passed anyway; only the screenshot showed it.
 *
 * Asserting the number pins the arithmetic instead of its direction.
 */
check('and reports the RIGHT number - 3 of 4 steps done, not fewer',
  pctMatch && Number(pctMatch[1]) === 75,
  `${pctMatch?.[0]} - email+identity+bank are done, only terms are not`);

/**
 * The self-contradicting row from that same screenshot: a green "Verified"
 * badge beside an un-ticked "2" circle. The identity step is DONE and must
 * render done, whatever the terms say.
 */
const identityRow = page.locator('.verification-step', { hasText: /Bank verification|Identity verification/i });
check('the identity step renders as DONE even while terms are pending',
  await identityRow.first().evaluate((el) => el.classList.contains('done')).catch(() => false),
  'terms are a separate step; they must not un-tick a completed identity check');

/**
 * AND NO LINE ON THE PAGE MAY PROMISE WHAT TERMS ARE BLOCKING.
 *
 * The verification-summary card printed "You are verified. You can now add a
 * bank account and use Sivan payment features" off the Bridge KYC field
 * alone - directly beneath a "Terms: Pending" row, on a screen where both of
 * those actions were being refused. Found in the screenshot after every
 * assertion above was already green.
 */
check('nothing claims the user can already add a bank or transact',
  !/You can now add a bank account/i.test(text),
  text.split('\n').filter((l) => /can now/i.test(l)).join(' | '));

check('no page errors', errors.length === 0, errors.join(' | '));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. accepting the terms completes the step ────────────────');

/**
 * ACCEPT THE TERMS through the REAL route the app itself uses when the user
 * returns from Bridge: the admin KYC-status refresh, which calls
 * refreshKycStatus() and re-reads the provider. Under the mock provider that
 * reports terms accepted - the same code path production runs, not a direct
 * database poke.
 */
const refreshed = await post(`/api/admin/customers/${USER_ID}/kyc-status`, {}, ADM);
console.log(`  after refresh: tos=${refreshed?.data?.tosStatus}`);

await page.reload();
await page.waitForTimeout(3500);
await page.screenshot({ path: 'e2e/shots/terms-accepted.png', fullPage: true });
text = await page.locator('body').innerText();

check('the outstanding-terms banner is gone',
  !/Accept the provider terms/i.test(text),
  text.split('\n').filter((l) => /term/i.test(l)).join(' | '));
const doneRow = page.locator('.verification-step.done', { hasText: /Accept provider terms/i });
check('the Terms row is now marked done', await doneRow.count() > 0);
const pctAfter = text.match(/(\d+)% complete/);
check('and the progress reaches 100% once accepted',
  pctAfter && Number(pctAfter[1]) === 100,
  `${pctMatch?.[0]} -> ${pctAfter?.[0]}`);

await browser.close();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

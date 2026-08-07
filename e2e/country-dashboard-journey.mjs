/**
 * A US USER MUST NEVER SEE NAIRA.
 *
 * Reported with a photo of the dashboard: an American who had just signed up
 * was shown
 *
 *     WITHDRAWN TO NAIRA · LAST 30 DAYS
 *     ₦0 left
 *     ₦0 of ₦0 used.
 *
 * beside "Verification summary / Not started". Bridge has no naira rail and
 * payoutRailFor() has always refused to route a non-Nigerian there, so that
 * heading names a currency the user can never transact in - and the ₦0 reads
 * as "you have spent your allowance" rather than "you have not verified yet".
 *
 * The server was already right: GET /verification-summary returns
 * path: 'bridge_kyc' for a US user. The dashboard hardcoded rail === 'ngn'
 * when picking which allowance to render.
 *
 * Both countries are driven here, in one run, because the failure mode is a
 * REGRESSION IN EITHER DIRECTION: fixing the American by hiding the card would
 * break the Nigerian, who genuinely needs to see a naira ceiling.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const API = process.env.API || 'http://127.0.0.1:4713';
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

async function makeUser(country, fullName) {
  const email = `${country.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const start = await post('/api/auth/email/start', {
    email, intent: 'signup', fullName,
    legalAcceptance: { accepted: true, termsVersion: '1.0', privacyVersion: '1.0' },
  });
  const v = await post('/api/auth/email/verify', { email, code: start.data.devCode });
  await put(`/api/users/${v.data.user.id}/country`, { country });
  return { user: { ...v.data.user, country }, token: v.data.token };
}

const browser = await chromium.launch();
fs.mkdirSync('e2e/shots', { recursive: true });

async function dashboardText(session, shot) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(APP);
  await page.evaluate(([t, u]) => {
    localStorage.setItem('sivan.authToken', t);
    localStorage.setItem('sivan.user', u);
  }, [session.token, JSON.stringify(session.user)]);
  await page.goto(`${APP}/dashboard`);
  await page.waitForTimeout(3000);
  const text = await page.locator('body').innerText();
  await page.screenshot({ path: `e2e/shots/${shot}.png`, fullPage: true });
  await page.close();
  return { text, errors: errors.filter((e) => !/favicon|404|Failed to load resource/i.test(e)) };
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. a brand-new US user ──────────────────────────────────');

const us = await makeUser('US', 'John Miller');
const usPlan = await fetch(`${API}/api/users/${us.user.id}/verification-summary`).then(r => r.json());
check('the SERVER routes them to Bridge', usPlan.data.path === 'bridge_kyc', usPlan.data.path);

const usDash = await dashboardText(us, 'dashboard-us');

// The exact strings from the reported screenshot.
check('the dashboard shows NO naira symbol at all',
  !usDash.text.includes('₦'),
  usDash.text.split('\n').filter((l) => l.includes('₦')).join(' | '));
check('no "Withdrawn to naira" heading',
  !/withdrawn to naira/i.test(usDash.text));
check('no "₦0 left"', !/₦0 left/i.test(usDash.text));
check('no "₦0 of ₦0 used"', !/₦0 of ₦0 used/i.test(usDash.text));

// And the positive: it must say something USEFUL instead of nothing.
check('a locked limit is explained, not shown as a spent bar',
  /Not unlocked yet/i.test(usDash.text) || /Verification/i.test(usDash.text),
  usDash.text.slice(0, 400));
check('no uncaught page errors (US)', usDash.errors.length === 0, usDash.errors.slice(0, 2).join(' | '));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. a Nigerian user still sees naira ─────────────────────');

const ng = await makeUser('NG', 'OGUNMEPON SHARAFA');
const ngPlan = await fetch(`${API}/api/users/${ng.user.id}/verification-summary`).then(r => r.json());
check('the SERVER routes them to the bank path', ngPlan.data.path === 'ngn_bank', ngPlan.data.path);

// Give them a verified bank so they have a REAL non-zero naira ceiling -
// otherwise this asserts the locked state and proves nothing about currency.
await post('/api/ngn/payout-accounts', { userId: ng.user.id, bankId: '1', accountNumber: '1111111111' });
const accounts = await fetch(`${API}/api/ngn/payout-accounts?userId=${ng.user.id}`).then(r => r.json());
await put(`/api/admin/ngn/payout-accounts/${accounts.data[0].id}/review`, { decision: 'approve' }, ADM);

const ngSummary = await fetch(`${API}/api/users/${ng.user.id}/verification-summary`).then(r => r.json());
const ngOfframp = ngSummary.data.allowances.find((a) => a.flow === 'offramp' && a.rail === 'ngn');
check('they have a real non-zero naira ceiling', ngOfframp.limitNgn > 0, String(ngOfframp.limitNgn));

const ngDash = await dashboardText(ng, 'dashboard-ng');
check('the Nigerian DOES see naira', ngDash.text.includes('₦'), ngDash.text.slice(0, 300));
// The dashboard renders the KPI card ("YOUR LIMIT / ₦100,000 left"), not the
// verification page's "Withdrawn to naira" card - those are two different
// components. Asserting the latter here was asserting my own mental model
// rather than the screen, and it failed on correct code. Verified against the
// rendered screenshot.
check('the naira limit KPI is present',
  /YOUR LIMIT/i.test(ngDash.text) && /left/i.test(ngDash.text), ngDash.text.slice(0, 500));
check('with their actual ceiling, not zero',
  new RegExp(`₦${ngOfframp.limitNgn.toLocaleString('en-NG')}`).test(ngDash.text)
  || /₦100,000/.test(ngDash.text),
  ngDash.text.split('\n').filter((l) => l.includes('₦')).join(' | '));
check('no uncaught page errors (NG)', ngDash.errors.length === 0, ngDash.errors.slice(0, 2).join(' | '));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. a user who has not picked a country yet ──────────────');

/**
 * Country is collected in the VERIFICATION MODAL, not at signup - so between
 * creating an account and opening that modal, every user has country
 * undefined. verificationPathFor() sends them to bridge_kyc, which means they
 * must not see naira either. This is the state the reported screenshot was
 * most likely taken in.
 */
const email = `nocountry-${Date.now()}@example.com`;
const s = await post('/api/auth/email/start', {
  email, intent: 'signup', fullName: 'Pat Nobody',
  legalAcceptance: { accepted: true, termsVersion: '1.0', privacyVersion: '1.0' },
});
const v = await post('/api/auth/email/verify', { email, code: s.data.devCode });
check('a fresh signup genuinely has no country', !v.data.user.country, String(v.data.user.country));

const none = await dashboardText({ user: v.data.user, token: v.data.token }, 'dashboard-nocountry');
check('a country-less user is shown no naira either',
  !none.text.includes('₦'),
  none.text.split('\n').filter((l) => l.includes('₦')).join(' | '));
check('no uncaught page errors (no country)', none.errors.length === 0, none.errors.slice(0, 2).join(' | '));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. the VERIFICATION page (where the report came from) ────');

/**
 * The reported photo shows "Start verification / Contact support" above the
 * naira card and "Verification summary / Not started" below it - that is
 * /verification, not the dashboard. It renders VerificationLimitCard, which
 * hardcoded the naira allowance and the "Withdrawn to naira" heading.
 */
async function verificationText(session, shot) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1300 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(APP);
  await page.evaluate(([t, u]) => {
    localStorage.setItem('sivan.authToken', t);
    localStorage.setItem('sivan.user', u);
  }, [session.token, JSON.stringify(session.user)]);
  await page.goto(`${APP}/verification`);
  await page.waitForTimeout(3000);
  const text = await page.locator('body').innerText();
  await page.screenshot({ path: `e2e/shots/${shot}.png`, fullPage: true });
  await page.close();
  return { text, errors: errs.filter((e) => !/favicon|404|Failed to load resource/i.test(e)) };
}

const usVer = await verificationText(us, 'verification-us');
check('/verification shows no naira to a US user',
  !usVer.text.includes('₦'),
  usVer.text.split('\n').filter((l) => l.includes('₦')).join(' | '));
check('no "Withdrawn to naira" on /verification either',
  !/withdrawn to naira/i.test(usVer.text));
check('the locked state is explained rather than shown as ₦0',
  /Not unlocked yet/i.test(usVer.text), usVer.text.slice(0, 600));
check('no uncaught page errors (US /verification)', usVer.errors.length === 0, usVer.errors.slice(0, 2).join(' | '));

const ngVer = await verificationText(ng, 'verification-ng');
check('a Nigerian still gets the naira card on /verification',
  /withdrawn to naira/i.test(ngVer.text), ngVer.text.slice(0, 600));
check('with a real ceiling, not zero', /₦100,000/.test(ngVer.text),
  ngVer.text.split('\n').filter((l) => l.includes('₦')).join(' | '));
check('no uncaught page errors (NG /verification)', ngVer.errors.length === 0, ngVer.errors.slice(0, 2).join(' | '));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. a VERIFIED US user - the discriminating case ──────────');

/**
 * THE CASE THAT ACTUALLY PROVES THE RAIL SELECTION.
 *
 * Everything above passes even with the fix reverted, and I only found that
 * by mutation-testing it: a BRAND-NEW US user has ngn=0 AND foreign=0, so the
 * "Not unlocked yet" branch renders either way and the two fixes are
 * indistinguishable. Those assertions test the zero-state copy, not the rail.
 *
 * A US user at IDENTITY level is different by construction:
 *
 *     offramp/ngn      = 0          (no naira rail for a non-Nigerian)
 *     offramp/foreign  = 500,000    (real ceiling, FLOW_LIMITS line 311)
 *
 * Pick the wrong rail and the card says "Not unlocked yet" to somebody who
 * has a live 500,000 allowance - so the number itself is the assertion.
 */
const vus = await makeUser('US', 'Dana Reed');
await post('/api/customers', { userId: vus.user.id, payload: { type: 'individual', first_name: 'Dana', last_name: 'Reed' } });
await post(`/api/customers/${vus.user.id}/sandbox/simulate-kyc-approval`, {});
await post('/api/external-accounts', {
  userId: vus.user.id, accountType: 'us', currency: 'usd', bankName: 'Chase',
  accountOwnerName: 'Dana Reed', accountOwnerType: 'individual',
  firstName: 'Dana', lastName: 'Reed', paymentRail: 'ach',
  account: { routing_number: '021000021', account_number: '123456789', checking_or_savings: 'checking' },
  address: { street_line_1: '1 Main St', city: 'New York', state: 'NY', postal_code: '10001', country: 'USA' },
});

const vSummary = await fetch(`${API}/api/users/${vus.user.id}/verification-summary`).then(r => r.json());
const vNgn = vSummary.data.allowances.find((a) => a.flow === 'offramp' && a.rail === 'ngn');
const vForeign = vSummary.data.allowances.find((a) => a.flow === 'offramp' && a.rail === 'foreign');

/**
 * NOTE ON WHY THIS USER'S TWO RAILS MATCH.
 *
 * I expected ngn=0 / foreign=500,000 here and asserted it. Wrong: this user
 * clears UPLIFT, and upliftApplies raises BOTH rails to UPLIFT_CEILING_NGN
 * (10,000,000). That is real product behaviour, not test configuration - so
 * the assertion was wrong, not the code.
 *
 * The rail selection is therefore proven by the NIGERIAN Level 1 case in
 * section 6, where the two rails genuinely differ (ngn=100,000, foreign=0)
 * without anything being forced.
 */
check('a fully verified US user gets the uplift ceiling on the foreign rail',
  vForeign.limitNgn === 10_000_000, String(vForeign.limitNgn));

const vVer = await verificationText(vus, 'verification-us-verified');
check('the card shows the FOREIGN allowance, not the naira one',
  !/Not unlocked yet/i.test(vVer.text),
  'rendering the ngn row here would wrongly say "Not unlocked yet"');
check('the real foreign ceiling is on screen',
  vVer.text.includes(vForeign.limitNgn.toLocaleString('en-US')),
  vVer.text.slice(0, 700));
check('and still no naira symbol', !vVer.text.includes('₦'),
  vVer.text.split('\n').filter((l) => l.includes('₦')).join(' | '));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5b. the verified US DASHBOARD notice ─────────────────────');

/**
 * The "Account status / verified" notice on the dashboard appends a headroom
 * sentence, and it read the NAIRA allowance for every user - so a verified
 * American was told "You can withdraw up to ₦0 in the next 30 days".
 *
 * This section exists because mutation-testing caught that ungating it
 * changed nothing: no earlier section reaches this branch, which only renders
 * once summary.pathComplete is true. Sections 1-4 use unverified users.
 */
const vusDash = await dashboardText(vus, 'dashboard-us-verified');
check('a VERIFIED US user sees no naira on the dashboard',
  !vusDash.text.includes('₦'),
  vusDash.text.split('\n').filter((l) => l.includes('₦')).join(' | '));
check('the headroom sentence does not quote a naira figure',
  !/withdraw up to ₦/i.test(vusDash.text),
  vusDash.text.slice(0, 500));
check('they are still told they can withdraw',
  /withdraw/i.test(vusDash.text));
check('no uncaught page errors (verified US)', vusDash.errors.length === 0,
  vusDash.errors.slice(0, 2).join(' | '));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 6. THE DISCRIMINATING CASE: Nigerian, Level 1 ────────────');

/**
 * THE ONLY SECTION THAT ACTUALLY PROVES THE RAIL SELECTION.
 *
 * Found by mutation-testing: with `railForPath` reverted to a hardcoded
 * 'ngn', sections 1-5 ALL STILL PASSED. A brand-new US user has ngn=0 and
 * foreign=0, so the "Not unlocked yet" branch renders either way; a fully
 * verified one has both rails at the uplift ceiling. In both cases the two
 * allowances are identical and the card looks the same whichever it picks.
 *
 * The Nigerian at Level 1 is the one state where they genuinely differ, with
 * nothing forced:
 *
 *     offramp/ngn      = 100,000   (bank verified)
 *     offramp/foreign  = 0         (foreign rails need IDENTITY)
 *
 * So: picking the wrong rail here shows "Not unlocked yet" to a user who has
 * a live ₦100,000 allowance. That is an assertion the mutation cannot survive.
 */
const ngSum = await fetch(`${API}/api/users/${ng.user.id}/verification-summary`).then(r => r.json());
const nNgn = ngSum.data.allowances.find((a) => a.flow === 'offramp' && a.rail === 'ngn');
const nForeign = ngSum.data.allowances.find((a) => a.flow === 'offramp' && a.rail === 'foreign');
check('their naira and foreign ceilings genuinely differ',
  nNgn.limitNgn > 0 && nForeign.limitNgn === 0,
  `ngn=${nNgn.limitNgn} foreign=${nForeign.limitNgn}`);

const nVer = await verificationText(ng, 'verification-ng-level1');
check('the card renders the NAIRA allowance for them',
  !/Not unlocked yet/i.test(nVer.text),
  'picking the foreign rail here would wrongly say "Not unlocked yet"');
check('showing their real naira ceiling', /₦100,000/.test(nVer.text),
  nVer.text.split('\n').filter((l) => l.includes('₦')).join(' | '));
check('with the naira heading', /withdrawn to naira/i.test(nVer.text));

await browser.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

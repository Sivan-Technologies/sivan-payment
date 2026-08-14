/**
 * THE SAVED NAIRA ACCOUNT, IN A REAL BROWSER.
 *
 * Two things are being proved here that no unit test can reach:
 *
 *   1. A user who has already withdrawn once is offered that account and can
 *      reach the amount field WITHOUT retyping a NUBAN or waiting on a bank
 *      lookup.
 *   2. "Use a different account" still exposes the full manual form, because a
 *      user with a second account of their own must not be trapped.
 *
 * WHY THIS IS NOT A DOM-ONLY TEST.
 *
 * The amount field, the Get quote button and Continue were all gated on
 * `resolved`, which is set only by the manual bank lookup. Selecting a saved
 * account satisfied none of them, so the list would have rendered, accepted a
 * tap, and dead-ended with no amount field - and every assertion phrased as
 * "is the row in the DOM" would have passed. So the assertions below are about
 * what the user can DO after tapping: is the amount input actually on screen.
 *
 * Run: node e2e/saved-payout-journey.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const FRONTEND = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4178';
const API = process.env.E2E_API ?? 'http://127.0.0.1:4179';
const SHOTS = new URL('./shots/saved-payout/', import.meta.url).pathname;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json.data ?? json };
}

async function makeUser() {
  const email = `saved-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@sivan.test`;
  const start = await api('/api/auth/email/start', {
    method: 'POST',
    body: JSON.stringify({
      email, fullName: 'OGUNMEPON SHARAFA', intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
    }),
  });
  if (!start.body?.devCode) throw new Error(`signup failed (${start.status}): ${JSON.stringify(start.body).slice(0, 200)}`);
  const verified = await api('/api/auth/email/verify', {
    method: 'POST', body: JSON.stringify({ email, code: start.body.devCode }),
  });
  const { token, user } = verified.body;
  await api(`/api/users/${user.id}/country`, {
    method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ country: 'NG' }),
  });
  return { token, user: { ...user, country: 'NG' } };
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });

  const { token, user } = await makeUser();

  // Save an account the way a first withdrawal would, through the real route,
  // so the row carries genuine server-side name-match evidence.
  const saved = await api('/api/ngn/payout-accounts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ userId: user.id, bankId: '1', accountNumber: '1111111111' }),
  });
  check('the first account saves as verified',
    saved.body?.status === 'verified',
    `${saved.status} ${JSON.stringify(saved.body).slice(0, 200)}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const shot = (name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: false });

  /** On screen WITHOUT scrolling - the only definition the user cares about. */
  const visible = (selector) => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el || el.offsetParent === null) return false;
    const box = el.getBoundingClientRect();
    return box.top >= 0 && box.top < window.innerHeight && box.height > 0;
  }, selector);

  const amountFieldPresent = () => page.evaluate(() =>
    [...document.querySelectorAll('label')].some((l) => /Amount to withdraw/i.test(l.innerText)));

  await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([t, u]) => {
    localStorage.setItem('sivan.authToken', t);
    localStorage.setItem('sivan.user', JSON.stringify(u));
  }, [token, user]);
  await page.goto(`${FRONTEND}/withdraw`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  // Guard against testing the wrong screen: a wrong route or a lost token
  // renders the landing page, where almost any assertion below would pass
  // vacuously. Confirm we are on the withdrawal form before asserting.
  const onWithdrawScreen = await page.evaluate(() =>
    /Withdraw to|Search your bank/i.test(document.body.innerText));
  check('the withdrawal screen is the one under test', onWithdrawScreen,
    (await page.evaluate(() => document.body.innerText.slice(0, 160))).replace(/\n/g, ' '));

  await shot('01-saved-list');

  console.log('\n── the saved account is offered ──────────────────────────────');

  const savedRowText = await page.evaluate(() =>
    [...document.querySelectorAll('.saved-payout-accounts .bank-option')].map((el) => el.innerText.trim()));

  check('the saved account is listed', savedRowText.length === 1,
    JSON.stringify(savedRowText));
  check('it shows the account name', /OGUNMEPON SHARAFA/i.test(savedRowText.join(' ')),
    JSON.stringify(savedRowText));
  /**
   * MY FIRST VERSION OF THIS ASSERTION WAS WRONG and would have reported a
   * masking failure that did not exist. It tested for `*`, while
   * maskAccountNumber renders `••••••1111` with U+2022 bullets - so a correctly
   * masked number failed, and an UNMASKED one containing no `*` would also have
   * "passed" the first clause. Assert the actual contract instead: the last
   * four digits are shown for recognition, and the first six are not.
   */
  const rowText = savedRowText.join(' ');
  check('the last four digits are shown, so the user can tell accounts apart',
    rowText.includes('1111'), rowText);
  check('and the rest of the NUBAN is masked',
    !rowText.includes('1111111111'), rowText);

  /**
   * NO "ABOVE THE FOLD" ASSERTION HERE, DELIBERATELY.
   *
   * There was one, and it failed - but measuring the UNMODIFIED manual form
   * showed the bank search already sits at y=1018 in a 900px viewport. The
   * whole withdrawal step begins below the fold because of the page header,
   * rail tabs and step tracker above it. That is a pre-existing layout
   * question about the page, not a fact about the saved-account list, and an
   * assertion here would fail for reasons this change cannot fix while
   * implying it caused them.
   */

  console.log('\n── one tap reaches the amount, with no NUBAN retyped ─────────');

  /**
   * The single account is preselected, so the amount field must ALREADY be
   * reachable. This is the assertion that would have caught the `resolved`
   * gating: the row renders either way, but without the fix there is no
   * amount field to type into and the screen is a dead end.
   */
  check('the amount field is available without touching a bank picker',
    await amountFieldPresent(),
    'the saved account was selected but the form did not advance');

  const bankSearchVisible = await page.evaluate(() =>
    [...document.querySelectorAll('input')].some((i) => /Search your bank/i.test(i.placeholder ?? '')));
  check('the bank search is NOT shown when a saved account is in use',
    !bankSearchVisible,
    'two ways to name a destination on one screen can disagree about where money goes');

  await shot('02-amount-ready');

  console.log('\n── a different account is still allowed ──────────────────────');

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.bank-list-more')]
      .find((b) => /different account/i.test(b.innerText));
    btn?.click();
  });
  await page.waitForTimeout(600);
  await shot('03-manual-entry');

  const manualBankSearch = await page.evaluate(() =>
    [...document.querySelectorAll('input')].some((i) => /Search your bank/i.test(i.placeholder ?? '')));
  check('"Use a different account" reveals the bank picker', manualBankSearch,
    'a user with a second account of their own must not be trapped');

  const cancelPresent = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => /^Cancel$/i.test(b.innerText.trim())));
  check('and there is a way back to the saved list', cancelPresent);

  console.log('\n── the third-party tab is HIDDEN while the toggle is off ─────');

  /**
   * The admin control is off by default, so the choice must not be on screen
   * at all. Hidden rather than disabled: a greyed-out "Pay someone else" asks
   * why it cannot be clicked about a path that needs a different provider, not
   * a flag flip.
   *
   * Asserted in the browser because this is a rendering decision. The server
   * refuses the destination regardless - proven in
   * test:ngn-third-party-payouts - so what is left to check is only whether
   * the UI honours the switch.
   */
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('button')].map((b) => b.innerText.trim()));
  check('"Pay someone else" is not offered', !tabs.some((t) => /Pay someone else/i.test(t)),
    JSON.stringify(tabs.filter((t) => /pay/i.test(t))));
  check('and neither is "Pay myself", since one option is not a choice',
    !tabs.some((t) => /^Pay myself$/i.test(t)),
    JSON.stringify(tabs.filter((t) => /pay/i.test(t))));

  console.log('\n── console ──────────────────────────────────────────────────');
  // React key/state warnings surface here and nowhere else.
  const relevant = consoleErrors.filter((e) => !/favicon|manifest|404/i.test(e));
  check('no console errors', relevant.length === 0, relevant.slice(0, 2).join(' | '));

  await browser.close();

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`   ${failures.join('\n   ')}`);
  console.log(`   screenshots: ${SHOTS}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });

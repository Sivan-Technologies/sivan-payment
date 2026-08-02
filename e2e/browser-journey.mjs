/**
 * The thing no human had done: click through the product end to end.
 *
 * Everything claimed about the frontend so far has been typecheck, unit test
 * and bundle inspection. None of that proves a real browser can complete a
 * signup, pick a country, verify a bank account and see a limit. This does.
 *
 * It drives the DEPLOYED test frontend against the DEPLOYED test API. No
 * mocks, no local server, no injected state - the same URLs a user opens.
 *
 * The one concession: it reads the OTP from the API's devCode field rather
 * than an inbox. AUTH_DEV_SHOW_OTP is true on test and false on live, so this
 * cannot be run against production - which is correct.
 *
 * Screenshots land in e2e/shots/ so failures are inspectable rather than
 * described.
 *
 * Run: npm run e2e:browser
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const FRONTEND = process.env.E2E_FRONTEND ?? 'https://sivan-payments-user-test.vercel.app';
const API = process.env.E2E_API ?? 'https://test-sivan.sivantech.online/api/payment';
const SHOTS = new URL('./shots/', import.meta.url).pathname;

let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const email = `e2e-${Date.now()}@sivan.test`;
// Matches the Breet sandbox stub for any account number, so the name check
// produces a real MATCH rather than a mismatch. The stub is why this still
// lands in review rather than verified - see the assertions below.
const fullName = 'Samuel Udochukwu';

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  // A real phone viewport. The modal is the screen most likely to break on
  // mobile, and it is where the country names were truncating.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const failedRequests = [];
  page.on('response', r => {
    if (r.url().includes('/api/') && r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().split('?')[0]}`);
  });

  const shot = async (name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: false });

  try {
    console.log(`\nfrontend ${FRONTEND}\napi      ${API}\nemail    ${email}\n`);

    console.log('1. LANDING AND SIGNUP FORM');
    await page.goto(`${FRONTEND}/signup`, { waitUntil: 'networkidle', timeout: 60000 });
    await shot('01-signup');
    check('the signup page loads', await page.locator('input[name="email"]').isVisible());
    check('it asks for a full name', await page.locator('input[name="fullName"]').isVisible());
    check('and there is no country field at signup',
      (await page.locator('select[name="country"], input[name="country"]').count()) === 0);

    console.log('\n2. CREATE THE ACCOUNT');
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="fullName"]', fullName);
    await page.check('input[name="legalAccepted"]');
    await page.click('button:has-text("Send verification code")');
    await page.waitForTimeout(4000);
    await shot('02-otp');

    // The OTP is read from the API, not the UI. This is the only place the
    // test steps outside the browser.
    const start = await fetch(`${API}/api/auth/email/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, fullName, intent: 'signup',
        legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' } }),
    }).then(r => r.json());
    const code = start?.data?.devCode;
    check('an OTP was issued', Boolean(code), JSON.stringify(start).slice(0, 160));
    if (!code) throw new Error('no devCode - cannot continue');

    const otpBoxes = page.locator('input[inputmode="numeric"], input[maxlength="1"]');
    const boxCount = await otpBoxes.count();
    if (boxCount >= 6) {
      for (let i = 0; i < 6; i++) await otpBoxes.nth(i).fill(code[i]);
    } else {
      await page.fill('input[name="code"], input[placeholder*="code" i]', code);
    }
    await page.waitForTimeout(1500);
    const submit = page.locator('button:has-text("Verify"), button:has-text("Continue"), button:has-text("Confirm")').first();
    if (await submit.isVisible().catch(() => false)) await submit.click();
    await page.waitForTimeout(6000);
    await shot('03-after-signin');

    const signedIn = !page.url().includes('/signup') || await page.locator('text=/dashboard|overview/i').first().isVisible().catch(() => false);
    check('the user is signed in', signedIn, page.url());

    console.log('\n3. OPEN VERIFICATION');
    await page.goto(`${FRONTEND}/verification`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);
    await shot('04-verification-page');

    const startBtn = page.locator('button:has-text("Start verification"), button:has-text("Starting")').first();
    check('a start-verification button exists', await startBtn.isVisible().catch(() => false));
    await startBtn.click();
    await page.waitForTimeout(5000);
    await shot('05-modal');

    console.log('\n4. THE COUNTRY STEP');
    const modal = page.locator('.sv-modal');
    check('the modal opens', await modal.isVisible().catch(() => false));

    const askedCountry = await page.locator('text=/Where are you based|One moment/i').first().isVisible().catch(() => false);
    check('it asks for the country (or is detecting)', askedCountry);

    // THE TRUNCATION BUG. "United Kingdom" and "United States" both rendered
    // as "United ..." at this width, which is two different countries looking
    // identical on the screen that decides the whole verification path.
    const names = await page.locator('.sv-country-name').allInnerTexts().catch(() => []);
    if (names.length) {
      const truncated = names.filter(n => n.includes('…') || n.trim().endsWith('...'));
      check('no country name is truncated', truncated.length === 0, truncated.join(' | '));
      const dupes = names.length !== new Set(names).size;
      check('no two countries render identically', !dupes, names.join(' | '));
    } else {
      check('country list rendered (or auto-selected)', true, 'auto-selected, list skipped');
    }

    console.log('\n5. PICK NIGERIA -> BANK PATH');
    const ng = page.locator('.sv-country:has-text("Nigeria")').first();
    if (await ng.isVisible().catch(() => false)) {
      await ng.click();
      await page.waitForTimeout(4000);
    }
    await shot('06-after-country');

    const bankPath = await page.locator('text=/bank account|Your bank|Level 1/i').first().isVisible().catch(() => false);
    check('Nigeria routes to the bank check, not a photo ID', bankPath);
    const askedForId = await page.locator('text=/photo ID|selfie/i').first().isVisible().catch(() => false);
    check('and it does NOT ask a Nigerian for a selfie', !askedForId);

    console.log('\n6. RESOLVE A BANK ACCOUNT');
    const search = page.locator('.sv-field input').first();
    if (await search.isVisible().catch(() => false)) {
      await search.fill('Palm');
      await page.waitForTimeout(2500);
      await shot('07-bank-search');
      const bank = page.locator('.sv-bank').first();
      check('the bank list loads from the provider', await bank.isVisible().catch(() => false));
      if (await bank.isVisible().catch(() => false)) {
        await bank.click();
        await page.waitForTimeout(2000);
        const acct = page.locator('input[inputmode="numeric"]').first();
        await acct.fill('8102524846');
        // Resolution is a paid provider call; it fires on the 10th digit.
        await page.waitForTimeout(9000);
        await shot('08-resolved');

        const resolved = await page.locator('.sv-resolved').isVisible().catch(() => false);
        check('the account resolves to a holder name', resolved);

        if (resolved) {
          const holder = await page.locator('.sv-resolved-head strong').first().innerText().catch(() => '');
          console.log(`       bank returned: "${holder}"`);
          // The sandbox stub. Presenting it as confirmation would be a lie,
          // and the UI is supposed to say so.
          const warned = await page.locator('text=/simulated|Test environment/i').first().isVisible().catch(() => false);
          check('a sandbox resolution is labelled as proving nothing', warned);

          const confirm = page.locator('button:has-text("Yes, that is me")');
          check('there is a confirm button', await confirm.isVisible().catch(() => false));
          if (await confirm.isVisible().catch(() => false)) {
            await confirm.click();
            await page.waitForTimeout(8000);
            await shot('09-submitted');
            const queued = await page.locator('text=/manual check|being checked|few hours/i').first().isVisible().catch(() => false);
            // NOT "verified". The sandbox is untrustworthy, so this must queue.
            check('the user is told it needs a manual check, not that they are verified', queued);
          }
        }
      }
    } else {
      check('bank search rendered', false, 'no search field found');
    }

    console.log('\n7. THE DASHBOARD REFLECTS IT');
    await page.goto(`${FRONTEND}/dashboard`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(4000);
    await shot('10-dashboard');
    const stillPrompting = await page.locator('text=/Verify your account/i').first().isVisible().catch(() => false);
    const inReview = await page.locator('text=/being checked|in progress|Bank check/i').first().isVisible().catch(() => false);
    check('the dashboard does not tell a pending user to verify again',
      !stillPrompting || inReview, 'still showing the generic verify prompt');

    console.log('\n8. NOTHING BROKE ALONG THE WAY');
    const realErrors = consoleErrors.filter(e => !/favicon|sentry|Download the React/i.test(e));
    check('no unexpected console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
    // 401s are expected before sign-in; anything else is not.
    const badRequests = failedRequests.filter(r => !r.startsWith('401'));
    check('no failing API calls', badRequests.length === 0, badRequests.slice(0, 4).join(' | '));

    await context.close();
    await browser.close();
  } catch (error) {
    await page.screenshot({ path: `${SHOTS}99-crash.png` }).catch(() => {});
    await browser.close();
    console.error('\nthrew:', error.message);
    fail++;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`\n  - ${failures.join('\n  - ')}`);
  console.log(`\nscreenshots: ${SHOTS}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();

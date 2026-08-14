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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
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

    // INTERCEPT the browser's own response rather than calling the API again.
    //
    // The first version issued a SECOND email/start from the test, which mints
    // a fresh challenge and invalidates the code the UI is waiting on. The
    // screenshot showed the button still reading "Sending secure code..."
    // while the test had already moved on with a code the UI would reject.
    const startResponse = page.waitForResponse(
      r => r.url().includes('/auth/email/start') && r.request().method() === 'POST',
      { timeout: 90000 }
    );
    await page.click('button:has-text("Send verification code")');
    const startBody = await (await startResponse).json().catch(() => null);
    const code = startBody?.data?.devCode;
    check('an OTP was issued', Boolean(code), JSON.stringify(startBody).slice(0, 160));
    if (!code) throw new Error('no devCode - cannot continue');

    // Wait for the UI to actually reach the code screen. A fixed sleep raced
    // a 3s API call and typed into a form that was not there yet.
    await page.waitForSelector('input[inputmode="numeric"], input[maxlength="1"], input[name="code"]', { timeout: 60000 });
    await shot('02-otp');

    const otpBoxes = page.locator('input[inputmode="numeric"], input[maxlength="1"]');
    const boxCount = await otpBoxes.count();
    if (boxCount >= 6) {
      for (let i = 0; i < 6; i++) await otpBoxes.nth(i).fill(code[i]);
    } else {
      await page.fill('input[name="code"], input[placeholder*="code" i]', code);
    }
    const verifyResponse = page.waitForResponse(
      r => r.url().includes('/auth/email/verify') && r.request().method() === 'POST',
      { timeout: 90000 }
    ).catch(() => null);
    const submit = page.locator('button:has-text("Verify"), button:has-text("Continue"), button:has-text("Confirm")').first();
    if (await submit.isVisible().catch(() => false)) await submit.click();
    const verified = await verifyResponse;
    if (verified) check('the verify call succeeded', verified.status() === 200, String(verified.status()));

    // Wait for the app to leave /signup rather than guessing at a duration.
    await page.waitForURL(u => !u.toString().includes('/signup'), { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await shot('03-after-signin');
    check('the user is signed in', !page.url().includes('/signup'), page.url());

    console.log('\n3. OPEN VERIFICATION');
    await page.goto(`${FRONTEND}/verification`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);
    await shot('04-verification-page');

    // EVERY "Start verification" BUTTON MUST OPEN VERIFICATION.
    //
    // .first() used to be clicked blindly. It matched the status-notice
    // button, whose onContinue was wired to onRefresh - so the click did
    // nothing and the suite reported "the modal opens: FAIL", which read as a
    // modal bug rather than a dead button. Both are now asserted, in order,
    // because a page with two identical buttons that behave differently is
    // the actual defect.
    const startButtons = page.locator('button:visible:has-text("Start verification"), button:visible:has-text("Starting")');
    const startCount = await startButtons.count();
    check('a start-verification button exists', startCount > 0, `${startCount} found`);

    let openedBy = null;
    for (let i = 0; i < startCount; i++) {
      await startButtons.nth(i).click().catch(() => {});
      await page.waitForTimeout(4000);
      if (await page.locator('.sv-modal').isVisible().catch(() => false)) { openedBy = i; break; }
    }
    check('every "Start verification" button opens verification, not just one',
      openedBy === 0,
      openedBy === null ? 'none of them opened it' : `only button ${openedBy} worked; earlier ones are dead`);
    await shot('05-modal');

    console.log('\n4. THE COUNTRY STEP');
    const modal = page.locator('.sv-modal');
    check('the modal opens', await modal.isVisible().catch(() => false));

    // AUTO-DETECTION MEANS THERE MAY BE NO PROMPT AT ALL.
    //
    // The first version asserted "it asks for the country" and failed - not
    // because anything was broken, but because detection had already worked:
    // this sandbox egresses from the US, so the modal auto-selected United
    // States and went straight to Bridge. That is the feature behaving
    // correctly, and the test was wrong to demand a question.
    //
    // Either state is valid, so both are accepted - and whichever happens,
    // the country must be VISIBLE and CHANGEABLE.
    const chosen = page.locator('.sv-chosen-country');
    const autoSelected = await chosen.isVisible().catch(() => false);
    const askedCountry = await page.locator('text=/Where are you based|One moment/i').first().isVisible().catch(() => false);
    check('the country is either asked for or auto-detected', askedCountry || autoSelected,
      `asked=${askedCountry} auto=${autoSelected}`);

    if (autoSelected) {
      const detected = (await chosen.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      console.log(`       auto-detected: ${detected}`);
      // A detected country the user cannot correct would strand a Nigerian on
      // a VPN, or anyone travelling, on a path they never chose.
      check('the detected country is shown to the user', detected.length > 0);
      check('and it can be changed', await page.locator('.sv-chosen-country button:has-text("Change")').isVisible().catch(() => false));
    }

    console.log('\n5. PICK NIGERIA -> BANK PATH');
    // If detection already chose a country, click Change to reach the picker -
    // which is the exact path a Nigerian on a US VPN would take.
    if (autoSelected) {
      await page.locator('.sv-chosen-country button:has-text("Change")').click();
      await page.waitForTimeout(2500);
      await shot('05b-picker-reopened');
      const names = await page.locator('.sv-country-name').allInnerTexts().catch(() => []);
      check('changing the country reopens the full list', names.length > 0, `${names.length} countries`);
      // THE TRUNCATION BUG, checked where the list actually renders.
      const truncated = names.filter(n => n.includes('…') || n.trim().endsWith('...'));
      check('no country name is truncated', truncated.length === 0, truncated.join(' | '));
      check('no two countries render identically',
        names.length === new Set(names).size, names.join(' | '));
    }

    const ng = page.locator('.sv-country:has-text("Nigeria")').first();
    check('Nigeria is selectable', await ng.isVisible().catch(() => false));
    if (await ng.isVisible().catch(() => false)) {
      await ng.click();
      await page.waitForTimeout(5000);
    }
    await shot('06-after-country');

    const bankPath = await page.locator('text=/bank account|Your bank|Level 1/i').first().isVisible().catch(() => false);
    check('Nigeria routes to the bank check, not a photo ID', bankPath);

    // Scope to the MODAL. The first version searched the whole page and hit
    // the verification page rendered BEHIND the overlay, which legitimately
    // describes the Bridge path for users who need it. The modal is what the
    // Nigerian is actually looking at.
    const modalText = await page.locator('.sv-modal').innerText().catch(() => '');
    // MY ASSERTION WAS WRONG, NOT THE APP.
    //
    // A bare /selfie/ matched the Nigerian copy's own reassurance - "no
    // documents, no selfie, usually under a minute" - so the test failed on
    // the exact sentence that proves the behaviour is right. Corrected to
    // match only a selfie being REQUESTED, and the negated forms are excluded
    // explicitly so this cannot regress into the same false positive.
    const asksForSelfie = /(?<!no )\bselfie\b/i.test(modalText.replace(/no documents, no selfie/gi, ''))
      || /(upload|take|provide|submit)[^.]{0,30}(selfie|photo ID)/i.test(modalText);
    check('and the modal does NOT ask a Nigerian for a selfie',
      !asksForSelfie, modalText.slice(0, 120).replace(/\n/g, ' '));
    check('it explicitly reassures them no documents are needed',
      /no documents/i.test(modalText), modalText.slice(0, 120).replace(/\n/g, ' '));

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
        await acct.fill('1111111111');
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
            // NOT "verified". The sandbox is untrustworthy, so this must queue -
            // and the page must SAY so rather than reverting to a generic
            // "verify your account" prompt, which is what it used to do.
            const pageText = await page.locator('body').innerText().catch(() => '');
            const queued = /manual check|being checked|in progress|few hours/i.test(pageText);
            check('the user is told a check is in progress', queued,
              pageText.slice(0, 200).replace(/\n/g, ' '));
            check('and is NOT told to start verifying all over again',
              !/Verify your account/i.test(pageText),
              'page still shows the generic verify prompt');
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
    // A 401 before sign-in is the app correctly discovering it has no session.
    // Counting it as an error made a clean run look broken.
    const realErrors = consoleErrors.filter(e =>
      !/favicon|sentry|Download the React|status of 401/i.test(e));
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

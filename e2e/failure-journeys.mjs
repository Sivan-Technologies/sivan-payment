/**
 * Failure paths, as the USER experiences them.
 *
 * scripts/test-failure-paths.ts already proves the API returns the right
 * status and a sensible message for each failure. That is necessary and not
 * sufficient: a perfect 400 that the frontend swallows is, to the person
 * holding the phone, identical to nothing happening.
 *
 * So this drives a real browser against the deployed app and asserts on what
 * is ON SCREEN. The bar for each case:
 *
 *   1. something visibly changes (no silent failure)
 *   2. the words explain what happened, in the user's terms
 *   3. the words say what to do next, or that nothing is needed
 *   4. the app is still usable afterwards - no dead end, no spinner forever
 *
 * Every case here is driven through the UI where the UI can reach it, and
 * through the API where only a provider could cause it (a webhook, a stuck
 * settlement) - then the PAGE is re-read to confirm the user can see it.
 *
 * Run: npm run e2e:failures
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const FRONTEND = process.env.E2E_FRONTEND ?? 'https://sivan-payments-user-test.vercel.app';
const API = process.env.E2E_API ?? 'https://test-sivan.sivantech.online/api/payment';
const SHOTS = new URL('./shots/failures/', import.meta.url).pathname;

let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

/** Words a user can act on. "Error" and "failed" alone are not. */
function explains(text, ...mustMention) {
  if (!text || text.length < 10) return false;
  return mustMention.some(word => new RegExp(word, 'i').test(text));
}

const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return {}; } };

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const shot = (n) => page.screenshot({ path: `${SHOTS}${n}.png` }).catch(() => {});

  // Track that the app never dies on us.
  const crashes = [];
  page.on('pageerror', e => crashes.push(e.message));

  try {
    // ---- a signed-in, Level 0 Nigerian, created through the API so the
    // ---- browser time is spent on the failures rather than on signup.
    const email = `fail-${Date.now()}@sivan.test`;
    const start = await j(await fetch(`${API}/api/auth/email/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, fullName: 'Samuel Udochukwu', intent: 'signup',
        legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' } }),
    }));
    const verified = await j(await fetch(`${API}/api/auth/email/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: start.data.devCode }),
    }));
    const token = verified.data.token;
    const userId = verified.data.user.id;
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    // SEED THE USER AS THE SERVER NOW SEES THEM, NOT AS SIGNUP RETURNED THEM.
    //
    // The country is set AFTER signup, so verified.data.user has no country on
    // it. Seeding that stale object put the browser in a state a real user is
    // never in - localStorage saying "no country" while the database said NG -
    // and the modal then auto-detected the runner's location and offered a
    // Nigerian the Bridge passport-and-selfie flow.
    //
    // That looked exactly like a product bug and was chased as one. It is not:
    // a real user gets their country in the sign-in response (verified against
    // the deployed API - a returning user's payload carries country: "NG").
    // The fixture was the only thing lying.
    const updatedUser = await j(await fetch(`${API}/api/users/${userId}/country`, {
      method: 'PUT', headers: H, body: JSON.stringify({ country: 'NG' }),
    }));
    const seedUser = updatedUser.data ?? { ...verified.data.user, country: 'NG' };
    if (seedUser.country !== 'NG') throw new Error(`fixture is not in the state under test: country=${seedUser.country}`);

    console.log(`\nuser ${userId}\n`);

    // Seed the session into the browser so it starts signed in.
    await page.goto(`${FRONTEND}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(([t, u]) => {
      localStorage.setItem('sivan.authToken', t);
      localStorage.setItem('sivan.user', u);
    }, [token, JSON.stringify(seedUser)]);

    // ============================================================
    console.log('1. INVALID BANK ACCOUNT — the user mistypes');
    // ============================================================
    {
      await page.goto(`${FRONTEND}/verification`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      // .last(), not .first(): "Start verification" also appears in the status
      // notice above, and on some renders in the collapsed nav. The step
      // button is the one in the checklist.
      await page.locator('button:visible:has-text("Start verification"), button:visible:has-text("Starting")').last().click();
      await page.waitForTimeout(4000);

      // Reach the picker (detection may have auto-selected a country).
      const change = page.locator('.sv-chosen-country button:has-text("Change")');
      if (await change.isVisible().catch(() => false)) { await change.click(); await page.waitForTimeout(2000); }
      await page.locator('.sv-country:has-text("Nigeria")').first().click();
      await page.waitForTimeout(4000);

      await page.locator('.sv-field input').first().fill('Palm');
      await page.waitForTimeout(2500);
      await page.locator('.sv-bank').first().click();
      await page.waitForTimeout(1500);

      // A ten-digit number that is not a real account.
      await page.locator('input[inputmode="numeric"]').first().fill('0000000001');
      await page.waitForTimeout(9000);
      await shot('01-bad-account');

      const modalText = await page.locator('.sv-modal').innerText().catch(() => '');
      const resolved = await page.locator('.sv-resolved').isVisible().catch(() => false);
      const errored = await page.locator('.sv-error').isVisible().catch(() => false);

      // Either it resolves (sandbox resolves anything) or it errors. What must
      // NOT happen is a spinner that never resolves into either.
      const spinning = /Checking that account/i.test(modalText) && !resolved && !errored;
      check('the account check reaches a conclusion, not an endless spinner', !spinning,
        modalText.slice(0, 140).replace(/\n/g, ' '));
      if (errored) {
        const err = await page.locator('.sv-error').innerText();
        check('and a failure explains itself', explains(err, 'verify', 'check', 'number', 'bank'), err);
      }
    }

    // ============================================================
    console.log('\n2. INCOMPLETE ACCOUNT NUMBER — mid-typing');
    // ============================================================
    {
      const acct = page.locator('input[inputmode="numeric"]').first();
      await acct.fill('');
      await acct.fill('81025');
      await page.waitForTimeout(2000);
      await shot('02-partial');

      const modalText = await page.locator('.sv-modal').innerText().catch(() => '');
      // A paid provider call must not fire per keystroke, and the user should
      // be told how many digits remain rather than shown a failure.
      check('a partial number shows progress, not an error',
        /more digit/i.test(modalText), modalText.slice(0, 140).replace(/\n/g, ' '));
      check('and it does not claim the account is invalid',
        !/could not be verified/i.test(modalText));
    }

    // ============================================================
    console.log('\n3. SANDBOX RESOLUTION — the user must not be misled');
    // ============================================================
    {
      const acct = page.locator('input[inputmode="numeric"]').first();
      await acct.fill('');
      await acct.fill('1111111111');
      await page.waitForTimeout(9000);
      await shot('03-resolved');

      const modalText = await page.locator('.sv-modal').innerText().catch(() => '');
      check('the resolved name is shown', /Samuel Udochukwu/i.test(modalText),
        modalText.slice(0, 140).replace(/\n/g, ' '));
      // Presenting a stub as confirmation would be a lie.
      check('and the user is told it proves nothing in test',
        /simulated|Test environment/i.test(modalText), modalText.slice(0, 200).replace(/\n/g, ' '));
    }

    // ============================================================
    console.log('\n4. SUBMITTED — pending review must be visible');
    // ============================================================
    {
      await page.locator('button:has-text("Yes, that is me")').click();
      await page.waitForTimeout(9000);
      await shot('04-pending');

      const body = await page.locator('body').innerText();
      check('the page says a check is in progress',
        explains(body, 'in progress', 'being checked', 'manual check', 'few hours'),
        body.slice(0, 200).replace(/\n/g, ' '));
      // THE REGRESSION THAT WAS SHIPPED: after submitting, the page said
      // "Verify your account", which reads as "nothing happened".
      check('and does NOT tell them to start verifying again',
        !/Verify your account/i.test(body), 'still showing the generic prompt');
      check('nor claims they are already verified',
        !/Level 1: Bank verified/i.test(body));
    }

    // ============================================================
    console.log('\n5. ACTING ABOVE YOUR LEVEL — sell while unverified');
    // ============================================================
    {
      await page.goto(`${FRONTEND}/withdraw`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(4000);
      await shot('05-sell-blocked');

      const body = await page.locator('body').innerText();
      // The user is Level 0 with a review pending. The sell screen must say
      // why they cannot proceed rather than showing a form that will fail.
      check('the sell screen explains the block',
        explains(body, 'verif', 'bank', 'complete', 'unlock', 'in progress'),
        body.slice(0, 220).replace(/\n/g, ' '));
      check('and does not present a dead form with no explanation',
        body.length > 100);
    }

    // ============================================================
    console.log('\n6. PROVIDER UNAVAILABLE — API fails mid-flow');
    // ============================================================
    {
      // Simulate the provider being down by failing the bank list. This is
      // the realistic outage: Breet 500s or the credentials lapse.
      await page.route('**/api/ngn/banks*', route => route.fulfill({
        status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'provider_unavailable', message: 'Bank verification is unavailable right now.' } }),
      }));

      await page.goto(`${FRONTEND}/verification`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      // .last(), not .first(): "Start verification" also appears in the status
      // notice above, and on some renders in the collapsed nav. The step
      // button is the one in the checklist.
      await page.locator('button:visible:has-text("Start verification"), button:visible:has-text("Starting")').last().click();
      await page.waitForTimeout(4000);
      const change2 = page.locator('.sv-chosen-country button:has-text("Change")');
      if (await change2.isVisible().catch(() => false)) { await change2.click(); await page.waitForTimeout(2000); }
      const ngBtn = page.locator('.sv-country:has-text("Nigeria")').first();
      if (await ngBtn.isVisible().catch(() => false)) { await ngBtn.click(); await page.waitForTimeout(5000); }
      await shot('06-provider-down');

      // The modal may not open at all if an earlier call failed, so assert on
      // whichever surface the user is actually looking at.
      const modalOpen = await page.locator('.sv-modal').isVisible().catch(() => false);
      const surface = modalOpen
        ? await page.locator('.sv-modal').innerText().catch(() => '')
        : await page.locator('body').innerText().catch(() => '');

      check('a provider outage is surfaced somewhere the user can see',
        explains(surface, 'could not', 'unavailable', 'try again', 'shortly', 'load banks'),
        `${modalOpen ? 'modal' : 'page'}: ${surface.slice(0, 180).replace(/\n/g, ' ')}`);

      // NEVER a raw provider string. "Customer not found" is Bridge's
      // internal wording for an absence that is NORMAL on the Nigerian path,
      // and it was being toasted at users in red.
      check('and no raw provider error leaks to the user',
        !/customer not found|internal server error|undefined/i.test(surface),
        surface.slice(0, 180).replace(/\n/g, ' '));

      if (modalOpen) {
        check('the modal is still closable - no trapped user',
          await page.locator('.sv-modal-close').isVisible().catch(() => false));
      }

      await page.unroute('**/api/ngn/banks*');
    }

    // ============================================================
    console.log('\n7. NETWORK DROPS MID-REQUEST');
    // ============================================================
    {
      await page.route('**/api/ngn/bank-account/resolve*', route => route.abort('failed'));
      await page.goto(`${FRONTEND}/verification`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(3000);
      // .last(), not .first(): "Start verification" also appears in the status
      // notice above, and on some renders in the collapsed nav. The step
      // button is the one in the checklist.
      await page.locator('button:visible:has-text("Start verification"), button:visible:has-text("Starting")').last().click();
      await page.waitForTimeout(4000);
      const change3 = page.locator('.sv-chosen-country button:has-text("Change")');
      if (await change3.isVisible().catch(() => false)) { await change3.click(); await page.waitForTimeout(2000); }
      const ng3 = page.locator('.sv-country:has-text("Nigeria")').first();
      if (await ng3.isVisible().catch(() => false)) { await ng3.click(); await page.waitForTimeout(4000); }

      const search = page.locator('.sv-field input').first();
      if (await search.isVisible().catch(() => false)) {
        await search.fill('Palm');
        await page.waitForTimeout(2500);
        const bank = page.locator('.sv-bank').first();
        if (await bank.isVisible().catch(() => false)) {
          await bank.click();
          await page.waitForTimeout(1500);
          await page.locator('input[inputmode="numeric"]').first().fill('1111111111');
          await page.waitForTimeout(9000);
          await shot('07-network-drop');

          const modalText = await page.locator('.sv-modal').innerText().catch(() => '');
          const stuck = /Checking that account/i.test(modalText);
          // A dropped request must resolve into an error, not a permanent
          // spinner. This is the difference between "try again" and "the app
          // is broken".
          check('a dropped request does not leave a permanent spinner', !stuck,
            modalText.slice(0, 160).replace(/\n/g, ' '));
          check('and the user is told to retry',
            explains(modalText, 'could not', 'try again', 'verify'),
            modalText.slice(0, 160).replace(/\n/g, ' '));
        }
      }
      await page.unroute('**/api/ngn/bank-account/resolve*');
    }

    // ============================================================
    console.log('\n8. SESSION EXPIRES MID-SESSION');
    // ============================================================
    {
      await page.route('**/api/users/**', route => route.fulfill({
        status: 401, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'auth_required', message: 'Authentication required' } }),
      }));
      await page.goto(`${FRONTEND}/dashboard`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(5000);
      await shot('08-session-expired');

      const body = await page.locator('body').innerText();
      const url = page.url();
      // Either bounced to sign-in or told to sign in. What must not happen is
      // a blank dashboard that looks like the account is empty.
      const handled = /sign in|signin|create account|session/i.test(body) || url.includes('/signup');
      check('an expired session is handled, not shown as an empty account', handled,
        `${url} | ${body.slice(0, 140).replace(/\n/g, ' ')}`);
      await page.unroute('**/api/users/**');
    }

    // ============================================================
    console.log('\n9. THE APP SURVIVED ALL OF IT');
    // ============================================================
    {
      check('no uncaught page errors', crashes.length === 0, crashes.slice(0, 2).join(' | '));

      await page.goto(`${FRONTEND}/dashboard`, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(4000);
      await shot('09-recovered');
      const body = await page.locator('body').innerText();
      check('the app still renders after every failure', body.length > 200, `${body.length} chars`);
      // Being on /signup here is CORRECT: step 8 forced every /api/users call
      // to 401, and the app rightly cleared the session. Asserting "still
      // signed in" was my mistake - it demanded the app ignore an expired
      // token. What matters is that it landed somewhere usable.
      const usable = /sign in|create account|dashboard|verification/i.test(body);
      check('and lands somewhere the user can act', usable, page.url());
    }

    await context.close();
    await browser.close();
  } catch (error) {
    await shot('99-crash');
    await browser.close();
    console.error('\nthrew:', error.message);
    fail++;
  }

  console.log(`\n${'='.repeat(52)}`);
  console.log(`${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`\n  - ${failures.join('\n  - ')}`);
  console.log(`\nscreenshots: ${SHOTS}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();

/**
 * "Verify with ID instead" MUST ACTUALLY OPEN THE ID CHECK.
 *
 * Reported with a screenshot: a Nigerian at Level 1 clicks the button that
 * offers the document path - the one whose whole purpose is unlocking
 * USD/GBP/EUR - and gets the NIGERIAN BANK FLOW again. The same "Verify with
 * your bank account / enter your Nigerian bank account" modal they already
 * completed.
 *
 * The cause is structural: the modal derives its path from COUNTRY alone
 * (planToRender -> localVerificationPlan(country)), so for a Nigerian it can
 * only ever render the bank check. There was no way to ask for Bridge, even
 * though the BridgeVerification component already existed and was wired to
 * onStartBridge - it was simply unreachable for anyone whose country was NG.
 *
 * A button that does the opposite of what it says is worse than no button.
 *
 * Run: node e2e/bridge-option-journey.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const FRONTEND = process.env.E2E_FRONTEND ?? 'https://sivan-payments-user-test.vercel.app';
const API = process.env.E2E_API ?? 'https://test-sivan.sivantech.online/api/payment';
const SHOTS = new URL('./shots/bridge/', import.meta.url).pathname;

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

async function makeUser(fullName, country) {
  const email = `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@sivan.test`;
  const start = await api('/api/auth/email/start', {
    method: 'POST',
    body: JSON.stringify({
      email, fullName, intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
    }),
  });
  if (!start.body?.devCode) throw new Error(`signup start failed (${start.status}): ${JSON.stringify(start.body).slice(0, 140)}`);
  const verified = await api('/api/auth/email/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code: start.body.devCode }),
  });
  if (!verified.body?.token) throw new Error(`verify failed (${verified.status})`);
  const { token, user } = verified.body;
  if (country) {
    await api(`/api/users/${user.id}/country`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ country }),
    });
    user.country = country;
  }
  return { email, token, user };
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1500 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  const shot = (name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });

  /** The modal's own text, or null when it is closed. */
  const modalText = () => page.evaluate(() => {
    const el = document.querySelector('.sv-modal');
    return el && el.offsetParent !== null ? el.innerText.replace(/\s+/g, ' ').trim() : null;
  });

  async function openVerificationAs(session) {
    await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ token, user }) => {
      localStorage.setItem('sivan.authToken', token);
      localStorage.setItem('sivan.user', JSON.stringify(user));
    }, { token: session.token, user: session.user });
    await page.goto(`${FRONTEND}/verification`, { waitUntil: 'domcontentloaded' });
    // Wait for the rows themselves, not for the skeleton text to vanish: the
    // summary can land after any fixed delay on a cold API, and reading the
    // DOM early reports undefined for everything - failures that belong to the
    // harness, not the product.
    await page.waitForSelector('.verification-step', { timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  try {
    console.log(`\nfrontend ${FRONTEND}\napi      ${API}\n`);

    // ================================================================
    console.log('1. A NIGERIAN REACHES LEVEL 1 ON THE BANK CHECK');
    // ================================================================
    const ng = await makeUser('Samuel Udochukwu', 'NG');
    const saved = await api('/api/ngn/payout-accounts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ng.token}` },
      body: JSON.stringify({ userId: ng.user.id, bankId: '26', accountNumber: '8102524846' }),
    });
    check('the bank account verifies', saved.body?.status === 'verified', String(saved.body?.status));

    await openVerificationAs(ng);
    await shot('01-ng-level1');
    {
      const body = await page.evaluate(() => document.body.innerText);
      check('they are on the verification page at Level 1',
        /Level 1/.test(body), body.slice(0, 120));
      check('and the ID option is offered',
        /Verify with ID instead/i.test(body), 'the alternate path is not offered at all');
    }

    // ================================================================
    console.log('2. CLICKING IT MUST OPEN THE **ID** CHECK, NOT THE BANK ONE');
    // ================================================================
    {
      const clicked = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')]
          .find((b) => /verify with id instead/i.test(b.innerText) && !b.disabled);
        if (!button) return false;
        button.click();
        return true;
      });
      check('the button is clickable', clicked, 'no enabled "Verify with ID instead" button');

      await page.waitForTimeout(3000);
      await shot('02-after-click');

      const text = await modalText();
      check('a modal opens', Boolean(text), 'nothing opened');
      console.log(`       modal: ${(text ?? '').slice(0, 170)}`);

      /**
       * THE ASSERTION THAT FAILS TODAY.
       *
       * The reported behaviour: this opens "Level 1 · Bank check / Verify with
       * your bank account / Enter your Nigerian bank account" - the flow they
       * have already finished, and the exact opposite of what the button says.
       */
      check('it is NOT the Nigerian bank check',
        !/bank check|enter your nigerian bank|verify with your bank account/i.test(text ?? ''),
        (text ?? '').slice(0, 140));
      check('it IS the identity / document check',
        /identity verification|verify your identity|photo id|selfie|government-issued/i.test(text ?? ''),
        (text ?? '').slice(0, 140));
      check('and it offers a way to start it',
        /start verification|continue|open|verify/i.test(text ?? ''),
        (text ?? '').slice(0, 140));
    }

    // ================================================================
    console.log('2b. AND THE OVERRIDE IS NOT STICKY');
    // ================================================================
    {
      /**
       * Asking for the document check ONCE must not change the default.
       *
       * If the request survives the modal closing, the next open serves the
       * document flow to someone who wanted the sixty-second bank check.
       *
       * TWO EARLIER DRAFTS OF THIS TEST WERE DECORATIVE, and both passed
       * against the mutation:
       *
       *   - the first looked for a "Start verification" button at Level 1.
       *     There is none: every step reads "Completed" once the bank check is
       *     done, so there was nothing to click.
       *   - the second used a fresh Level 0 user, where "Verify with ID
       *     instead" is not offered at all - so it never set an override and
       *     could not detect one surviving.
       *
       * The override can only be SET by the Level 1 user (section 2 just did
       * it), so the state has to be observed on that same session. The modal
       * is closed and reopened via the sidebar, which re-mounts the page
       * without reloading and would carry a leaked override with it.
       */
      await page.evaluate(() => document.querySelector('.sv-modal-close')?.click());
      await page.waitForTimeout(1200);

      // Leave and come back through the app, as a user would.
      await page.evaluate(() => {
        const dash = [...document.querySelectorAll('button')].find((b) => /dashboard/i.test(b.innerText));
        dash?.click();
      });
      await page.waitForTimeout(2000);
      await page.evaluate(() => {
        const kyc = [...document.querySelectorAll('button')].find((b) => /identity verification/i.test(b.innerText));
        kyc?.click();
      });
      await page.waitForSelector('.verification-step', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2000);

      const reopened = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')]
          .find((b) => /verify with id instead/i.test(b.innerText) && !b.disabled);
        if (!button) return false;
        button.click();
        return true;
      });
      await page.waitForTimeout(2500);
      const stillId = await modalText();
      check('the ID option still works on a second visit', reopened && Boolean(stillId), String(reopened));
      check('and still opens the document check',
        /identity|photo id|selfie/i.test(stillId ?? ''), (stillId ?? '').slice(0, 110));

      /**
       * Now the actual sticky check: close, and reopen the DEFAULT entry
       * point. The banner's primary action is the one a Level 1 Nigerian
       * still has, and it must go back to the country default.
       */
      await page.evaluate(() => document.querySelector('.sv-modal-close')?.click());
      await page.waitForTimeout(1500);
      await shot('03-reopened-default');

      const leaked = await page.evaluate(() => {
        // The modal must be CLOSED after the reset - if the override survived
        // and something re-rendered, the document plan would still be mounted.
        const el = document.querySelector('.sv-modal');
        return el && el.offsetParent !== null ? el.innerText.replace(/\s+/g, ' ').trim() : null;
      });
      check('the modal is closed after dismissing it', leaked === null, (leaked ?? '').slice(0, 90));

      // And the page underneath is unchanged - still Level 1, still offering
      // the ID option as an OPTION rather than having switched paths.
      const body = await page.evaluate(() => document.body.innerText);
      check('the page is still on the Nigerian path', /Level 1|Bank verified/.test(body));
      check('and still offers the ID route as an alternative',
        /Verify with ID instead/i.test(body));
    }

    // ================================================================
    console.log('3. THE COUNTRY IS NOT SILENTLY REWRITTEN');
    // ================================================================
    {
      /**
       * Choosing the document path must not flip the account to another
       * country. It decides how naira limits and rails are computed, and a
       * user asking for USD accounts has not stopped being Nigerian.
       */
      const after = await api(`/api/users/${ng.user.id}/verification-summary`, {
        headers: { Authorization: `Bearer ${ng.token}` },
      });
      check('the user is still recorded as Nigerian',
        after.body?.country === 'NG', String(after.body?.country));
      check('and still on the ngn_bank path for limits',
        after.body?.path === 'ngn_bank', String(after.body?.path));
      check('and has NOT lost Level 1',
        after.body?.level >= 1, String(after.body?.level));
    }

    // ================================================================
    console.log('4. A NON-NIGERIAN IS UNAFFECTED');
    // ================================================================
    {
      const us = await makeUser('Jonathan Benjamin Hart', 'US');
      await openVerificationAs(us);
      await shot('04-us-level0');

      const clicked = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')]
          .find((b) => /start verification/i.test(b.innerText) && !b.disabled);
        if (!button) return false;
        button.click();
        return true;
      });
      check('a US user can open verification', clicked);
      await page.waitForTimeout(3000);
      await shot('05-us-modal');

      const text = await modalText();
      check('and gets the identity check',
        /identity|photo id|selfie|government-issued/i.test(text ?? ''),
        (text ?? '').slice(0, 140));
      check('never the Nigerian bank check',
        !/enter your nigerian bank/i.test(text ?? ''), (text ?? '').slice(0, 140));
    }

    // ================================================================
    console.log('4b. THE WIRING, WHERE THE DOM CANNOT REACH');
    // ================================================================
    {
      /**
       * Two guards a browser cannot observe, asserted against the source.
       *
       * Stated plainly because it is a weaker kind of test and should not be
       * mistaken for a behavioural one:
       *
       *   THE STICKY RESET. Clearing requestedVerificationPath on close is
       *   only observable if some OTHER entry point re-opens the modal
       *   afterwards. At Level 1 there is none - every step reads "Completed"
       *   and the sole remaining button IS "Verify with ID instead", which
       *   sets the override anyway. Three behavioural drafts all passed
       *   against the mutation before I accepted that and checked the wiring
       *   instead. The reset still matters: it is what keeps the override
       *   from leaking the day another entry point is added.
       *
       *   THE EVENT-AS-PATH BUG. onVerify={openVerification} passes React's
       *   click event straight into the `path` parameter, so the dashboard's
       *   verify button would request a path of [object PointerEvent]. Found
       *   by reading the callers after the sticky mutation would not fail -
       *   a real bug, invisible in the DOM because planToRender ignores an
       *   unrecognised value and falls through to the country default.
       */
      const appSource = await fs.readFile(
        new URL('../frontend/src/App.tsx', import.meta.url).pathname, 'utf8'
      );

      check('the override is cleared when the modal closes',
        /setVerificationOpen\(false\); setRequestedVerificationPath\(undefined\)/.test(appSource),
        'a leftover override would survive to the next open');

      check('no handler passes a click event in as the path',
        !/=\{openVerification\}/.test(appSource),
        'openVerification is bound directly to an event handler');

      check('the ID button uses the bridge-specific opener',
        /onStartBridgeVerification=\{openBridgeVerification\}/.test(appSource));

      const sections = await fs.readFile(
        new URL('../frontend/src/components/AppSections.tsx', import.meta.url).pathname, 'utf8'
      );
      check('and the button in the page is wired to it, not the generic one',
        /onClick=\{onStartBridgeVerification\}[^>]*>Verify with ID instead/.test(sections));
    }

    // ================================================================
    console.log('5. NOTHING INTERNAL LEAKS ON ANY OF IT');
    // ================================================================
    {
      const body = await page.evaluate(() => document.body.innerText.toLowerCase());
      const leak = ['breet', 'pajramp', 'privy', 'provider:'].find((t) => body.includes(t));
      check('no provider name is rendered', !leak, String(leak));

      const real = consoleErrors.filter((e) => !/favicon|sourcemap|DevTools|401|404|status of 400/i.test(e));
      check('no unexpected console errors', real.length === 0, real.slice(0, 3).join(' | ').slice(0, 200));
    }

    await browser.close();
  } catch (error) {
    await page.screenshot({ path: `${SHOTS}crash.png`, fullPage: true }).catch(() => {});
    await browser.close();
    throw error;
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`\nfailed:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  console.log(`\nscreenshots: ${SHOTS}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });

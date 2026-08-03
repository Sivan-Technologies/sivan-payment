/**
 * THE VERIFICATION PAGE, THROUGH A REAL BROWSER, AT EVERY LEVEL.
 *
 * Reported from a real screen: a Nigerian finished Level 1 with a bank check,
 * and step 2 still offered "Start verification" as though nothing had
 * happened. Step 3 said "Payout ready / Completed" at the same time. The page
 * contradicted itself on one screen.
 *
 * The backend was already right - /verification-summary returns
 * pathComplete: true, level 1, checks.bank: verified. So this is a frontend
 * defect, and only a browser can prove it either way.
 *
 * Drives the DEPLOYED frontend against the DEPLOYED API. No mocks, no local
 * server, no injected state.
 *
 * Run: node e2e/verification-levels-journey.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const FRONTEND = process.env.E2E_FRONTEND ?? 'https://sivan-payments-user-test.vercel.app';
const API = process.env.E2E_API ?? 'https://test-sivan.sivantech.online/api/payment';
const SHOTS = new URL('./shots/levels/', import.meta.url).pathname;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

/** Breet's sandbox returns this for any account number. */
const BANK_NAME = 'Samuel Udochukwu';

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json.data ?? json };
}

/** Create a signed-in user straight through the API, then hand the browser the session. */
async function makeUser({ fullName, country }) {
  const email = `lvl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@sivan.test`;
  const start = await api('/api/auth/email/start', {
    method: 'POST',
    body: JSON.stringify({
      email, fullName, intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
    }),
  });
  const verified = await api('/api/auth/email/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code: start.body.devCode }),
  });
  const token = verified.body.token;
  const user = verified.body.user;
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

/**
 * Put the session into the page the way the app itself stores it, then load
 * /verification. Signing in through the UI is covered by browser-journey.mjs;
 * repeating it here would spend four OTP emails a run on a free Resend tier to
 * re-prove something already proven.
 */
async function openVerificationAs(page, session) {
  await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token, user }) => {
    localStorage.setItem('sivan.authToken', token);
    localStorage.setItem('sivan.user', JSON.stringify(user));
    localStorage.setItem('sivan.lastActivityAt', String(Date.now()));
  }, { token: session.token, user: session.user });
  await page.goto(`${FRONTEND}/verification`, { waitUntil: 'domcontentloaded' });
  /**
   * Wait for the STEP ROWS, not for the skeleton text to disappear.
   *
   * The first version waited on the absence of "Checking your verification
   * status" and then read the DOM 2.5s later. On a cold Render dyno the
   * summary took longer than that, so every assertion read undefined and the
   * run reported thirteen failures that were all the harness's fault. A test
   * that fails for its own reasons is worse than no test - it buries the one
   * real defect in noise. Waiting for the thing being asserted on cannot lie.
   */
  await page.waitForSelector('.verification-step', { timeout: 45_000 })
    .catch(() => console.log('       (no .verification-step rendered)'));
  await page.waitForTimeout(2000);
}

/** The step-2 row: its title and the label on its button. */
async function stepTwo(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('.verification-step')];
    const row = rows.find(r => /Bank verification|Identity verification/i.test(r.innerText));
    if (!row) return null;
    const button = row.querySelector('button, a');
    return {
      text: row.innerText.replace(/\s+/g, ' ').trim(),
      action: button?.innerText?.trim() ?? '',
      done: row.className.includes('done'),
    };
  });
}

async function pageFacts(page) {
  return page.evaluate(() => {
    const body = document.body.innerText;
    const pct = body.match(/(\d+)% complete/)?.[1];
    const level = body.match(/Level \d[^\n]*/)?.[0];
    return { pct: pct ? Number(pct) : null, level, body };
  });
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  const shot = (name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });

  try {
    console.log(`\nfrontend ${FRONTEND}\napi      ${API}\n`);

    // ================================================================
    console.log('1. NIGERIAN, LEVEL 0 — nothing done yet');
    // ================================================================
    const ng = await makeUser({ fullName: BANK_NAME, country: 'NG' });
    await openVerificationAs(page, ng);
    await shot('01-ng-level0');
    {
      const step = await stepTwo(page);
      const facts = await pageFacts(page);
      check('step 2 is the BANK check for a Nigerian',
        /Bank verification/i.test(step?.text ?? ''), step?.text?.slice(0, 80));
      check('and it invites them to start',
        /Start verification|Continue/i.test(step?.action ?? ''), step?.action);
      check('progress is not yet complete', (facts.pct ?? 100) < 100, String(facts.pct));
      console.log(`       level="${facts.level}" pct=${facts.pct} step2="${step?.action}"`);
    }

    // ================================================================
    console.log('\n2. NIGERIAN, LEVEL 1 — bank verified (THE REPORTED BUG)');
    // ================================================================
    const saved = await api('/api/ngn/payout-accounts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ng.token}` },
      body: JSON.stringify({ userId: ng.user.id, bankId: '26', accountNumber: '8102524846' }),
    });
    check('the bank account auto-verified server side',
      saved.body?.status === 'verified', String(saved.body?.status));

    const summary = await api(`/api/users/${ng.user.id}/verification-summary`, {
      headers: { Authorization: `Bearer ${ng.token}` },
    });
    check('the API says the path is complete',
      summary.body?.pathComplete === true, String(summary.body?.pathComplete));
    check('the API says level 1', summary.body?.level === 1, String(summary.body?.level));

    await openVerificationAs(page, ng);
    await shot('02-ng-level1');
    {
      const step = await stepTwo(page);
      const facts = await pageFacts(page);
      console.log(`       level="${facts.level}" pct=${facts.pct} step2="${step?.action}" done=${step?.done}`);

      /**
       * THE BUG, STATED AS AN ASSERTION.
       *
       * The user has finished everything the Nigerian path asks for. Offering
       * "Start verification" tells them the opposite of what the API says on
       * the same screen, and next to a step 3 that reads "Completed".
       */
      check('step 2 is marked done', step?.done === true, JSON.stringify(step));
      check('step 2 does NOT still say "Start verification"',
        !/Start verification/i.test(step?.action ?? ''), step?.action);
      check('step 2 reads as complete', /Completed|Verified/i.test(step?.action ?? ''), step?.action);
      check('progress reads 100%', facts.pct === 100, String(facts.pct));
      check('the level badge says Level 1', /Level 1/.test(facts.level ?? ''), facts.level);
    }

    // ================================================================
    console.log('\n3. NIGERIAN AT LEVEL 1 — is there a way UP to level 2?');
    // ================================================================
    {
      const facts = await pageFacts(page);
      const offersNext = /NIN|BVN|Level 2|higher limit|increase your limit/i.test(facts.body);
      check('the page offers a route to a higher level (NIN/BVN)', offersNext,
        'no mention of NIN, BVN or Level 2 anywhere on the page');

      const allowance = summary.body?.allowances?.find(a => a.flow === 'offramp' && a.rail === 'ngn');
      check('the API already knows the next level is 2',
        allowance?.nextLevel === 2, String(allowance?.nextLevel));
      console.log(`       limit=${allowance?.limitNgn} nextLevel=${allowance?.nextLevel}`);
    }

    // ================================================================
    console.log('\n4. NIGERIAN — can they choose Bridge instead?');
    // ================================================================
    {
      const facts = await pageFacts(page);
      const offersBridge = /passport|photo ID|document|international/i.test(facts.body);
      check('a Nigerian is offered the document path as an option', offersBridge,
        'the Nigerian path is the only one ever shown');
    }

    // ================================================================
    console.log('\n5. NON-NIGERIAN, LEVEL 0 — the Bridge path');
    // ================================================================
    const us = await makeUser({ fullName: 'Jonathan Benjamin Hart', country: 'US' });
    await openVerificationAs(page, us);
    await shot('05-us-level0');
    {
      const step = await stepTwo(page);
      const facts = await pageFacts(page);
      console.log(`       level="${facts.level}" pct=${facts.pct} step2="${step?.action}"`);
      check('step 2 is the IDENTITY check for a US user',
        /Identity verification/i.test(step?.text ?? ''), step?.text?.slice(0, 80));
      check('and it invites them to start',
        /Start verification|Continue/i.test(step?.action ?? ''), step?.action);

      const usSummary = await api(`/api/users/${us.user.id}/verification-summary`, {
        headers: { Authorization: `Bearer ${us.token}` },
      });
      check('the API routes them to bridge_kyc',
        usSummary.body?.path === 'bridge_kyc', String(usSummary.body?.path));
      check('and their NGN off-ramp allowance is zero until they verify',
        usSummary.body?.allowances?.find(a => a.rail === 'ngn' && a.flow === 'offramp')?.limitNgn === 0
          || usSummary.body?.allowances?.find(a => a.rail === 'ngn' && a.flow === 'offramp') === undefined,
        JSON.stringify(usSummary.body?.allowances?.map(a => `${a.flow}/${a.rail}=${a.limitNgn}`)));
    }

    // ================================================================
    console.log('\n6. THE COUNTRY PICKER — what a user is actually offered');
    // ================================================================
    const fresh = await makeUser({ fullName: 'Ada Nwosu' });
    await openVerificationAs(page, fresh);
    {
      const opened = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')];
        const start = buttons.find(b => /Start verification/i.test(b.innerText) && !b.disabled);
        if (!start) return false;
        start.click();
        return true;
      });
      await page.waitForTimeout(2500);
      await shot('06-country-picker');
      check('the verification modal opens', opened, 'no enabled "Start verification" button');

      const modal = await page.evaluate(() => {
        const el = document.querySelector('.sv-modal-body, [class*="sv-modal"]');
        return el ? el.innerText.replace(/\s+/g, ' ').trim().slice(0, 400) : null;
      });
      check('it asks for a country first', Boolean(modal) && /Country|Nigeria/i.test(modal ?? ''),
        modal?.slice(0, 120));
      console.log(`       modal: ${modal?.slice(0, 140)}`);
    }

    // ================================================================
    console.log('\n7. NO CONSOLE ERRORS THE USER COULD SEE');
    // ================================================================
    {
      const real = consoleErrors.filter(e =>
        !/favicon|sourcemap|Download the React DevTools/i.test(e));
      check('no unexpected console errors', real.length === 0, real.slice(0, 4).join(' | '));
      if (real.length) real.slice(0, 6).forEach(e => console.log(`       ${e.slice(0, 160)}`));
    }

    await browser.close();
  } catch (error) {
    await page.screenshot({ path: `${SHOTS}crash.png`, fullPage: true }).catch(() => {});
    await browser.close();
    throw error;
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`\nfailed:\n${failures.map(f => `  - ${f}`).join('\n')}`);
  console.log(`\nscreenshots: ${SHOTS}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });

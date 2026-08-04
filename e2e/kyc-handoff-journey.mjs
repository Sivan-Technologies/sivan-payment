/**
 * "THE START VERIFICATION IS NOT OPENING THE BRIDGE VERIFICATION PAGE."
 *
 * Reported from a phone. My first attempt to reproduce it used
 * page.evaluate(() => button.click()), which is NOT a user gesture, so the
 * browser blocked window.open and I "confirmed" a bug that did not exist. That
 * was wrong and this file drives the button with page.click() throughout.
 *
 * What is actually there, measured: POST /api/customers/kyc-link takes about
 * TWELVE SECONDS. During those twelve seconds the old build showed a blank
 * about:blank tab and a button reading "Opening…". Nothing else moved. To the
 * user that is a dead button, and the reasonable response - closing the tab,
 * or clicking again - either aborts the flow or starts a second one.
 *
 * This drives it in a real Chromium against the live test API:
 *
 *   1. the tab opened by the click is NOT blank while we wait
 *   2. the modal itself says what is happening, and for how long
 *   3. the tab really does end up on Bridge/Persona
 *   4. a second click during the wait does not open a second tab
 *
 * Run: node e2e/kyc-handoff-journey.mjs
 * (needs a local build served by e2e/serve-dist.py, since Vercel is not
 * auto-deploying: cd frontend && npx vite build --mode test)
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const FRONTEND = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4173';
const API = process.env.E2E_API ?? 'https://test-sivan.sivantech.online/api/payment';
const SHOTS = new URL('./shots/kyc-handoff/', import.meta.url).pathname;

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
  const email = `handoff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@sivan.test`;
  const start = await api('/api/auth/email/start', {
    method: 'POST',
    body: JSON.stringify({
      email, fullName, intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
    }),
  });
  if (!start.body?.devCode) throw new Error(`signup start failed (${start.status}): ${JSON.stringify(start.body).slice(0, 160)}`);
  const verified = await api('/api/auth/email/verify', {
    method: 'POST', body: JSON.stringify({ email, code: start.body.devCode }),
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const shot = (name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: false });

  const modalText = () => page.evaluate(() => {
    const el = document.querySelector('.sv-modal');
    return el && el.offsetParent !== null ? el.innerText.replace(/\s+/g, ' ').trim() : null;
  });

  try {
    console.log(`\nfrontend ${FRONTEND}\napi      ${API}\n`);

    // ================================================================
    console.log('1. A US USER OPENS THE DOCUMENT CHECK');
    // ================================================================
    const us = await makeUser('Grace Adeyemi', 'US');
    await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ token, user }) => {
      localStorage.setItem('sivan.authToken', token);
      localStorage.setItem('sivan.user', JSON.stringify(user));
    }, { token: us.token, user: us.user });
    await page.goto(`${FRONTEND}/verification`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.verification-step', { timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await shot('01-verification-page');

    // page.click, NOT evaluate+click. An evaluate click is not a user gesture
    // and the browser will block the popup - which is how I mis-reproduced
    // this bug the first time.
    const startButton = page.locator('button', { hasText: /^Start verification$/ }).first();
    const hasStart = await startButton.count() > 0;
    check('there is a Start verification button', hasStart);
    if (hasStart) await startButton.click();
    await page.waitForTimeout(1200);
    await shot('02-modal-open');

    let text = await modalText();
    check('the modal opened', Boolean(text), 'no visible .sv-modal');
    check('on the document path, not the Nigerian bank form',
      /Photo ID/i.test(text ?? ''), (text ?? '').slice(0, 160));

    // ================================================================
    console.log('\n2. THE WAIT IS DISCLOSED BEFORE THE CLICK');
    // ================================================================
    check('the modal warns it can take up to 15 seconds',
      /up to 15 seconds/i.test(text ?? ''), (text ?? '').slice(0, 240));

    // ================================================================
    console.log('\n3. THE CLICK — THE TWELVE SECONDS MUST NOT BE SILENT');
    // ================================================================
    const popupPromise = context.waitForEvent('page', { timeout: 60_000 });
    const bridgeButton = page.locator('.sv-modal button', { hasText: /Start verification/ }).first();
    await bridgeButton.click();

    // Sampled ~700ms in: this is the moment that used to be a blank tab and a
    // frozen button.
    await page.waitForTimeout(700);
    await shot('03-while-waiting');
    const waiting = await modalText();
    check('the modal shows progress while the link is being made',
      /Opening secure verification/i.test(waiting ?? ''), (waiting ?? '').slice(0, 200));
    check('and repeats how long it can take',
      /up to 15 seconds/i.test(waiting ?? ''), (waiting ?? '').slice(0, 240));
    check('the "Start verification" button is gone, not sitting there dead',
      !/Start verification →/.test(waiting ?? ''), (waiting ?? '').slice(0, 200));

    const popup = await popupPromise;
    // THE ORIGINAL COMPLAINT: this tab used to be white and empty for twelve
    // seconds. Read before it navigates away.
    const holdingText = await popup.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    check('the tab it opened is NOT blank',
      holdingText.trim().length > 0, `body text was ${JSON.stringify(holdingText.slice(0, 80))}`);
    check('it explains itself in the tab',
      /Opening secure verification/i.test(holdingText), holdingText.slice(0, 160));
    check('and asks the user not to close it',
      /keep this tab open/i.test(holdingText), holdingText.slice(0, 200));
    const holdingBg = await popup.evaluate(
      () => getComputedStyle(document.body).backgroundColor).catch(() => '');
    check('the holding tab is dark, not a white flash',
      holdingBg === 'rgb(7, 9, 13)', holdingBg);
    await popup.screenshot({ path: `${SHOTS}04-holding-tab.png` }).catch(() => {});

    // ================================================================
    console.log('\n4. A SECOND CLICK DURING THE WAIT MUST NOT START A SECOND SESSION');
    // ================================================================
    const tabsBefore = context.pages().length;
    const stillClickable = await page.locator('.sv-modal button', { hasText: /Start verification/ }).count();
    check('the button is not even present to double-click', stillClickable === 0, `${stillClickable} present`);
    await page.waitForTimeout(1500);
    check('no extra tab appeared', context.pages().length === tabsBefore,
      `${tabsBefore} -> ${context.pages().length}`);

    // ================================================================
    console.log('\n5. IT ACTUALLY LANDS ON BRIDGE');
    // ================================================================
    const started = Date.now();
    let landedUrl = popup.url();
    while (Date.now() - started < 45_000 && !/persona|bridge/i.test(landedUrl)) {
      await page.waitForTimeout(500);
      landedUrl = popup.url();
    }
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`     landed after ~${elapsed}s: ${landedUrl.slice(0, 110)}`);
    check('the tab ends up on the verification partner',
      /withpersona\.com|bridge\.xyz/i.test(landedUrl), landedUrl.slice(0, 160));
    check('over https', landedUrl.startsWith('https://'), landedUrl.slice(0, 60));
    await popup.screenshot({ path: `${SHOTS}05-persona.png` }).catch(() => {});

    await page.waitForTimeout(1500);
    await shot('06-after-handoff');

    // ================================================================
    console.log('\n6. NO CONSOLE ERRORS THROUGH ANY OF IT');
    // ================================================================
    const real = consoleErrors.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED/i.test(e));
    check('the console stayed clean', real.length === 0, real.slice(0, 3).join(' | '));

  } catch (error) {
    check('the journey ran to completion', false, error.message);
    await shot('99-crash').catch(() => {});
  } finally {
    await browser.close();
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`   ${failures.join('\n   ')}`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => { console.error(error); process.exit(1); });

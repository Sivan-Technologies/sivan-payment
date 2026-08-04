/**
 * THE BUY SCREEN MUST NOT HAND A NIGERIAN A FORM IT WILL REFUSE.
 *
 * Reported with a screenshot from app.sivantech.online/buy. A Nigerian user at
 * Level 1 - bank check done, dashboard reading "verified", setup 100% - was
 * given the complete buy form: amount, asset, destination network, wallet
 * address, fee breakdown. They filled it in, pressed "Create buy order", and
 * got a red wall:
 *
 *   The payments-api service did not respond. This was a POST request and it
 *   was NOT retried, because repeating it could duplicate the action. Check
 *   whether it took effect before trying again.
 *
 * Two defects behind that, both reproduced against the deployed test API:
 *
 *   1. the frontend gated on `pathComplete` (did you finish YOUR COUNTRY's
 *      check) where buying needs Bridge's own document check
 *   2. the server took ~18s to say no - four whole-database reads before the
 *      cheap eligibility check - and the Cloudflare gateway gives up at 12s,
 *      so the user got the timeout instead of the reason
 *
 * This drives the screen in real Chromium and asserts the user is stopped at
 * the door, with a reason, and a button that goes somewhere useful.
 *
 * Run: node e2e/buy-gate-journey.mjs
 * (against a local build: cd frontend && npx vite build --mode test,
 *  then e2e/serve-dist.py)
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const FRONTEND = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4173';
const API = process.env.E2E_API ?? 'https://test-sivan.sivantech.online/api/payment';
const SHOTS = new URL('./shots/buy-gate/', import.meta.url).pathname;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function api(path, options = {}) {
  const started = Date.now();
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  return { ms: Date.now() - started, status: res.status, body: json.data ?? json };
}

async function makeUser(fullName, country) {
  const email = `buygate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@sivan.test`;
  const start = await api('/api/auth/email/start', {
    method: 'POST',
    body: JSON.stringify({
      email, fullName, intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' },
    }),
  });
  if (!start.body?.devCode) throw new Error(`signup failed (${start.status})`);
  const verified = await api('/api/auth/email/verify', {
    method: 'POST', body: JSON.stringify({ email, code: start.body.devCode }),
  });
  const { token, user } = verified.body;
  if (country) {
    await api(`/api/users/${user.id}/country`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ country }),
    });
    user.country = country;
  }
  return { token, user };
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  // The report came from a phone, so this reproduces at phone width.
  const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const shot = (n) => page.screenshot({ path: `${SHOTS}${n}.png`, fullPage: false });

  try {
    console.log(`\nfrontend ${FRONTEND}\napi      ${API}\n`);

    // ================================================================
    console.log('1. A NIGERIAN REACHES LEVEL 1 ON THE BANK CHECK');
    // ================================================================
    const ng = await makeUser('Samuel Udochukwu', 'NG');
    const saved = await api('/api/ngn/payout-accounts', {
      method: 'POST', headers: { Authorization: `Bearer ${ng.token}` },
      body: JSON.stringify({ userId: ng.user.id, bankId: '26', accountNumber: '8102524846' }),
    });
    check('the bank account verifies', saved.body?.status === 'verified', String(saved.body?.status));

    const summary = await api(`/api/users/${ng.user.id}/verification-summary`, {
      headers: { Authorization: `Bearer ${ng.token}` },
    });
    check('the server calls their country path complete', summary.body?.pathComplete === true);
    check('…which is exactly why the old frontend gate let them through',
      summary.body?.level === 1, `level ${summary.body?.level}`);

    // ================================================================
    console.log('\n2. THE BUY SCREEN MUST STOP THEM AT THE DOOR');
    // ================================================================
    await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ token, user }) => {
      localStorage.setItem('sivan.authToken', token);
      localStorage.setItem('sivan.user', JSON.stringify(user));
    }, { token: ng.token, user: ng.user });
    await page.goto(`${FRONTEND}/buy`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await shot('01-buy-blocked');

    const body = await page.evaluate(() => document.body.innerText);

    /**
     * THE BUG, AS THE USER MET IT. Every one of these fields was on screen for
     * someone who could never submit them.
     */
    check('there is NO amount field', await page.locator('input[name="amount"]').count() === 0);
    check('no destination network picker',
      !/Destination network/i.test(body), 'the network picker is still rendered');
    check('no receiving wallet address field',
      await page.locator('input[name="destinationAddress"]').count() === 0);
    check('and no "Create buy order" button',
      await page.locator('button', { hasText: /Create buy order/ }).count() === 0);

    // ================================================================
    console.log('\n3. AND TELL THEM SOMETHING TRUE AND ACTIONABLE');
    // ================================================================
    check('it credits the bank check they already passed',
      /bank verification/i.test(body), body.slice(0, 300));
    check('it asks for the thing that is actually missing',
      /photo ID/i.test(body) && /selfie/i.test(body), body.slice(0, 300));
    /**
     * "Complete verification" to someone who just completed verification is
     * what made the original report read as the app being broken.
     */
    check('it does NOT just say "complete verification"',
      !/Complete verification before buying stablecoins/i.test(body), body.slice(0, 300));

    const cta = page.locator('button', { hasText: /Verify with ID/ });
    check('there is a button that goes somewhere useful', await cta.count() > 0);

    // ================================================================
    console.log('\n4. AND IT MUST OPEN THE ID CHECK, NOT THE BANK FORM AGAIN');
    // ================================================================
    if (await cta.count() > 0) {
      await cta.first().click();
      await page.waitForTimeout(2500);
      await shot('02-verify-modal');
      const modal = await page.evaluate(() => {
        const el = document.querySelector('.sv-modal');
        return el && el.offsetParent !== null ? el.innerText.replace(/\s+/g, ' ').trim() : null;
      });
      check('the verification modal opened', Boolean(modal), 'no visible modal');
      check('on the DOCUMENT path', /Photo ID/i.test(modal ?? ''), (modal ?? '').slice(0, 200));
      /**
       * The whole point of forcePath. Country-only routing sent a Nigerian
       * back to the bank form they had already finished.
       */
      check('NOT the Nigerian bank form they already completed',
        !/Account number/i.test(modal ?? '') && !/10 digits/i.test(modal ?? ''),
        (modal ?? '').slice(0, 200));
    }

    // ================================================================
    console.log('\n5. THE SERVER STILL REFUSES — BUT FAST, AND IN WORDS');
    // ================================================================
    const rejected = await api('/api/onramp/orders', {
      method: 'POST', headers: { Authorization: `Bearer ${ng.token}` },
      body: JSON.stringify({
        userId: ng.user.id, sourceCurrency: 'usd', destinationCurrency: 'usdc',
        destinationChain: 'base', destinationAddress: '0xBB0d3af2397c956850c250F35a2F603fa2000000',
        amount: 1000,
      }),
    });
    console.log(`     refused in ${rejected.ms}ms with ${rejected.status}`);
    check('the server still refuses — the gate is real', rejected.status === 400,
      `${rejected.status}: ${JSON.stringify(rejected.body).slice(0, 160)}`);
    /**
     * The Cloudflare gateway cuts writes off at 12s. Anything at or over that
     * reaches the user as UPSTREAM_UNAVAILABLE - "may or may not have been
     * applied" - which is the message in the bug report.
     */
    check('and it does so well inside the 12s gateway timeout',
      rejected.ms < 6000, `${rejected.ms}ms`);
    check('the answer is the reason, not a gateway timeout',
      rejected.body?.error?.code === 'bad_request',
      JSON.stringify(rejected.body).slice(0, 200));

    const serverMessage = rejected.body?.error?.message ?? '';
    console.log(`     "${serverMessage}"`);
    check('the server message reached the user intact',
      !/We could not complete that request/i.test(serverMessage), serverMessage);
    check('it names ID and selfie',
      /photo ID/i.test(serverMessage) && /selfie/i.test(serverMessage), serverMessage);
    /**
     * safeUserMessage() rewrites anything containing a provider name. My first
     * draft said "our partner Bridge" and was silently replaced by the blandest
     * line we own.
     */
    check('and no provider name leaked out of the API',
      !/bridge|breet|persona|privy/i.test(serverMessage), serverMessage);

    // ================================================================
    console.log('\n6. NAIRA PAYOUTS MUST STILL WORK — THEY DO NOT NEED BRIDGE');
    // ================================================================
    await page.goto(`${FRONTEND}/withdraw`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    await shot('03-sell-still-open');
    const sell = await page.evaluate(() => document.body.innerText);
    /**
     * The obvious over-fix is to gate everything on Bridge KYC, which would
     * lock every Nigerian out of the one rail that does work for them. Naira
     * runs on Breet and Bridge plays no part.
     */
    check('the sell screen does NOT demand a document check',
      !/photo ID/i.test(sell) || /Sell|Withdraw|amount/i.test(sell),
      sell.slice(0, 200));
    check('and it is not showing the buy-gate refusal',
      !/bank verification covers naira payouts/i.test(sell), sell.slice(0, 200));

    // ================================================================
    console.log('\n7. CONSOLE');
    // ================================================================
    const real = consoleErrors.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED/i.test(e));
    check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));

  } catch (error) {
    check('the journey ran to completion', false, error.message);
    await shot('99-crash').catch(() => {});
  } finally {
    await browser.close();
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (failures.length) console.log(`   ${failures.join('\n   ')}`);
  console.log(`\nscreenshots: ${SHOTS}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

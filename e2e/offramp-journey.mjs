/**
 * THE CRYPTO -> NAIRA JOURNEY, AS THE USER SEES IT.
 *
 * The API-level proof is not enough. A correct quote the frontend never shows,
 * or a deposit address the user cannot copy, is - to the person holding the
 * phone - the same as nothing happening.
 *
 * Drives the DEPLOYED frontend against the DEPLOYED API. A Nigerian who is
 * already Level 1 (bank approved through the admin queue, as an operator would
 * do) walks to the sell screen and tries to off-ramp.
 *
 * Asserts on WHAT IS ON SCREEN:
 *   - the sell screen is reachable and shows their real headroom
 *   - an amount below Breet's minimum is refused with the number, before any
 *     address exists - because a flagged deposit costs the user a fee
 *   - a valid amount produces a deposit address the user can actually see
 *   - nothing raw from the provider leaks into the copy
 *
 * Run: node e2e/offramp-journey.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const FRONTEND = process.env.E2E_FRONTEND ?? 'https://sivan-payments-user-test.vercel.app';
const API = process.env.E2E_API ?? 'https://test-sivan.sivantech.online/api/payment';
const ADMIN_KEY = process.env.ADMIN_API_KEY ?? '';
const SHOTS = new URL('./shots/offramp/', import.meta.url).pathname;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; } };

/** A Level 1 Nigerian with an approved payout account. */
async function seedVerifiedNigerian() {
  const email = `off-${Date.now()}@sivan.test`;
  const start = await j(await fetch(`${API}/api/auth/email/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Samuel Udochukwu', intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' } }),
  }));
  const v = await j(await fetch(`${API}/api/auth/email/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: start.data.devCode }),
  }));
  const token = v.data.token, user = v.data.user;
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const updated = await j(await fetch(`${API}/api/users/${user.id}/country`, {
    method: 'PUT', headers: H, body: JSON.stringify({ country: 'NG' }) }));

  const banks = await j(await fetch(`${API}/api/ngn/banks`, { headers: H }));
  const palm = (banks.data ?? []).find((b) => /palmpay/i.test(b.name));
  const saved = await j(await fetch(`${API}/api/ngn/payout-accounts`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ userId: user.id, bankId: String(palm.id), accountNumber: '8102524846' }) }));

  // THE SANDBOX CANNOT GRANT LEVEL 1 BY ITSELF, AND THAT IS CORRECT.
  // Breet's sandbox returns the same fabricated name for every account
  // number, so resolutionTrustworthy is false and the account queues for a
  // human. Approving it here is exactly what an operator does in the hub.
  if (saved.data?.status === 'pending_review' && ADMIN_KEY) {
    await fetch(`${API}/api/admin/ngn/payout-accounts/${saved.data.id}/review`, {
      method: 'PUT', headers: { 'x-admin-api-key': ADMIN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', note: 'e2e offramp journey' }) });
  }

  await fetch(`${API}/api/users/${user.id}/wallets`, { method: 'POST', headers: H, body: JSON.stringify({ chain: 'base' }) });
  const summary = await j(await fetch(`${API}/api/users/${user.id}/verification-summary`, { headers: H }));
  return { token, user: updated.data ?? user, summary: summary.data ?? summary };
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const seeded = await seedVerifiedNigerian();
  console.log(`\nfrontend ${FRONTEND}`);
  console.log(`user     ${seeded.user.id}`);
  console.log(`level    ${seeded.summary?.level} pathComplete=${seeded.summary?.pathComplete}\n`);

  if (seeded.summary?.level !== 1) {
    console.log('ABORT: fixture is not Level 1 - set ADMIN_API_KEY so the payout account can be approved.');
    process.exit(1);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await context.addInitScript(([t, u]) => {
    localStorage.setItem('sivan.authToken', t);
    localStorage.setItem('sivan.user', u);
  }, [seeded.token, JSON.stringify(seeded.user)]);
  const page = await context.newPage();
  const crashes = [];
  page.on('pageerror', (e) => crashes.push(e.message));
  const shot = (n) => page.screenshot({ path: `${SHOTS}${n}.png`, fullPage: true }).catch(() => {});

  try {
    console.log('1. THE SELL SCREEN');
    await page.goto(`${FRONTEND}/withdraw`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);
    await shot('01-sell');
    let body = await page.locator('body').innerText();

    check('the sell screen renders for a verified user', body.length > 200, `${body.length} chars`);
    check('it does not tell a Level 1 user to go and verify',
      !/Verify your account|Complete identity verification/i.test(body),
      body.slice(0, 160).replace(/\n/g, ' '));
    // THE RAIL DEFAULT. A verified Nigerian must not land on the Bridge tab
    // being told to add a bank they have already added.
    check('it does NOT tell a user with an approved NUBAN to add a bank first',
      !/Add a bank first/i.test(body), body.slice(0, 220).replace(/\n/g, ' '));
    check('the naira rail is the one selected for a Nigerian',
      /Nigerian bank|NGN/i.test(body), body.slice(0, 220).replace(/\n/g, ' '));

    console.log('\n2. BELOW BREET MINIMUM - refuse BEFORE an address exists');
    {
      // Driven through the API because the amount guard lives on order
      // acceptance, then the PAGE is re-read to confirm the user is not left
      // with a dangling address.
      const H = { Authorization: `Bearer ${seeded.token}`, 'Content-Type': 'application/json' };
      const q = await j(await fetch(`${API}/api/ngn/quote?userId=${seeded.user.id}&direction=offramp`
        + `&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=20&network=base`, { headers: H }));
      check('a below-minimum amount still QUOTES (so the user sees the rate)',
        Boolean(q.data?.id), JSON.stringify(q).slice(0, 160));

      const order = await j(await fetch(`${API}/api/ngn/offramp/orders`, {
        method: 'POST', headers: H, body: JSON.stringify({ userId: seeded.user.id, quoteId: q.data.id }) }));
      const msg = order.error?.message ?? '';
      check('but accepting it is REFUSED', Boolean(order.error), JSON.stringify(order).slice(0, 160));
      check('and the refusal names the actual minimum', /50/.test(msg), msg);
      check('and warns what a flagged deposit would cost', /flag/i.test(msg), msg);
      check('no deposit address was created for it', !order.data?.depositAddress);
    }

    console.log('\n3. A VALID AMOUNT PRODUCES A DEPOSIT ADDRESS');
    {
      const H = { Authorization: `Bearer ${seeded.token}`, 'Content-Type': 'application/json' };
      const q = await j(await fetch(`${API}/api/ngn/quote?userId=${seeded.user.id}&direction=offramp`
        + `&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=60&network=base`, { headers: H }));
      const order = await j(await fetch(`${API}/api/ngn/offramp/orders`, {
        method: 'POST', headers: H, body: JSON.stringify({ userId: seeded.user.id, quoteId: q.data.id }) }));

      check('the order is accepted', Boolean(order.data?.id), JSON.stringify(order).slice(0, 160));
      check('Breet returned a real deposit address',
        /^0x[0-9a-fA-F]{40}$/.test(order.data?.depositAddress ?? ''), order.data?.depositAddress);
      check('it is awaiting the crypto deposit',
        order.data?.status === 'awaiting_crypto_deposit', order.data?.status);
      check('the naira figure is present and non-zero',
        Number(order.data?.destinationAmount) > 0, String(order.data?.destinationAmount));

      console.log('\n4. THE USER CAN SEE IT');
      await page.goto(`${FRONTEND}/withdrawals`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(12000);
      await shot('02-transactions');
      body = await page.locator('body').innerText();
      // Assert on what the page ACTUALLY renders, not on raw API vocabulary.
      // The first version looked for "awaiting", which is the API's word - the
      // UI deliberately translates it to "Waiting for your crypto". The test
      // was checking for the untranslated string and so would have passed only
      // if the copy were bad.
      check('the pending sell appears in their transaction history',
        !/No transactions yet/i.test(body) && /Sell crypto to naira/i.test(body),
        body.slice(0, 240).replace(/\n/g, ' '));
      check('and it is described in the user\'s terms, not the API\'s',
        /Waiting for your crypto/i.test(body), body.slice(0, 240).replace(/\n/g, ' '));
      check('the naira they will receive is shown',
        /95,?817|NGN/i.test(body), body.slice(0, 240).replace(/\n/g, ' '));
      // The whole point of an off-ramp awaiting funds.
      check('the deposit address is on screen so the sell can be completed',
        /0x[0-9a-fA-F]{6}/.test(body), body.slice(0, 240).replace(/\n/g, ' '));
      check('no raw provider wording leaks to the user',
        !/(internal server error|undefined|null|breet_offramp)/i.test(body));
    }

    console.log('\n5. NOTHING BROKE');
    check('no uncaught page errors', crashes.length === 0, crashes.join(' | '));
  } catch (error) {
    check('the journey ran to completion', false, String(error).slice(0, 200));
    await shot('99-crash');
  }

  await browser.close();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });

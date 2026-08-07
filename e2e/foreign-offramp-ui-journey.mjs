/**
 * LOOK AT THE WITHDRAW SCREEN, don't just trust the component.
 *
 * The backend can now fund a USD/GBP/EUR withdrawal from the Sivan balance.
 * That is worth nothing if the screen still only offers "here is an address,
 * go send crypto yourself" - which is exactly what it did, and which looked
 * identical to the naira screen that HAS self-funded for a while.
 *
 * So this drives the real built bundle in a real browser and asserts on the
 * rendered DOM: the funding choice exists, an amount field appears, the
 * balance is stated, and the manual-send warning is NOT shown on a path where
 * the user sends nothing.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const API = process.env.API || 'http://127.0.0.1:4712';
const APP = process.env.APP || 'http://127.0.0.1:4790';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const j = { 'content-type': 'application/json' };
const post = (p, b, h = {}) => fetch(`${API}${p}`, { method: 'POST', headers: { ...j, ...h }, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, h = {}) => fetch(`${API}${p}`, { method: 'PUT', headers: { ...j, ...h }, body: JSON.stringify(b) }).then(r => r.json());
const ADM = { 'x-admin-api-key': 'e2e-admin-key' };

// ── seed a user who can actually reach the withdraw screen ───────────
const email = `ui-${Date.now()}@example.com`;
const start = await post('/api/auth/email/start', {
  email, intent: 'signup', fullName: 'OGUNMEPON SHARAFA',
  legalAcceptance: { accepted: true, termsVersion: '1.0', privacyVersion: '1.0' },
});
const verify = await post('/api/auth/email/verify', { email, code: start.data.devCode });
const user = verify.data.user;
const token = verify.data.token;

await post('/api/customers', { userId: user.id, payload: { type: 'individual', first_name: 'OGUNMEPON', last_name: 'SHARAFA' } });
await post(`/api/customers/${user.id}/sandbox/simulate-kyc-approval`, {});
await post('/api/admin/balance/adjustments', { userId: user.id, asset: 'usdc', amount: 500, status: 'available', reason: 'ui journey seed' }, ADM);
await post('/api/external-accounts', {
  userId: user.id, accountType: 'us', currency: 'usd', bankName: 'Chase',
  accountOwnerName: 'OGUNMEPON SHARAFA', accountOwnerType: 'individual',
  firstName: 'OGUNMEPON', lastName: 'SHARAFA', paymentRail: 'ach',
  account: { routing_number: '021000021', account_number: '123456789', checking_or_savings: 'checking' },
  address: { street_line_1: '1 Main St', city: 'New York', state: 'NY', postal_code: '10001', country: 'USA' },
});
await put('/api/admin/ngn/controls', { onrampEnabled: true, offrampEnabled: true, activeProvider: 'mock' }, ADM);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(APP);
await page.evaluate(([t, u]) => {
  localStorage.setItem('sivan.authToken', t);
  localStorage.setItem('sivan.user', u);
}, [token, JSON.stringify(user)]);

await page.goto(`${APP}/withdraw`);
await page.waitForTimeout(2500);

// The withdraw wizard lives behind the Withdraw nav item on this route set.
const withdrawLink = page.locator('a,button', { hasText: /^Withdraw$/i }).first();
if (await withdrawLink.count()) { await withdrawLink.click().catch(() => {}); await page.waitForTimeout(1500); }

fs.mkdirSync('e2e/shots', { recursive: true });

console.log('\n── the withdraw screen offers a funding choice ──────────────');

const body = () => page.locator('body').innerText();
let text = await body();

// If the rail toggle is present we must be on the Bridge side, not naira.
const bridgeTab = page.locator('button', { hasText: /Bank transfer \(USD/i }).first();
if (await bridgeTab.count()) { await bridgeTab.click().catch(() => {}); await page.waitForTimeout(800); text = await body(); }

// Matches EITHER heading: the card is now titled by funding source, and this
// assertion is about being on the right screen, not about which copy shows.
check('the Bridge withdraw form is on screen',
  /Choose payout and (deposit rail|amount)/i.test(text), text.slice(0, 300));

/**
 * WITH EXTERNAL FUNDING OFF - the shipped default (migration 045) - there is
 * only ONE funding source, so there is no CHOICE to render. A segmented
 * control with a single option is just a label.
 *
 * The first version of this asserted both buttons were present and failed,
 * because it was asserting my expectation rather than the configured
 * behaviour. The toggle is verified against the admin API below instead, so
 * this tests what the product actually does in its default state.
 */
check('no funding toggle while external funding is disabled',
  !/send crypto myself/i.test(text),
  'a single-option segmented control would be a label pretending to be a choice');

const amountField = page.locator('input[name="sourceAmount"]');
check('an Amount field is rendered on the balance path', await amountField.count() > 0);

check('the spendable balance is stated', /available to withdraw/i.test(text), text.slice(0, 400));
check('no manual-send warning while Sivan is sending',
  !/Send only .* on .*\. Sending any other token/i.test(text));
check('it says Sivan moves the funds automatically',
  /move the crypto from your Sivan balance automatically/i.test(text), text.slice(0, 400));

/**
 * THE SURROUNDING COPY MUST NOT CONTRADICT THE FORM.
 *
 * Caught by looking at the screenshot, not the code: the form correctly said
 * "we'll move the crypto for you" while the panel beside it still said
 * "Provider-backed deposit address / Send the selected asset to the generated
 * address", and the stepper's last step was "Deposit". Three places telling a
 * user to go and send funds that Sivan sends for them.
 */
check('the side panel describes the balance flow',
  /Paid from your Sivan balance/i.test(text) && !/Provider-backed deposit address/i.test(text),
  text.slice(0, 600));
check('no step tells the user to send to a generated address',
  !/Send the selected asset to the generated address/i.test(text));
check('the stepper says Sending, not Deposit', /Sending/i.test(text));
check('the header does not promise a deposit address',
  !/Review carefully before a deposit address is created/i.test(text));
// The form card had its own two lines about a deposit address, separate from
// the page header. Found on the screenshot after the header was already fixed.
check('the form card does not promise a deposit address either',
  !/Your deposit address will be tied to this bank account/i.test(text)
  && /Choose payout and amount/i.test(text), text.slice(0, 700));
check('no Refund wallet address field on the balance path',
  await page.locator('input[name="returnAddress"]').count() === 0,
  'a refund address is for funds a liquidation address bounces back - Sivan owns the sending wallet here');

await page.screenshot({ path: 'e2e/shots/foreign-offramp-form.png', fullPage: true });

console.log('\n── the amount is validated before the user commits ──────────');

await amountField.fill('99999');
await page.locator('button', { hasText: /Review withdrawal/i }).first().click().catch(() => {});
await page.waitForTimeout(1200);
text = await body();
check('overdrawing is refused with the real balance quoted',
  /You have 500\.00 available to withdraw/i.test(text), text.slice(0, 500));

console.log('\n── a valid amount reaches the review screen ─────────────────');

await amountField.fill('100');
await page.locator('button', { hasText: /Review withdrawal/i }).first().click().catch(() => {});
await page.waitForTimeout(1500);
text = await body();
check('the review step is reached', /Review withdrawal/i.test(text), text.slice(0, 300));
check('review does not say "before creating your deposit address"',
  !/Confirm before creating your deposit address/i.test(text)
  && /Confirm your withdrawal/i.test(text), text.slice(0, 500));
check('review states the balance path, not a deposit address',
  /from your Sivan balance automatically/i.test(text), text.slice(0, 600));
check('and the amount is echoed back', /100/.test(text));

await page.screenshot({ path: 'e2e/shots/foreign-offramp-review.png', fullPage: true });

console.log('\n── with external funding ON, the choice appears ─────────────');

/**
 * The other half of the toggle, driven for real rather than reasoned about.
 * Without this the suite would only ever prove the default, and a regression
 * that broke the manual-send path would go unnoticed until a user hit it.
 */
await put('/api/admin/ngn/controls', { externalFundingEnabled: true }, ADM);
await page.goto(`${APP}/withdraw`);
await page.waitForTimeout(2500);
const bridgeTab2 = page.locator('button', { hasText: /Bank transfer \(USD/i }).first();
if (await bridgeTab2.count()) { await bridgeTab2.click().catch(() => {}); await page.waitForTimeout(800); }
text = await body();
check('"From my Sivan balance" is now offered', /From my Sivan balance/i.test(text), text.slice(0, 400));
check('"I\'ll send crypto myself" is now offered', /send crypto myself/i.test(text));

// Choosing manual send must hide the amount field and restore the warning -
// the two paths are genuinely different and the screen has to say so.
await page.locator('button', { hasText: /send crypto myself/i }).first().click().catch(() => {});
await page.waitForTimeout(600);
text = await body();
check('picking manual send hides the Amount field',
  await page.locator('input[name="sourceAmount"]').count() === 0);
check('and restores the wrong-network warning',
  /Send only the selected token on the selected network/i.test(text), text.slice(0, 500));

await page.screenshot({ path: 'e2e/shots/foreign-offramp-external.png', fullPage: true });

// Put it back, so the suite leaves the environment as it found it.
await put('/api/admin/ngn/controls', { externalFundingEnabled: false }, ADM);

console.log('\n── nothing threw ───────────────────────────────────────────');
const real = errors.filter((e) => !/favicon|404|Failed to load resource/i.test(e));
check('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

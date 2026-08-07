/**
 * A CROSS-BORDER PAYOUT NOW HAS A REVIEW STEP, AND THE FEE LINE LOST ITS
 * PERCENTAGE.
 *
 * Two changes, one screen.
 *
 * 1. "Create supplier payment" submitted straight from the form - to a THIRD
 *    PARTY'S BANK ACCOUNT, in another currency, through a compliance path the
 *    user cannot reverse. The crypto route had just been given a confirm step;
 *    this one, the higher-stakes of the two, still had none.
 *
 * 2. The transfer fee row printed "(5.00%)" beside a $0.25 charge on a $5
 *    send. That is the floor, not a rate, and rendering it as a percentage
 *    makes a flat 25 cents look like a 5% tax.
 *
 * The supplier dialog must NOT claim irreversibility. Unlike a crypto send,
 * confirming here places a HOLD and enters a review queue - an admin releases
 * or rejects. Saying "this cannot be undone" would be false, and would make
 * the "pending review" screen that follows look like a failure.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const API = process.env.API || 'http://127.0.0.1:4720';
const APP = process.env.APP || 'http://127.0.0.1:4173';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const j = { 'content-type': 'application/json' };
const post = (p, b, h = {}) => fetch(`${API}${p}`, { method: 'POST', headers: { ...j, ...h }, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, h = {}) => fetch(`${API}${p}`, { method: 'PUT', headers: { ...j, ...h }, body: JSON.stringify(b) }).then(r => r.json());
const ADM = { 'x-admin-api-key': 'e2e-admin-key' };

// ── a verified, funded user with an APPROVED supplier ────────────────
const email = `sup-${Date.now()}@example.com`;
const start = await post('/api/auth/email/start', {
  email, intent: 'signup', fullName: 'OGUNMEPON SHARAFA',
  legalAcceptance: { accepted: true, termsVersion: '1.0', privacyVersion: '1.0' },
});
const v = await post('/api/auth/email/verify', { email, code: start.data.devCode });
const user = v.data.user;
const token = v.data.token;

await put(`/api/users/${user.id}/country`, { country: 'NG' });
await post('/api/ngn/payout-accounts', { userId: user.id, bankId: '1', accountNumber: '1111111111' });
const accts = await fetch(`${API}/api/ngn/payout-accounts?userId=${user.id}`).then(r => r.json());
await put(`/api/admin/ngn/payout-accounts/${accts.data[0].id}/review`, { decision: 'approve' }, ADM);
await post(`/api/users/${user.id}/wallets`, { chain: 'solana' });
await post('/api/admin/balance/adjustments', {
  userId: user.id, asset: 'usdc', amount: 500, status: 'available', reason: 'supplier confirm journey',
}, ADM);

/**
 * A supplier needs a Bridge customer with KYC AND Terms approved - suppliers
 * are a Bridge external account under the hood, so the Nigerian bank path
 * alone is not enough. Seeded here rather than the test being weakened to
 * skip the route.
 */
// kyc-link, not POST /api/customers: only the link path sets tosStatus, and
// the supplier route requires BOTH kyc_approved and tos approved.
await post('/api/customers/kyc-link', { userId: user.id, type: 'individual' });
await post(`/api/customers/${user.id}/sandbox/simulate-kyc-approval`, {});
const cust = await fetch(`${API}/api/customers/${user.id}`).then(r => r.json());
console.log(`  customer: kyc=${cust?.data?.kycStatus} tos=${cust?.data?.tosStatus}`);

const SUPPLIER = 'Northwind Trading Ltd';
const created = await post(`/api/users/${user.id}/suppliers`, {
  userId: user.id, supplierName: SUPPLIER, accountType: 'gb', currency: 'gbp', supplierCountry: 'GB',
  bankName: 'Barclays', accountOwnerName: SUPPLIER,
  account: { sort_code: '040075', account_number: '12345678' },
  address: { street_line_1: '1 High St', city: 'London', postal_code: 'E1 6AN', country: 'GBR' },
}, { authorization: `Bearer ${token}` });

const supplierId = created?.data?.id;
if (supplierId) {
  const rev = await post(`/api/admin/suppliers/${supplierId}/review`, { decision: 'approve', reviewedBy: 'journey', reason: 'approved for the supplier-confirm journey' }, ADM);
  console.log(`  review: ${JSON.stringify(rev).slice(0, 160)}`);
}
const suppliers = await fetch(`${API}/api/users/${user.id}/suppliers`, {
  headers: { authorization: `Bearer ${token}` },
}).then(r => r.json());
const approved = (suppliers.data || []).filter((s) => s.status === 'approved');
console.log(`\n  seeded supplier: ${supplierId ?? 'FAILED ' + JSON.stringify(created).slice(0, 200)} | approved: ${approved.length}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(APP);
await page.evaluate(([t, u]) => {
  localStorage.setItem('sivan.authToken', t);
  localStorage.setItem('sivan.user', u);
}, [token, JSON.stringify(user)]);
await page.goto(`${APP}/transfer`);
await page.waitForTimeout(3000);
fs.mkdirSync('e2e/shots', { recursive: true });

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the crypto fee row no longer prints a percentage ──────');

await page.locator('.transfer-route-card', { hasText: 'Send crypto' }).first().click().catch(() => {});
await page.waitForTimeout(1000);
await page.locator('input[name="destinationAddress"]').first()
  .fill('B5YyF9W4GhET9xxuiLkTmGoMecJY5QsYascLc8XJfgTv');
await page.locator('input[name="amount"]').first().fill('20');
await page.locator('button', { hasText: /Review transfer/i }).first().click().catch(() => {});
await page.waitForTimeout(2500);

let text = await page.locator('body').innerText();
check('the fee is still shown', /Transfer fee/i.test(text));
/**
 * The AMOUNT must survive; only the rate goes. A change that removed the
 * percentage by removing the whole row would pass a naive "no % sign" check.
 */
check('and still shows a cash amount', /−0\.55 USDC|-0\.55 USDC/.test(text),
  text.split('\n').filter((l) => /fee/i.test(l)).join(' | '));
check('but NOT a percentage', !/Transfer fee \(/.test(text),
  text.split('\n').filter((l) => /Transfer fee/i.test(l)).join(' | '));

await page.locator('button', { hasText: /^Back$/ }).first().click().catch(() => {});
await page.waitForTimeout(800);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. the supplier payout asks before it submits ────────────');

await page.locator('.transfer-route-card', { hasText: 'Pay supplier' }).first().click().catch(() => {});
await page.waitForTimeout(1200);

await page.locator('input[name="amount"]').last().fill('120');
await page.locator('textarea[name="paymentPurpose"]').first().fill('Invoice INV-2001 for design work');
await page.locator('button', { hasText: /Review payment/i }).first().click().catch(() => {});
await page.waitForTimeout(1500);

text = await page.locator('body').innerText();
await page.screenshot({ path: 'e2e/shots/supplier-confirm.png', fullPage: true });

check('a confirm dialog opens instead of submitting', /Confirm supplier payment/i.test(text),
  text.slice(0, 300));
check('the button now says Review, not Create', /Review payment/i.test(text));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. it shows who is being paid, and what leaves ───────────');

check('the supplier is named', text.includes(SUPPLIER), text.slice(0, 400));
check('the bank is shown for a sanity check', /Barclays/i.test(text));
check('with the last 4 of the account', /5678/.test(text),
  'paying the right amount to the wrong approved supplier passes every validation');
check('the amount leaving is in USDC', /120 USDC/.test(text));
check('and the payout currency is stated separately', /GBP/.test(text),
  'USDC leaves the balance; the supplier is paid in GBP - one figure would hide which');
check('the balance after is shown', /Balance after/i.test(text));
check('and the purpose is echoed back', /INV-2001/.test(text));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 4. it does NOT claim the money is gone ───────────────────');

/**
 * The crypto dialog correctly says "this cannot be undone". Here that would be
 * false - the USDC is HELD and a reviewer releases or rejects it. Copying the
 * stronger wording would be a lie in the user's favour, and would make the
 * pending-review screen that follows read as a failure.
 */
check('it does not say "cannot be undone"', !/cannot be undone/i.test(text),
  'a supplier payout is held for review, not broadcast');
check('it explains the hold', /hold/i.test(text), text.slice(0, 500));
check('and that a reviewer decides', /review/i.test(text));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 5. confirmation is gated ────────────────────────────────');

const payBtn = page.locator('button', { hasText: /^Pay 120 USDC$/ }).first();
check('the pay button names the amount', await payBtn.count() > 0);
check('and is DISABLED until the supplier is acknowledged',
  await payBtn.isDisabled().catch(() => false),
  'a confirm reachable by muscle memory from the previous button position is not a confirm');

await page.locator('.confirm-ack input[type="checkbox"]').first().check().catch(() => {});
await page.waitForTimeout(400);
check('ticking the acknowledgement enables it',
  await payBtn.isEnabled().catch(() => false));

check('no uncaught page errors', errors.filter((e) => !/favicon|404/i.test(e)).length === 0,
  errors.slice(0, 2).join(' | '));

await browser.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

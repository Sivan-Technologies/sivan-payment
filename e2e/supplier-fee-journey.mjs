/**
 * THE SUPPLIER FEE, ON THE ACTUAL SCREEN.
 *
 * The unit suite proves the arithmetic. It cannot see what the dialog renders,
 * and the transfer dialog already shipped once charging a fee it never
 * displayed - the exact bug this route was at risk of repeating.
 *
 * WHAT THIS HAS TO CATCH:
 *   - the fee row exists and shows a real number, not "Calculating…" forever
 *   - the headline and the button quote the GROSS, not the amount typed
 *   - "balance after" is reduced by the gross
 *   - the numbers on screen agree with the server's own quote endpoint
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const API = process.env.API || 'http://127.0.0.1:4730';
const APP = process.env.APP || 'http://127.0.0.1:4174';
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const j = { 'content-type': 'application/json' };
const post = (p, b, h = {}) => fetch(`${API}${p}`, { method: 'POST', headers: { ...j, ...h }, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, h = {}) => fetch(`${API}${p}`, { method: 'PUT', headers: { ...j, ...h }, body: JSON.stringify(b) }).then(r => r.json());
const ADM = { 'x-admin-api-key': 'e2e-admin-key' };

const email = `supfee-${Date.now()}@example.com`;
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
  userId: user.id, asset: 'usdc', amount: 5000, status: 'available', reason: 'supplier fee journey',
}, ADM);

await post('/api/customers/kyc-link', { userId: user.id, type: 'individual' });
await post(`/api/customers/${user.id}/sandbox/simulate-kyc-approval`, {});

const SUPPLIER = 'Northwind Trading Ltd';
const created = await post(`/api/users/${user.id}/suppliers`, {
  userId: user.id, supplierName: SUPPLIER, accountType: 'gb', currency: 'gbp', supplierCountry: 'GB',
  bankName: 'Barclays', accountOwnerName: SUPPLIER,
  account: { sort_code: '040075', account_number: '12345678' },
  address: { street_line_1: '1 High St', city: 'London', postal_code: 'E1 6AN', country: 'GBR' },
}, { authorization: `Bearer ${token}` });
const supplierId = created?.data?.id;
if (supplierId) {
  await post(`/api/admin/suppliers/${supplierId}/review`,
    { decision: 'approve', reviewedBy: 'journey', reason: 'approved for the supplier fee journey' }, ADM);
}
if (!supplierId) { console.error('supplier seed failed', JSON.stringify(created).slice(0, 300)); process.exit(1); }

/**
 * THE SERVER'S OWN NUMBER, fetched first.
 *
 * Everything on screen is compared against this rather than against a figure
 * hardcoded in the test. A hardcoded expectation drifts the moment the default
 * curve is retuned and starts failing for a reason that is not a bug; this
 * asserts the thing that actually matters - that the UI shows what the server
 * will charge.
 */
const AMOUNT = '600';
const quoteRes = await fetch(`${API}/api/users/${user.id}/supplier-payments/quote?amount=${AMOUNT}`).then(r => r.json());
const quote = quoteRes.data ?? quoteRes;
console.log(`  server quote: net=${quote.netAmount} fee=${quote.fee} gross=${quote.grossAmount} rate=${quote.effectivePercent}%`);

// 600 = 500@1.5% (7.50) + 100@1.2% (1.20) = 8.70
check('the server prices $600 across two marginal bands = 8.70',
  quote.fee === '8.70', quote.fee);
check('and the gross is the amount plus the fee',
  quote.grossAmount === '608.70', quote.grossAmount);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
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

await page.locator('.transfer-route-card', { hasText: 'Pay supplier' }).first().click().catch(() => {});
await page.waitForTimeout(1200);
await page.locator('input[name="amount"]').last().fill(AMOUNT);
await page.locator('textarea[name="paymentPurpose"]').first().fill('Invoice INV-3001 for manufacturing');
await page.locator('button', { hasText: /Review payment/i }).first().click().catch(() => {});
// Long enough for the quote round trip to land and replace "Calculating…".
await page.waitForTimeout(3000);

const text = await page.locator('body').innerText();
await page.screenshot({ path: 'e2e/shots/supplier-fee-confirm.png', fullPage: true });

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the fee is actually on screen ─────────────────────────');

check('a Sivan fee row is rendered', /Sivan fee/i.test(text),
  text.split('\n').filter((l) => /fee/i.test(l)).join(' | ') || '(no fee line)');
/**
 * THE ROW MUST HAVE RESOLVED. "Calculating…" forever is the failure mode of a
 * quote that 404s or throws - and it looks like a fee row, so a test that only
 * checked for the label would pass against a permanently broken dialog.
 */
check('and it shows a number, not a stuck "Calculating…"',
  !/Calculating/i.test(text),
  text.split('\n').filter((l) => /Sivan fee|Calculating/i.test(l)).join(' | '));
check(`the fee shown is the server's ${quote.fee}`,
  text.includes(quote.fee), `expected ${quote.fee}`);

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. the totals describe the GROSS, not the amount typed ───');

/**
 * The fee is ADDED on this route, so the amount typed is NOT what leaves the
 * balance. Every total the user reads before agreeing has to say so.
 */
check('the supplier is shown receiving the full amount typed',
  text.includes(quote.netAmount), quote.netAmount);
check('the total debited is the gross',
  text.includes(quote.grossAmount), quote.grossAmount);
check('and the confirm button quotes the gross, not the net',
  await page.locator('button', { hasText: new RegExp(`Pay\\s+${quote.grossAmount.replace('.', '\\.')}`) }).count() > 0,
  await page.locator('.transfer-confirm-actions button').last().innerText().catch(() => '?'));

/**
 * BALANCE AFTER must subtract the gross. Subtracting the net would understate
 * the cost by exactly the fee - the number the user is checking.
 */
const expectedRemaining = (5000 - Number(quote.grossAmount)).toFixed(2);
check(`"balance after" is reduced by the gross (${expectedRemaining})`,
  text.replace(/,/g, '').includes(expectedRemaining), `expected ${expectedRemaining}`);
/**
 * AND IT IS FORMATTED LIKE THE REST OF THE COLUMN.
 *
 * This assertion failed first time and the DIALOG WAS RIGHT - it rendered
 * "4,391.3" because maximumFractionDigits:6 drops a trailing zero, while every
 * neighbouring row showed two decimals. My expectation was correct arithmetic
 * and the wrong format, which is exactly the kind of ragged money figure that
 * reads as a bug to a user.
 */
check('and it is shown with 2 decimals like every other money row',
  !/Balance after\s*\n?\s*[\d,]+\.\d(?!\d)/.test(text),
  text.split('\n').filter((l) => /Balance after/i.test(l)).join(' | '));

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. the dialog still tells the truth about what happens ───');

check('it still says the money is HELD, not sent',
  /hold/i.test(text) && /review/i.test(text));
check('and does not claim irreversibility - a reviewer can reject it',
  !/cannot be undone/i.test(text));
check('no page errors', errors.length === 0, errors.join(' | '));

await browser.close();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

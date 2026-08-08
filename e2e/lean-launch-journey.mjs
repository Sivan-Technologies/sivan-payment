/**
 * SHIPPING LEAN: the admin kill switch must actually remove the route.
 *
 * The server already refused supplier payouts when disabled - but nothing in
 * the customer app read the flag, so the entire Pay-supplier route stayed on
 * screen. A user could pick a currency, type a supplier's IBAN and their
 * invoice details, and only then get a 403.
 *
 * For a lean launch that is the worst of both worlds: the scope is not really
 * reduced (the UI still advertises it) and the failure is late and confusing.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const API = process.env.API || 'http://127.0.0.1:4750';
const APP = process.env.APP || 'http://127.0.0.1:4175';
let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` -> ${d}` : ''}`); } };
const j = { 'content-type': 'application/json' };
const post = (p, b, h = {}) => fetch(`${API}${p}`, { method: 'POST', headers: { ...j, ...h }, body: JSON.stringify(b) }).then(r => r.json());
const put = (p, b, h = {}) => fetch(`${API}${p}`, { method: 'PUT', headers: { ...j, ...h }, body: JSON.stringify(b) }).then(r => r.json());
const ADM = { 'x-admin-api-key': 'e2e-admin-key' };

const email = `lean-${Date.now()}@example.com`;
const start = await post('/api/auth/email/start', { email, intent: 'signup', fullName: 'OGUNMEPON SHARAFA', legalAcceptance: { accepted: true, termsVersion: '1.0', privacyVersion: '1.0' } });
const v = await post('/api/auth/email/verify', { email, code: start.data.devCode });
const user = v.data.user, token = v.data.token;
await put(`/api/users/${user.id}/country`, { country: 'NG' });
await post('/api/ngn/payout-accounts', { userId: user.id, bankId: '1', accountNumber: '1111111111' });
const accts = await fetch(`${API}/api/ngn/payout-accounts?userId=${user.id}`).then(r => r.json());
await put(`/api/admin/ngn/payout-accounts/${accts.data[0].id}/review`, { decision: 'approve' }, ADM);
await post(`/api/users/${user.id}/wallets`, { chain: 'solana' });
await post('/api/customers/kyc-link', { userId: user.id, type: 'individual' });
await post(`/api/customers/${user.id}/sandbox/simulate-kyc-approval`, {});

const setSupplier = async (enabled) => {
  const cur = await fetch(`${API}/api/admin/supplier-payments/controls`, { headers: ADM }).then(r => r.json()).then(d => d.data ?? d);
  await put('/api/admin/supplier-payments/controls', { ...cur, supplierPaymentsEnabled: enabled, updatedBy: 'ops', reason: 'lean launch journey' }, ADM);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(APP);
await page.evaluate(([t, u]) => { localStorage.setItem('sivan.authToken', t); localStorage.setItem('sivan.user', u); }, [token, JSON.stringify(user)]);
fs.mkdirSync('e2e/shots', { recursive: true });

// ── OFF ───────────────────────────────────────────────────────────────
console.log('\n── 1. switched OFF: the route is gone, not broken ───────────');
await setSupplier(false);
const ctrlOff = await fetch(`${API}/api/offramp/controls`).then(r => r.json()).then(d => d.data ?? d);
check('the public controls endpoint reports it disabled', ctrlOff.supplierPayoutsEnabled === false, String(ctrlOff.supplierPayoutsEnabled));

await page.goto(`${APP}/transfer`);
await page.waitForTimeout(3000);
let text = await page.locator('body').innerText();
await page.screenshot({ path: 'e2e/shots/lean-off.png', fullPage: true });

check('the Pay-supplier route card is NOT rendered',
  await page.locator('.transfer-route-card', { hasText: 'Pay supplier' }).count() === 0);
check('no supplier bank form is reachable',
  await page.locator('input[name="supplierName"]').count() === 0);
/** The point of shipping lean: the feature must not be advertised. */
check('the page does not advertise cross-border payouts',
  !/Add supplier bank/i.test(text) && !/Saved suppliers/i.test(text),
  text.split('\n').filter((l) => /supplier/i.test(l)).slice(0, 3).join(' | '));
/**
 * AND NOTHING POINTS AT THE ROUTE THAT IS GONE.
 *
 * Caught in the screenshot: the crypto form's warning box still said
 * "use the Pay supplier route" with that route hidden. Directions to a tab
 * that does not exist read as a broken app rather than a lean one.
 */
check('nothing directs the user to the hidden route',
  !/use the Pay supplier route/i.test(text) && !/pay suppliers through/i.test(text),
  text.split('\n').filter((l) => /Pay supplier/i.test(l)).join(' | '));

check('but Send crypto still works - scope reduced, not broken',
  await page.locator('.transfer-route-card', { hasText: 'Send crypto' }).count() > 0);
check('no page errors', errors.length === 0, errors.join(' | '));

// ── ON ────────────────────────────────────────────────────────────────
console.log('\n── 2. switched ON: it comes back, no deploy ─────────────────');
await setSupplier(true);
const ctrlOn = await fetch(`${API}/api/offramp/controls`).then(r => r.json()).then(d => d.data ?? d);
check('the public controls endpoint reports it enabled', ctrlOn.supplierPayoutsEnabled === true);

await page.reload();
await page.waitForTimeout(3000);
await page.screenshot({ path: 'e2e/shots/lean-on.png', fullPage: true });
check('the Pay-supplier route card is back',
  await page.locator('.transfer-route-card', { hasText: 'Pay supplier' }).count() > 0);
await page.locator('.transfer-route-card', { hasText: 'Pay supplier' }).first().click();
await page.waitForTimeout(1200);
check('and the supplier form is usable again',
  await page.locator('input[name="supplierName"]').count() > 0);

// ── the server still refuses regardless of the UI ─────────────────────
console.log('\n── 3. the switch is enforced server-side, not just hidden ───');
await setSupplier(false);
const refused = await post(`/api/users/${user.id}/supplier-payments`, { supplierId: 'sup_any', amount: 100, destinationCurrency: 'gbp', paymentPurpose: 'lean launch enforcement probe' }, { authorization: `Bearer ${token}` });
check('a direct API call is still refused when hidden',
  /disabled/i.test(JSON.stringify(refused)), JSON.stringify(refused).slice(0, 140));
check('and it is a clean refusal, not a 500',
  refused?.error?.code === 'forbidden', JSON.stringify(refused?.error?.code));
await setSupplier(true);

await browser.close();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

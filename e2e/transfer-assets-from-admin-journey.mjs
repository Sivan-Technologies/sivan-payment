/**
 * THE SEND-CRYPTO ASSET LIST COMES FROM ADMIN, AND THE DEAD ROUTE IS GONE.
 *
 * Two reports, one screen.
 *
 * 1. The asset dropdown was hardcoded to `usdc` plus a permanently disabled
 *    "USDT (Tether), coming soon". USDT was ALREADY enabled in admin - live
 *    controls show `usdt: enabled true`, set by sup_ola - so the product was
 *    telling users the one asset the operator had switched on was unavailable.
 *    Same class of fault as the hidden fee: the screen and the system
 *    disagreed, and the screen won.
 *
 * 2. "Transfer to @username" advertised a route that does nothing. Clicking it
 *    opened a panel reading "Roadmap - this future route will...". A disabled
 *    third of the chooser is a promise the product cannot keep.
 *
 * Both directions are asserted here: turning an asset OFF must remove it, and
 * turning it ON must show it. A test that only checks the enabled case would
 * pass against a list that is still hardcoded, just hardcoded differently.
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

// ── a verified, funded user who can reach the form ───────────────────
const email = `assets-${Date.now()}@example.com`;
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
  userId: user.id, asset: 'usdc', amount: 100, status: 'available', reason: 'asset list journey',
}, ADM);

const browser = await chromium.launch();

async function openSendCrypto() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(APP);
  await page.evaluate(([t, u]) => {
    localStorage.setItem('sivan.authToken', t);
    localStorage.setItem('sivan.user', u);
  }, [token, JSON.stringify(user)]);
  await page.goto(`${APP}/transfer`);
  await page.waitForTimeout(3000);
  // The page opens on Pay supplier; the Send crypto form is not in the DOM
  // until its route card is clicked.
  await page.locator('.transfer-route-card', { hasText: 'Send crypto' }).first().click().catch(() => {});
  await page.waitForTimeout(1200);
  return { page, errors };
}

/** Open the asset dropdown and read the options it offers. */
async function assetOptions(page) {
  const select = page.locator('label:has-text("Asset") .custom-select, label:has-text("Asset") [role="button"], label:has-text("Asset") button').first();
  await select.click().catch(() => {});
  await page.waitForTimeout(500);
  const text = await page.locator('body').innerText();
  return text;
}

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 1. the dead "coming soon" route is gone ──────────────────');

const a = await openSendCrypto();
let text = await a.page.locator('body').innerText();

check('the route chooser still offers Send crypto', /Send crypto/i.test(text));
check('and Pay supplier / cross-border', /Pay supplier/i.test(text));
check('"Transfer to @username" is NOT shown', !/Transfer to @username/i.test(text),
  text.split('\n').filter((l) => /username/i.test(l)).join(' | '));
check('and neither is its Roadmap panel', !/Roadmap/i.test(text));

fs.mkdirSync('e2e/shots', { recursive: true });
await a.page.screenshot({ path: 'e2e/shots/transfer-routes.png', fullPage: true });

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 2. USDT ENABLED in admin -> offered, not "coming soon" ───');

await put('/api/admin/offramp/controls', {
  sourceAssets: [{ asset: 'usdc', enabled: true }, { asset: 'usdt', enabled: true }],
  updatedBy: 'asset-journey', reason: 'both assets on',
}, ADM);

const live = await fetch(`${API}/api/offramp/controls`).then(r => r.json());
const enabled = (live.data.sourceAssets || []).filter((x) => x.enabled).map((x) => x.asset);
check('admin now reports both assets enabled', enabled.includes('usdc') && enabled.includes('usdt'),
  JSON.stringify(enabled));

await a.page.close();
const b = await openSendCrypto();
text = await assetOptions(b.page);

check('USDC is offered', /USDC/.test(text));
check('USDT is offered', /USDT/.test(text), text.split('\n').filter((l) => /USD[CT]/.test(l)).join(' | '));
/**
 * THE ASSERTION THAT MATTERS. The old list did show the string "USDT" - as a
 * disabled "coming soon" entry. Showing it is not enough; it must not be
 * labelled unavailable while admin has it switched on.
 */
check('and USDT is NOT labelled "coming soon"', !/coming soon/i.test(text),
  text.split('\n').filter((l) => /USDT|coming/i.test(l)).join(' | '));

await b.page.screenshot({ path: 'e2e/shots/transfer-assets-both.png', fullPage: true });
await b.page.close();

// ─────────────────────────────────────────────────────────────────────
console.log('\n── 3. USDT DISABLED in admin -> it disappears ───────────────');

/**
 * The other direction, and the one a hardcoded list would still fail. If this
 * passed while the options were fixed in the source, the test would be
 * decorative.
 */
await put('/api/admin/offramp/controls', {
  sourceAssets: [{ asset: 'usdc', enabled: true }, { asset: 'usdt', enabled: false }],
  updatedBy: 'asset-journey', reason: 'usdt off',
}, ADM);

const off = await fetch(`${API}/api/offramp/controls`).then(r => r.json());
check('admin now reports USDT disabled',
  !(off.data.sourceAssets || []).some((x) => x.asset === 'usdt' && x.enabled));

const c = await openSendCrypto();
text = await assetOptions(c.page);
check('USDC is still offered', /USDC/.test(text));
check('USDT is GONE from the dropdown', !/USDT/.test(text),
  text.split('\n').filter((l) => /USD[CT]/.test(l)).join(' | '));
check('no uncaught page errors', c.errors.filter((e) => !/favicon|404/i.test(e)).length === 0,
  c.errors.slice(0, 2).join(' | '));

await c.page.screenshot({ path: 'e2e/shots/transfer-assets-usdc-only.png', fullPage: true });
await c.page.close();

// restore
await put('/api/admin/offramp/controls', {
  sourceAssets: [{ asset: 'usdc', enabled: true }, { asset: 'usdt', enabled: true }],
  updatedBy: 'asset-journey', reason: 'restore',
}, ADM);

await browser.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

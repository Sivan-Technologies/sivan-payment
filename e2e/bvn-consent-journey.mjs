/**
 * THE BVN CONSENT HAND-OFF, IN A BROWSER.
 *
 * The unit suite proves the server returns a consent URL and can collect the
 * result. It cannot prove the URL reaches the SCREEN - and that was the whole
 * bug: the server had been returning it inside matchedFields all along while
 * the form rendered only `message`, so the user read "needs manual review",
 * had nothing to click, and waited for a human who was never coming.
 *
 * Drives the real built bundle: submit the Level 2 form, get a consent
 * response, and check that an approval link and a way to finish both appear.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5179';
const USER = 'u_1';
const CONSENT_URL = 'https://nibss.example/consent/abc123';

let completeCalls = 0;
let verdict = 'review';

function stub() {
  return async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const j = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: o }) });
    const U = `/api/users/${USER}`;

    if (p === `${U}/kyc/ngn-bvn/verify`) {
      return j({
        status: 'review', level: 'ngn_level_2', provider: 'flutterwave', bvnLast4: '4821',
        message: 'Approve the request with your BVN provider to finish. This opens a secure page from our partner.',
        matchedFields: { consentRequired: true, consentUrl: CONSENT_URL },
        providerReference: 'flw_ref_123',
        consentUrl: CONSENT_URL, awaitingUserConsent: true,
      });
    }
    if (p === `${U}/kyc/ngn-bvn/complete`) {
      completeCalls += 1;
      return j(verdict === 'matched'
        ? { status: 'matched', level: 'ngn_level_2', provider: 'flutterwave', bvnLast4: '4821',
            message: 'Your Nigerian identity check was successful.', awaitingUserConsent: false }
        : { status: 'review', level: 'ngn_level_2', provider: 'flutterwave', bvnLast4: '4821',
            message: 'Approve the request with your BVN provider to finish. This opens a secure page from our partner.',
            consentUrl: CONSENT_URL, awaitingUserConsent: true });
    }

    if (p === '/api/system/status') return j({ mode: 'active', activeIncidents: [] });
    if (p === '/api/offramp/controls') return j({
      customerTypes: [{ customerType: 'individual', enabled: true, label: 'Individual' }],
      payoutCurrencies: [], virtualAccounts: [],
      sourceAssets: [{ asset: 'usdc', enabled: true, label: 'USDC' }],
      sourceNetworks: [{ network: 'solana', enabled: true, label: 'Solana', sortOrder: 10 }],
      supplierPayoutsEnabled: true, ngnOfframpFeePercent: '1',
    });
    // Level 1 Nigerian with a verified NUBAN: exactly who is offered Level 2.
    if (p === `${U}/verification-summary`) return j({
      level: 1, levelLabel: 'Level 1: Bank verified', path: 'ngn_bank', country: 'NG',
      checks: { identity: 'not_started', bank: 'verified', nin: 'not_started', bvn: 'not_started', proofOfAddress: 'not_started', sourceOfFunds: 'not_started' },
      upliftApplies: false, terms: { required: false, accepted: true },
      identityComplete: true, pathComplete: true, hasPayoutAccount: true,
      hasPendingPayoutReview: false, windowDays: 30,
      allowances: [{ flow: 'offramp', rail: 'ngn', limitNgn: 100000, usedNgn: 0, remainingNgn: 100000 }],
      nextStep: { level: 2, label: 'Level 2', description: 'Add your BVN to raise your limit.', action: 'nin_bvn', available: true },
    });
    if (p === `/api/customers/${USER}`) return j({ id: 'cus_1', provider: 'breet', kycStatus: 'kyc_approved', tosStatus: 'approved' });
    if (p === `${U}/balance/unified`) return j({ totalUsd: '0.00', availableUsd: '0.00', heldUsd: '0.00', balances: [] });
    if (p.startsWith('/api/')) return j([]);
    return route.continue();
  };
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addInitScript((u) => {
  localStorage.setItem('sivan.user', JSON.stringify({ id: u, email: 'bvn@sivantech.online', fullName: 'BVN Probe', status: 'active' }));
  localStorage.setItem('sivan.authToken', 'stub-token');
  localStorage.setItem('sivan.theme', 'light');
}, USER);

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
};

const page = await ctx.newPage();
await page.route('**/api/**', stub());
await page.goto(`${BASE}/verification`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

let body = await page.evaluate(() => document.body.innerText);
// Guard: a suite that cannot tell which page it is on cannot report on it.
check('verification page rendered', /Verification/i.test(body), body.slice(0, 90).replace(/\n/g, ' | '));

const startBtn = page.locator('button', { hasText: 'Start Level 2' });
check('the Level 2 entry point is offered', await startBtn.count() > 0);
if (await startBtn.count() > 0) await startBtn.first().click();
await page.waitForTimeout(500);

// Fill and submit.
await page.fill('input[name="firstName"]', 'Micheal');
await page.fill('input[name="lastName"]', 'Samson');
await page.fill('input[name="dateOfBirth"]', '01-01-1990');
await page.fill('input[name="mobileNo"]', '08012345678');
await page.fill('input[name="bvn"]', '12345678901');
await page.locator('form.ngn-level2-card button.primary-btn').first().click();
await page.waitForTimeout(1500);

body = await page.evaluate(() => document.body.innerText);
await page.locator('.ngn-consent-steps').scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/bvn-consent.png' });

// ── the bug, asserted against the rendered page ────────────────────────────
check('the user is NOT told to wait for a human',
  !/manual review/i.test(body), 'still says "needs manual review"');
check('an approval action is offered', /Open approval page/i.test(body), 'no way to reach the consent page');
check('a way to finish is offered', /I have approved/i.test(body), 'no way to collect the result');

// The link must actually point at the provider, not be decorative text.
const href = await page.locator('a', { hasText: 'Open approval page' }).first().getAttribute('href').catch(() => null);
check('the approval link points at the real consent URL', href === CONSENT_URL, String(href));
const rel = await page.locator('a', { hasText: 'Open approval page' }).first().getAttribute('rel').catch(() => null);
check('the third-party link does not leak our referrer', String(rel || '').includes('noreferrer'), String(rel));

/**
 * THE TWO ACTIONS MUST LOOK LIKE A PAIR.
 *
 * Asserted on the COMPOSITED geometry, not on the stylesheet: the first
 * version of this CSS let the anchor stretch to full width while the button
 * beside it stayed content-width, so they sat as two mismatched blocks. Every
 * text assertion above passed while the screenshot plainly showed it.
 */
const geom = await page.evaluate(() => {
  const wrap = document.querySelector('.ngn-consent-steps .consent-actions');
  if (!wrap) return null;
  const a = wrap.querySelector('a');
  const b = wrap.querySelector('button');
  if (!a || !b) return null;
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  return { aw: ra.width, bw: rb.width, ww: wrap.getBoundingClientRect().width, sameRow: Math.abs(ra.top - rb.top) < 4 };
});
check('both consent actions exist in one row', Boolean(geom?.sameRow), JSON.stringify(geom));
check('the approval link is not stretched to full width',
  Boolean(geom && geom.aw < geom.ww - 20), JSON.stringify(geom));

// Re-submitting during consent would start a SECOND request and burn an attempt.
const submitVisible = await page.locator('form.ngn-level2-card button.primary-btn', { hasText: 'Submit Level 2' }).count();
check('re-submitting is prevented while awaiting approval', submitVisible === 0, `${submitVisible} submit buttons still shown`);

// ── pressing "I have approved" collects the result ─────────────────────────
verdict = 'matched';
await page.locator('button', { hasText: 'I have approved' }).first().click();
await page.waitForTimeout(1500);
body = await page.evaluate(() => document.body.innerText);

check('the completion endpoint was called', completeCalls > 0, `${completeCalls} calls`);
check('success is shown once approved', /successful/i.test(body), body.split('\n').find((l) => /BVN|success/i.test(l)) || '');
await page.screenshot({ path: '/tmp/bvn-verified.png' });

console.log(`\n${failures === 0 ? 'PASS' : `${failures} FAILED`}`);
await browser.close();
if (failures) process.exit(1);

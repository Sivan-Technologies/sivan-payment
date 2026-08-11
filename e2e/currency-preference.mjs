/**
 * DOES THE PREFERENCE CHANGE WHAT IS ON THE SCREEN?
 *
 * The unit suite (scripts/test-display-currency.ts) proves the formatter and
 * the resolver behave. It cannot prove the value is actually WIRED to the
 * component - and that gap is the entire original bug: a working Settings
 * select, a value saved to the database, and a dashboard that never read it.
 *
 * So this drives a real browser against the built bundle and reads the
 * rendered text. Two runs of the same page, differing only in the
 * `defaultFiatCurrency` the preferences endpoint returns.
 *
 * NOTE ON THE STUB. e2e/stub.mjs returns `{ currency: 'USD' }` from
 * /preferences and `limitUsd` inside allowances - neither field exists on the
 * real types (UserPreferencesRecord.defaultFiatCurrency, FlowAllowance
 * .limitNgn). Reusing it would have tested against a shape the server never
 * sends. The stub here is taken from src/types.ts and the live
 * /api/offramp/controls payload.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5179';
const CURRENCY = process.env.CURRENCY || 'ngn';
const USER = 'u_1';

const FX = {
  ngnPerUnit: { ngn: 1, usd: 1500, gbp: 2000, eur: 1600 },
  configured: { ngn: true, usd: true, gbp: true, eur: true },
  approximate: true,
  enforcementCurrency: 'ngn',
};

function stub(currency) {
  return async (route) => {
    const p = new URL(route.request().url()).pathname;
    const j = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: o }) });
    const U = `/api/users/${USER}`;

    if (p === '/api/system/status') return j({ mode: 'active', activeIncidents: [] });
    if (p === '/api/offramp/controls') return j({
      customerTypes: [{ customerType: 'individual', enabled: true, label: 'Individual' }],
      payoutCurrencies: [
        { currency: 'usd', enabled: true, label: 'USD — US bank account', accountType: 'us', defaultPaymentRail: 'ach', updatedAt: '2026-08-01T00:00:00Z' },
        { currency: 'ngn', enabled: true, label: 'NGN — Nigerian bank account', accountType: 'nuban', defaultPaymentRail: 'nip', updatedAt: '2026-08-01T00:00:00Z' },
      ],
      virtualAccounts: [], sourceAssets: [{ asset: 'usdc', enabled: true, label: 'USDC' }],
      sourceNetworks: [{ network: 'solana', enabled: true, label: 'Solana', sortOrder: 10 }],
      supplierPayoutsEnabled: true, ngnOfframpFeePercent: '1',
      displayFx: FX,
    });
    // limitNgn / usedNgn / remainingNgn - the real FlowAllowance field names.
    if (p === `${U}/verification-summary`) return j({
      level: 1, levelLabel: 'Level 1: Bank verified', path: 'ngn_bank', country: 'NG',
      checks: {}, identitySource: 'ngn_bank', upliftApplies: false,
      terms: { required: false, accepted: true },
      identityComplete: true, pathComplete: true, hasPayoutAccount: true,
      hasPendingPayoutReview: false, windowDays: 30,
      allowances: [{ flow: 'offramp', rail: 'ngn', allowed: true, limitNgn: 150000, usedNgn: 30000, remainingNgn: 120000 }],
    });
    if (p === `${U}/preferences`) return j({
      userId: USER, defaultFiatCurrency: currency, language: 'en-US',
      transactionUpdates: true, marketingEmails: false, securityAlerts: true,
      emailConfirmationsForHighValue: false, updatedAt: '2026-08-01T00:00:00Z',
    });
    if (p === `/api/customers/${USER}`) return j({ id: 'cus_1', provider: 'bridge', kycStatus: 'kyc_approved', tosStatus: 'approved' });
    if (p === `${U}/balance/unified`) return j({ totalUsd: '1250.00', availableUsd: '1250.00', heldUsd: '0.00', balances: [] });
    if (p === `${U}/balance`) return j({ totalUsd: '1250.00', availableUsd: '1250.00', heldUsd: '0.00', balances: [] });
    if (p.startsWith('/api/')) return j([]);
    return route.continue();
  };
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript(([u, c]) => {
  localStorage.setItem('sivan.user', JSON.stringify({ id: u, email: 'probe@sivantech.online', fullName: 'Probe User', status: 'active' }));
  // 'sivan.authToken' is the real key (App.tsx:57). My first pass used
  // 'sivan.token', so the app stayed logged out and rendered the LANDING page -
  // whose marketing hero contains '$987.50' and a '1 USDC ~ $1.00' rate line.
  // The naive body-wide checks for '$' and '~' both came back true on it, in
  // BOTH runs, and would have read as a pass. Caught by opening the
  // screenshot instead of trusting the booleans.
  localStorage.setItem('sivan.authToken', 'stub-token');
  localStorage.setItem('sivan.theme', 'light');
  void c;
}, [USER, CURRENCY]);

const page = await ctx.newPage();
await page.route('**/api/**', stub(CURRENCY));
await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const body = await page.evaluate(() => document.body.innerText);
await page.screenshot({ path: `/tmp/currency-${CURRENCY}.png`, fullPage: false });

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
};

/**
 * PROVE WE ARE ON THE DASHBOARD BEFORE ASSERTING ANYTHING ABOUT IT.
 *
 * My first run of this file asserted straight against document.body.innerText
 * with the wrong localStorage key, so the app stayed logged out and served the
 * LANDING page. Its hero contains '$987.50' and '1 USDC ~ $1.00', which made a
 * bare "does the page contain a dollar sign" check return TRUE for both the
 * USD run and the NGN run - two identical passes that proved nothing. A test
 * that cannot tell which page it is looking at cannot report on that page.
 */
check('the dashboard actually rendered', body.includes('YOUR LIMIT'), body.slice(0, 120).replace(/\n/g, ' | '));

// The limit figure SPECIFICALLY - a '$' anywhere else on the page is not
// evidence that this card converted.
const limitLine = (body.split('\n').find((l) => l.includes('left')) || '').trim();
check('the limit card shows a figure', Boolean(limitLine), 'no line containing "left"');

if (CURRENCY === 'ngn') {
  check('naira user reads naira', limitLine.includes('₦'), limitLine);
  check('an exact figure is not marked approximate', !limitLine.includes('≈'), limitLine);
  check('the naira limit is the unconverted server figure', limitLine.includes('120,000'), limitLine);
} else {
  check('the preference is honoured on screen', !limitLine.includes('₦'), limitLine);
  check('the chosen symbol is shown', limitLine.includes('$'), limitLine);
  check('a converted figure is marked approximate', limitLine.includes('≈'), limitLine);
  // 120,000 / 1500. Asserts the ARITHMETIC reached the screen, not merely that
  // a dollar sign did - a hardcoded '$' would pass the two checks above.
  check('the converted amount is correct', limitLine.includes('80.00'), limitLine);
  // The naira figure must not survive anywhere on the card.
  check('no stale naira figure elsewhere on the card', !body.includes('120,000'), 'raw 120,000 still on the page');
}

console.log(`\n${CURRENCY}: ${failures === 0 ? 'PASS' : `${failures} FAILED`}`);
await browser.close();
if (failures) process.exit(1);

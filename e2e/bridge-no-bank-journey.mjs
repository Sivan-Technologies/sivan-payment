/**
 * THE REPORTED ACCOUNT, IN A BROWSER.
 *
 * Nigerian, Bridge KYC approved, terms accepted, NO payout account. The four
 * screenshots showed: "Verification complete" beside "Level 0: Starter" and
 * "50% complete", Receive saying "Verify your identity first", Send saying
 * "Complete verification before transferring crypto", and the dashboard
 * showing "₦0 left · Level 0: Starter".
 *
 * The server fix is asserted in scripts/test-identity-without-bank.ts. This
 * asserts the thing the user actually complained about - what is ON THE PAGE.
 *
 * The stub is shaped from src/types.ts and from what the real
 * /verification-summary now returns for this user: level 2, pathComplete true,
 * hasPayoutAccount false, and an NGN allowance carrying
 * blockedBy: 'payout_account_required'.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5179';
const USER = 'u_1';

function stub() {
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
    });

    // LEVEL 2, no payout account. This is the shape the fixed server emits.
    if (p === `${U}/verification-summary`) return j({
      level: 2, levelLabel: 'Level 2: Identity verified', path: 'ngn_bank', country: 'NG',
      checks: { identity: 'verified', bank: 'not_started', nin: 'verified', bvn: 'not_started', proofOfAddress: 'not_started', sourceOfFunds: 'not_started' },
      identitySource: 'bridge', upliftApplies: false,
      terms: { required: true, accepted: true },
      identityComplete: true, pathComplete: true,
      hasPayoutAccount: false, hasPendingPayoutReview: false, windowDays: 30,
      allowances: [
        { flow: 'offramp', rail: 'ngn', limitNgn: 5000000, usedNgn: 0, remainingNgn: 5000000, blockedBy: 'payout_account_required' },
        { flow: 'offramp', rail: 'foreign', limitNgn: 500000, usedNgn: 0, remainingNgn: 500000 },
      ],
    });
    if (p === `/api/customers/${USER}`) return j({ id: 'cus_1', provider: 'bridge', kycStatus: 'kyc_approved', tosStatus: 'approved' });
    if (p === `${U}/preferences`) return j({ userId: USER, defaultFiatCurrency: 'ngn', language: 'en-US', transactionUpdates: true, marketingEmails: false, securityAlerts: true, emailConfirmationsForHighValue: false, updatedAt: '2026-08-01T00:00:00Z' });
    if (p === `${U}/wallets`) return j([{ id: 'w_1', chain: 'solana', asset: 'USDC', provider: 'privy', address: 'HN7cABqLq46Es1jh92dQQpXBoUn3xSzXk1uMv6d3sB2', balance: '0' }]);
    if (p === `${U}/balance/unified`) return j({ totalUsd: '0.00', availableUsd: '0.00', heldUsd: '0.00', balances: [] });
    if (p === `${U}/balance`) return j({ totalUsd: '0.00', availableUsd: '0.00', heldUsd: '0.00', balances: [] });
    if (p.startsWith('/api/')) return j([]);
    return route.continue();
  };
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript((u) => {
  localStorage.setItem('sivan.user', JSON.stringify({ id: u, email: 'sivantechnology@gmail.com', fullName: 'Sivan Technologies', status: 'active' }));
  localStorage.setItem('sivan.authToken', 'stub-token');
  localStorage.setItem('sivan.theme', 'light');
}, USER);

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
};

async function visit(path) {
  const page = await ctx.newPage();
  await page.route('**/api/**', stub());
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => document.body.innerText);
  return { page, text };
}

// ---------------------------------------------------------------- dashboard
{
  const { page, text } = await visit('/dashboard');
  // Guard first: a test that cannot tell which page it is on cannot report on
  // it. An earlier suite of mine "passed" against the logged-out landing page.
  check('dashboard rendered', text.includes('YOUR LIMIT'), text.slice(0, 100).replace(/\n/g, ' | '));
  check('no longer calls a verified user Level 0', !text.includes('Level 0'), 'Level 0 still on the dashboard');
  check('does not advertise a ceiling they cannot use', !text.includes('5,000,000'), 'showed the unreachable ₦5m');
  check('does not accuse them of a spent allowance', !/₦0 left/.test(text), '₦0 left still shown');
  check('names the actual missing step', text.includes('Add a bank'), text.split('\n').find((l) => l.includes('LIMIT')) || '');
  await page.screenshot({ path: '/tmp/bnb-dashboard.png' });
  await page.close();
}

// ------------------------------------------------------------------ receive
{
  const { page, text } = await visit('/receive');
  check('receive rendered', text.length > 200);
  check('no longer tells a verified user to verify',
    !text.includes('Verify your identity first'), 'still blocked on the receive screen');
  await page.screenshot({ path: '/tmp/bnb-receive.png' });
  await page.close();
}

// ------------------------------------------------------------- verification
{
  const { page, text } = await visit('/verification');
  check('verification page rendered', text.length > 200);
  check('level and banner no longer contradict', !text.includes('Level 0'),
    'page still says Level 0 while claiming verification is complete');
  /**
   * THESE TWO WERE MISSED BY EVERY BOOLEAN ABOVE.
   *
   * The journey passed while the page plainly said "Bank verification ...
   * Completed" and "Confirmed with your bank verification" to a user with no
   * bank at all. Both were labelled from `isNgnPath` - the COUNTRY - rather
   * than from the route the user actually took. Caught by opening the
   * screenshot, which is the second time on this task that reading the render
   * found what the assertions could not.
   */
  check('does not claim a bank check that never happened',
    !text.includes('Bank verification'),
    'step 2 still labelled "Bank verification" for a documents-verified user');
  check('does not credit the payout step to a bank check',
    !text.includes('Confirmed with your bank verification'),
    'step 3 still says the bank confirmed it');
  check('the identity route is named honestly',
    text.includes('Identity verification'), 'step 2 should name the documents route');
  await page.screenshot({ path: '/tmp/bnb-verification.png' });
  await page.close();
}

console.log(`\n${failures === 0 ? 'PASS' : `${failures} FAILED`}`);
await browser.close();
if (failures) process.exit(1);

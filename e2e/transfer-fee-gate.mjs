/**
 * NOTHING IS CONFIRMABLE UNTIL THE FEE IS KNOWN.
 *
 * Reported from two screenshots of the same dialog moments apart: the first
 * had Amount and "Balance after" only, the second had gained a Transfer fee
 * and "Recipient gets". For the window in between, the acknowledgement
 * checkbox and the Send button were both live - so a fast user could agree to
 * and dispatch a transfer whose price they had never been shown, and a careful
 * one watched the panel grow and read it as the app glitching.
 *
 * The quote is deliberately delayed here so that window is wide enough to
 * assert against. Everything is checked on the RENDERED, COMPOSITED state -
 * `disabled` as the browser reports it, and the panel's real pixel height -
 * rather than on props or stylesheet text.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5179';
const USER = 'u_1';
const QUOTE_DELAY_MS = 2500;

/** 'ok' resolves after a delay; 'fail' 500s, which must NOT lock the user out. */
let quoteMode = 'ok';

function stub() {
  return async (route) => {
    const p = new URL(route.request().url()).pathname;
    const j = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: o }) });
    const U = `/api/users/${USER}`;

    if (p === '/api/balance/transfers/quote') {
      if (quoteMode === 'fail') {
        return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'quote failed' } }) });
      }
      await new Promise((r) => setTimeout(r, QUOTE_DELAY_MS));
      return j({ fee: '0.25', netAmount: '9.75', effectivePercent: '0.50', newRecipientFee: '0', createsRecipientAccount: false });
    }

    if (p === '/api/system/status') return j({ mode: 'active', activeIncidents: [] });
    if (p === '/api/offramp/controls') return j({
      customerTypes: [{ customerType: 'individual', enabled: true, label: 'Individual' }],
      payoutCurrencies: [], virtualAccounts: [],
      sourceAssets: [{ asset: 'usdc', enabled: true, label: 'USDC' }],
      sourceNetworks: [{ network: 'solana', enabled: true, label: 'Solana', sortOrder: 10 }],
      supplierPayoutsEnabled: false, ngnOfframpFeePercent: '1',
    });
    if (p === `${U}/verification-summary`) return j({
      level: 2, levelLabel: 'Level 2: Identity verified', path: 'bridge_kyc', country: 'US',
      checks: {}, upliftApplies: false, terms: { required: false, accepted: true },
      identityComplete: true, pathComplete: true, hasPayoutAccount: true,
      hasPendingPayoutReview: false, windowDays: 30, allowances: [],
    });
    if (p === `/api/customers/${USER}`) return j({ id: 'cus_1', provider: 'bridge', kycStatus: 'kyc_approved', tosStatus: 'approved' });
    /*
      `spendable` is the field the component actually reads (line 519):
        available = unified ? Number(unified.spendable || 0) : ...
      My first stub sent availableUsd, so `available` computed to 0 and the
      form's own button stayed disabled with "No settled USDC available" -
      the test never reached the dialog. Shape taken from the source, not
      guessed.
    */
    /*
      `spendable` lives INSIDE balances[], keyed by asset (line 517-519):
        unified   = unifiedBalance?.balances.find(i => i.asset === 'usdc')
        available = Number(unified.spendable || 0)
      Two wrong guesses before this one - availableUsd at the top level, then
      spendable at the top level. Read off the source in the end rather than
      guessed a third time.
    */
    if (p === `${U}/balance/unified`) return j({
      balances: [{ asset: 'usdc', spendable: '100', pending: '0', held: '0', total: '100', chainUnavailable: false }],
    });
    if (p === `${U}/balance`) return j({
      usdc: { available: '100', pending: '0', held: '0' },
      totalUsd: '100.00', availableUsd: '100.00', heldUsd: '0.00',
      balances: [{ asset: 'usdc', chain: 'solana', amount: '100', usd: '100.00', available: '100', held: '0' }],
    });
    if (p === `${U}/wallets`) return j([{ id: 'w_1', chain: 'solana', asset: 'USDC', provider: 'privy', address: 'HN7cABqLq46Es1jh92dQQpXBoUn3xSzXk1uMv6d3sB2', balance: '100' }]);
    if (p.startsWith('/api/')) return j([]);
    return route.continue();
  };
}

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript((u) => {
  localStorage.setItem('sivan.user', JSON.stringify({ id: u, email: 'fee@sivantech.online', fullName: 'Fee Probe', status: 'active' }));
  localStorage.setItem('sivan.authToken', 'stub-token');
  localStorage.setItem('sivan.theme', 'light');
}, USER);

async function openConfirm(page) {
  await page.fill('input[name="destinationAddress"]', 'HN7cABqLq46Es1jh92dQQpXBoUn3xSzXk1uMv6d3sB2');
  await page.fill('input[name="amount"]', '10');
  await page.locator('form button[type="submit"], form button.primary-btn').first().click();
  await page.waitForSelector('.transfer-confirm-actions', { timeout: 8000 });
}

// ─────────────────────────────────── 1. the gate holds while the quote is out
{
  quoteMode = 'ok';
  const page = await ctx.newPage();
  await page.route('**/api/**', stub());
  await page.goto(`${BASE}/transfer`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const body = await page.evaluate(() => document.body.innerText);
  check('the transfer page rendered', /Send|Transfer/i.test(body), body.slice(0, 90).replace(/\n/g, ' | '));

  await openConfirm(page);
  await page.waitForTimeout(400); // firmly inside the quote delay

  const send = page.locator('.transfer-confirm-actions button.primary-btn');
  const ack = page.locator('.confirm-ack input[type="checkbox"]');

  check('Send is disabled while the fee is calculating', await send.isDisabled(), 'user could dispatch an unpriced transfer');
  check('the acknowledgement cannot be ticked yet', await ack.isDisabled(), 'user could agree before seeing the price');
  check('the button says why it is waiting', /Calculating fee/i.test(await send.innerText()), await send.innerText());
  check('a placeholder stands in for the fee', await page.locator('.confirm-fee-skeleton').count() > 0);

  // Clicking must be a no-op, not merely styled as one.
  await send.click({ force: true }).catch(() => {});
  await page.waitForTimeout(200);
  check('force-clicking Send does nothing while pending',
    await page.locator('.transfer-confirm-actions').count() > 0, 'the dialog submitted anyway');

  const hBefore = await page.locator('.transfer-confirm-panel, .confirm-rows').first().boundingBox().then((b) => b?.height ?? 0);
  await page.screenshot({ path: '/tmp/fee-pending.png' });

  // ── the quote lands ──────────────────────────────────────────────────────
  await page.waitForTimeout(QUOTE_DELAY_MS + 700);

  // The label must stop saying "Calculating" - that is the visible half of the
  // gate lifting, independent of the acknowledgement still being required.
  check('the button stops saying it is calculating',
    !/Calculating/i.test(await send.innerText()), await send.innerText());
  check('the acknowledgement unlocks once priced', !(await ack.isDisabled()), 'still locked after the quote landed');
  check('the fee is shown', /0\.25/.test(await page.evaluate(() => document.body.innerText)));
  check('the placeholder is gone', await page.locator('.confirm-fee-skeleton').count() === 0);

  // Send is still gated on the acknowledgement - that guard must survive.
  check('Send still requires the acknowledgement', await send.isDisabled(), 'the network warning stopped being enforced');
  await ack.check();
  await page.waitForTimeout(150);
  check('Send enables after ticking', !(await send.isDisabled()));
  check('the button shows the real amount', /Send 10 USDC/i.test(await send.innerText()), await send.innerText());

  /**
   * THE LAYOUT MUST NOT JUMP. This is the "friction" in the report - the panel
   * grew as rows appeared and moved the button under the cursor. Rows are now
   * reserved, so the height should barely move.
   */
  const hAfter = await page.locator('.transfer-confirm-panel, .confirm-rows').first().boundingBox().then((b) => b?.height ?? 0);
  /*
    TIGHTENED FROM 40px TO 4px. At 40 this passed while the panel still moved
    ~19px, because the "Calculating transfer fee..." line was a real row that
    disappeared. Found by comparing the pending and ready screenshots, not by
    this assertion - so the slack was hiding the thing it was meant to catch.
  */
  check('the dialog does not grow when the fee lands',
    Math.abs(hAfter - hBefore) < 4, `height ${hBefore} -> ${hAfter}`);

  await page.screenshot({ path: '/tmp/fee-ready.png' });
  await page.close();
}

// ───────────────────────── 2. a FAILED quote must not strand the user
{
  quoteMode = 'fail';
  const page = await ctx.newPage();
  await page.route('**/api/**', stub());
  await page.goto(`${BASE}/transfer`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await openConfirm(page);
  /**
   * A 500 IS RETRYABLE, SO THE CATCH FIRES LATER THAN YOU EXPECT.
   *
   * appUtils.isRetryableHttpStatus lists 500, and App's api helper makes 3
   * attempts with a 500ms * attempt backoff - so a failing quote takes roughly
   * 1.5s plus three round trips before it ever throws. My first version waited
   * 1200ms and reported the checkbox as permanently locked, which was a bug in
   * the TEST, not the app: it was still legitimately mid-retry.
   *
   * Waiting for the outcome rather than for a fixed delay, so this stays
   * correct if the retry policy changes.
   */
  await page.waitForFunction(
    () => {
      const box = document.querySelector('.confirm-ack input[type="checkbox"]');
      return box instanceof HTMLInputElement && !box.disabled;
    },
    { timeout: 15000 },
  ).catch(() => {});

  const send = page.locator('.transfer-confirm-actions button.primary-btn');
  const ack = page.locator('.confirm-ack input[type="checkbox"]');

  check('a failed quote does NOT lock the checkbox', !(await ack.isDisabled()), 'user stranded on a dialog they cannot confirm');
  check('a failed quote explains itself',
    /could not load the fee/i.test(await page.evaluate(() => document.body.innerText)), 'silent failure');
  await ack.check();
  await page.waitForTimeout(150);
  check('the user can still send after a failed quote', !(await send.isDisabled()), 'permanently blocked by a pricing outage');
  await page.screenshot({ path: '/tmp/fee-unavailable.png' });
  await page.close();
}

console.log(`\n${failures === 0 ? 'PASS' : `${failures} FAILED`}`);
await browser.close();
if (failures) process.exit(1);

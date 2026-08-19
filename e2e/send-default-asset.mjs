/**
 * THE SEND PAGE MUST OPEN ON THE ASSET THE USER ACTUALLY HOLDS.
 *
 * Reported with three screenshots: the dashboard showed a real balance, the
 * Send & transfer page showed "0 USDC available to send" with a disabled
 * button, and switching the dropdown to USDT looked like it changed nothing.
 *
 * TWO SEPARATE THINGS WERE HAPPENING.
 *
 * 1. The browser was serving a cached pre-fix bundle. Proven by string search:
 *    the hero in the screenshot reads "Send settled USDC to wallets", and that
 *    string does not exist in the deployed bundle - it says "stablecoins".
 *    Nothing to fix in code; a hard refresh clears it.
 *
 * 2. A REAL BUG that a hard refresh would NOT have fixed, and that this file
 *    covers. The default selection was `sendableAssetOptions[0]` - whatever
 *    the ADMIN listed first. Live that is usdc. So a user holding only USDT
 *    opened on USDC, saw four zeroes and a disabled button before touching
 *    anything. The card was following the dropdown correctly the whole time;
 *    the dropdown was simply pointed at the wrong coin.
 *
 * WHY THE FIXTURE IS SHAPED THIS WAY. sourceAssets lists usdc FIRST and the
 * user holds ONLY usdt - exactly the live control order and the reporter's
 * real position. Reverse the order, or give the user both, and the test passes
 * whether the fix is present or not.
 *
 * Run: node e2e/send-default-asset.mjs
 */

import { chromium } from 'playwright';

const FE = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4178';

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const USER = 'usr_default_asset';
const U = `/api/users/${USER}`;

const routes = (page, balances) => page.route('**/api/**', async (route) => {
  const p = new URL(route.request().url()).pathname;
  const j = (data) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ data }),
  });

  /** usdc FIRST, matching the live admin control order. */
  if (p === '/api/offramp/controls') return j({
    customerTypes: [{ customerType: 'individual', enabled: true, label: 'Individual' }],
    payoutCurrencies: [{ currency: 'usd', enabled: true, label: 'USD', accountType: 'us', defaultPaymentRail: 'ach' }],
    virtualAccounts: [],
    sourceAssets: [
      { asset: 'usdc', enabled: true, label: 'USDC' },
      { asset: 'usdt', enabled: true, label: 'USDT' },
    ],
    sourceNetworks: [{ network: 'solana', enabled: true, label: 'Solana', sortOrder: 10 }],
    supplierPayoutsEnabled: false, transfersEnabled: true,
  });

  if (p === `${U}/verification-summary`) return j({
    level: 2, levelLabel: 'Level 2: Identity verified', path: 'foreign', country: 'NG',
    checks: { identity: 'verified', bank: 'verified' },
    identitySource: 'bridge', upliftApplies: false,
    terms: { required: true, accepted: true },
    identityComplete: true, pathComplete: true,
    hasPayoutAccount: true, hasPendingPayoutReview: false, windowDays: 30, allowances: [],
  });

  if (p === `${U}/balance/unified`) return j({
    userId: USER, updatedAt: new Date().toISOString(), wallets: [],
    balances: balances.map((b) => ({
      asset: b.asset, chain: b.amount, ledger: '0.000000', held: '0.000000',
      pending: '0.000000', spendable: b.amount, chainUnavailable: false,
    })),
  });
  if (p === `${U}/balance`) return j({
    totalUsd: '17.88', availableUsd: '17.88', heldUsd: '0.00',
    balances: balances.map((b) => ({ asset: b.asset, available: b.amount, pending: '0', held: '0', spent: '0' })),
  });

  if (p === `/api/customers/${USER}`) return j({ id: 'cus_1', provider: 'bridge', kycStatus: 'kyc_approved', tosStatus: 'approved' });
  if (p === `${U}/balance/transfers`) return j([]);
  if (p === `${U}/suppliers`) return j([]);
  if (p === `${U}/supplier-payments`) return j([]);
  if (p === `${U}/wallets`) return j([]);
  if (p === '/api/system/status') return j({ mode: 'active', message: '' });
  return j([]);
});

const readCard = (p) => p.evaluate(() => {
  const card = document.querySelector('.transfer-balance-card');
  const trigger = [...document.querySelectorAll('label')]
    .find((l) => /^Asset/i.test(l.innerText))?.querySelector('.custom-select-trigger');
  const btn = [...document.querySelectorAll('button')]
    .find((x) => /Review transfer|No settled/i.test(x.innerText));
  return {
    eyebrow: (card?.querySelector('.eyebrow')?.innerText || '').trim(),
    headline: (card?.querySelector('h2')?.innerText || '').trim(),
    dropdown: (trigger?.innerText || '').trim(),
    hint: (card?.innerText || ''),
    buttonText: (btn?.innerText || '').trim(),
    buttonDisabled: Boolean(btn?.disabled),
  };
});

const open = async (b, balances) => {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
  const p = await ctx.newPage();
  await routes(p, balances);
  await p.goto(FE, { waitUntil: 'domcontentloaded' });
  await p.evaluate((id) => {
    localStorage.setItem('sivan.authToken', 'e2e-token');
    localStorage.setItem('sivan.user', JSON.stringify({ id, email: 'd@sivan.test', fullName: 'Default Asset', country: 'NG' }));
  }, USER);
  await p.goto(`${FE}/transfer`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  return { ctx, p };
};

const b = await chromium.launch();

console.log('\n══ holds ONLY USDT, admin lists USDC first ══════════════');
{
  const { ctx, p } = await open(b, [
    { asset: 'usdc', amount: '0.000000' },
    { asset: 'usdt', amount: '17.880096' },
  ]);

  const onScreen = await p.evaluate(() => Boolean(document.querySelector('.transfer-balance-card')));
  check('the send screen loaded', onScreen);

  if (onScreen) {
    const card = await readCard(p);

    /**
     * THE REPORTED BUG. Before the fix this opened on USDC - the admin's first
     * entry - and showed 0 with a disabled button.
     */
    check('it opens on USDT, the asset actually held',
      /USDT/.test(card.eyebrow) && !/USDC/.test(card.eyebrow), card.eyebrow);
    check('the dropdown agrees with the card',
      /USDT/.test(card.dropdown), card.dropdown);
    check('the real balance is shown, not a zero',
      /17\.88/.test(card.headline), card.headline);
    check('the send button is enabled',
      !card.buttonDisabled, `disabled=${card.buttonDisabled} text="${card.buttonText}"`);
    check('and it invites the transfer',
      /Review transfer/i.test(card.buttonText), card.buttonText);
  }
  await ctx.close();
}

console.log('\n══ holds BOTH, the larger one wins ══════════════════════');
{
  const { ctx, p } = await open(b, [
    { asset: 'usdc', amount: '2.000000' },
    { asset: 'usdt', amount: '17.880096' },
  ]);
  const card = await readCard(p);
  check('opens on the larger balance',
    /USDT/.test(card.eyebrow), card.eyebrow);
  check('showing that balance',
    /17\.88/.test(card.headline), card.headline);
  await ctx.close();
}

console.log('\n══ holds ONLY USDC ══════════════════════════════════════');
{
  const { ctx, p } = await open(b, [
    { asset: 'usdc', amount: '5.000000' },
    { asset: 'usdt', amount: '0.000000' },
  ]);
  const card = await readCard(p);
  check('opens on USDC when that is what is held',
    /USDC/.test(card.eyebrow) && !/USDT/.test(card.eyebrow), card.eyebrow);
  check('with the real figure',
    /^5/.test(card.headline), card.headline);
  await ctx.close();
}

console.log('\n══ empty account still renders sanely ═══════════════════');
{
  const { ctx, p } = await open(b, [
    { asset: 'usdc', amount: '0.000000' },
    { asset: 'usdt', amount: '0.000000' },
  ]);
  const card = await readCard(p);
  check('falls back to the admin default without crashing',
    /USDC|USDT/.test(card.eyebrow), card.eyebrow);
  check('button is correctly disabled on a genuinely empty account',
    card.buttonDisabled, `disabled=${card.buttonDisabled}`);
  /**
   * No other asset is funded, so the cross-asset hint must NOT appear -
   * otherwise it would tell an empty user they hold something.
   */
  check('and no misleading "you do hold" hint is shown',
    !/you do hold/i.test(card.hint), card.hint.slice(0, 160));
  await ctx.close();
}

console.log('\n══ the dashboard/send reconciliation hint ═══════════════');
{
  /**
   * The user's actual complaint: dashboard shows money, send page shows zero.
   * When the SELECTED asset is empty but another is funded, the card must say
   * so rather than leaving four zeroes unexplained.
   *
   * Forced by switching to the empty asset by hand - the new default would
   * otherwise never land on it.
   */
  const { ctx, p } = await open(b, [
    { asset: 'usdc', amount: '0.000000' },
    { asset: 'usdt', amount: '17.880096' },
  ]);
  await p.evaluate(() => {
    [...document.querySelectorAll('label')]
      .find((l) => /^Asset/i.test(l.innerText))?.querySelector('.custom-select-trigger')?.click();
  });
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    const al = [...document.querySelectorAll('label')].find((l) => /^Asset/i.test(l.innerText));
    [...(al?.querySelectorAll('.custom-select-menu button') ?? [])]
      .find((o) => o.innerText.toUpperCase().includes('USDC'))?.click();
  });
  await p.waitForFunction(
    () => (document.querySelector('.transfer-balance-card h2')?.textContent || '').toUpperCase().includes('USDC'),
    null, { timeout: 5000 }
  ).catch(() => {});

  const card = await readCard(p);
  check('an empty selected asset explains where the money is',
    /you do hold/i.test(card.hint), card.hint.slice(0, 200));
  check('and it names the funded asset and amount',
    /17\.880096 USDT/.test(card.hint), card.hint.slice(0, 220));
  check('and explains why the dashboard total differs',
    /adds every stablecoin together/i.test(card.hint), card.hint.slice(0, 260));

  /** One tap must actually switch the form. */
  await p.evaluate(() => {
    const card = document.querySelector('.transfer-balance-card');
    [...(card?.querySelectorAll('.link-btn') ?? [])][0]?.click();
  });
  await p.waitForTimeout(600);
  const after = await readCard(p);
  check('clicking the named asset switches the form to it',
    /USDT/.test(after.eyebrow) && /17\.88/.test(after.headline),
    `${after.eyebrow} | ${after.headline}`);
  check('and the button becomes usable',
    !after.buttonDisabled, `disabled=${after.buttonDisabled}`);

  await p.screenshot({ path: '/tmp/send-default-asset.png', fullPage: false });
  await ctx.close();
}

await b.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
process.exit(fail === 0 ? 0 : 1);

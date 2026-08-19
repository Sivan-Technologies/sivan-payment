/**
 * THE SUPPLIER CARD IS USDC-ONLY, AND MUST NOT FOLLOW THE ASSET DROPDOWN.
 *
 * A REGRESSION I INTRODUCED. aad7cf2 fixed the crypto send card by making
 * `available` follow the Asset dropdown. That variable was SHARED with the
 * supplier payment card, which was safe only while it was hardcoded to USDC.
 *
 * Supplier payments are USDC-only as a SERVER rule, not a UI preference:
 *
 *   createSupplierPaymentSchema:  sourceAsset: z.literal('usdc')
 *   supplier.service.ts:          balances.find(i => i.asset === input.sourceAsset)
 *
 * A literal, not an enum - the API refuses any other asset outright. So after
 * aad7cf2, a user holding USDT and no USDC could pick USDT on the crypto tab
 * and see the supplier button light up against a balance the supplier route
 * cannot spend. The server would then reject the payment they were invited to
 * make. The inverse is worse: a user holding USDC who happens to have USDT
 * selected sees "No settled USDC available" while their USDC sits there.
 *
 * WHY A BROWSER TEST. The defect is a shared variable across two cards. Each
 * card reads correctly on its own; the bug is that one of them was reading the
 * other's state. Only the composed render shows it.
 *
 * THE SEEDED USER IS THE DISCRIMINATOR: 5 USDC and 17.88 USDT. Any test where
 * the two balances are equal - or where one is absent - passes whether the
 * supplier card reads its own figure or the dropdown's. The two numbers must
 * differ and both must be non-zero.
 *
 * Run: node e2e/supplier-card-asset.mjs
 */

import { chromium } from 'playwright';

const FE = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4178';

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const USER = 'usr_supplier_e2e';
const U = `/api/users/${USER}`;

/**
 * Balance fixtures are a PARAMETER, not a second route handler.
 *
 * My first version registered a second page.route() for the zero-USDC case on
 * top of this one. Playwright runs the MOST RECENTLY registered handler first,
 * so the general handler below would have shadowed the override and both runs
 * would have used the same balances - two identical passes dressed up as two
 * cases. One handler, one fixture, passed in.
 */
const routes = (page, balances) => page.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  const p = url.pathname;
  const j = (data) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ data }),
  });

  /** supplierPayoutsEnabled TRUE here - the card under test is behind it. */
  if (p === '/api/offramp/controls') return j({
    customerTypes: [{ customerType: 'individual', enabled: true, label: 'Individual' }],
    payoutCurrencies: [{ currency: 'usd', enabled: true, label: 'USD', accountType: 'us', defaultPaymentRail: 'ach' }],
    virtualAccounts: [],
    sourceAssets: [
      { asset: 'usdc', enabled: true, label: 'USDC' },
      { asset: 'usdt', enabled: true, label: 'USDT (Tether)' },
    ],
    sourceNetworks: [{ network: 'solana', enabled: true, label: 'Solana', sortOrder: 10 }],
    supplierPayoutsEnabled: true, transfersEnabled: true,
  });

  if (p === `${U}/verification-summary`) return j({
    level: 2, levelLabel: 'Level 2: Identity verified', path: 'foreign', country: 'NG',
    checks: { identity: 'verified', bank: 'verified' },
    identitySource: 'bridge', upliftApplies: false,
    terms: { required: true, accepted: true },
    identityComplete: true, pathComplete: true,
    hasPayoutAccount: true, hasPendingPayoutReview: false, windowDays: 30,
    allowances: [],
  });

  /**
   * TWO DIFFERENT NON-ZERO FIGURES. 5 USDC vs 17.88 USDT.
   *
   * If the supplier card is wrongly reading the dropdown, selecting USDT makes
   * it show/enable against 17.88. Reading its own USDC row it stays on 5.
   */
  if (p === `${U}/balance/unified`) return j({
    userId: USER, updatedAt: new Date().toISOString(), wallets: [],
    balances: [
      { asset: 'usdc', chain: balances.usdc, ledger: '0.000000', held: '0.000000',
        pending: '0.000000', spendable: balances.usdc, chainUnavailable: false },
      { asset: 'usdt', chain: balances.usdt, ledger: '0.000000', held: '0.000000',
        pending: '0.000000', spendable: balances.usdt, chainUnavailable: false },
    ],
  });
  if (p === `${U}/balance`) return j({
    totalUsd: '22.88', availableUsd: '22.88', heldUsd: '0.00',
    balances: [
      { asset: 'usdc', available: balances.usdc, pending: '0', held: '0', spent: '1.000000' },
      { asset: 'usdt', available: balances.usdt, pending: '0', held: '0', spent: '2.500000' },
    ],
  });

  /** One approved supplier, so the payment form renders rather than the empty state. */
  if (p === `${U}/suppliers`) return j([{
    id: 'sup_1', userId: USER, supplierName: 'ABC Trading Ltd', status: 'approved',
    currency: 'gbp', supplierCountry: 'GB', bankName: 'Barclays', accountLast4: '4321',
    createdAt: new Date().toISOString(),
  }]);

  if (p === `/api/customers/${USER}`) return j({ id: 'cus_1', provider: 'bridge', kycStatus: 'kyc_approved', tosStatus: 'approved' });
  if (p === `${U}/balance/transfers`) return j([]);
  if (p === `${U}/supplier-payments`) return j([]);
  if (p === `${U}/wallets`) return j([]);
  if (p === '/api/system/status') return j({ mode: 'active', message: '' });
  return j([]);
});

const b = await chromium.launch();

/** The supplier payment button, found by its own card rather than by index. */
const readSupplierCard = (p) => p.evaluate(() => {
  const cards = [...document.querySelectorAll('.supplier-form-card')];
  const card = cards.find((c) => /Create supplier payment/i.test(c.innerText));
  if (!card) return null;
  const btn = [...card.querySelectorAll('button')]
    .find((x) => /Review payment|No settled|Creating payment/i.test(x.innerText));
  return {
    heading: (card.querySelector('h3')?.innerText || '').trim(),
    buttonText: (btn?.innerText || '').trim(),
    buttonDisabled: Boolean(btn?.disabled),
  };
});

const readSendCard = (p) => p.evaluate(() => {
  const card = document.querySelector('.transfer-balance-card');
  return card ? {
    eyebrow: (card.querySelector('.eyebrow')?.innerText || '').trim(),
    headline: (card.querySelector('h2')?.innerText || '').trim(),
  } : null;
});

const clickTab = async (p, name) => {
  await p.evaluate((wanted) => {
    const tab = [...document.querySelectorAll('.route-tabs button, .transfer-route-grid button')]
      .find((t) => t.innerText.toLowerCase().includes(wanted.toLowerCase()));
    tab?.click();
  }, name);
  await p.waitForTimeout(400);
};

const selectAsset = async (p, label) => {
  await p.evaluate(() => {
    const assetLabel = [...document.querySelectorAll('label')].find((l) => /^Asset/i.test(l.innerText));
    assetLabel?.querySelector('.custom-select-trigger')?.click();
  });
  await p.waitForTimeout(300);
  const chosen = await p.evaluate((wanted) => {
    const assetLabel = [...document.querySelectorAll('label')].find((l) => /^Asset/i.test(l.innerText));
    const options = [...(assetLabel?.querySelectorAll('.custom-select-menu button') ?? [])];
    const option = options.find((o) => o.innerText.toUpperCase().includes(wanted));
    option?.click();
    return { found: Boolean(option), options: options.map((o) => o.innerText.trim()) };
  }, label);
  if (!chosen.found) throw new Error(`asset "${label}" not in dropdown: ${JSON.stringify(chosen.options)}`);
  await p.waitForFunction(
    (wanted) => (document.querySelector('.transfer-balance-card h2')?.textContent || '')
      .toUpperCase().includes(wanted),
    label,
    { timeout: 5000 }
  );
};

const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
const consoleErrors = [];
p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await routes(p, { usdc: '5.000000', usdt: '17.880096' });
await p.goto(FE, { waitUntil: 'domcontentloaded' });
await p.evaluate((id) => {
  localStorage.setItem('sivan.authToken', 'e2e-token');
  localStorage.setItem('sivan.user', JSON.stringify({
    id, email: 'supplier@sivan.test', fullName: 'OGUNMEPON SHARAFA', country: 'NG',
  }));
}, USER);
await p.goto(`${FE}/transfer`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);

const onScreen = await p.evaluate(() => Boolean(document.querySelector('.transfer-balance-card')));
check('the send screen is the one under test', onScreen,
  (await p.evaluate(() => document.body.innerText.slice(0, 120))).replace(/\n/g, ' '));

if (onScreen) {
  /**
   * STEP 1: put the Asset dropdown on USDT while on the crypto tab. This is
   * the state that used to leak into the supplier card.
   */
  await selectAsset(p, 'USDT');
  const send = await readSendCard(p);
  check('precondition: the send card is on USDT',
    /USDT/.test(send.headline) && /17\.88/.test(send.headline), send.headline);

  /** STEP 2: move to the supplier tab WITHOUT touching the dropdown. */
  await clickTab(p, 'supplier');
  const sup = await readSupplierCard(p);
  check('the supplier payment card is rendered', Boolean(sup),
    'supplierPayoutsEnabled is true in this fixture, so it must be');

  if (sup) {
    /**
     * THE ASSERTION THAT CATCHES THE REGRESSION.
     *
     * The user holds 5 USDC, so this button must be ENABLED and read
     * "Review payment". Before the fix it read the USDT-selected `available`.
     * That happens to be non-zero here too - which is exactly why the
     * DISABLED-state test below, with USDC at zero, is the real discriminator.
     */
    check('the supplier button is enabled from the USDC balance',
      !sup.buttonDisabled, `disabled=${sup.buttonDisabled} text="${sup.buttonText}"`);
    check('and it invites the payment rather than refusing it',
      /Review payment/i.test(sup.buttonText), sup.buttonText);
    check('the supplier card still states USDC, the only asset the API accepts',
      /USDC/i.test(sup.heading), sup.heading);

    /**
     * THE CONFIRM DIALOG IS DENOMINATED IN USDC TOO.
     *
     * SupplierPaymentConfirm computes "Balance after" as
     * `Math.max(details.available - gross, 0)` and prints it with a literal
     * " USDC" suffix. Passing the Asset dropdown's figure would print a USDT
     * balance labelled USDC on the one screen where the user commits money.
     *
     * Seeded 5 USDC, 17.88 USDT, paying 1 USDC. Correct: 5 - 1 = 4.00 USDC
     * (before fees). Wrong: 17.88 - 1 = 16.88. The two are far enough apart
     * that no rounding or fee can confuse them.
     */
    await p.evaluate(() => {
      const cards = [...document.querySelectorAll('.supplier-form-card')];
      const card = cards.find((c) => /Create supplier payment/i.test(c.innerText));
      const amount = card?.querySelector('input[name="amount"]');
      const purpose = card?.querySelector('textarea[name="paymentPurpose"]');
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      if (amount) set(amount, '1');
      if (purpose) set(purpose, 'Invoice INV-1001 for software services');
      card?.querySelector('form')?.requestSubmit();
    });
    await p.waitForTimeout(1200);

    const dialog = await p.evaluate(() => {
      const rows = [...document.querySelectorAll('.confirm-row')];
      const row = rows.find((r) => /Balance after/i.test(r.querySelector('span')?.innerText || ''));
      return {
        open: rows.length > 0,
        balanceAfter: (row?.querySelector('strong')?.innerText || '').trim(),
      };
    });

    check('the confirm dialog opened', dialog.open, JSON.stringify(dialog));
    if (dialog.open) {
      check('the dialog counts down from the USDC balance, not the USDT one',
        /^4\./.test(dialog.balanceAfter) || /^3\./.test(dialog.balanceAfter),
        `${dialog.balanceAfter} - 5 USDC minus 1 leaves ~4; the USDT balance would leave ~16.88`);
      check('and it never shows the USDT figure',
        !/^1[0-9]\./.test(dialog.balanceAfter), dialog.balanceAfter);
    }
  }
}

const relevant = consoleErrors.filter((e) => !/favicon|manifest|404|Failed to load resource/i.test(e));
check('no console errors', relevant.length === 0, relevant.slice(0, 2).join(' | '));
await ctx.close();

/**
 * ══ THE DISCRIMINATING CASE ══
 *
 * ZERO USDC, plenty of USDT. This is the pairing that a shared `available`
 * cannot survive: with USDT selected the supplier button would be ENABLED
 * against 17.88 USDT while the user has no USDC at all, and the server would
 * reject the payment on submit.
 *
 * A separate context because the balance fixture differs.
 */
console.log('\n══ zero USDC, 17.88 USDT ═══════════════════════════════');

const ctx2 = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const p2 = await ctx2.newPage();
await routes(p2, { usdc: '0.000000', usdt: '17.880096' });
await p2.goto(FE, { waitUntil: 'domcontentloaded' });
await p2.evaluate((id) => {
  localStorage.setItem('sivan.authToken', 'e2e-token');
  localStorage.setItem('sivan.user', JSON.stringify({
    id, email: 'supplier@sivan.test', fullName: 'OGUNMEPON SHARAFA', country: 'NG',
  }));
}, USER);
await p2.goto(`${FE}/transfer`, { waitUntil: 'domcontentloaded' });
await p2.waitForTimeout(3000);

const on2 = await p2.evaluate(() => Boolean(document.querySelector('.transfer-balance-card')));
check('zero-USDC: the send screen loaded', on2);

if (on2) {
  await selectAsset(p2, 'USDT');
  const send2 = await readSendCard(p2);
  check('zero-USDC: the send card shows the 17.88 USDT the user really has',
    /17\.88/.test(send2.headline), send2.headline);

  await clickTab(p2, 'supplier');
  const sup2 = await readSupplierCard(p2);
  check('zero-USDC: the supplier card is rendered', Boolean(sup2));

  if (sup2) {
    /**
     * THE POINT OF THE WHOLE FILE.
     *
     * USDC is zero. The supplier route can spend nothing. The button MUST be
     * disabled and MUST say so, no matter that USDT is selected next door and
     * holds 17.88. A shared `available` reads 17.88 here and enables a payment
     * the server will refuse.
     */
    check('zero-USDC: the supplier button is DISABLED despite USDT being selected',
      sup2.buttonDisabled,
      `disabled=${sup2.buttonDisabled} text="${sup2.buttonText}" - a shared 'available' reads 17.88 USDT here`);
    check('zero-USDC: and it names USDC as the thing that is missing',
      /No settled USDC/i.test(sup2.buttonText), sup2.buttonText);
  }
  await p2.screenshot({ path: '/tmp/supplier-card.png', fullPage: false });
}

await ctx2.close();
await b.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
console.log('');
process.exit(fail === 0 ? 0 : 1);

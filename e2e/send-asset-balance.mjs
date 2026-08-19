/**
 * THE SEND CARD MUST REPORT THE ASSET THE USER PICKED.
 *
 * Reported from production while holding 17.88 USDT: the Send & transfer panel
 * read "0 USDC available to send", the button read "No settled USDC available"
 * and was DISABLED. Not a labelling slip - the send was impossible for anyone
 * whose balance was in the other stablecoin.
 *
 * Cause: every figure in that card was pinned to a hardcoded 'usdc' lookup
 * while the Asset dropdown offered USDT. /balance/unified already returns a
 * row per asset; the component threw that away.
 *
 * WHY THIS IS A BROWSER TEST. The defect only exists in the COMPOSED view -
 * dropdown state on one side, a balance lookup on the other. Both halves read
 * correctly in isolation. The bug is that they disagreed, which is visible
 * only once React has rendered them together.
 *
 * Run: node e2e/send-asset-balance.mjs
 */

import { chromium } from 'playwright';

const FE = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4178';
const API = process.env.E2E_API ?? 'http://127.0.0.1:4179';

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const USER = 'usr_send_e2e';
const U = `/api/users/${USER}`;

/**
 * INTERCEPTED, NOT SIGNED UP.
 *
 * My first version created a real user and seeded a balance. It failed for a
 * reason that had nothing to do with the fix: a fresh user is UNVERIFIED, so
 * the form renders "Complete verification before transferring crypto" and the
 * Asset dropdown never exists. `sendAsset` therefore stayed at its 'usdc'
 * default and the card was asserted in a state no real user with a balance
 * would ever see.
 *
 * Interception is also the only way to pin the exact production condition:
 * USDT held, USDC completely absent. The same approach the other journeys in
 * this directory use.
 */
const routes = (page) => page.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());
  const p = url.pathname;
  const j = (data) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ data }),
  });

  if (p === '/api/offramp/controls') return j({
    customerTypes: [{ customerType: 'individual', enabled: true, label: 'Individual' }],
    payoutCurrencies: [{ currency: 'usd', enabled: true, label: 'USD', accountType: 'us', defaultPaymentRail: 'ach' }],
    virtualAccounts: [],
    sourceAssets: [
      { asset: 'usdc', enabled: true, label: 'USDC' },
      { asset: 'usdt', enabled: true, label: 'USDT (Tether)' },
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
    hasPayoutAccount: true, hasPendingPayoutReview: false, windowDays: 30,
    allowances: [],
  });

  /**
   * USDT ONLY. No USDC row at all - exactly what the reporter was holding.
   * Under the old code the card looked this row up by a hardcoded 'usdc' key,
   * found nothing, and rendered four zeroes plus a disabled button.
   */
  if (p === `${U}/balance/unified`) return j({
    userId: USER, updatedAt: new Date().toISOString(), wallets: [],
    balances: [{
      asset: 'usdt', chain: '17.880096', ledger: '0.000000', held: '0.000000',
      pending: '0.000000', spendable: '17.880096', chainUnavailable: false,
    }],
  });
  if (p === `${U}/balance`) return j({
    totalUsd: '17.88', availableUsd: '17.88', heldUsd: '0.00',
    balances: [{ asset: 'usdt', available: '17.880096', pending: '0', held: '0', spent: '2.500000' }],
  });

  if (p === `/api/customers/${USER}`) return j({ id: 'cus_1', provider: 'bridge', kycStatus: 'kyc_approved', tosStatus: 'approved' });
  if (p === `${U}/balance/transfers`) return j([]);
  if (p === `${U}/suppliers`) return j([]);
  if (p === `${U}/supplier-payments`) return j([]);
  if (p === `${U}/wallets`) return j([]);
  if (p === '/api/system/status') return j({ mode: 'active', message: '' });
  return j([]);
});

const b = await chromium.launch();

/** Read what the card is actually showing, as text. */
const readCard = (p) => p.evaluate(() => {
  const card = document.querySelector('.transfer-balance-card');
  if (!card) return null;
  const kv = {};
  card.querySelectorAll('.kv').forEach((row) => {
    kv[(row.querySelector('span')?.innerText || '').trim()] = (row.querySelector('strong')?.innerText || '').trim();
  });
  const btn = [...document.querySelectorAll('button')]
    .find((x) => /Review transfer|No settled/i.test(x.innerText));
  return {
    eyebrow: (card.querySelector('.eyebrow')?.innerText || '').trim(),
    headline: (card.querySelector('h2')?.innerText || '').trim(),
    usdLine: (card.querySelector('.balance-usd-approx')?.innerText || '').trim(),
    heading: (document.querySelector('.transfer-form-card h3')?.innerText || '').trim(),
    kv,
    buttonText: (btn?.innerText || '').trim(),
    buttonDisabled: Boolean(btn?.disabled),
  };
});

/**
 * TWO STEPS, NOT ONE. The menu is rendered only after the trigger's click has
 * been committed to state, so opening and choosing in a single evaluate() finds
 * an empty option list and silently selects nothing - which is what made my
 * first run report "USDC" no matter what was clicked.
 */
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
  /**
   * WAIT FOR THE RE-RENDER, do not sleep and hope.
   *
   * A fixed 600ms pause read the PREVIOUS card on a cold first paint, which
   * sent me chasing a data bug that did not exist - the balance was correct in
   * component state the whole time. Poll the rendered headline until it names
   * the asset just chosen.
   */
  await p.waitForFunction(
    (wanted) => (document.querySelector('.transfer-balance-card h2')?.textContent || '')
      .toUpperCase().includes(wanted),
    label,
    { timeout: 5000 }
  );
};

for (const vp of [{ w: 1280, h: 900, name: 'desktop' }, { w: 360, h: 780, name: 'mobile 360' }]) {
  console.log(`\n══ ${vp.name} (${vp.w}px) ═══════════════════════════════════════`);

  const ctx = await b.newContext({
    viewport: { width: vp.w, height: vp.h },
    isMobile: vp.w < 768, hasTouch: vp.w < 768,
  });
  const p = await ctx.newPage();
  const consoleErrors = [];
  p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await routes(p);
  await p.goto(FE, { waitUntil: 'domcontentloaded' });
  await p.evaluate((id) => {
    localStorage.setItem('sivan.authToken', 'e2e-token');
    localStorage.setItem('sivan.user', JSON.stringify({
      id, email: 'send@sivan.test', fullName: 'OGUNMEPON SHARAFA', country: 'NG',
    }));
  }, USER);
  await p.goto(`${FE}/transfer`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);

  // Guard: a wrong route renders the landing page, where every assertion
  // below would pass vacuously.
  const onScreen = await p.evaluate(() => Boolean(document.querySelector('.transfer-balance-card')));
  check(`${vp.name}: the send screen is the one under test`, onScreen,
    (await p.evaluate(() => document.body.innerText.slice(0, 120))).replace(/\n/g, ' '));
  if (!onScreen) { await ctx.close(); continue; }

  await selectAsset(p, 'USDT');
  let card = await readCard(p);

  check(`${vp.name}: the card names USDT, not USDC`,
    /USDT/.test(card.eyebrow) && !/USDC/.test(card.eyebrow), card.eyebrow);
  check(`${vp.name}: the headline is denominated in USDT`,
    /USDT/.test(card.headline) && !/USDC/.test(card.headline), card.headline);
  check(`${vp.name}: the form heading follows too`,
    /USDT/.test(card.heading), card.heading);
  check(`${vp.name}: every breakdown row is in USDT`,
    Object.values(card.kv).every((v) => !/USDC/.test(v)), JSON.stringify(card.kv));

  /**
   * The whole point of the report. Under the old code this button was
   * disabled and read "No settled USDC available" while the user held USDT.
   */
  check(`${vp.name}: the send button is not blocked by the wrong asset`,
    !/No settled USDC/i.test(card.buttonText), card.buttonText);

  /**
   * THE NUMBER, NOT THE LABEL. This is the assertion that actually catches the
   * bug, and my first version did not have it.
   *
   * `assetLabelUpper` reads the dropdown directly, so every heading and unit
   * suffix re-denominates even when the BALANCE LOOKUP is still pinned to a
   * hardcoded 'usdc'. Mutation-testing proved it: I reverted the lookup to
   * `const selectedAssetKey = 'usdc'` - the exact reported defect - and all 22
   * assertions still passed, because they only read text.
   *
   * The seeded user holds 17.880096 USDT and no USDC at all, so the figure is
   * the only thing that can tell a working card from a broken one.
   */
  check(`${vp.name}: the USDT balance itself is shown, not a zero`,
    /17\.88/.test(card.headline),
    `${card.headline} - a wrong-asset lookup renders 0 here while the label still says USDT`);
  check(`${vp.name}: the wallet row carries the real figure too`,
    /17\.88/.test(card.kv['In your wallet'] || ''),
    JSON.stringify(card.kv));
  check(`${vp.name}: the USD line reflects that balance`,
    /≈\$17\.88/.test(card.usdLine), card.usdLine);
  check(`${vp.name}: spent is read from the USDT row`,
    /2\.5/.test(card.kv['Spent'] || ''),
    `${card.kv['Spent']} - seeded as 2.5 USDT; a usdc lookup shows 0`);

  check(`${vp.name}: a USD approximation is shown as a second line`,
    /≈\$/.test(card.usdLine), card.usdLine || '(missing)');
  check(`${vp.name}: and it is marked approximate, never stated as exact`,
    card.usdLine.startsWith('≈'), card.usdLine);

  // Switch back: the card must track the selection, not latch on first paint.
  await selectAsset(p, 'USDC');
  const afterSwitch = await readCard(p);
  check(`${vp.name}: switching to USDC re-denominates the card`,
    /USDC/.test(afterSwitch.eyebrow) && !/USDT/.test(afterSwitch.eyebrow),
    afterSwitch.eyebrow);
  check(`${vp.name}: and the headline switches with it`,
    /USDC/.test(afterSwitch.headline), afterSwitch.headline);

  // Capture the USDT state - the one the report was about - not the USDC
  // state the switch-back test leaves behind.
  await selectAsset(p, 'USDT');
  await p.screenshot({ path: `/tmp/send-${vp.w}.png`, fullPage: false });

  const relevant = consoleErrors.filter((e) => !/favicon|manifest|404|Failed to load resource/i.test(e));
  check(`${vp.name}: no console errors`, relevant.length === 0, relevant.slice(0, 2).join(' | '));

  await ctx.close();
}

await b.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
console.log('');
process.exit(fail === 0 ? 0 : 1);

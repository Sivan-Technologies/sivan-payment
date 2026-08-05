/**
 * THE NEW WORK, IN A REAL BROWSER, AGAINST A REAL BACKEND.
 *
 * Everything shipped in the last few commits - the transfer fee table, the
 * new-recipient surcharge, gas limits, deposits in the feed, chain marks - has
 * been proven by unit tests and HTTP calls. None of that puts it on a screen.
 *
 * This drives the actual built bundle against the actual API. No mocks, no
 * injected component state: the same JavaScript a user downloads, talking to a
 * server that reads a real database and a real Solana RPC.
 *
 * Run: node e2e/fee-and-gas-journey.mjs
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const FRONTEND = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4200';
const API = process.env.E2E_API ?? 'http://127.0.0.1:4100';
const TOKEN = process.env.E2E_TOKEN ?? '';
const SHOTS = new URL('./shots/', import.meta.url).pathname;

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const browser = await chromium.launch();
await fs.mkdir(SHOTS, { recursive: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
const failedRequests = [];
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.status() >= 400) {
    failedRequests.push(`${r.status()} ${r.url().replace(API, '').split('?')[0]}`);
  }
});

const shot = (name) => page.screenshot({ path: `${SHOTS}${name}.png`, fullPage: true });

try {
  console.log(`\nfrontend ${FRONTEND}\napi      ${API}\n`);

  // Authenticate the way the app does, then reload so it boots signed in.
  await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([token]) => {
    localStorage.setItem('sivan.authToken', token);
    localStorage.setItem('sivan.user', JSON.stringify({
      id: 'usr_e2e', email: 'e2e@sivan.test', fullName: 'E2E User', country: 'NG',
    }));
  }, [TOKEN]);

  console.log('── the app boots signed in ───────────────────────────────────');
  await page.goto(`${FRONTEND}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  await shot('journey-01-dashboard');

  const bodyText = await page.textContent('body');
  check('the dashboard renders', (bodyText ?? '').length > 200);
  check('no error boundary', !/Something went wrong/i.test(bodyText ?? ''),
    'a React crash would show the boundary rather than the app');

  console.log('\n── deposits reach the activity feed ──────────────────────────');
  check('the seeded deposit is on the dashboard', /Deposit received/i.test(bodyText ?? ''),
    'walletDeposits is the seventh feed source');
  check('and its network is capitalised', !/\bon base\b/.test(bodyText ?? ''),
    'a rendered screenshot caught "base" lowercase once already');

  console.log('\n── the transactions page shows detail for a selected row ─────');
  // /withdrawals, NOT /transactions. appUtils.tsx maps the 'history' view to
  // that path; my first attempt used the view name as the URL and landed on a
  // page with no activity rows, which looked like a product bug and was mine.
  await page.goto(`${FRONTEND}/withdrawals`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const rows = await page.$$('.activity-row');
  check('the transactions list renders rows', rows.length > 0, `${rows.length} rows`);

  if (rows.length) {
    await rows[0].click();
    await page.waitForTimeout(900);
    await shot('journey-02-transaction-detail');
    const panel = await page.textContent('.transaction-timeline-card');
    check('a selected row shows detail, not the empty state',
      !/Select a transaction to see its timeline/i.test(panel ?? ''),
      'this was the reported bug: the row highlighted and the panel said "select a transaction"');
    check('the detail names the amount', /USDC/i.test(panel ?? ''));

    /**
     * Both caught by LOOKING at the screenshot, after every assertion above
     * had passed. Neither is visible to a text check that does not know what
     * the row's status is.
     */
    const confirmed = /Confirmed/i.test(panel ?? '');
    if (confirmed) {
      check('a CONFIRMED row does not promise a link that will never arrive',
        !/link appears once the network confirms/i.test(panel ?? ''),
        'the poller detects deposits by diffing balances, so it never sees a hash');
      check('and it does not say the hash is "Pending"',
        !/Pending/i.test(panel ?? ''),
        'nothing is pending on a confirmed transfer');
    }
  }

  {
    // The page title split into "Transact / ions" at 390px because a generic
    // overflow-wrap:anywhere applied to it.
    const heading = await page.$('.page-hero h1');
    const box = heading ? await heading.boundingBox() : null;
    /**
     * MEASURE THE WORD, NOT THE BOX.
     *
     * My first attempt asserted the heading was under 90px tall. Shrinking the
     * font made two broken lines fit under that threshold, so the test went
     * green while the screenshot still read "Transacti / ons". Height is a
     * proxy; whether a single word was split is the actual question, and a
     * Range gives it directly.
     */
    const brokeMidWord = await page.evaluate(() => {
      const h1 = document.querySelector('.page-hero h1');
      if (!h1 || !h1.firstChild) return false;
      const text = (h1.textContent ?? '').trim();
      // One word only: a multi-word title wrapping between words is correct.
      if (/\s/.test(text)) return false;
      const range = document.createRange();
      range.selectNodeContents(h1);
      // More than one client rect for a single word means it was split.
      return range.getClientRects().length > 1;
    });
    check('the page title does not break mid-word', !brokeMidWord,
      'a one-word title rendering across two lines has been hyphen-less split');
  }

  console.log('\n── the transfer screen quotes a fee before committing ────────');
  await page.goto(`${FRONTEND}/transfer`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await shot('journey-03-transfer');

  const transferText = await page.textContent('body');
  check('the transfer screen renders', (transferText ?? '').length > 200);
  check('ethereum is NOT offered as a network', !/\bEthereum\b/.test(transferText ?? ''),
    'it loses $2-3 of sponsored gas on every transfer at any size');

  console.log('\n── the fee quote endpoint answers the browser ────────────────');
  // Asked through the PAGE, so it exercises CORS and the real fetch path.
  const quote = await page.evaluate(async ([api]) => {
    const res = await fetch(`${api}/api/balance/transfers/quote?amount=10`);
    return res.json();
  }, [API]);
  check('a $10 transfer quotes $0.25', Number(quote?.data?.fee) === 0.25, JSON.stringify(quote?.data));
  check('and reports 2.50% rather than the headline 0.5%',
    quote?.data?.effectivePercent === '2.50', quote?.data?.effectivePercent);

  const newQuote = await page.evaluate(async ([api]) => {
    const res = await fetch(`${api}/api/balance/transfers/quote?amount=10&network=solana&asset=usdc`
      + `&destinationAddress=EJJaFs7u3QyTAREDsAW7RCK4KeSTtBwujnrqKDGfJzZp`);
    return res.json();
  }, [API]);
  check('a NEW solana recipient quotes $0.55', Number(newQuote?.data?.fee) === 0.55,
    JSON.stringify(newQuote?.data));
  check('the surcharge is reported separately',
    Number(newQuote?.data?.newRecipientFee) === 0.3);
  check('and the explanation says why, without saying "network fee"',
    /set up this recipient/i.test(newQuote?.data?.explanation ?? '')
    && !/network fee|gas fee/i.test(newQuote?.data?.explanation ?? ''),
    newQuote?.data?.explanation);

  console.log('\n── the receive screen still works ────────────────────────────');
  await page.goto(`${FRONTEND}/receive`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await shot('journey-04-receive');
  const receiveText = await page.textContent('body');
  check('the receive screen renders', (receiveText ?? '').length > 200);
  check('no error boundary on receive', !/Something went wrong/i.test(receiveText ?? ''),
    'React #310 crashed exactly this screen once');

  console.log('\n── the console is clean ──────────────────────────────────────');
  // Favicon and font 404s are noise from a preview server, not product faults.
  const realErrors = consoleErrors.filter((e) =>
    !/favicon|manifest|sentry|Failed to load resource/i.test(e));
  check('no unexpected console errors', realErrors.length === 0,
    realErrors.slice(0, 3).join(' | '));
  const realFailures = failedRequests.filter((r) => !r.includes('/sentry'));
  check('no failed API requests', realFailures.length === 0,
    [...new Set(realFailures)].slice(0, 5).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
console.log(`   screenshots in e2e/shots/\n`);
process.exit(fail === 0 ? 0 : 1);

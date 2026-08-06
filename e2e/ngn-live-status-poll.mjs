/**
 * THE DEPOSIT CARD MUST FOLLOW THE ORDER, NOT PHOTOGRAPH IT.
 *
 * Reported with a screenshot: crypto sent, Breet had it (trade.pending,
 * confirmations 1, real txHash), backend already at settlement_processing -
 * and the screen still read "Waiting for crypto deposit".
 *
 * `depositResult` was set once when the POST returned and never refetched.
 * This drives the real wizard, advances the transfer SERVER-SIDE behind the
 * page's back, and asserts the card catches up on its own with no reload.
 */
import { chromium } from 'playwright';

const FRONTEND = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4200';
const API = process.env.E2E_API ?? 'http://127.0.0.1:4100';
const TOKEN = process.env.E2E_TOKEN ?? '';
const ADMIN = 'e2e-admin-key';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { if (ok) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` -> ${d}` : ''}`); } };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();

try {
  await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([t]) => {
    localStorage.setItem('sivan.authToken', t);
    localStorage.setItem('sivan.user', JSON.stringify({ id: 'usr_ngn', email: 'ngn@sivan.test', fullName: 'Sharafa Ogunmepon', country: 'NG' }));
  }, [TOKEN]);

  await page.goto(`${FRONTEND}/withdraw`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await page.locator('text=Nigerian bank (NGN)').first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator("text=I'll send crypto myself").first().click().catch(() => {});
  await page.waitForTimeout(500);
  await page.locator('button:has-text("Access Bank")').first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator('input[placeholder*="NUBAN"]').first().fill('1111111111').catch(() => {});
  await page.waitForTimeout(2200);
  await page.locator('input[placeholder="20"]').first().fill('20').catch(() => {});
  await page.waitForTimeout(600);
  await page.locator('button:has-text("Get quote")').first().click().catch(() => {});
  await page.waitForTimeout(2500);
  await page.locator('button:has-text("Continue")').first().click().catch(() => {});
  await page.waitForTimeout(2000);
  await page.locator('button:has-text("Create deposit")').first().click().catch(() => {});
  await page.waitForTimeout(4000);

  const before = (await page.textContent('body')) ?? '';
  check('the deposit card rendered', /Deposit address created/i.test(before));
  check('it starts on "Waiting for crypto deposit"',
    /Waiting for crypto deposit/i.test(before));

  // Advance the transfer SERVER-SIDE. The page is not told.
  /**
   * Read the id off the CARD, not from data[0].
   *
   * My first version took the newest transfer from the API. Every run of this
   * test leaves another order behind, so data[0] was frequently a DIFFERENT
   * transfer from the one on screen - the test advanced one order and then
   * asserted against another, and reported the poll as broken when it was
   * working. Caught by printing both: the card showed one id while the API's
   * first row was another.
   */
  const id = await page.evaluate(() => {
    const match = document.body.innerText.match(/Request ID\s*(\S+)/i);
    return match ? match[1] : null;
  });
  check('found the transfer the card is actually showing', Boolean(id), String(id));

  /**
   * Advanced by writing the JSON store directly. There is no admin route that
   * forces a status, and inventing one purely to make a test pass would be
   * adding a production capability to serve a test. The point of the
   * assertion is what the BROWSER does when the server record changes, so how
   * it changed is irrelevant.
   */
  /**
   * Advanced through the DEV-ONLY status route, so the running server's own
   * in-memory copy changes.
   *
   * My first attempt wrote the JSON file directly and the test failed - which
   * looked like the poll was broken. It was not: request tracing showed the
   * browser polling correctly (3 calls -> 5 calls across the wait), but the
   * JSON backend caches the database in memory, so a file write behind the
   * server's back is invisible to it. The API kept returning the old status
   * and the card was right to keep showing it.
   */
  const advanced = await page.evaluate(async ([api, key, tid]) => {
    const r = await fetch(`${api}/api/admin/ngn/transfers/${tid}/dev-status`, {
      method: 'POST',
      headers: { 'x-admin-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'blockchain_confirmed' }),
    });
    return r.status;
  }, [API, ADMIN, id]);
  check('the transfer was advanced server-side', advanced === 200, `HTTP ${advanced}`);

  // The poll runs every 10s. Wait past one tick.
  await page.waitForTimeout(13000);
  const after = (await page.textContent('body')) ?? '';

  /**
   * ASSERT THE STEP STATE, NOT THE LABEL.
   *
   * My first version checked for the text "Blockchain confirmed" - which is a
   * STATIC step label rendered on this card at every status, including the
   * frozen one. It passed with polling entirely disabled, so it proved
   * nothing. Caught by mutation-testing: I removed the poll and the suite
   * stayed green.
   *
   * The DOM carries the real answer: each step div is classed with its status
   * (customer-timeline-step current / completed / pending). Read that.
   */
  const stepState = await page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('.customer-timeline-step')) {
      const label = el.querySelector('strong')?.textContent?.trim() ?? '';
      const cls = [...el.classList].find((c) => ['current', 'completed', 'pending', 'failed'].includes(c)) ?? '?';
      out[label] = cls;
    }
    return out;
  });
  console.log('       step states:', JSON.stringify(stepState));

  check('the card advanced WITHOUT a reload',
    stepState['Blockchain confirmed'] === 'current',
    `Blockchain confirmed is "${stepState['Blockchain confirmed']}" - the screen must follow the order, not stay frozen`);
  check('and the waiting step is now closed',
    stepState['Waiting for crypto deposit'] === 'completed',
    `still "${stepState['Waiting for crypto deposit']}" - this is the step the user was stuck on`);
  check('the deposit address is still shown', /DEPOSIT ADDRESS/i.test(after),
    'polling must not blow away the address the user still needs');
} finally {
  await browser.close();
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

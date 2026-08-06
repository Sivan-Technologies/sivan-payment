/**
 * THE NAIRA WITHDRAWAL, DRIVEN IN A REAL BROWSER.
 *
 * Reported: /withdraw showed "Something went wrong. Please refresh or try
 * again." while the withdrawal itself succeeded - the user was charged and
 * shown a black screen, with the deposit address they needed trapped inside
 * the response that crashed the page.
 *
 * Unit tests could not have caught it: the crash needed a REAL naira response,
 * whose `timeline` is a bare array where the component expects an object with
 * `.steps`. Only clicking through the wizard produces that.
 *
 * Run: node e2e/ngn-withdraw-journey.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const FRONTEND = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4200';
const TOKEN = process.env.E2E_TOKEN ?? '';
const SHOTS = new URL('./shots/ngn/', import.meta.url).pathname;

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
};

const browser = await chromium.launch();
await fs.mkdir(SHOTS, { recursive: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const failedApi = [];
page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) failedApi.push(`${r.status()} ${new URL(r.url()).pathname}`); });

const crashed = async () => /Something went wrong/i.test((await page.textContent('body')) ?? '');
const shot = (n) => page.screenshot({ path: `${SHOTS}${n}.png`, fullPage: true });

try {
  await page.goto(FRONTEND, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([t]) => {
    localStorage.setItem('sivan.authToken', t);
    localStorage.setItem('sivan.user', JSON.stringify({ id: 'usr_ngn', email: 'ngn@sivan.test', fullName: 'Sharafa Ogunmepon', country: 'NG' }));
  }, [TOKEN]);

  console.log('\n── the sell screen loads ─────────────────────────────────────');
  await page.goto(`${FRONTEND}/withdraw`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  check('the withdraw page renders', !(await crashed()));

  await page.locator('text=Nigerian bank (NGN)').first().click().catch(() => {});
  await page.waitForTimeout(1200);
  await shot('01-form');
  check('the naira tab does not crash', !(await crashed()));

  /**
   * Ethereum is disabled for deposits, and this is where a user would pick it.
   * Asserted on the RENDERED radio group rather than on the API, because the
   * question is what the user can choose.
   */
  const networks = await page.evaluate(() =>
    Array.from(document.querySelectorAll('input[name="sell-network"]'))
      .map((el) => el.closest('label')?.textContent?.trim().toLowerCase() ?? ''));
  check('ethereum is NOT offered as a sell network',
    !networks.some((n) => n.includes('ethereum')),
    JSON.stringify(networks));

  console.log('\n── the form reaches a quote ──────────────────────────────────');
  await page.locator("text=I'll send crypto myself").first().click().catch(() => {});
  await page.waitForTimeout(600);
  await page.locator('button:has-text("Access Bank")').first().click().catch(() => {});
  await page.waitForTimeout(1200);
  await page.locator('input[placeholder*="NUBAN"]').first().fill('1111111111').catch(() => {});
  await page.waitForTimeout(2500);
  check('the bank account resolves', !(await crashed()));

  await page.locator('input[placeholder="20"]').first().fill('20').catch(() => {});
  await page.waitForTimeout(800);
  await page.locator('button:has-text("Get quote")').first().click().catch(() => {});
  await page.waitForTimeout(3000);
  await shot('02-quote');
  check('a quote is returned', !(await crashed()));

  console.log('\n── THE REPORTED CRASH: confirming the withdrawal ─────────────');
  for (let step = 0; step < 4; step++) {
    let clicked = null;
    for (const label of ['Continue', 'Create deposit', 'Confirm']) {
      const el = page.locator(`button:has-text("${label}")`).first();
      if (await el.count() && await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => false)) {
        clicked = label; await el.click().catch(() => {}); break;
      }
    }
    if (!clicked) break;
    await page.waitForTimeout(3500);
    if (await crashed()) { check(`clicking "${clicked}" does not crash the page`, false, 'error boundary replaced the screen AFTER the order was created'); break; }
    check(`clicking "${clicked}" does not crash the page`, true);
  }
  await shot('03-deposit');

  const body = (await page.textContent('body')) ?? '';

  console.log('\n── the confirmation says what happened ───────────────────────');
  check('the deposit address screen rendered', /Deposit address created/i.test(body),
    'this is what the user saw as a black screen');
  check('a deposit address is shown', /DEPOSIT ADDRESS/i.test(body),
    'the address was inside the response that used to crash');
  check('the timeline rendered its steps', /Waiting for crypto deposit/i.test(body),
    'timeline.steps.map was the throwing expression');

  console.log('\n── the numbers a user checks ─────────────────────────────────');
  check('"You receive" is shown', /You receive/i.test(body));
  check('"You send" is shown', /You send/i.test(body));
  check('the fee is a value, not a dash', /FEE\s*0\.3/i.test(body.replace(/\s+/g, ' ')),
    'every NGN withdrawal rendered "FEE —" because only feePercent was read');

  console.log('\n── the REVIEW panel (reported screenshot) ────────────────────');
  // Re-open the wizard to inspect the review step, which the loop above walked past.
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
  await page.waitForTimeout(2500);
  await shot('04-review');
  const review = (await page.textContent('body')) ?? '';

  /**
   * Matched on the FLATTENED panel text. My first version used a
   * case-insensitive /NETWORK\s*solana/i, which matches the correctly
   * capitalised "NETWORK Solana" too - so it failed against a screen that was
   * already fixed. Assert the exact rendered casing instead.
   */
  const flat = review.replace(/\s+/g, ' ');
  /**
   * The label is rendered as "Network" and uppercased by CSS, so the DOM text
   * is mixed case. Matching on the literal uppercase found nothing at all -
   * a test that silently matches nothing is worse than one that fails loudly,
   * so this now reports the row it did find.
   */
  /**
   * Kv renders label and value as adjacent elements with no whitespace
   * between them, so textContent reads "NetworkSolana". Two earlier versions
   * of this assertion expected a space and matched NOTHING - reporting "no
   * row found" rather than a real result. Verified against the actual DOM
   * before writing this one.
   */
  check('the review panel says "Solana", not "solana"',
    /NetworkSolana/.test(flat) && !/Networksolana/.test(flat),
    flat.match(/Network[A-Za-z]+/)?.[0] ?? 'no Network row found');
  check('the deposit warning also names it properly',
    !/on solana\b/.test(flat),
    'the Kv row and the warning text are two separate reads of the same value');
  check('the gas estimate is not a false $0.00',
    /Estimated network fee\$0\.0010/.test(flat),
    flat.match(/Estimated network fee\S+/)?.[0] ?? 'no fee row found');

  console.log('\n── the network is named properly ─────────────────────────────');
  check('the warning says "on Solana", not "on solana"',
    /on Solana/.test(body) && !/on solana\b/.test(body),
    'a raw database value on the screen where a user decides where to send money');

  console.log('\n── nothing threw ─────────────────────────────────────────────');
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  check('no failed API calls', failedApi.length === 0, [...new Set(failedApi)].slice(0, 4).join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
console.log(`   screenshots in e2e/shots/ngn/\n`);
process.exit(fail === 0 ? 0 : 1);

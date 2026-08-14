/**
 * THE REGRESSION TEST FOR THE RACE.
 *
 * A fast endpoint does not fix this bug, it only hides it. The page must be
 * correct at ANY latency, so this test does not hope for a fast network - it
 * FORCES the summary to be slow and asserts the page still never lies.
 *
 * Three scenarios, each on a cold context and a direct navigation, which is
 * how a real user arrives from a link:
 *
 *   SLOW      summary delayed 8s. The page must not describe the Bridge path
 *             to a Nigerian, and must eventually show the pending card.
 *   NORMAL    no interference. Correct, and reasonably quick.
 *   FAILING   summary 500s. The page must NOT hang on a skeleton forever -
 *             a failure is an answer, and the user must land somewhere usable.
 *
 * The bar is not "shows the right thing eventually". It is "NEVER shows the
 * wrong thing", which is why the Bridge copy is asserted against at every
 * poll rather than only at the end.
 *
 *   node verification-race.mjs [frontendUrl]
 */
import { chromium } from 'playwright';

const FRONTEND = process.argv[2] ?? process.env.E2E_FRONTEND ?? 'https://sivan-payments-user-test.onrender.com';
const API = process.env.E2E_API ?? 'https://test-sivan.sivantech.online/api/payment';
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; } };

let pass = 0, fail = 0;
const failed = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failed.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

/** The words that are only ever correct on the Bridge path. */
const BRIDGE_ONLY = /Government-issued ID|selfie/i;

async function seedPendingNigerian() {
  const email = `race-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@sivan.test`;
  const start = await j(await fetch(`${API}/api/auth/email/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Samuel Udochukwu', intent: 'signup',
      legalAcceptance: { accepted: true, termsVersion: 't', privacyVersion: 'p', riskDisclosureVersion: 'r' } }),
  }));
  const v = await j(await fetch(`${API}/api/auth/email/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: start.data.devCode }),
  }));
  const token = v.data.token, user = v.data.user;
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  await fetch(`${API}/api/users/${user.id}/country`, { method: 'PUT', headers: H, body: JSON.stringify({ country: 'NG' }) });
  const banks = await j(await fetch(`${API}/api/ngn/banks`, { headers: H }));
  const list = Array.isArray(banks.data) ? banks.data : [];
  const palm = list.find((b) => /palmpay/i.test(b.name)) ?? list[0];
  await fetch(`${API}/api/ngn/payout-accounts`, { method: 'POST', headers: H,
    body: JSON.stringify({ userId: user.id, bankId: String(palm.id), accountNumber: '1111111111' }) });
  const summary = await j(await fetch(`${API}/api/users/${user.id}/verification-summary`, { headers: H }));
  return { token, user, summary: summary.data ?? summary };
}

/**
 * Loads /verification and samples the page every 500ms, so a wrong render
 * that is later corrected is still caught. A single read at the end would
 * miss exactly the bug this guards.
 */
async function watch(browser, seeded, mode, budgetMs = 22000) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(([t, u]) => {
    localStorage.setItem('sivan.authToken', t);
    localStorage.setItem('sivan.user', u);
  }, [seeded.token, JSON.stringify(seeded.user)]);

  if (mode === 'slow') {
    await context.route('**/verification-summary*', async (route) => {
      await new Promise((r) => setTimeout(r, 8000));
      await route.continue();
    });
  }
  if (mode === 'noisy-neighbours') {
    // The summary answers promptly; the thirteen calls around it do not.
    // This is the shape of the deployed test API on a cold Render instance,
    // and it is what caught the gate being wired to the WRONG promise.
    await context.route('**/api/**', async (route) => {
      if (/verification-summary/.test(route.request().url())) return route.continue();
      await new Promise((r) => setTimeout(r, 12000));
      await route.continue();
    });
  }
  if (mode === 'failing') {
    await context.route('**/verification-summary*', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
  }

  const page = await context.newPage();
  const samples = [];
  await page.goto(`${FRONTEND}/verification`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const t0 = Date.now();
  let firstCorrectAt = null;
  while (Date.now() - t0 < budgetMs) {
    const text = await page.locator('body').innerText().catch(() => '');
    samples.push({ at: Date.now() - t0, text });
    if (firstCorrectAt === null && /Bank check in progress/i.test(text)) firstCorrectAt = Date.now() - t0;
    await page.waitForTimeout(500);
  }
  const finalText = samples[samples.length - 1]?.text ?? '';
  const everBridge = samples.filter((s) => BRIDGE_ONLY.test(s.text));
  await page.screenshot({ path: new URL(`./shots/race-${mode}.png`, import.meta.url).pathname, fullPage: false }).catch(() => {});
  await context.close();
  return { samples, finalText, everBridge, firstCorrectAt };
}

const seeded = await seedPendingNigerian();
console.log(`frontend ${FRONTEND}`);
console.log(`user     ${seeded.user.id}`);
console.log(`server   pending=${seeded.summary?.hasPendingPayoutReview} level=${seeded.summary?.level} path=${seeded.summary?.path}`);
if (seeded.summary?.hasPendingPayoutReview !== true) {
  console.log('\nABORT: the fixture is not in the state under test.');
  process.exit(1);
}

const browser = await chromium.launch();

console.log('\n1. SLOW SUMMARY (8s delay) — the exact conditions that produced the bug');
{
  const r = await watch(browser, seeded, 'slow');
  check('the Bridge document flow is NEVER shown to a Nigerian',
    r.everBridge.length === 0,
    r.everBridge.length ? `shown at ${r.everBridge.map((s) => s.at + 'ms').slice(0, 6).join(', ')}` : '');
  check('the user is told something is happening while it loads',
    /Checking your verification status|Bank check in progress/i.test(r.samples[1]?.text ?? ''),
    (r.samples[1]?.text ?? '').slice(0, 120).replace(/\n/g, ' '));
  check('and the pending card arrives once the answer does',
    /Bank check in progress/i.test(r.finalText), r.finalText.slice(0, 160).replace(/\n/g, ' '));
  check('it does not still tell them to start verifying',
    !/Verify your account/i.test(r.finalText));
}

console.log('\n2. NORMAL SPEED — no interference');
{
  const r = await watch(browser, seeded, 'normal', 16000);
  check('the Bridge document flow is never shown', r.everBridge.length === 0,
    r.everBridge.length ? `${r.everBridge.length} samples` : '');
  check('the pending card is shown', /Bank check in progress/i.test(r.finalText),
    r.finalText.slice(0, 160).replace(/\n/g, ' '));
  check('and it arrives in under 12s', r.firstCorrectAt !== null && r.firstCorrectAt < 12000,
    String(r.firstCorrectAt));
}

console.log('\n3. SLOW NEIGHBOURS — the summary must not wait on data this page never shows');
{
  // Regression guard for a bug introduced BY THIS FIX and caught by widening
  // the test: the "answered yet?" flag was resolved after Promise.allSettled
  // over all fourteen calls, so the skeleton was held up by /suppliers and
  // /virtual-accounts. Measured: summary back at 10.1s, skeleton still up at
  // 30.1s. The page must gate on its OWN call and nothing else.
  const r = await watch(browser, seeded, 'noisy-neighbours', 20000);
  check('the Bridge document flow is never shown', r.everBridge.length === 0,
    r.everBridge.length ? `${r.everBridge.length} samples` : '');
  check('the pending card does not wait for unrelated calls',
    r.firstCorrectAt !== null && r.firstCorrectAt < 10000,
    r.firstCorrectAt === null ? 'never appeared in 20s' : `${r.firstCorrectAt}ms`);
}

console.log('\n4. SUMMARY FAILS (500) — a failure is an answer, not a hang');
{
  const r = await watch(browser, seeded, 'failing', 16000);
  check('the page does NOT sit on a skeleton forever',
    !/Checking your verification status/i.test(r.finalText),
    r.finalText.slice(0, 160).replace(/\n/g, ' '));
  check('the user still lands somewhere they can act',
    /verif/i.test(r.finalText) && r.finalText.length > 100,
    String(r.finalText.length));
}

await browser.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (fail) { console.log(failed.map((f) => `  - ${f}`).join('\n')); process.exit(1); }

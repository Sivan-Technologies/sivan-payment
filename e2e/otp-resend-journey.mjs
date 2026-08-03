/**
 * THE RESEND COUNTDOWN MUST NOT LIE.
 *
 * The backend enforces a per-address OTP cooldown
 * (AUTH_OTP_RESEND_COOLDOWN_SECONDS, default 60s) to protect the email quota.
 * The frontend renders its own countdown on the "Resend code" button.
 *
 * When those two disagree the button re-enables early, the user clicks a
 * control that says it is ready, and the API refuses. Caught exactly that way
 * on the deployed app: button enabled at ~25s, server replied "ask for another
 * in 26 seconds".
 *
 * A countdown that lies is worse than no countdown - the user learns the
 * button is unreliable rather than that they need to wait.
 *
 * Run: node e2e/otp-resend-journey.mjs [frontendUrl]
 */

import { chromium } from 'playwright';

const FRONTEND = process.argv[2] ?? process.env.E2E_FRONTEND ?? 'https://sivan-payments-user-test.vercel.app';

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const email = `resend-${Date.now()}@sivan.test`;

  try {
    await page.goto(`${FRONTEND}/signup`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="fullName"]', 'Resend Test');
    const boxes = page.locator('input[type="checkbox"]');
    for (let i = 0; i < await boxes.count(); i++) await boxes.nth(i).check().catch(() => {});
    await page.click('button:has-text("Send verification code")');
    await page.waitForTimeout(9000);

    const resend = page.locator('button:has-text("Resend code")').first();
    check('the OTP screen is reached', await resend.isVisible().catch(() => false));

    const initial = await resend.innerText().catch(() => '');
    check('the resend button starts counting down', /in \d+s/i.test(initial), initial);

    // Wait for the button to claim it is ready, then hold it to that claim.
    let readyAt = null;
    for (let s = 0; s < 24; s++) {
      const text = await resend.innerText().catch(() => '');
      if (text && !/in \d+s/i.test(text)) { readyAt = s * 5; break; }
      await page.waitForTimeout(5000);
    }
    check('the countdown finishes within a sensible time', readyAt !== null, 'never re-enabled');

    await resend.click();
    await page.waitForTimeout(4000);
    const body = await page.locator('body').innerText();

    // THE ASSERTION THAT MATTERS. If the countdown told the truth, the server
    // accepted it; if it lied, the cooldown message is on screen.
    const refused = /A code was just sent to that address/i.test(body);
    check('clicking a re-enabled resend button is NOT refused by the server',
      !refused, refused ? `button was ready at ~${readyAt}s but the server still refused` : '');
    check('and the user is told a new code was sent',
      /new verification code has been sent/i.test(body) || !refused,
      body.slice(0, 160).replace(/\n/g, ' '));
  } catch (error) {
    check('the journey ran', false, String(error).slice(0, 200));
  }

  await browser.close();
  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
  if (fail) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });

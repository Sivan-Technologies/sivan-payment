/**
 * THE ASK SIVAN CHIPS MUST ANSWER THE TOPIC THEY NAME.
 *
 * Reported with screenshots: clicking "Verification help" produced a status
 * report about an unrelated buy order, and pasting an NGN request id did the
 * same. Both at confidence: high.
 *
 * WHY A BROWSER TEST ON TOP OF THE UNIT TEST. The unit test drives
 * answerAceSupport() directly, so it proves the SERVER classifies correctly.
 * It cannot prove the chip sends the right thing - and the chip was itself
 * part of the bug: it shipped a sentence and let the server guess, with no
 * explicit context. Only clicking the real button through the real bundle
 * exercises that path.
 *
 * Run against a live API + built frontend:
 *   node e2e/ace-support-chat.mjs
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

/** A real signup, because verification evidence only exists for a real user. */
const email = `ace-e2e-${Date.now()}@sivantech.online`;
const post = async (path, body, token) => {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return res.json();
};

const started = await post('/api/auth/email/start', {
  email, fullName: 'Ace E2E', intent: 'signup', legalAcceptance: { accepted: true },
});
const devCode = started?.data?.devCode;
if (!devCode) {
  console.log('❌ no devCode returned - AUTH_DEV_SHOW_OTP must be true on the API');
  process.exit(1);
}
const verified = await post('/api/auth/email/verify', { email, code: devCode });
const userId = verified?.data?.user?.id;
const token = verified?.data?.token || verified?.data?.accessToken;
if (!userId || !token) {
  console.log('❌ could not establish a session');
  process.exit(1);
}
console.log(`  seeded user ${userId}`);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 1000 } });
const p = await ctx.newPage();
const consoleErrors = [];
p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await p.goto(FE, { waitUntil: 'domcontentloaded' });
await p.evaluate(([id, tok, mail]) => {
  localStorage.setItem('sivan.authToken', tok);
  localStorage.setItem('sivan.user', JSON.stringify({ id, email: mail, fullName: 'Ace E2E', country: 'NG' }));
}, [userId, token, email]);
await p.goto(`${FE}/help`, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);

/** Open the drawer via the Ask Sivan card. */
await p.evaluate(() => {
  const card = [...document.querySelectorAll('.support-card, button')]
    .find((el) => /Ask Sivan|Start chat/i.test(el.innerText || ''));
  card?.click();
});
await p.waitForTimeout(1200);

const drawerOpen = await p.evaluate(() => Boolean(document.querySelector('.ask-sivan-drawer')));
check('the Ask Sivan drawer opens', drawerOpen);

if (drawerOpen) {
  /** Read the last assistant bubble, waiting for it to actually arrive. */
  const lastAnswer = async () => {
    await p.waitForFunction(() => {
      const msgs = [...document.querySelectorAll('.ask-sivan-message.assistant')];
      const last = msgs[msgs.length - 1];
      return last && !last.classList.contains('typing');
    }, null, { timeout: 20000 }).catch(() => {});
    return p.evaluate(() => {
      const msgs = [...document.querySelectorAll('.ask-sivan-message.assistant')].filter((m) => !m.classList.contains('typing'));
      return (msgs[msgs.length - 1]?.querySelector('p')?.innerText || '').trim();
    });
  };

  const clickChip = async (label) => {
    const before = await p.evaluate(() => document.querySelectorAll('.ask-sivan-message.assistant').length);
    await p.evaluate((wanted) => {
      const btn = [...document.querySelectorAll('.ask-sivan-quick button')]
        .find((x) => x.innerText.toLowerCase().includes(wanted.toLowerCase()));
      btn?.click();
    }, label);
    await p.waitForFunction(
      (n) => document.querySelectorAll('.ask-sivan-message.assistant').length > n,
      before, { timeout: 20000 }
    ).catch(() => {});
    return lastAnswer();
  };

  /**
   * THE REPORTED BUG. This chip used to return a buy order status report.
   */
  const verification = await clickChip('Verification help');
  check('the Verification chip returns a verification answer',
    /verification/i.test(verification) && /level/i.test(verification),
    verification.slice(0, 120) || '(empty)');
  check('and it does NOT return a transaction status report',
    !/buy order is currently|withdrawal is currently|naira payout is currently/i.test(verification),
    verification.slice(0, 120));
  check('and it names a concrete next step',
    /next step/i.test(verification), verification.slice(0, 120));

  /**
   * The chip must not fall into the "I could not find that reference" branch.
   * It used to send resourceId: customer.id - a CUSTOMER id in a TRANSACTION
   * slot - which was harmless only while the server ignored it.
   */
  check('and it does not claim a reference could not be found',
    !/could not find any transaction matching/i.test(verification),
    verification.slice(0, 120));

  const recovery = await clickChip('2FA');
  check('the 2FA chip answers about account recovery',
    /2fa|recovery|account access/i.test(recovery), recovery.slice(0, 120) || '(empty)');
  check('and the 2FA answer is not a transaction report',
    !/is currently .* with /i.test(recovery), recovery.slice(0, 120));

  await p.screenshot({ path: '/tmp/ace-chat.png', fullPage: false });
}

const relevant = consoleErrors.filter((e) => !/favicon|manifest|404|Failed to load resource/i.test(e));
check('no console errors', relevant.length === 0, relevant.slice(0, 2).join(' | '));

await ctx.close();
await b.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
if (failures.length) console.log(`   ${failures.join('\n   ')}`);
process.exit(fail === 0 ? 0 : 1);

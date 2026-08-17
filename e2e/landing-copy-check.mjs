/**
 * The landing copy, as a browser renders it.
 *
 * Source-only checks are not enough here: the payout list is interpolated from
 * the live /api/offramp/controls response, so the bug reported ("NGN and NGN")
 * only exists in the COMPOSED string. Reading the rendered text is the only way
 * to see what the visitor sees.
 */
import { chromium } from 'playwright';
const FE = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4178';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 600, height: 1000 } });
await p.goto(FE, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);

// The card animates in on scroll; screenshotting before that yields a blank.
const card = await p.$('.direction-card.sell');
await card?.scrollIntoViewIfNeeded();
await p.waitForTimeout(1200);

/**
 * FAIL LOUDLY IF THE API IS NOT UP.
 *
 * payoutCurrencies falls back to a hardcoded 'USD, GBP, EUR' when
 * /api/offramp/controls cannot be reached, so with the API down this file
 * reports "NGN appears 0 times" and looks like a regression in the page. It
 * cost me a few minutes chasing exactly that. Check the dependency first and
 * say so, rather than blaming the component.
 */
const apiUp = await p.evaluate(async () => {
  try {
    const r = await fetch('http://127.0.0.1:4179/api/offramp/controls');
    return r.ok;
  } catch { return false; }
});
if (!apiUp) {
  console.log('\n  SKIP - the API on :4179 is not reachable, so the currency list is the');
  console.log('         offline fallback and any NGN assertion here is meaningless.\n');
  await b.close();
  process.exit(2);
}

const text = await p.evaluate(() => document.body.innerText);
const line = text.split('\n').find((l) => /Payouts in/i.test(l))?.trim() ?? '(not found)';
let fail = 0;
const check = (name, ok, detail='') => { console.log(`  ${ok?'ok  ':'FAIL'} ${name}${ok?'':` -> ${detail}`}`); if(!ok) fail++; };

console.log(`\nrendered: "${line}"\n`);
check('NGN appears exactly once', (line.match(/NGN/g)||[]).length === 1, `${(line.match(/NGN/g)||[]).length} times`);
check('GHS is named as coming soon', /GHS coming soon/i.test(line), line);
check('the live currencies are all listed', ['USD','GBP','EUR','NGN'].every(c => line.includes(c)), line);
check('no stale "NGN supported" badge remains', !/NGN supported/i.test(text));
check('no hardcoded "USD · GBP · EUR" badge remains', !/USD · GBP · EUR/.test(text));

await card?.screenshot({ path: '/tmp/landing-sell.png' });
await b.close();
console.log(`\n${fail===0?'✅':'❌'} ${5-fail} passed, ${fail} failed\n`);
process.exit(fail===0?0:1);

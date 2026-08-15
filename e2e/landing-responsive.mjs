/**
 * IS THE LANDING PAGE ACTUALLY RESPONSIVE? MEASURED, AT REAL DEVICE WIDTHS.
 *
 * "Looks fine when I drag the window" is not a test. The failures that matter
 * on a phone are measurable and invisible in a desktop browser:
 *
 *   - HORIZONTAL OVERFLOW. One element wider than the viewport gives the whole
 *     page a sideways scroll. It is the single most common mobile defect and
 *     the easiest to miss, because the offending element is usually off-screen.
 *   - TAP TARGETS under ~40px. Apple says 44, Material says 48. A 30px button
 *     is hit-or-miss with a thumb, and this page's primary CTA is the whole
 *     funnel.
 *   - TEXT under 12px, which iOS Safari may zoom on focus and which most
 *     people cannot read at arm's length.
 *   - CONTENT CLIPPED by a fixed height or an overflow:hidden ancestor.
 *
 * 360px is the honest floor for the Nigerian market this ships to - it is the
 * Android baseline, not the iPhone one.
 */
import { chromium } from 'playwright';

const FE = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4178';
const VIEWPORTS = [
  { w: 360,  h: 780, name: '360 Android baseline' },
  { w: 390,  h: 844, name: '390 iPhone 14' },
  { w: 430,  h: 932, name: '430 iPhone Pro Max' },
  { w: 768,  h: 1024, name: '768 tablet portrait' },
  { w: 1024, h: 768, name: '1024 tablet landscape' },
  { w: 1280, h: 900, name: '1280 laptop' },
  { w: 1920, h: 1080, name: '1920 desktop' },
];

let fail = 0;
const problems = [];
const check = (vp, name, ok, detail = '') => {
  if (!ok) { fail++; problems.push(`${vp}: ${name} -> ${detail}`); }
  return ok;
};

const b = await chromium.launch();

for (const vp of VIEWPORTS) {
  // 768 counts as touch: a tablet in portrait is a finger, not a mouse.
  const isTouch = vp.w <= 768;
  const ctx = await b.newContext({
    viewport: { width: vp.w, height: vp.h },
    deviceScaleFactor: 1,
    isMobile: isTouch,
    hasTouch: isTouch,
  });
  const p = await ctx.newPage();
  await p.goto(FE, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);
  // Reveal everything below the fold so clipped/overflowing sections are real.
  await p.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60));
    }
    window.scrollTo(0, 0);
  });
  await p.waitForTimeout(700);

  const report = await p.evaluate((vw) => {
    const doc = document.documentElement;
    // Elements sticking out past the viewport. Ignore anything deliberately
    // positioned off-screen (visually-hidden helpers, closed drawers).
    const overflowing = [];
    document.querySelectorAll('body *').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return;
      if (cs.position === 'fixed') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.right > vw + 1.5 || r.left < -1.5) {
        overflowing.push({
          sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string'
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
          left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
        });
      }
    });

    const small = [];
    document.querySelectorAll('button, a.primary-btn, a.secondary-btn, .nav-item, summary').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.height < 40) small.push({ text: (el.innerText || '').trim().slice(0, 22), h: Math.round(r.height) });
    });

    const tiny = [];
    document.querySelectorAll('p, span, small, li, a, button, strong').forEach((el) => {
      if (!el.innerText || !el.innerText.trim()) return;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const size = parseFloat(cs.fontSize);
      if (size && size < 12) tiny.push({ text: el.innerText.trim().slice(0, 22), size: +size.toFixed(1) });
    });

    return {
      scrollW: doc.scrollWidth,
      clientW: doc.clientWidth,
      overflowing: overflowing.slice(0, 6),
      overflowCount: overflowing.length,
      small: small.slice(0, 6),
      tiny: tiny.slice(0, 6),
      heroH1: parseFloat(getComputedStyle(document.querySelector('.premium-hero h1')).fontSize),
      /**
       * HEADER HEIGHT, because the worst defect found in this audit was
       * invisible to every other check here: at 360px the nav rendered 133px
       * tall against 67px at 390px. It declared `height: 62px` while its
       * contents wrapped onto a second line and escaped it - a band of empty
       * white eating the top of the fold, with no overflow and no scrollbar
       * to give it away. Reintroducing that bug left this suite green until
       * this was added.
       */
      navH: Math.round((document.querySelector('.premium-nav')
        ?? document.querySelector('header'))?.getBoundingClientRect().height ?? 0),
    };
  }, vp.w);

  const hScroll = report.scrollW > report.clientW + 1;
  console.log(`\n${vp.name}  (${vp.w}×${vp.h})${isTouch ? '  [touch]' : ''}`);
  console.log(`  scrollWidth ${report.scrollW} vs viewport ${report.clientW}  h1=${report.heroH1}px  nav=${report.navH}px`);
  check(vp.name, 'no horizontal scroll', !hScroll, `scrollWidth ${report.scrollW} > ${report.clientW}`);
  // 96px is generous - the header is ~62 by design. Anything approaching
  // double that means the row has wrapped out of its own container.
  check(vp.name, 'the header has not wrapped to a second row', report.navH <= 96,
    `navHeight=${report.navH}px`);
  check(vp.name, 'nothing overflows the viewport', report.overflowCount === 0,
    JSON.stringify(report.overflowing));
  /**
   * TAP-TARGET AND MINIMUM-TEXT RULES ARE FOR TOUCH, AND ONLY FOR TOUCH.
   *
   * My first version asserted them at every width and reported 14 problems,
   * of which half were desktop breakpoints where a 38px button hit by a mouse
   * is completely fine and an 11px eyebrow at a 60cm viewing distance is a
   * deliberate type choice, not a defect. That is a test measuring the wrong
   * thing loudly - it buries the two real mobile faults in noise.
   *
   * The CSS fixes are scoped to `@media (pointer: coarse)` for exactly this
   * reason, so the assertion is scoped the same way. Anything else would be
   * asserting behaviour the stylesheet never claims.
   */
  if (isTouch) {
    check(vp.name, 'tap targets >= 40px', report.small.length === 0, JSON.stringify(report.small));
    check(vp.name, 'no text under 12px', report.tiny.length === 0, JSON.stringify(report.tiny));
  }
  if (hScroll) console.log(`  ⚠ HORIZONTAL SCROLL`);
  if (report.overflowCount) console.log(`  ⚠ ${report.overflowCount} overflowing:`, JSON.stringify(report.overflowing));
  if (isTouch && report.small.length) console.log(`  ⚠ small tap targets:`, JSON.stringify(report.small));
  if (isTouch && report.tiny.length) console.log(`  ⚠ tiny text:`, JSON.stringify(report.tiny));

  await p.screenshot({ path: `/tmp/land-${vp.w}.png`, fullPage: false });
  await ctx.close();
}

await b.close();
console.log(`\n${'─'.repeat(60)}`);
if (problems.length) { console.log('PROBLEMS:'); problems.forEach((x) => console.log('  ' + x)); }
console.log(`\n${fail === 0 ? '✅ responsive across all widths' : `❌ ${fail} problem(s)`}\n`);
process.exit(fail === 0 ? 0 : 1);

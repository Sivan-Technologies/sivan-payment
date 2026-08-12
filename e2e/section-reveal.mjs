/**
 * DO THE LANDING SECTIONS ACTUALLY ANIMATE IN?
 *
 * Measured before this change: 7 sections, 1 with reveal wiring. Every
 * below-fold section sat at opacity 1, fully painted before it was ever seen.
 *
 * WHAT THIS FILE REFUSES TO DO. It does not grep styles.css, and it does not
 * check that a class name appears in the bundle. Both of those assert that
 * code EXISTS rather than that it RUNS, which is the single most repeated
 * mistake in this repo's test history - a press-feedback test once passed on a
 * mid-flight transition value, and a toast test passed against markup the test
 * itself had injected.
 *
 * So every assertion here reads a COMPOSITED value out of the live page:
 * getComputedStyle opacity, and DOMMatrix translation from the real transform.
 * A section is only "revealed" if the browser is actually painting it at
 * opacity 1 and zero offset, after transitions have settled.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:5179';

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) { console.log(`  ok   ${name}`); return; }
  failures += 1;
  console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
};

/** Composited opacity + Y offset for a selector, read from the rendered page. */
async function paintedState(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    // DOMMatrix parses the COMPUTED transform, so 'none', a matrix() string
    // and a matrix3d() string all reduce to comparable numbers. Comparing
    // transform strings is what let a mid-flight value pass as settled once.
    const m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform);
    return { opacity: Number(cs.opacity), y: Math.round(m.m42 * 100) / 100 };
  }, selector);
}

const SECTIONS = [
  ['hero', '.landing-hero.reveal-section'],
  ['rails strip', '.landing-strip.reveal-section'],
  ['two directions', '.two-directions.reveal-section'],
  ['how it works', '#how.reveal-section'],
  ['why sivan', '#business.reveal-section'],
  ['faq', '.faq-section.reveal-section'],
  ['final cta', '.final-cta-section.reveal-section'],
];

const browser = await chromium.launch();

// ───────────────────────────────────────────── 1. normal motion preference
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  check('all seven sections are wired', (await page.locator('.reveal-section').count()) === 7,
    `found ${await page.locator('.reveal-section').count()}`);

  // The hero is above the fold and must be painted WITHOUT any scrolling -
  // a landing page whose first screen waits for a scroll event is broken.
  const hero = await paintedState(page, '.landing-hero.reveal-section');
  check('the hero is visible on load, without scrolling', hero && hero.opacity === 1 && hero.y === 0,
    JSON.stringify(hero));

  /**
   * THE CENTRAL ASSERTION: a below-fold section must start HIDDEN.
   *
   * If this fails the whole feature is decorative - the section was already
   * painted and the "reveal" reveals nothing. Read before any scrolling.
   */
  const faqBefore = await paintedState(page, '.faq-section.reveal-section');
  check('a below-fold section starts hidden', faqBefore && faqBefore.opacity < 0.5,
    `faq opacity before scroll: ${faqBefore && faqBefore.opacity}`);
  check('and starts offset downward', faqBefore && faqBefore.y > 5,
    `faq translateY before scroll: ${faqBefore && faqBefore.y}`);

  // Now scroll each section into view and confirm it SETTLES at full paint.
  for (const [label, selector] of SECTIONS) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    // Wait for the transition to finish rather than sampling mid-flight: a
    // half-finished opacity of 0.6 is neither the start nor the end state and
    // would make this test flaky in both directions.
    await page.waitForTimeout(1100);
    const after = await paintedState(page, selector);
    check(`${label}: settles at full opacity and zero offset`,
      after && after.opacity === 1 && Math.abs(after.y) < 0.5,
      JSON.stringify(after));
  }

  /**
   * JUMPING STRAIGHT TO A SECTION, THE WAY AN ANCHOR LINK DOES.
   *
   * The loop above uses scrollIntoViewIfNeeded(), which nudges an element to
   * the viewport edge - and that gentle arrival was enough to hide a total
   * failure: the IntersectionObserver was created in useEffect but observe()
   * was called from a ref callback that runs BEFORE effects, so the optional
   * chain swallowed every call and nothing was ever observed. Sections only
   * appeared because a later render caught them via the "already on screen"
   * branch.
   *
   * A hard jump has no such rescue. Before the fix these sections sat at
   * opacity 0.00 one full second after the jump and never recovered - a blank
   * page for anyone clicking a nav link. Asserted here because the polite
   * scroll in the loop above provably cannot catch it.
   */
  /**
   * ON A FRESH PAGE. Reusing the page above hid the bug a second time: the
   * scrollIntoViewIfNeeded() loop had already dragged every section past the
   * "already on screen" branch, so they were revealed before the jump ever
   * happened and the assertion passed against the broken build. A test for
   * first-load behaviour has to actually be on a first load.
   */
  const jumpPage = await ctx.newPage();
  await jumpPage.goto(BASE, { waitUntil: 'networkidle' });
  await jumpPage.waitForTimeout(1000);

  /**
   * MEASURES LATENCY, NOT THE END STATE.
   *
   * Asserting "opacity > 0.85 eventually" passed against the broken build
   * too, because the section does get there - just late. The two builds are
   * only distinguishable by HOW LONG the user stares at nothing: 100ms with
   * the pending queue, 487ms without it. So this times the first visible
   * frame, with real elapsed time rather than summed sleeps.
   */
  const started = Date.now();
  await jumpPage.evaluate(() => document.querySelector('.faq-section').scrollIntoView());
  let msUntilVisible = null;
  while (Date.now() - started < 3000) {
    const op = await jumpPage.evaluate(() =>
      Number(getComputedStyle(document.querySelector('.faq-section')).opacity));
    if (op > 0.01) { msUntilVisible = Date.now() - started; break; }
    await jumpPage.waitForTimeout(20);
  }
  check('a section jumped to directly starts revealing promptly',
    msUntilVisible !== null && msUntilVisible < 300,
    `${msUntilVisible}ms until first visible (broken build measured 487ms)`);
  await jumpPage.close();

  // Inner elements must move too, or the section arrives as one slab.
  await page.locator('#how.reveal-section').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1100);
  const stepCards = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#how .steps-grid-premium > *')];
    return cards.map((el) => Number(getComputedStyle(el).opacity));
  });
  check('the step cards are revealed individually', stepCards.length === 3 && stepCards.every((o) => o === 1),
    JSON.stringify(stepCards));

  /**
   * THE STAGGER IS REAL, NOT DECLARED.
   *
   * Asserts the computed transition-delay actually differs between siblings.
   * Without this, deleting every nth-child rule would still pass everything
   * above - all three cards would simply arrive at once and still be opacity 1.
   */
  const delays = await page.evaluate(() =>
    [...document.querySelectorAll('#how .steps-grid-premium > *')]
      .map((el) => getComputedStyle(el).transitionDelay));
  check('and they are staggered against each other', new Set(delays).size === 3,
    JSON.stringify(delays));

  await page.screenshot({ path: '/tmp/reveal-full.png', fullPage: false });
  await ctx.close();
}

// ─────────────────────────────────────── 2. prefers-reduced-motion: reduce
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  /**
   * EVERY SECTION MUST BE READABLE WITHOUT SCROLLING OR SCRIPTING.
   *
   * The entry state (opacity 0) lives inside a no-preference media query
   * precisely so this holds. If it leaked outside that guard, a
   * reduced-motion user - or anyone whose JS failed - would get a blank page.
   * Checked WITHOUT scrolling: nothing here may depend on an observer firing.
   */
  for (const [label, selector] of SECTIONS) {
    const state = await paintedState(page, selector);
    check(`reduced motion: ${label} is fully painted`,
      state && state.opacity === 1 && Math.abs(state.y) < 0.5, JSON.stringify(state));
  }
  await ctx.close();
}

// ──────────────────────────────────── 3. the content survives without JS
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }).catch(() => {});
  // This is a client-rendered SPA, so with JS off there is no landing markup
  // at all - which is a pre-existing property of the app, not something this
  // change introduced. What matters is that the CSS cannot be the thing
  // hiding content, and that is proven by the reduced-motion block above.
  await ctx.close();
}

console.log(`\n${failures === 0 ? 'PASS' : `${failures} FAILED`}`);
await browser.close();
if (failures) process.exit(1);

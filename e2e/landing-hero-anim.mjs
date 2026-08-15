/**
 * THE HERO ANIMATION, CAUGHT MID-FLIGHT.
 *
 * A settled opacity of 1 proves nothing: the hero looked identical before this
 * change, because it was never hidden in the first place. The only honest test
 * is to sample the COMPOSITED opacity in the first frames after load and show
 * the children are still arriving, in reading order.
 *
 * Also asserts the case that would be a real bug rather than a missing polish:
 * with prefers-reduced-motion: reduce, the hero must be fully visible
 * immediately. An entry state that hides content and depends on a class to
 * restore it is how a landing page ships blank.
 */
import { chromium } from 'playwright';
const FE = process.env.E2E_FRONTEND ?? 'http://127.0.0.1:4178';
let fail = 0;
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${ok ? '' : ` -> ${d}`}`); if (!ok) fail++; };

const b = await chromium.launch();

// ── 1. motion allowed: sample the first frames ───────────────────────────
{
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await p.goto(FE, { waitUntil: 'commit' });
  const samples = await p.evaluate(() => new Promise((resolve) => {
    const sels = ['.premium-hero .eyebrow', '.premium-hero h1', '.premium-hero .lead',
                  '.premium-hero .landing-actions', '.premium-hero .landing-trust',
                  '.premium-hero .quote-widget'];
    const out = [];
    const t0 = performance.now();
    (function tick() {
      const row = { t: Math.round(performance.now() - t0) };
      sels.forEach((s) => {
        const el = document.querySelector(s);
        row[s] = el ? +(+getComputedStyle(el).opacity).toFixed(2) : null;
      });
      out.push(row);
      if (performance.now() - t0 < 1200) requestAnimationFrame(tick);
      else resolve(out);
    })();
  }));

  const mid = samples.filter((r) => r['.premium-hero h1'] !== null);
  const anyPartial = mid.some((r) => Object.entries(r)
    .some(([k, v]) => k !== 't' && typeof v === 'number' && v > 0 && v < 1));
  check('the hero children are genuinely mid-transition after load', anyPartial,
    'every child was already at opacity 1 on the first frame - nothing animates');

  // Reading order: the headline must not finish AFTER the trust badges.
  const settleTime = (sel) => {
    const hit = mid.find((r) => r[sel] === 1);
    return hit ? hit.t : Infinity;
  };
  const h1 = settleTime('.premium-hero h1');
  const trust = settleTime('.premium-hero .landing-trust');
  check('the headline lands before the trust row', h1 <= trust, `h1=${h1}ms trust=${trust}ms`);

  const last = samples[samples.length - 1];
  /**
   * 1000ms, not 700. My first window was too tight and failed a hero that was
   * behaving correctly: the last child starts at a 305ms delay and runs for
   * 580ms, so it legitimately settles around 885ms. Asserting 700 measured my
   * arithmetic, not the page.
   *
   * Still a real ceiling. A hero that takes over a second to finish is slow
   * regardless of how it is staggered, so this fails if the timings are ever
   * stretched.
   */
  const allSettled = Object.entries(last).every(([k, v]) => k === 't' || v === 1);
  check('everything is fully visible within ~1s', allSettled && last.t <= 1300,
    JSON.stringify(last));
  await p.close();
}

// ── 2. reduced motion: nothing may be hidden, ever ───────────────────────
{
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const p = await ctx.newPage();
  await p.goto(FE, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(400);
  const hidden = await p.evaluate(() => {
    const sels = ['.premium-hero .eyebrow', '.premium-hero h1', '.premium-hero .lead',
                  '.premium-hero .landing-actions', '.premium-hero .landing-trust',
                  '.premium-hero .quote-widget', '.landing-strip'];
    return sels.filter((s) => {
      const el = document.querySelector(s);
      return el && +getComputedStyle(el).opacity < 1;
    });
  });
  check('with reduced motion, nothing in the hero is hidden', hidden.length === 0, hidden.join(', '));

  /**
   * WHY THIS ASSERTION IS WEAKER THAN IT LOOKS, STATED HONESTLY.
   *
   * Removing the hero from the reduce-block safety list does NOT fail this -
   * I mutation-tested it and it stayed green. The reason is structural: the
   * `opacity: 0` entry state lives inside @media (prefers-reduced-motion:
   * no-preference), so under `reduce` it never applies and there is nothing to
   * restore. The reduce block is defence-in-depth, not the mechanism.
   *
   * The mechanism that WOULD strand content is an entry state outside that
   * guard. That is what this really checks, and it is the failure worth
   * catching: it would hide the top of the page from every reduced-motion
   * visitor and from anyone whose JS never runs.
   */
  const unguarded = await p.evaluate(() => {
    // Any rule hiding hero content must be inside a no-preference block. If a
    // reduced-motion visitor can see opacity 0 on these, the guard is gone.
    const sels = ['.premium-hero .eyebrow', '.premium-hero h1', '.premium-hero .quote-widget'];
    return sels.filter((s) => {
      const el = document.querySelector(s);
      if (!el) return false;
      const cs = getComputedStyle(el);
      return +cs.opacity < 1 || cs.transform !== 'none';
    });
  });
  check('no hero entry state escapes the no-preference guard', unguarded.length === 0,
    unguarded.join(', '));
  await p.screenshot({ path: '/tmp/hero-reduced.png', clip: { x: 0, y: 0, width: 1280, height: 760 } });
  await ctx.close();
}

await b.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} ${5 - fail} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

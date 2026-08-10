// The landing feature grid must be ALIVE: cards reveal as they scroll in,
// respond to the cursor, and go quiet under prefers-reduced-motion.
//
// Every assertion drives a real browser and reads composited state, because
// "the CSS exists" says nothing about whether it runs.
import { chromium } from 'playwright';

const URL = 'http://localhost:5173/';
const b = await chromium.launch();
let fails = 0;
const ck = (n, ok, x = '') => { if (!ok) fails++; console.log((ok ? 'PASS' : 'FAIL').padEnd(5), n.padEnd(52), x); };

const open = async (opts = {}) => {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  return { ctx, p };
};

// ---------------------------------------------------------------- 1. reveal
{
  const { ctx, p } = await open();

  // Before scrolling, the grid is below the fold and must still be hidden.
  const before = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.feature-card-premium')];
    return {
      n: cards.length,
      revealed: cards.filter((c) => c.classList.contains('is-revealed')).length,
      opacity: cards[0] ? getComputedStyle(cards[0]).opacity : null,
    };
  });
  ck('six feature cards render', before.n === 6, 'n=' + before.n);
  ck('cards start hidden before scroll', before.revealed === 0 && Number(before.opacity) < 0.5,
    `revealed=${before.revealed} opacity=${before.opacity}`);

  await p.evaluate(() => document.querySelector('#business')?.scrollIntoView());
  await p.waitForTimeout(1500);

  const after = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.feature-card-premium')];
    return {
      revealed: cards.filter((c) => c.classList.contains('is-revealed')).length,
      opacity: cards.map((c) => Number(getComputedStyle(c).opacity)),
      delays: cards.map((c) => c.style.getPropertyValue('--reveal-delay')),
    };
  });
  ck('all cards reveal on scroll', after.revealed === 6, 'revealed=' + after.revealed);
  ck('all cards fully opaque after reveal', after.opacity.every((o) => o > 0.98),
    'min=' + Math.min(...after.opacity).toFixed(2));
  // A stagger means the delays must differ, not just exist.
  ck('reveal is staggered, not simultaneous', new Set(after.delays).size === 6,
    after.delays.join(' '));

  await ctx.close();
}

// ------------------------------------------------------- 2. cursor response
{
  const { ctx, p } = await open();
  await p.evaluate(() => document.querySelector('#business')?.scrollIntoView());
  await p.waitForTimeout(1400);

  const card = p.locator('.feature-card-premium').first();
  const box = await card.boundingBox();

  const rest = await p.evaluate(() => {
    const c = document.querySelector('.feature-card-premium');
    return {
      transform: getComputedStyle(c).transform,
      glow: getComputedStyle(c.querySelector('.feature-card-glow')).opacity,
    };
  });

  await p.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await p.waitForTimeout(650);

  const hover = await p.evaluate(() => {
    const c = document.querySelector('.feature-card-premium');
    const m = new DOMMatrix(getComputedStyle(c).transform);
    return {
      lift: m.f,
      glow: Number(getComputedStyle(c.querySelector('.feature-card-glow')).opacity),
      mx: c.style.getPropertyValue('--mx'),
      shadow: getComputedStyle(c).boxShadow,
    };
  });

  ck('card lifts on hover', hover.lift < -2, `translateY=${hover.lift.toFixed(1)}px`);
  ck('spotlight fades in on hover', hover.glow > 0.9 && Number(rest.glow) < 0.1,
    `rest=${rest.glow} hover=${hover.glow}`);
  ck('spotlight tracks the pointer', hover.mx !== '', 'mx=' + hover.mx);
  ck('card gains a shadow on hover', hover.shadow !== 'none', hover.shadow.slice(0, 34));

  // Moving to a different x must move the spotlight with it.
  const firstMx = parseFloat(hover.mx);
  await p.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await p.waitForTimeout(300);
  const moved = await p.evaluate(() =>
    parseFloat(document.querySelector('.feature-card-premium').style.getPropertyValue('--mx')));
  ck('spotlight follows a second move', moved > firstMx + 40, `${firstMx} -> ${moved}`);

  // Leaving must clear it, or a touch/keyboard user inherits a stuck highlight.
  await p.mouse.move(10, 10);
  await p.waitForTimeout(500);
  const left = await p.evaluate(() => {
    const c = document.querySelector('.feature-card-premium');
    return { mx: c.style.getPropertyValue('--mx'), glow: Number(getComputedStyle(c.querySelector('.feature-card-glow')).opacity) };
  });
  ck('spotlight clears on pointer leave', left.mx === '' && left.glow < 0.1,
    `mx="${left.mx}" glow=${left.glow}`);

  await ctx.close();
}

// -------------------------------------------------------- 3. reduced motion
{
  const { ctx, p } = await open({ reducedMotion: 'reduce' });
  await p.waitForTimeout(900);

  const rm = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.feature-card-premium')];
    const c = cards[0];
    return {
      revealedWithoutScrolling: cards.every((x) => x.classList.contains('is-revealed')),
      opacity: Number(getComputedStyle(c).opacity),
      transition: getComputedStyle(c).transition,
      glowShown: getComputedStyle(c.querySelector('.feature-card-glow')).display,
    };
  });

  // The key property: content is visible WITHOUT the animation having run.
  ck('reduced motion: content visible immediately', rm.revealedWithoutScrolling && rm.opacity > 0.98,
    'opacity=' + rm.opacity);
  ck('reduced motion: no transition', rm.transition === 'none' || rm.transition.startsWith('all 0s'),
    rm.transition.slice(0, 30));
  ck('reduced motion: spotlight removed', rm.glowShown === 'none', rm.glowShown);

  await ctx.close();
}

console.log('-'.repeat(72));
console.log(fails ? `${fails} FAIL` : 'feature cards are alive and accessible');
await b.close();
process.exit(fails ? 1 : 0);

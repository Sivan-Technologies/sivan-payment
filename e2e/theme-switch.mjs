// Behavioural contract for the theme switch.
import { chromium } from 'playwright';
import { makeStub, STUB_USER } from './stub.mjs';

const b = await chromium.launch();
let fails = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL').padEnd(5), name.padEnd(52), ok ? '' : `got ${got}, want ${want}`);
};

const mk = async (opts = {}) => {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 }, ...opts.ctx });
  await ctx.route('**/api/**', makeStub());
  await ctx.addInitScript(([u, seed]) => {
    localStorage.setItem('sivan.authToken', 'stub');
    localStorage.setItem('sivan.user', JSON.stringify(u));
    if (seed !== null) localStorage.setItem('sivan.theme', seed);
  }, [STUB_USER, opts.seed === undefined ? null : opts.seed]);
  const p = await ctx.newPage();
  await p.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' });
  await p.waitForTimeout(900);
  return { ctx, p };
};
const theme = (p) => p.evaluate(() => document.documentElement.getAttribute('data-theme'));

// 1. No stored preference -> follow the OS.
{
  const { ctx, p } = await mk({ ctx: { colorScheme: 'dark' } });
  check('no preference + OS dark  -> dark', await theme(p), 'dark');
  await ctx.close();
}
{
  const { ctx, p } = await mk({ ctx: { colorScheme: 'light' } });
  check('no preference + OS light -> light', await theme(p), 'light');
  await ctx.close();
}
// 2. A stored preference beats the OS.
{
  const { ctx, p } = await mk({ seed: 'light', ctx: { colorScheme: 'dark' } });
  check('stored light overrides OS dark', await theme(p), 'light');
  await ctx.close();
}
// 3. Toggle flips, persists, and survives a reload.
{
  // NOTE: seeded via a one-shot page script, NOT addInitScript -- the latter
  // re-runs on every navigation and would re-seed 'light' on reload, which
  // looks like the app losing the preference.
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.route('**/api/**', makeStub());
  await ctx.addInitScript((u) => {
    localStorage.setItem('sivan.authToken', 'stub');
    localStorage.setItem('sivan.user', JSON.stringify(u));
  }, STUB_USER);
  const p = await ctx.newPage();
  await p.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.setItem('sivan.theme', 'light'));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  await p.locator('.theme-toggle').click();
  await p.waitForTimeout(400);
  check('click toggles light -> dark', await theme(p), 'dark');
  check('preference persisted', await p.evaluate(() => localStorage.getItem('sivan.theme')), 'dark');
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  check('survives reload', await theme(p), 'dark');
  await ctx.close();
}
// 4. No flash of the wrong theme: the attribute must be set before React runs.
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
  await ctx.route('**/api/**', makeStub());
  await ctx.addInitScript(() => localStorage.setItem('sivan.theme', 'dark'));
  const p = await ctx.newPage();
  // Block the JS bundle: if the attribute still lands, it came from the
  // inline pre-hydration script and not from a React effect.
  await p.route('**/assets/*.js', (r) => r.abort());
  await p.goto('http://localhost:5173/dashboard', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(300);
  check('theme applied with the app bundle blocked', await theme(p), 'dark');
  await ctx.close();
}
// 5. colorScheme is set, so UA widgets and scrollbars follow.
{
  const { ctx, p } = await mk({ seed: 'dark' });
  check('html.style.colorScheme follows theme',
    await p.evaluate(() => document.documentElement.style.colorScheme), 'dark');
  check('theme-color meta follows theme',
    await p.evaluate(() => document.querySelector('meta[name="theme-color"]').getAttribute('content')), '#07090d');
  await ctx.close();
}
// 6. A corrupt stored value must not break rendering.
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 950 }, colorScheme: 'light' });
  await ctx.route('**/api/**', makeStub());
  await ctx.addInitScript(() => localStorage.setItem('sivan.theme', '{{garbage'));
  const p = await ctx.newPage();
  await p.goto('http://localhost:5173/dashboard', { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  check('corrupt preference falls back to system', await theme(p), 'light');
  await ctx.close();
}
console.log('-'.repeat(68));
console.log(fails ? fails + ' FAIL' : 'theme switch behaves correctly');
await b.close();
process.exit(fails ? 1 : 0);

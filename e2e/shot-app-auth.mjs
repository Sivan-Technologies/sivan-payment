import { chromium } from 'playwright';
import { makeStub, STUB_USER } from './stub.mjs';
const TAG = process.argv[2] || 'before';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
await ctx.route('**/api/**', makeStub());
await ctx.addInitScript((u) => {
  localStorage.setItem('sivan.authToken', 'stub');
  localStorage.setItem('sivan.user', JSON.stringify(u));
}, STUB_USER);
const pages = [
  ['/dashboard','dashboard'], ['/withdraw','withdraw'], ['/buy','buy'], ['/receive','receive'],
  ['/transfer','transfer'], ['/withdrawals','history'], ['/bank-accounts','banks'],
  ['/virtual-account','vaccounts'], ['/verification','verification'], ['/settings','settings'], ['/help','help'],
];
for (const [path, name] of pages) {
  const p = await ctx.newPage();
  try {
    await p.goto('http://localhost:5173' + path, { waitUntil:'networkidle', timeout: 20000 });
    await p.waitForTimeout(1400);
    await p.screenshot({ path: `shots/${TAG}-auth-${name}.png`, fullPage: true });
    const t = await p.evaluate(()=>document.body.innerText.slice(0,60).replace(/\n/g,' '));
    console.log(name.padEnd(12), t.includes('went wrong') ? 'CRASHED' : 'ok');
  } catch(e) { console.log(name.padEnd(12), 'ERR', e.message.slice(0,50)); }
  await p.close();
}
await b.close();

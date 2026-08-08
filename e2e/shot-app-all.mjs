import { chromium } from 'playwright';
const TAG = process.argv[2] || 'before';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });

// Stub the API so authenticated views render with data instead of spinners.
await ctx.route('**/api/**', async r => {
  const u = r.request().url();
  const j = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  if (u.includes('/offramp/controls')) return j({ supplierPayoutsEnabled: true, ngnOfframpFeePercent: 1, withdrawalsEnabled: true, buyEnabled: true });
  if (u.includes('/fees')) return j({ percent: 1.25, minimumUsd: 0.5 });
  if (u.includes('/system/status')) return j({ status: 'ok' });
  return j({});
});

const pages = [
  ['/', 'landing'],
  ['/signup', 'signup'],
  ['/help', 'help'],
  ['/dashboard', 'dashboard'],
  ['/withdraw', 'withdraw'],
  ['/buy', 'buy'],
  ['/receive', 'receive'],
  ['/transfer', 'transfer'],
  ['/withdrawals', 'history'],
  ['/bank-accounts', 'banks'],
  ['/verification', 'verification'],
  ['/settings', 'settings'],
];
for (const [path, name] of pages) {
  const p = await ctx.newPage();
  try {
    await p.goto('http://localhost:5173' + path, { waitUntil: 'networkidle', timeout: 20000 });
    await p.waitForTimeout(1200);
    await p.screenshot({ path: `shots/${TAG}-${name}.png`, fullPage: true });
    console.log(name.padEnd(14), 'ok');
  } catch (e) { console.log(name.padEnd(14), 'ERR', e.message.slice(0, 60)); }
  await p.close();
}
await b.close();

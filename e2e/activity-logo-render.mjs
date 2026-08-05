/**
 * RENDER THE ROWS AND LOOK AT THEM.
 *
 * Source assertions cannot tell me whether a 13px mark sits on the text
 * baseline, gets squashed by an ellipsis, or wraps away from its label. Those
 * are the failures that only appear in pixels - the same class as the "2h Ago"
 * capitalisation and the Ethereum logo hidden behind Base, both of which passed
 * every unit test.
 *
 * Builds the real markup and the real stylesheet, renders at phone and desktop
 * widths, and measures geometry rather than trusting the screenshot alone.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'frontend/src/styles.css'), 'utf8');
const logoSrc = fs.readFileSync(path.join(root, 'frontend/src/components/receive/NetworkLogo.tsx'), 'utf8');

/** Pull a chain's SVG body straight out of the component, so this renders the
 *  real geometry rather than a copy that can drift. */
function svgFor(chain) {
  const marks = {
    solana: logoSrc.slice(logoSrc.indexOf("if (chain === 'solana')"), logoSrc.indexOf("if (chain === 'base')")),
    base: logoSrc.slice(logoSrc.indexOf("if (chain === 'base')"), logoSrc.indexOf('// Ethereum:')),
    ethereum: logoSrc.slice(logoSrc.indexOf('// Ethereum:'), logoSrc.indexOf('/**\n * The mark for a FAMILY row')),
  };
  const block = marks[chain];
  // polygon, arbitrum, tron: no mark exists, and that is the behaviour under
  // test. Return empty so the row renders the NAME alone.
  if (!block) return '';
  const inner = block.slice(block.indexOf('<svg'), block.lastIndexOf('</svg>') + 6);
  return inner
    .replace('<svg {...common}>', '<svg width="13" height="13" viewBox="0 0 32 32" aria-hidden="true" focusable="false">')
    .replace(/stopColor=/g, 'stop-color=')
    .replace(/fillOpacity=/g, 'fill-opacity=')
    .replace(/linearGradient id="sivan-sol"/, `linearGradient id="sivan-sol-${chain}"`)
    .replace(/url\(#sivan-sol\)/, `url(#sivan-sol-${chain})`)
    .replace(/\{'\s*'\}/g, '');
}

const ROWS = [
  { label: 'Deposit received', dir: 'in', sign: '+', amount: '50.000000', ccy: 'USDC', net: 'base', status: 'Pending', state: 'pending' },
  { label: 'Send crypto', dir: 'internal', sign: '', amount: '10', ccy: 'USDC', net: 'solana', status: 'Completed', state: 'success' },
  { label: 'Buy crypto', dir: 'in', sign: '+', amount: '20', ccy: 'USD', net: 'base', status: 'Completed', state: 'success' },
  { label: 'Sell crypto to naira', dir: 'out', sign: '−', amount: '150000', ccy: 'NGN', net: 'solana', status: 'Paying out', state: 'pending' },
  // Deliberately unsupported: must render the NAME with no mark.
  { label: 'Buy crypto', dir: 'in', sign: '+', amount: '5', ccy: 'USD', net: 'polygon', status: 'Completed', state: 'success' },
  // No chain at all - a bank rail. Must show no logo and no ragged gap.
  { label: 'Withdraw to bank', dir: 'out', sign: '−', amount: '400', ccy: 'GBP', net: null, status: 'Completed', state: 'success' },
  { label: 'Pay Acme Supplies', dir: 'out', sign: '−', amount: '1200', ccy: 'USD', net: null, status: 'Under review', state: 'pending' },
  // Long label on a narrow screen - does the mark survive the ellipsis?
  { label: 'Deposit received from a very long exchange name', dir: 'in', sign: '+', amount: '2500.500000', ccy: 'USDT', net: 'ethereum', status: 'Confirmed', state: 'success' },
];

const ARROW = { in: '↓', out: '↑', internal: '⇄' };

const rowHtml = (r) => `
<div class="activity-row">
  <span class="activity-icon ${r.dir}" aria-hidden="true">${ARROW[r.dir]}</span>
  <span class="activity-main">
    <strong>${r.label}</strong>
    <small>${r.net ? `<span class="activity-network-tag">${svgFor(r.net) || ''}<span class="activity-network">${r.net.replaceAll('_', ' ')}</span></span> · ` : ''}2h ago</small>
  </span>
  <span class="activity-figures">
    <b class="activity-amount ${r.dir}">${r.sign}${r.amount} ${r.ccy}</b>
    <span class="activity-status ${r.state}">${r.status}</span>
  </span>
</div>`;

// polygon has no mark; svgFor would throw, so blank it deliberately.
const safeRowHtml = (r) => {
  try { return rowHtml(r); }
  catch {
    return rowHtml({ ...r, net: r.net }).replace(/<svg[\s\S]*?<\/svg>/, '');
  }
};

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
body{background:#0d141b;padding:16px;margin:0}
.activity-list{display:grid;gap:8px}
</style></head><body><div class="activity-list">
${ROWS.map(rowHtml).join("")}
</div></body></html>`;

fs.writeFileSync("/tmp/rows.html", html);
const browser = await chromium.launch();
const outDir = path.join(root, 'e2e', 'shots');
fs.mkdirSync(outDir, { recursive: true });

let problems = 0;
const note = (ok, msg) => { if (!ok) { problems += 1; console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

for (const [name, width] of [['phone', 390], ['desktop', 1280]]) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
  await page.setContent(html);
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(outDir, `activity-logo-${name}.png`), fullPage: true });

  const measured = await page.evaluate(() => {
    return [...document.querySelectorAll('.activity-row')].map((row) => {
      const tag = row.querySelector('.activity-network-tag');
      const svg = row.querySelector('.activity-network-tag svg');
      const nameEl = row.querySelector('.activity-network');
      const small = row.querySelector('.activity-main small');
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      return {
        label: row.querySelector('strong').textContent,
        hasTag: Boolean(tag),
        hasSvg: Boolean(svg),
        svg: r(svg), name: r(nameEl), small: r(small), tag: r(tag),
        smallText: small.textContent.trim(),
      };
    });
  });

  console.log(`\n── ${name} (${width}px) ──`);
  for (const m of measured) {
    if (!m.hasTag) {
      note(!m.smallText.includes('·') || m.smallText.split('·').length === 2,
        `"${m.label}": no chain, renders "${m.smallText}"`);
      continue;
    }
    if (!m.hasSvg) {
      note(m.name && m.name.width > 0, `"${m.label}": name shown without a mark (${m.smallText})`);
      continue;
    }
    // The mark must be square-ish and not squashed by the ellipsis.
    note(m.svg.width >= 12 && m.svg.width <= 14,
      `"${m.label}": mark is ${m.svg.width.toFixed(1)}px wide (want ~13)`);
    // Optically centred: mark's centre within 2px of the name's centre.
    const svgMid = m.svg.top + m.svg.height / 2;
    const nameMid = m.name.top + m.name.height / 2;
    note(Math.abs(svgMid - nameMid) <= 2,
      `"${m.label}": mark centre off by ${(svgMid - nameMid).toFixed(2)}px vs name`);
    // Mark and name on the SAME line - no wrap between them.
    note(Math.abs(m.svg.top - m.name.top) < m.name.height,
      `"${m.label}": mark and name share a line`);
    // The mark precedes the name.
    note(m.svg.right <= m.name.left + 1, `"${m.label}": mark sits before the name`);
    // Nothing overflows the subtitle box.
    note(m.tag.right <= m.small.right + 1,
      `"${m.label}": tag stays inside the subtitle (${m.tag.right.toFixed(0)} vs ${m.small.right.toFixed(0)})`);
  }
  await page.close();
}

await browser.close();
console.log(problems === 0 ? '\n✅ geometry clean\n' : `\n❌ ${problems} geometry problems\n`);
process.exit(problems === 0 ? 0 : 1);

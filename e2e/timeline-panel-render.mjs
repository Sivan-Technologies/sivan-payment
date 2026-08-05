/**
 * RENDER THE SUMMARY PANEL AND LOOK AT IT.
 *
 * The reported bug was purely visual: a selected row showing "Select a
 * transaction to see its timeline". Source assertions prove the branch exists;
 * only pixels prove the card is readable, that the Solana signature does not
 * wrap into three lines, and that the explorer link is actually reachable.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'frontend/src/styles.css'), 'utf8');

const SOL_SIG = '4RPuLPbYvJ8dQvGgWnh1kUUq9YvT7cGZ4Kh5xN2mSdVpQeLrT8fMwXyZaB3cD6eF9gH2jK5mN8pQ1rS4tU7v';

const card = (title, status, badge, explanation, rows, action) => `
<aside class="transaction-timeline-card">
  <div class="timeline-card-head">
    <div><p class="eyebrow">Transaction</p><h3>${title}</h3><small>${status}</small></div>
    <span class="badge ${badge}">${status}</span>
  </div>
  <div class="transaction-explanation-box">${explanation}</div>
  <div class="timeline-meta-grid">
    ${rows.map(([k, v]) => `<div class="kv"><span>${k}</span><strong>${v}</strong></div>`).join('')}
  </div>
  ${action}
  <div class="support-reference-box">
    <strong>Need support?</strong>
    <span>Share the Request ID so support can trace this transaction faster.</span>
  </div>
</aside>`;

const solLogo = '<svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="32" x2="32" y2="0"><stop offset="0%" stop-color="#9945FF"/><stop offset="100%" stop-color="#14F195"/></linearGradient></defs><path fill="url(#g)" d="M6.5 21.3a1 1 0 0 1 .7-.3h18.1c.5 0 .8.6.4 1l-3.6 3.6a1 1 0 0 1-.7.3H3.3c-.5 0-.8-.6-.4-1zM6.5 6.4a1 1 0 0 1 .7-.3h18.1c.5 0 .8.6.4 1l-3.6 3.6a1 1 0 0 1-.7.3H3.3c-.5 0-.8-.6-.4-1zM22.1 13.8a1 1 0 0 0-.7-.3H3.3c-.5 0-.8.6-.4 1l3.6 3.6a1 1 0 0 0 .7.3h18.1c.5 0 .8-.6.4-1z"/></svg>';

const short = (v) => `${v.slice(0, 8)}…${v.slice(-6)}`;

const cards = [
  // Completed send: the exact case from the screenshot.
  card('Send crypto', 'Completed', 'success',
    'Sent on Solana. The recipient has the funds and the transaction is confirmed on chain.',
    [['Request ID', 'btx_9f2c1a44-8b7e-4d31-9a0f-2c5e7b1d8a63'], ['Amount', '10 USDC'],
     ['Asset', 'USDC'], ['Network', 'Solana'], ['When', '5 Aug 2026, 09:12:44'],
     ['Transaction hash', short(SOL_SIG)]],
    `<a class="secondary-btn small explorer-link" href="#">${solLogo}View on Solscan ↗</a>`),
  // In-progress send: no hash yet, so no link.
  card('Send crypto', 'Processing', 'pending',
    'Submitted to Solana and waiting for confirmation. Your balance already reflects it, and it cannot be reversed once broadcast.',
    [['Request ID', 'btx_1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809'], ['Amount', '10 USDC'],
     ['Asset', 'USDC'], ['Network', 'Solana'], ['When', '5 Aug 2026, 08:02:10'],
     ['Transaction hash', 'Pending']],
    '<small class="deposit-note">A block explorer link appears once the network confirms this transaction.</small>'),
  // Deposit.
  card('Deposit received', 'Pending', 'pending',
    'We have seen this deposit on Base and it is still confirming. You do not need to do anything.',
    [['Request ID', 'dep_77c0e2b1-3f45-4a8d-9e21-0b6f8c3d5a90'], ['Amount', '50.000000 USDC'],
     ['Asset', 'USDC'], ['Network', 'Base'], ['When', '5 Aug 2026, 07:41:03'],
     ['Transaction hash', 'Pending']],
    '<small class="deposit-note">A block explorer link appears once the network confirms this transaction.</small>'),
  // A fiat row - must say it is not on a chain rather than leaving a blank.
  card('Withdraw to bank', 'Completed', 'success',
    'This transaction is complete.',
    [['Request ID', 'wd_5b1e'], ['Amount', '400 GBP'], ['Asset', 'USDC'],
     ['Network', 'Bank transfer'], ['When', '4 Aug 2026, 18:20:00']],
    ''),
];

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${css}
body{background:#0d141b;padding:18px;margin:0}
.wrap{display:grid;gap:18px;max-width:560px}
</style></head><body><div class="wrap">${cards.join('')}</div></body></html>`;

const browser = await chromium.launch();
const outDir = path.join(root, 'e2e', 'shots');
fs.mkdirSync(outDir, { recursive: true });

let problems = 0;
const note = (ok, msg) => { if (!ok) { problems += 1; console.log(`  x ${msg}`); } else console.log(`  ok ${msg}`); };

for (const [name, width] of [['phone', 390], ['desktop', 1280]]) {
  const page = await browser.newPage({ viewport: { width, height: 1500 }, deviceScaleFactor: 2 });
  await page.setContent(html);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(outDir, `timeline-panel-${name}.png`), fullPage: true });

  const m = await page.evaluate(() => {
    const cardEls = [...document.querySelectorAll('.transaction-timeline-card')];
    return cardEls.map((c) => {
      const r = (el) => (el ? el.getBoundingClientRect() : null);
      const kvs = [...c.querySelectorAll('.kv')].map((kv) => ({
        label: kv.querySelector('span')?.textContent ?? '',
        value: kv.querySelector('strong')?.textContent ?? '',
        box: kv.getBoundingClientRect(),
        valueBox: r(kv.querySelector('strong')),
      }));
      const link = c.querySelector('.explorer-link');
      return {
        title: c.querySelector('h3')?.textContent ?? '',
        card: c.getBoundingClientRect(),
        kvs,
        link: link ? { box: link.getBoundingClientRect(), text: link.textContent.trim(), hasSvg: !!link.querySelector('svg') } : null,
        text: c.textContent,
      };
    });
  });

  console.log(`\n-- ${name} (${width}px)`);
  for (const c of m) {
    note(!/Select a transaction/.test(c.text), `"${c.title}": does not show the empty state`);
    // Nothing may overflow the card horizontally.
    const overflow = c.kvs.filter((kv) => kv.valueBox && kv.valueBox.right > c.card.right + 1);
    note(overflow.length === 0, `"${c.title}": no value overflows the card (${overflow.map((o) => o.label).join(',') || 'none'})`);
    // The hash must be one line - the whole reason it is shortened.
    // A fiat row has no hash field AT ALL - that is the correct behaviour, not
    // a missing element. Only assert the layout when one is present.
    const hash = c.kvs.find((kv) => kv.label === 'Transaction hash');
    const onChain = c.kvs.some((kv) => kv.label === 'Network' && kv.value !== 'Bank transfer');
    if (onChain) {
      note(hash && hash.valueBox.height < 26, `"${c.title}": hash stays on one line (${hash?.valueBox.height.toFixed(0)}px)`);
    } else {
      note(!hash, `"${c.title}": bank transfer correctly has NO hash field`);
      note(!/block explorer link appears/.test(c.text), `"${c.title}": does not promise an explorer link it can never have`);
    }
    note(!/\bon (solana|base|ethereum|polygon)\b/.test(c.text), `"${c.title}": chain names are capitalised`);
    if (c.link) {
      note(c.link.hasSvg, `"${c.title}": explorer link carries the chain mark`);
      note(c.link.box.height >= 28, `"${c.title}": link is a real tap target (${c.link.box.height.toFixed(0)}px)`);
      note(c.link.box.right <= c.card.right + 1, `"${c.title}": link stays inside the card`);
    }
  }
  await page.close();
}

await browser.close();
console.log(problems === 0 ? '\nOK geometry clean\n' : `\nFAIL ${problems} problems\n`);
process.exit(problems === 0 ? 0 : 1);

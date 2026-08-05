/** Drive the SHIPPED bundle's ambiguity classifier with real error strings. */
import { chromium } from 'playwright';
import fs from 'node:fs';
let p=0,f=0; const ck=(n,ok,d='')=>{ok?(p++,console.log('  ok   '+n)):(f++,console.log('  FAIL '+n+(d?' -> '+d:'')));};
const b=await chromium.launch(); const page=await (await b.newContext()).newPage();
await page.goto('http://127.0.0.1:4173/',{waitUntil:'domcontentloaded'});

// The exact regex the shipped App.tsx uses, extracted from the built bundle so
// this tests what users actually run, not a copy of the source.
const js = fs.readFileSync(new URL('../frontend/dist/assets/' + fs.readdirSync('../frontend/dist/assets').find(f=>f.endsWith('.js')), import.meta.url), 'utf8');
const m = /UPSTREAM_UNAVAILABLE\|[^/]+/.exec(js);
ck('the ambiguity regex is present in the SHIPPED bundle', Boolean(m), 'the fix did not make it into the build');
const src = m ? m[0] : '';
console.log('   pattern:', src.slice(0,110));

const cases = [
  ['the real 503 body from the worker', 'UPSTREAM_UNAVAILABLE', true],
  ['the worker\'s NOT retried wording', 'This was a POST request and it was NOT retried', true],
  ['the worker\'s did-not-respond wording', 'The payments service did not respond.', true],
  ['a browser transport failure', 'Failed to fetch', true],
  ['a firefox transport failure', 'NetworkError when attempting to fetch resource.', true],
  ['a genuine validation error', 'Minimum transfer amount is 10 USDC.', false],
  ['a genuine insufficient balance', 'Insufficient USDC balance. You can send up to 5.', false],
  ['a genuine bad address', 'That destination address is not valid.', false],
];
for (const [label, msg, expected] of cases) {
  const got = await page.evaluate(([s,t]) => new RegExp(s,'i').test(t), [src, msg]);
  ck(`${label} -> ${expected?'ambiguous':'shown as-is'}`, got === expected, `got ${got}`);
}
await b.close();
console.log(`\n${f===0?'✅':'❌'} ${p} passed, ${f} failed\n`);
process.exit(f===0?0:1);

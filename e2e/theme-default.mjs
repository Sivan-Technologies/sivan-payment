// The landing page and dashboard must be LIGHT by default, even when the
// operating system is set to dark. Dark is opt-in only.
import { chromium } from 'playwright';
import { makeStub, STUB_USER } from './stub.mjs';
const b = await chromium.launch();
let f=0; const ck=(n,ok,x='')=>{if(!ok)f++;console.log((ok?'PASS':'FAIL').padEnd(5),n.padEnd(52),x);};

const theme = p => p.evaluate(()=>document.documentElement.getAttribute('data-theme'));

// 1. OS dark, no stored preference -> still LIGHT
for (const [path,label] of [['/','landing'],['/dashboard','dashboard']]) {
  const ctx=await b.newContext({viewport:{width:1440,height:900},colorScheme:'dark'});
  await ctx.route('**/api/**', makeStub());
  if(path==='/dashboard') await ctx.addInitScript((u)=>{localStorage.setItem('sivan.authToken','stub');
    localStorage.setItem('sivan.user',JSON.stringify(u));},STUB_USER);
  const p=await ctx.newPage();
  await p.goto('http://localhost:5173'+path,{waitUntil:'networkidle'}); await p.waitForTimeout(1100);
  ck(`${label}: OS dark + no preference -> light`, await theme(p)==='light', await theme(p));
  await ctx.close();
}
// 2. Pre-paint (bundle blocked) must also be light
{
  const ctx=await b.newContext({viewport:{width:1440,height:900},colorScheme:'dark'});
  await ctx.route('**/api/**', makeStub());
  const p=await ctx.newPage();
  await p.route('**/assets/*.js', r=>r.abort());
  await p.goto('http://localhost:5173/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(300);
  ck('pre-hydration default is light (no dark flash)', await theme(p)==='light', await theme(p));
  await ctx.close();
}
// 3. Dark still reachable and remembered
{
  const ctx=await b.newContext({viewport:{width:1440,height:900}});
  await ctx.route('**/api/**', makeStub());
  await ctx.addInitScript((u)=>{localStorage.setItem('sivan.authToken','stub');
    localStorage.setItem('sivan.user',JSON.stringify(u));},STUB_USER);
  const p=await ctx.newPage();
  await p.goto('http://localhost:5173/dashboard',{waitUntil:'networkidle'}); await p.waitForTimeout(1000);
  await p.locator('.theme-toggle').click(); await p.waitForTimeout(400);
  ck('toggle still switches to dark', await theme(p)==='dark', await theme(p));
  await p.reload({waitUntil:'networkidle'}); await p.waitForTimeout(800);
  ck('dark choice survives reload', await theme(p)==='dark', await theme(p));
  await ctx.close();
}
// 4. Explicit "system" still follows the OS
{
  const ctx=await b.newContext({viewport:{width:1440,height:900},colorScheme:'dark'});
  await ctx.route('**/api/**', makeStub());
  await ctx.addInitScript(()=>localStorage.setItem('sivan.theme','system'));
  const p=await ctx.newPage();
  await p.goto('http://localhost:5173/',{waitUntil:'networkidle'}); await p.waitForTimeout(900);
  ck('explicit "system" still honours OS dark', await theme(p)==='dark', await theme(p));
  await ctx.close();
}
console.log('-'.repeat(72));
console.log(f? f+' FAIL':'light is the default; dark is opt-in');
await b.close(); process.exit(f?1:0);

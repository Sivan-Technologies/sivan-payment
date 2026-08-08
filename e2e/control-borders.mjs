// WCAG 1.4.11: the boundary of an interactive control needs 3:1 against what
// is behind it. surfaces.mjs only asks "is it perceivable at all" (>=1.25), so
// this asserts the stricter bar on the tokens/rules that draw control chrome.
import { chromium } from 'playwright';
import { makeStub, STUB_USER } from './stub.mjs';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{width:1440,height:950} });
await ctx.route('**/api/**', makeStub());
await ctx.addInitScript((u)=>{localStorage.setItem('sivan.authToken','stub');
  localStorage.setItem('sivan.user',JSON.stringify(u));},STUB_USER);
const p = await ctx.newPage();
await p.goto('http://localhost:5173/settings',{waitUntil:'networkidle'});
await p.waitForTimeout(1200);
const rows = await p.evaluate(() => {
  const lum=([r,g,b])=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
    return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);};
  // The production build minifies rgba() to 8-digit hex (#18345e8c), so a
  // number-scraping parser returns NaN. Handle both forms.
  const parse=v=>{
    v=String(v).trim();
    const h=v.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if(h){ const n=h[1]; const o=[0,2,4].map(i=>parseInt(n.slice(i,i+2),16));
      if(h[2]) o.push(parseInt(h[2],16)/255); return o; }
    const s3=v.match(/^#([0-9a-f]{3})$/i);
    if(s3) return [...s3[1]].map(c=>parseInt(c+c,16));
    return (v.match(/[\d.]+/g)||[]).map(Number);
  };
  const over=(fg,bg)=>{const a=fg[3]===undefined?1:fg[3];return [0,1,2].map(i=>fg[i]*a+bg[i]*(1-a));};
  const ratio=(a,b)=>{const[x,y]=[lum(a),lum(b)].sort((m,n)=>n-m);return (x+0.05)/(y+0.05);};
  const cs=getComputedStyle(document.documentElement);
  const W=[255,255,255];
  const tok=n=>parse(cs.getPropertyValue(n).trim());
  const out=[];
  for (const name of ['--border-control']) {
    const c=tok(name);
    out.push({ name, ratio:+ratio(over(c,W),W).toFixed(2), pass: ratio(over(c,W),W) >= 3 });
  }
  return out;
});
let bad=0;
for(const r of rows){ if(!r.pass) bad++;
  console.log((r.pass?'PASS':'FAIL').padEnd(5), String(r.ratio).padStart(6), ' ', r.name, '(needs >=3 on white)'); }
console.log(bad?bad+' FAIL':'control border tokens meet 1.4.11');
await b.close();
process.exit(bad?1:0);

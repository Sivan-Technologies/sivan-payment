import { chromium } from 'playwright';
import { makeStub, STUB_USER } from './stub.mjs';

const PAGES = [
  ['/dashboard','dashboard'], ['/withdraw','withdraw'], ['/buy','buy'], ['/receive','receive'],
  ['/transfer','transfer'], ['/withdrawals','history'], ['/bank-accounts','banks'],
  ['/virtual-account','vaccounts'], ['/verification','verification'], ['/settings','settings'],
  ['/help','help'],
];
const PUBLIC = [['/','landing'], ['/signup','signup']];

const MEASURE = () => {
  const lum = ([r,g,b]) => { const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
    return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
  const parse = s => (s.match(/[\d.]+/g)||[]).map(Number);
  const over = (fg,bg) => { const a=fg[3]===undefined?1:fg[3]; return [0,1,2].map(i=>fg[i]*a+bg[i]*(1-a)); };
  const stops = cs => { const im=cs.backgroundImage;
    if(!im||im==='none'||!im.includes('gradient')) return [];
    return (im.match(/rgba?\([^)]*\)/g)||[]).map(parse).filter(c=>c.length>=3&&(c[3]===undefined||c[3]>0.5)); };
  const bgOf = el => { const st=[]; let cur=el;
    while(cur){ const cs=getComputedStyle(cur);
      const s=stops(cs); if(s.length) st.push(...s);
      const c=parse(cs.backgroundColor); if(c.length&&(c[3]===undefined||c[3]>0)) st.push(c);
      cur=cur.parentElement; }
    let acc=[255,255,255]; for(let i=st.length-1;i>=0;i--) acc=over(st[i],acc); return acc; };
  const ratio=(a,b)=>{const[x,y]=[lum(a),lum(b)].sort((m,n)=>n-m);return (x+0.05)/(y+0.05);};

  const out=[];
  for (const el of document.querySelectorAll('*')) {
    const direct=[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim().length>1);
    if(!direct) continue;
    const cs=getComputedStyle(el);
    if(cs.visibility==='hidden'||cs.display==='none'||cs.opacity==='0') continue;
    const r0=el.getBoundingClientRect(); if(r0.width<2||r0.height<2) continue;
    const fg=over(parse(cs.color), bgOf(el.parentElement||el));
    const fs=parseFloat(cs.fontSize), wt=parseInt(cs.fontWeight,10)||400;
    const large= fs>=24 || (fs>=18.66&&wt>=700);
    // Worst-case over gradient stops -- but ONLY up to the first ancestor that
    // paints an opaque background of its own. Walking past it made a badge with
    // a solid fill inherit a distant hero gradient and report 1.0:1.
    let cur=el, gs=[];
    while(cur){
      const cs2=getComputedStyle(cur);
      gs=stops(cs2);
      if(gs.length) break;
      const own=parse(cs2.backgroundColor);
      if(own.length>=3 && (own[3]===undefined||own[3]>=0.99)) break; // opaque: stop here
      cur=cur.parentElement;
    }
    const bgs = gs.length ? gs.map(s=>over(s,bgOf(cur&&cur.parentElement||document.body)))
                          : [bgOf(el)];
    const r = Math.min(...bgs.map(b=>ratio(fg,b)));
    out.push({ text:(el.textContent||'').trim().slice(0,30), ratio:+r.toFixed(2),
      px:fs, wt, pass: r >= (large?3:4.5), large,
      cls: String(el.className||'').slice(0,34) });
  }
  return out;
};

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 950 } });
await ctx.route('**/api/**', makeStub());
await ctx.addInitScript((u)=>{localStorage.setItem('sivan.authToken','stub');
  localStorage.setItem('sivan.user',JSON.stringify(u));},STUB_USER);

let total=0, fails=[];
const run = async (list, ctxUse) => {
  for (const [path,name] of list) {
    const p = await ctxUse.newPage();
    try {
      await p.goto('http://localhost:5173'+path,{waitUntil:'networkidle',timeout:20000});
      await p.waitForTimeout(1200);
      const rows = await p.evaluate(MEASURE);
      total += rows.length;
      const bad = rows.filter(r=>!r.pass);
      // de-dup identical failures
      const seen=new Set();
      for (const r of bad) { const k=r.cls+'|'+r.ratio; if(seen.has(k))continue; seen.add(k);
        fails.push({ page:name, ...r }); }
      console.log(name.padEnd(13), String(rows.length).padStart(4)+' nodes', bad.length?(' '+bad.length+' FAIL'):' ok');
    } catch(e){ console.log(name.padEnd(13),'ERR',e.message.slice(0,50)); }
    await p.close();
  }
};
await run(PAGES, ctx);
const pub = await b.newContext({ viewport:{width:1440,height:950} });
await pub.route('**/api/**', makeStub());
await run(PUBLIC, pub);

console.log('\n'+'='.repeat(74));
console.log('total text nodes measured:', total, '| unique failures:', fails.length);
if (fails.length) {
  console.log('\n'+'page'.padEnd(13)+'ratio'.padStart(6)+'  px  wt  class / text');
  for (const f of fails.slice(0,50))
    console.log(f.page.padEnd(13)+String(f.ratio).padStart(6)+'  '+String(f.px).padStart(4)+
      ' '+String(f.wt).padStart(3)+'  '+(f.cls||'-')+' :: '+f.text);
}
await b.close();
process.exit(fails.length?1:0);

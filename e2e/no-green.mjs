// No teal/green accent may survive in EITHER theme. Reads composited pixels
// from the live page, not the stylesheet -- a literal can hide behind a var().
import { chromium } from 'playwright';
import { makeStub, STUB_USER } from './stub.mjs';
const b=await chromium.launch();
let f=0; const ck=(n,ok,x='')=>{if(!ok)f++;console.log((ok?'PASS':'FAIL').padEnd(5),n.padEnd(50),x);};

// Hue 130-190 = green/teal. Allow the SUCCESS token only (money semantics).
const SUCCESS = new Set(['35,205,169','22,133,109','15,107,87']);

for (const t of ['light','dark']) {
  for (const [path,label] of [['/','landing'],['/dashboard','dashboard'],['/withdraw','withdraw']]) {
    const ctx=await b.newContext({viewport:{width:1440,height:950}});
    await ctx.route('**/api/**', makeStub());
    await ctx.addInitScript(([u,th])=>{localStorage.setItem('sivan.authToken','stub');
      localStorage.setItem('sivan.user',JSON.stringify(u));localStorage.setItem('sivan.theme',th);},[STUB_USER,t]);
    const p=await ctx.newPage();
    await p.goto('http://localhost:5173'+path,{waitUntil:'networkidle'}); await p.waitForTimeout(1200);
    const hits = await p.evaluate((allow)=>{
      const parse=s=>(s.match(/[\d.]+/g)||[]).map(Number);
      const hue=(r,g,bb)=>{const mx=Math.max(r,g,bb),mn=Math.min(r,g,bb),d=mx-mn;
        if(d<28) return -1;               // grey-ish, no meaningful hue
        let h; if(mx===r)h=((g-bb)/d)%6; else if(mx===g)h=(bb-r)/d+2; else h=(r-g)/d+4;
        h*=60; if(h<0)h+=360; return h;};
      const out=[];
      for (const el of document.querySelectorAll('*')) {
        const cs=getComputedStyle(el);
        for (const prop of ['color','backgroundColor','borderTopColor','borderLeftColor','outlineColor']) {
          const c=parse(cs[prop]); if(c.length<3) continue;
          if(c[3]!==undefined && c[3]<0.25) continue;
          const key=c.slice(0,3).join(',');
          if(allow.includes(key)) continue;
          const h=hue(c[0],c[1],c[2]);
          if(h>=130 && h<=190) out.push(((el.className||el.tagName)+'').slice(0,26)+' '+prop+' rgb('+key+')');
        }
        // gradients too
        const bi=cs.backgroundImage;
        if(bi && bi.includes('gradient')) {
          for (const m of bi.match(/rgba?\([^)]*\)/g)||[]) {
            const c=parse(m); if(c.length<3) continue;
            if(c[3]!==undefined && c[3]<0.25) continue;
            const key=c.slice(0,3).join(',');
            if(allow.includes(key)) continue;
            const h=hue(c[0],c[1],c[2]);
            if(h>=130 && h<=190) out.push(((el.className||el.tagName)+'').slice(0,26)+' gradient rgb('+key+')');
          }
        }
      }
      return [...new Set(out)];
    }, [...SUCCESS]);
    ck(`${t}/${label}: no teal-green accent`, hits.length===0, hits.slice(0,3).join(' | '));
    await ctx.close();
  }
}
console.log('-'.repeat(72));
console.log(f? f+' FAIL':'palette is blue; teal reserved for success only');
await b.close(); process.exit(f?1:0);

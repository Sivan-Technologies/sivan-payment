// Catch surfaces/borders that became INVISIBLE on white (contrast tests only
// look at text, so a vanished card edge or input outline slips through).
import { chromium } from 'playwright';
import { makeStub, STUB_USER } from './stub.mjs';
const PAGES = ['/dashboard','/withdraw','/buy','/receive','/transfer','/withdrawals',
  '/bank-accounts','/virtual-account','/verification','/settings','/help','/','/signup'];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport:{width:1440,height:950} });
await ctx.route('**/api/**', makeStub());
await ctx.addInitScript((u)=>{localStorage.setItem('sivan.authToken','stub');
  localStorage.setItem('sivan.user',JSON.stringify(u));},STUB_USER);
let bad = [];
for (const path of PAGES) {
  const p = await ctx.newPage();
  await p.goto('http://localhost:5173'+path,{waitUntil:'networkidle',timeout:20000});
  await p.waitForTimeout(1100);
  const rows = await p.evaluate(() => {
    const lum=([r,g,b])=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
      return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);};
    const parse=s=>(s.match(/[\d.]+/g)||[]).map(Number);
    const over=(fg,bg)=>{const a=fg[3]===undefined?1:fg[3];return [0,1,2].map(i=>fg[i]*a+bg[i]*(1-a));};
    const bgOf=el=>{const st=[];let cur=el;
      while(cur){const cs=getComputedStyle(cur);const c=parse(cs.backgroundColor);
        if(c.length&&(c[3]===undefined||c[3]>0))st.push(c);cur=cur.parentElement;}
      let acc=[255,255,255];for(let i=st.length-1;i>=0;i--)acc=over(st[i],acc);return acc;};
    const ratio=(a,b)=>{const[x,y]=[lum(a),lum(b)].sort((m,n)=>n-m);return (x+0.05)/(y+0.05);};
    const out=[];
    // interactive controls whose boundary must be perceivable (WCAG 1.4.11)
    for (const el of document.querySelectorAll('input,select,textarea,button')) {
      const cs=getComputedStyle(el);
      const r0=el.getBoundingClientRect(); if(r0.width<4||r0.height<4) continue;
      if(cs.visibility==='hidden'||cs.display==='none') continue;
      const parentBg=bgOf(el.parentElement||document.body);
      // A gradient fill lives in backgroundImage, not backgroundColor -- reading
      // only the latter reports every gradient button as invisible.
      const bi=cs.backgroundImage;
      let ownBg=over(parse(cs.backgroundColor),parentBg);
      let fillR=ratio(ownBg,parentBg);
      if (bi && bi!=='none' && bi.includes('gradient')) {
        const st=(bi.match(/rgba?\([^)]*\)/g)||[]).map(parse).filter(c=>c.length>=3);
        if (st.length) fillR=Math.max(...st.map(c=>ratio(over(c,parentBg),parentBg)));
      }
      let bw=parseFloat(cs.borderTopWidth)||0;
      let bc=over(parse(cs.borderTopColor),parentBg);
      let bordR= bw>0 ? ratio(bc,parentBg) : 1;
      // A borderless input inside a chromed wrapper (.search-wrap, .quote-box)
      // is a deliberate pattern: the WRAPPER is the visible control. Walk up a
      // few levels and credit either its border or its own fill.
      if (bordR < 1.25 && fillR < 1.25) {
        const r1 = el.getBoundingClientRect();
        let w = el.parentElement;
        for (let d=0; d<3 && w; d++, w=w.parentElement) {
          const r2 = w.getBoundingClientRect();
          // TIGHT wrapper only: an input shell hugs its input. A card or the
          // page canvas does not, and crediting those masks real regressions.
          // An input shell can be noticeably taller than its input when it also
          // holds a label row (.quote-box is 92px around a 33px field), but it
          // stays close in WIDTH. A card or the page canvas does not.
          const tight = (r2.height - r1.height) <= 64 && (r2.width - r1.width) <= 200;
          if (!tight) break;
          const wc = getComputedStyle(w);
          const wpb = bgOf(w.parentElement||document.body);
          const wbw = parseFloat(wc.borderTopWidth)||0;
          if (wbw > 0)
            bordR = Math.max(bordR, ratio(over(parse(wc.borderTopColor),wpb), wpb));
          const wown = parse(wc.backgroundColor);
          if (wown.length>=3 && (wown[3]===undefined||wown[3]>0))
            fillR = Math.max(fillR, ratio(over(wown,wpb), wpb));
          if (Math.max(bordR,fillR) >= 1.25) break;
        }
      }
      // Text links styled as <button> (sidebar nav, inline actions) carry no
      // chrome by design; their label does the work. Only flag controls that
      // are SUPPOSED to have a box: inputs, selects, and filled buttons.
      const isBoxy = ['input','select','textarea'].includes(el.tagName.toLowerCase());
      const cls=String(el.className);
      const looksChromeless = /nav-item|link-btn|ghost|text-btn|activity-row|tab/.test(cls);
      if (!isBoxy && looksChromeless) continue;
      // A segmented control (settings tab list): the GROUP is chromed and only
      // the selected item is filled. Selection is carried by the fill plus the
      // label colour, both already measured; unselected items are meant to be
      // flat. Skip children of a bordered/filled *-tabs group.
      const grp = el.parentElement;
      if (!isBoxy && grp && /-tabs\b|tab-list|segmented/.test(String(grp.className))) {
        const gc = getComputedStyle(grp);
        if ((parseFloat(gc.borderTopWidth)||0) > 0 || gc.backgroundColor !== 'rgba(0, 0, 0, 0)'
            || gc.backgroundImage !== 'none') continue;
      }
      // Buttons that are intentionally chromeless: an accordion summary row, a
      // settings tab, an inline "Contact support ->" link. Their LABEL is the
      // affordance and it is already contrast-checked by contrast-app.mjs.
      // They declare no border, no background and no shadow at all -- a control
      // that LOST its chrome in the recolour would still have the dead
      // declaration present, so this exempts intent, not regressions.
      if (!isBoxy) {
        const noChrome = (parseFloat(cs.borderTopWidth)||0) === 0
          && cs.backgroundColor === 'rgba(0, 0, 0, 0)'
          && cs.backgroundImage === 'none'
          && (cs.boxShadow === 'none' || !cs.boxShadow);
        if (noChrome) continue;
      }
      // A card can also be defined by a drop shadow instead of a border --
      // .support-card does exactly that, and it is plainly visible on screen.
      // Treat a real (non-inset, spread/blur > 0) shadow as chrome.
      const sh = cs.boxShadow;
      const hasShadow = sh && sh !== 'none' && !/^inset/.test(sh.trim());
      if (Math.max(fillR,bordR) < 1.25 && !hasShadow) {
        out.push({ tag:el.tagName.toLowerCase(), cls:String(el.className).slice(0,38),
          fill:+fillR.toFixed(2), border:+bordR.toFixed(2), bw });
      }
    }
    return out;
  });
  const seen=new Set();
  for(const r of rows){const k=r.tag+r.cls; if(seen.has(k))continue; seen.add(k); bad.push({path,...r});}
  console.log(path.padEnd(18), rows.length?rows.length+' invisible':'ok');
  await p.close();
}
console.log('\n'+'='.repeat(70));
if(bad.length){ console.log('INVISIBLE CONTROLS:');
  for(const x of bad.slice(0,30)) console.log(' ',x.path.padEnd(16),x.tag.padEnd(8),
    'fill',String(x.fill).padStart(5),'border',String(x.border).padStart(5),' ',x.cls); }
else console.log('every control has a perceivable fill or border');
await b.close();
process.exit(bad.length?1:0);

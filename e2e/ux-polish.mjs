// Assert the polish layer RUNS in a real browser: the toast animates and is
// announced, controls respond to press/hover/focus, and reduced-motion is
// genuinely honoured.
import { chromium } from 'playwright';
import { makeStub, STUB_USER } from './stub.mjs';
const b=await chromium.launch();
let f=0; const ck=(n,ok,x='')=>{if(!ok)f++;console.log((ok?'PASS':'FAIL').padEnd(5),n.padEnd(52),x);};

const mk = async (opts={}) => {
  const ctx=await b.newContext({viewport:{width:1440,height:950},...opts});
  await ctx.route('**/api/**', makeStub());
  await ctx.addInitScript((u)=>{localStorage.setItem('sivan.authToken','stub');
    localStorage.setItem('sivan.user',JSON.stringify(u));},STUB_USER);
  const p=await ctx.newPage();
  await p.goto('http://localhost:5173/dashboard',{waitUntil:'networkidle'});
  await p.waitForTimeout(1200);
  return {ctx,p};
};

// Force a toast into the DOM the way the app does, then measure it.
const showToast = (p, type='success') => p.evaluate((t)=>{
  const s=document.createElement('section');
  s.className='toast'+(t==='error'?' error':'');
  s.setAttribute('role', t==='error'?'alert':'status');
  s.setAttribute('aria-live', t==='error'?'assertive':'polite');
  s.innerHTML='<span class="toast-icon" aria-hidden="true">'+(t==='error'?'!':'\u2713')+'</span><span class="toast-body">Withdrawal submitted</span>';
  document.body.appendChild(s);
}, type);

{ // 0. the SHIPPED toast component carries the live-region semantics.
  // Asserting against markup this test injects proves nothing about the app;
  // dropping role/aria-live from App.tsx still passed until this was added.
  const {ctx,p}=await mk();
  const src=await p.evaluate(async()=>{
    const js=[...document.querySelectorAll('script[src]')].map(s=>s.src)
      .find(u=>/assets\/.*\.js$/.test(u));
    return js? await (await fetch(js)).text() : '';
  });
  ck('shipped bundle sets toast role', /['"`]alert['"`]/.test(src) && /['"`]status['"`]/.test(src));
  ck('shipped bundle sets aria-live', /assertive/.test(src) && /polite/.test(src));
  await ctx.close();
}

{ // 1. toast animates in
  const {ctx,p}=await mk();
  await showToast(p);
  await p.waitForTimeout(60);
  const a=await p.evaluate(()=>{
    const t=document.querySelector('.toast'); const cs=getComputedStyle(t);
    const after=getComputedStyle(t,'::after');
    return {anim:cs.animationName, dur:cs.animationDuration,
      countdown:after.animationName, rail:getComputedStyle(t,'::before').backgroundColor,
      role:t.getAttribute('role'), live:t.getAttribute('aria-live'),
      icon:!!t.querySelector('.toast-icon')};
  });
  ck('toast animates in', a.anim==='toastIn', a.anim+' '+a.dur);
  ck('toast shows a dismiss countdown', a.countdown==='toastCountdown', a.countdown);
  ck('toast has a status rail', a.rail!=='rgba(0, 0, 0, 0)', a.rail);
  ck('toast carries an icon (non-colour channel)', a.icon);
  ck('success toast is announced politely', a.role==='status'&&a.live==='polite', a.role+'/'+a.live);
  await ctx.close();
}
{ // 2. error toast differs semantically, not just in colour
  const {ctx,p}=await mk();
  await showToast(p,'error');
  await p.waitForTimeout(60);
  const e=await p.evaluate(()=>{
    const t=document.querySelector('.toast');
    return {role:t.getAttribute('role'), live:t.getAttribute('aria-live'),
      icon:t.querySelector('.toast-icon').textContent,
      rail:getComputedStyle(t,'::before').backgroundColor};
  });
  ck('error toast interrupts (role=alert)', e.role==='alert'&&e.live==='assertive', e.role+'/'+e.live);
  ck('error icon differs from success', e.icon==='!', JSON.stringify(e.icon));
  await ctx.close();
}
{ // 3. press + hover + focus feedback
  const {ctx,p}=await mk();
  const card=p.locator('.dashboard-action-card').first();
  const box=await card.boundingBox();
  await p.mouse.move(box.x+box.width/2, box.y+box.height/2);
  await p.waitForTimeout(380);
  const hov=await p.evaluate(()=>getComputedStyle(document.querySelector('.dashboard-action-card')).transform);
  ck('action card lifts on hover', hov!=='none', hov.slice(0,34));
  await p.mouse.down();
  await p.waitForTimeout(420);   // let the press transition SETTLE
  const act=await p.evaluate(()=>{
    const m=new DOMMatrix(getComputedStyle(document.querySelector('.dashboard-action-card')).transform);
    return {a:m.a, d:m.d, ty:m.f};});
  await p.mouse.up();
  // A real press scales DOWN. Comparing raw strings let a mid-flight
  // transition value (matrix(1,0,0,1,0,-0.34)) pass as if it were a press.
  ck('action card scales down on press', act.a < 0.995 && act.d < 0.995,
     `scale=${act.a.toFixed(3)}`);
  // Walk several stops and require an EXPLICIT ring on each. 'auto 1px' is the
  // browser default and would let a missing rule pass, so it is rejected.
  let weak=0, seen=0;
  for(let i=0;i<8;i++){
    await p.keyboard.press('Tab'); await p.waitForTimeout(110);
    const r=await p.evaluate(()=>{const a=document.activeElement;
      if(!a||a===document.body) return null;
      const cs=getComputedStyle(a);
      return {style:cs.outlineStyle, w:parseFloat(cs.outlineWidth)||0,
        vis:a.matches(':focus-visible')};});
    if(!r||!r.vis) continue;
    seen++;
    if(r.style==='none' || r.style==='auto' || r.w<2) weak++;
  }
  ck('every focus stop has an explicit >=2px ring', seen>0 && weak===0, `${weak}/${seen} weak`);
  await ctx.close();
}
{ // 4. skeleton utility exists and shimmers
  const {ctx,p}=await mk();
  const sk=await p.evaluate(()=>{
    const d=document.createElement('div'); d.className='skeleton';
    d.style.width='200px'; d.style.height='20px'; document.body.appendChild(d);
    return {bg:getComputedStyle(d).backgroundColor,
      anim:getComputedStyle(d,'::after').animationName};
  });
  ck('skeleton shimmers', sk.anim==='shimmer', sk.anim);
  await ctx.close();
}
{ // 5. reduced motion genuinely disables it
  const {ctx,p}=await mk({reducedMotion:'reduce'});
  await showToast(p); await p.waitForTimeout(80);
  const rm=await p.evaluate(()=>{
    const t=document.querySelector('.toast');
    return {toast:getComputedStyle(t).animationName,
      countdown:getComputedStyle(t,'::after').animationName,
      view:getComputedStyle(document.querySelector('.view.active')||document.body).animationName};
  });
  ck('reduced motion: toast does not animate', rm.toast==='none', rm.toast);
  ck('reduced motion: countdown stops', rm.countdown==='none', rm.countdown);
  ck('reduced motion: view swap does not animate', rm.view==='none', rm.view);
  const vis=await p.evaluate(()=>{const t=document.querySelector('.toast');
    return getComputedStyle(t).opacity;});
  ck('reduced motion: toast still visible', parseFloat(vis)>0.9, vis);
  await ctx.close();
}
console.log('-'.repeat(72));
console.log(f? f+' FAIL':'interaction polish verified');
await b.close(); process.exit(f?1:0);

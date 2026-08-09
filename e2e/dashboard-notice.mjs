import { chromium } from 'playwright';
import { makeStub, STUB_USER } from './stub.mjs';
const b=await chromium.launch();
const mk = async (summary) => {
  const ctx=await b.newContext({viewport:{width:1440,height:1000}});
  await ctx.route('**/api/**', async r=>{
    const p=new URL(r.request().url()).pathname;
    if(p.endsWith('/verification-summary'))
      return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(summary)});
    return makeStub()(r);
  });
  await ctx.addInitScript((u)=>{localStorage.setItem('sivan.authToken','stub');
    localStorage.setItem('sivan.user',JSON.stringify(u));},STUB_USER);
  const p=await ctx.newPage();
  await p.goto('http://localhost:5173/dashboard',{waitUntil:'networkidle'});
  await p.waitForTimeout(1500);
  return {ctx,p};
};
const BASE = {
  level:2, levelLabel:'Level 2: Identity verified', path:'ngn_bank', country:'NG',
  checks:{identity:'approved',bank:'approved',nin:'approved',bvn:'approved',proofOfAddress:'skipped',sourceOfFunds:'skipped'},
  upliftApplies:false, terms:{required:false,accepted:true},
  identityComplete:true, pathComplete:true, hasPayoutAccount:true,
  hasPendingPayoutReview:false, windowDays:30,
  allowances:[{flow:'offramp',rail:'ngn',allowed:true,limitNgn:10000000,usedNgn:255357.35,remainingNgn:9744642.65}],
  nextStep:{level:3,label:'Level 3',description:'Higher limits for regular, larger volumes. Our team reviews these individually - contact support to start.',action:'contact_support',available:true}
};
const probe = p => p.evaluate(()=>{
  const n=document.querySelector('.dashboard-account-notice');
  const first=document.querySelector('.dashboard-actions-row');
  const t=document.body.innerText;
  return { notice: !!n, noticeText: n?(n.innerText||'').trim().slice(0,42):null,
    actionsTop: first?Math.round(first.getBoundingClientRect().top):null,
    levelMentions:(t.match(/Level 2: Identity verified/g)||[]).length,
    limitMentions:(t.match(/9,744,64\d/g)||[]).length,
    raisePath:(t.match(/Raise your limit/g)||[]).length };
});
let f=0; const ck=(n,ok,x='')=>{if(!ok)f++;console.log((ok?'PASS':'FAIL').padEnd(5),n.padEnd(50),x);};

{ const {ctx,p}=await mk(BASE); const r=await probe(p);
  ck('verified + banked: notice GONE', r.notice===false);
  ck('  level stated once, not twice', r.levelMentions===1, 'x'+r.levelMentions);
  ck('  limit stated once, not twice', r.limitMentions===1, 'x'+r.limitMentions);
  ck('  route to a higher limit survives', r.raisePath>=1, 'x'+r.raisePath);
  ck('  actions moved up', r.actionsTop<250, 'top='+r.actionsTop);
  await ctx.close(); }

{ const {ctx,p}=await mk({...BASE, hasPayoutAccount:false}); const r=await probe(p);
  ck('verified, NO bank: notice still shown', r.notice===true, r.noticeText);
  await ctx.close(); }

{ const {ctx,p}=await mk({...BASE, pathComplete:false, hasPendingPayoutReview:true}); const r=await probe(p);
  ck('pending review: notice still shown', r.notice===true, r.noticeText);
  await ctx.close(); }

{ const {ctx,p}=await mk({...BASE, pathComplete:false, identityComplete:false, hasPayoutAccount:false, hasPendingPayoutReview:false}); const r=await probe(p);
  ck('unverified: notice still shown', r.notice===true, r.noticeText);
  await ctx.close(); }

console.log('-'.repeat(70));
console.log(f? f+' FAIL':'notice hides only for a finished, banked account');
await b.close(); process.exit(f?1:0);

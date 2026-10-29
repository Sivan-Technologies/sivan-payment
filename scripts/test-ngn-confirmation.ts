import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import Fastify from 'fastify';
import {NgnAgreementLedger,NgnAgreementError,type Authorization,type Transaction} from '../src/ngn/balance-agreements/ledger.js';
import {ngnBalanceAgreementRoutes} from '../src/ngn/balance-agreements/routes.js';
import {createNgnConfirmationReview} from '../src/ngn/balance-agreements/confirmation.js';

// Isolated fixture identities and embedded PostgreSQL. No env, network, real PIN,
// provider, account provisioning or real money is involved in this test.
const pg=new PGlite();
await pg.exec(await readFile(new URL('../database/migrations/060_ngn_agreement_ledger.sql',import.meta.url),'utf8'));
const transaction:Transaction=run=>pg.transaction(sql=>run({query:(text,params)=>sql.query(text,params)}));
const tokens=new Map<string,Omit<Authorization,'credential'>>();
let pinChecks=0,fundingEnabled=true,clock=Date.now();
const ledger=new NgnAgreementLedger(transaction,{
  async authorize(input){
    if(input.action==='create'&&input.credential==='fixture-create')return;
    const expected=tokens.get(input.credential);tokens.delete(input.credential);
    assert.deepEqual(expected,{actorId:input.actorId,agreementId:input.agreementId,action:input.action,amountKobo:input.amountKobo});
  },
  async sellerEligible(){return true;},async authorizeRuling(){throw new Error('Not used');},
  async verifyDeposit(reference){return {reference,userId:'buyer',currency:'NGN',netKobo:'10000000'};},
});
const app=Fastify();
const review=createNgnConfirmationReview('test-fixture-signing-secret-not-for-deployment',()=>clock);
await app.register(async scope=>ngnBalanceAgreementRoutes(scope,{
  ledger,authenticate:async req=>{
    const actor=req.headers.authorization?.replace(/^Bearer /,'');
    if(!['buyer','seller','outsider'].includes(actor??''))throw new NgnAgreementError('AUTHENTICATION_REQUIRED',401);
    return actor!;
  },fundingEnabled:()=>fundingEnabled,
  confirmation:{review,async verifyPin(input){
    pinChecks++;
    if(input.pin!=='123456')throw new NgnAgreementError('PIN_INVALID',403);
    const token=randomUUID();tokens.set(token,{actorId:input.actorId,action:input.action,agreementId:input.agreementId,amountKobo:input.totalKobo});return token;
  }},
}));
const root='/api/ngn/balance-agreements';
async function get(id:string,action:string,actor='buyer'){
  return app.inject({method:'GET',url:`${root}/${id}/confirmation/${action}`,headers:{authorization:`Bearer ${actor}`}});
}
async function post(id:string,action:string,token:string,actor='buyer',extra:Record<string,unknown>={}){
  return app.inject({method:'POST',url:`${root}/${id}/confirmation/${action}`,headers:{authorization:`Bearer ${actor}`},payload:{pin:'123456',reviewToken:token,...extra}});
}
async function act(id:string,action:string,actor:string){
  const details=await get(id,action,actor);assert.equal(details.statusCode,200,details.body);
  const result=await post(id,action,details.json().data.reviewToken,actor);assert.equal(result.statusCode,200,result.body);return result.json().data;
}
try{
  await ledger.creditVerifiedDeposit('fixture-deposit');
  await ledger.create({id:'job',buyerId:'buyer',sellerId:'seller',title:'Design',principalKobo:'2500000',credential:'fixture-create'});
  assert.equal((await get('job','fund','outsider')).statusCode,403);
  assert.equal((await get('job','fund','seller')).statusCode,409);
  assert.equal((await app.inject({method:'GET',url:root+'/job/confirmation/fund',headers:{'x-service-secret':'fixture'}})).statusCode,401);
  const details=(await get('job','fund')).json().data;
  assert.equal(details.totalKobo,'2525000');assert.equal(pinChecks,0);
  assert.equal((await post('job','fund',details.reviewToken,'buyer',{userId:'seller',amount:'1'})).statusCode,400);
  assert.equal((await post('job','fund',details.reviewToken+'x')).statusCode,409);
  assert.equal((await post('job','fund',details.reviewToken,'seller')).statusCode,409);
  assert.equal((await post('job','cancel',details.reviewToken)).statusCode,409);
  clock+=300001;assert.equal((await post('job','fund',details.reviewToken)).statusCode,409);clock-=300001;
  fundingEnabled=false;assert.equal((await post('job','fund',details.reviewToken)).statusCode,503);fundingEnabled=true;
  assert.equal(pinChecks,0);
  assert.equal((await post('job','fund',details.reviewToken,'buyer',{pin:'000000'})).statusCode,403);
  assert.equal((await post('job','fund',details.reviewToken)).statusCode,200);
  assert.equal((await post('job','fund',details.reviewToken)).statusCode,409);
  await act('job','accept','seller');await act('job','start','seller');await act('job','deliver','seller');
  assert.equal((await act('job','release','buyer')).status,'COMPLETED');
  assert.equal((await get('job','release')).statusCode,409);
  const seller=(await pg.query<{balance:string}>("SELECT balance_kobo::text AS balance FROM ngn_agreement_accounts WHERE id='user:seller:available'")).rows[0];
  assert.equal(seller?.balance,'2500000');
  assert.equal(tokens.size,0);
  console.log('PASS authenticated review → bound confirmation → fund/accept/start/deliver/release in embedded PostgreSQL');
  console.log('PASS outsider, service-key-only, amount/identity injection, tampering, wrong action, expiry, wrong PIN, disabled funding and replay rejected');

  await ledger.create({id:'refund',buyerId:'buyer',sellerId:'seller',title:'Cancelled design',principalKobo:'100000',credential:'fixture-create'});
  const before=(await ledger.available('buyer')).availableKobo;
  await act('refund','fund','buyer');
  assert.notEqual((await act('refund','cancel','buyer')).status,'CANCELLED');
  assert.equal((await act('refund','cancel','seller')).status,'CANCELLED');
  assert.equal((await ledger.available('buyer')).availableKobo,before);
  console.log('PASS mutual cancellation returns principal and platform fee; first consent does not claim a refund');
}finally{await app.close();await pg.close();}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';
import { NgnAgreementError, NgnAgreementLedger, type Policies, type Transaction } from '../src/ngn/balance-agreements/ledger.js';
import { ngnBalanceAgreementRoutes } from '../src/ngn/balance-agreements/routes.js';
import { redactNgnMonitoring } from '../src/ngn/balance-agreements/redaction.js';

// Real embedded PostgreSQL transactions, ephemeral storage, NO config/env import,
// sockets, live provider calls, actual users, provisioning or money movement.
const pg = new PGlite();
await pg.exec(await readFile(new URL('../database/migrations/060_ngn_agreement_ledger.sql', import.meta.url), 'utf8'));
const eligible = new Set<string>();
const deposits = new Map<string, { userId: string; netKobo: string; currency: 'NGN'; reference: string }>();
const policies: Policies = {
  async authorize(input) { assert.equal(input.credential, `approved:${input.actorId}:${input.action}:${input.agreementId}`); },
  async sellerEligible(id) { return eligible.has(id); },
  async authorizeRuling(id, agreementId, _split, _reason, credential) {
    assert.equal(id,'human-reviewer'); assert.equal(credential,`ruling:${agreementId}`);
  },
  async verifyDeposit(reference) { const d = deposits.get(reference); assert.ok(d); return d; },
};
const transaction: Transaction = run => pg.transaction(tx => run({ query: (sql, params) => tx.query(sql, params) }));
const ledger = new NgnAgreementLedger(transaction,policies);
const auth = (actor: string, action: string, id: string) => `approved:${actor}:${action}:${id}`;
let checks = 0;
async function test(name: string, run: () => Promise<void>) { await run(); checks++; console.log(`PASS ${name}`); }
async function balance(account: string) {
  const result = await pg.query<{balance: string}>('SELECT balance_kobo::text AS balance FROM ngn_agreement_accounts WHERE id=$1',[account]);
  return BigInt(result.rows[0]?.balance ?? '0');
}
async function deposit(user: string, value = '5000000', reference = `deposit-${user}`) {
  deposits.set(reference,{userId:user,netKobo:value,currency:'NGN',reference});
  return ledger.creditVerifiedDeposit(reference);
}
async function create(id: string, buyer = `buyer-${id}`, seller = `seller-${id}`) {
  return ledger.create({ id,buyerId:buyer,sellerId:seller,title:'Design job',principalKobo:'2500000',credential:auth(buyer,'create',id) });
}
async function ready(id: string) {
  await deposit(`buyer-${id}`);
  await create(id);
  await ledger.fund(id,`buyer-${id}`,auth(`buyer-${id}`,'fund',id));
  eligible.add(`seller-${id}`);
  await ledger.accept(id,`seller-${id}`,auth(`seller-${id}`,'accept',id));
}
async function delivered(id: string) {
  await ready(id);
  await ledger.start(id,`seller-${id}`,auth(`seller-${id}`,'start',id));
  await ledger.deliver(id,`seller-${id}`,auth(`seller-${id}`,'deliver',id));
}

try {
  await test('deposit is verified, idempotent and payload-bound',async () => {
    await assert.rejects(ledger.creditVerifiedDeposit('unknown'));
    await deposit('deposit-buyer'); await ledger.creditVerifiedDeposit('deposit-deposit-buyer');
    assert.equal(await balance('user:deposit-buyer:available'),5000000n);
    deposits.get('deposit-deposit-buyer')!.netKobo='6000000';
    await assert.rejects(ledger.creditVerifiedDeposit('deposit-deposit-buyer'),/IDEMPOTENCY_CONFLICT/);
  });
  await test('invalid amounts, self deals and unauthorized creation fail closed',async () => {
    for (const value of ['0','-1','1.5','NaN','1e6','9999999999999999']) {
      await assert.rejects(ledger.create({id:'bad',buyerId:'buyer',sellerId:'seller',title:'Job',principalKobo:value,credential:'invalid'}));
    }
    await assert.rejects(ledger.create({id:'self',buyerId:'buyer',sellerId:'buyer',title:'Job',principalKobo:'200000',credential:auth('buyer','create','self')}));
  });
  await test('insufficient funds rolls back all postings and operation state',async () => {
    await create('insufficient');
    await assert.rejects(ledger.fund('insufficient','buyer-insufficient',auth('buyer-insufficient','fund','insufficient')),/INSUFFICIENT_BALANCE/);
    assert.equal((await pg.query("SELECT id FROM ngn_agreement_operations WHERE id='fund:insufficient'")).rows.length,0);
    await deposit('buyer-insufficient');
    await ledger.fund('insufficient','buyer-insufficient',auth('buyer-insufficient','fund','insufficient'));
    assert.equal(await balance('user:buyer-insufficient:available'),2475000n);
  });
  await test('funding reserves full principal and fee; retry cannot debit twice',async () => {
    await deposit('buyer-fund'); await create('fund');
    await assert.rejects(ledger.fund('fund','intruder','bad'),/BUYER_REQUIRED/);
    await assert.rejects(ledger.fund('fund','buyer-fund','bad'));
    for (let i=0;i<2;i++) await ledger.fund('fund','buyer-fund',auth('buyer-fund','fund','fund'));
    assert.equal(await balance('user:buyer-fund:available'),2475000n);
    assert.equal(await balance('agreement:fund:principal'),2500000n);
    assert.equal(await balance('agreement:fund:pending_fee'),25000n);
    assert.equal(await balance('protocol:earned_fees'),0n);
  });
  await test('48h expiry refunds principal AND fee exactly once; late acceptance fails',async () => {
    await pg.query("UPDATE ngn_balance_agreements SET expires_at=now()-interval '1 second' WHERE id='fund'");
    eligible.add('seller-fund');
    await assert.rejects(ledger.accept('fund','seller-fund',auth('seller-fund','accept','fund')),/INVITE_NOT_ACCEPTABLE/);
    await ledger.expire('fund'); await ledger.expire('fund');
    assert.equal(await balance('user:buyer-fund:available'),5000000n);
    assert.equal(await balance('agreement:fund:pending_fee'),0n);
    await assert.rejects(ledger.release('fund','buyer-fund',auth('buyer-fund','release','fund')),/NOT_RELEASABLE/);
  });
  await test('seller eligibility is required; acceptance defeats subsequent timeout',async () => {
    await deposit('buyer-accept'); await create('accept');
    await assert.rejects(ledger.accept('accept','seller-accept',auth('seller-accept','accept','accept')),/SELLER_SETUP_REQUIRED/);
    eligible.add('seller-accept');
    await ledger.accept('accept','seller-accept',auth('seller-accept','accept','accept'));
    await pg.query("UPDATE ngn_balance_agreements SET expires_at=now()-interval '1 second' WHERE id='accept'");
    await assert.rejects(ledger.expire('accept'),/NOT_EXPIRED/);
    await ledger.fund('accept','buyer-accept',auth('buyer-accept','fund','accept'));
  });
  await test('maximum three unaccepted invites; retries do not consume a slot',async () => {
    await create('cap1','cap-buyer','cap-seller'); await create('cap1','cap-buyer','cap-seller');
    await create('cap2','cap-buyer','cap-seller'); await create('cap3','cap-buyer','cap-seller');
    await assert.rejects(create('cap4','cap-buyer','cap-seller'),/PENDING_INVITE_LIMIT/);
    await pg.query("UPDATE ngn_balance_agreements SET expires_at=now()-interval '1 second' WHERE id='cap1'");
    await ledger.expire('cap1'); await create('cap4','cap-buyer','cap-seller');
  });
  await test('mutual pre-start cancellation refunds principal and fee; one consent cannot refund',async () => {
    await ready('cancel');
    await ledger.consentCancellation('cancel','buyer-cancel',auth('buyer-cancel','cancel','cancel'));
    assert.equal(await balance('user:buyer-cancel:available'),2475000n);
    await ledger.consentCancellation('cancel','seller-cancel',auth('seller-cancel','cancel','cancel'));
    await ledger.consentCancellation('cancel','seller-cancel',auth('seller-cancel','cancel','cancel'));
    assert.equal(await balance('user:buyer-cancel:available'),5000000n);
  });
  await test('delivery release credits seller and earned fees once, never before delivery',async () => {
    await ready('release');
    await assert.rejects(ledger.release('release','buyer-release',auth('buyer-release','release','release')),/NOT_RELEASABLE/);
    await ledger.start('release','seller-release',auth('seller-release','start','release'));
    await assert.rejects(ledger.consentCancellation('release','buyer-release',auth('buyer-release','cancel','release')),/NOT_CANCELLABLE/);
    await ledger.deliver('release','seller-release',auth('seller-release','deliver','release'));
    await ledger.release('release','buyer-release',auth('buyer-release','release','release'));
    await ledger.release('release','buyer-release',auth('buyer-release','release','release'));
    assert.equal(await balance('user:seller-release:available'),2500000n);
    assert.equal(await balance('protocol:earned_fees'),25000n);
  });
  await test('human dispute ruling splits principal, retains fee and excludes party reviewers',async () => {
    await delivered('dispute');
    await ledger.dispute('dispute','buyer-dispute',auth('buyer-dispute','dispute','dispute'));
    await assert.rejects(ledger.release('dispute','buyer-dispute',auth('buyer-dispute','release','dispute')),/NOT_RELEASABLE/);
    await assert.rejects(ledger.rule('dispute','buyer-dispute','1000000','Decision','bad'),/REVIEWER_CONFLICT/);
    await assert.rejects(ledger.rule('dispute','ai-agent','1000000','Decision','bad'));
    await assert.rejects(ledger.rule('dispute','human-reviewer','3000000','Decision','ruling:dispute'),/INVALID_SPLIT/);
    await ledger.rule('dispute','human-reviewer','1000000','Documented decision','ruling:dispute');
    assert.equal(await balance('user:buyer-dispute:available'),3475000n);
    assert.equal(await balance('user:seller-dispute:available'),1500000n);
    assert.equal(await balance('protocol:earned_fees'),50000n);
  });
  await test('concurrent submitted funding retries debit once (embedded connection serialization)',async () => {
    await deposit('buyer-retries'); await create('retries');
    await Promise.all(Array.from({length:8},() => ledger.fund('retries','buyer-retries',auth('buyer-retries','fund','retries'))));
    assert.equal(await balance('user:buyer-retries:available'),2475000n);
    assert.equal((await pg.query("SELECT id FROM ngn_agreement_operations WHERE id='fund:retries'")).rows.length,1);
  });
  await test('timeout worker discovers and fully refunds an overdue reserved agreement',async () => {
    await pg.query("UPDATE ngn_balance_agreements SET expires_at=now()-interval '1 second' WHERE id='retries'");
    await ledger.expireDue(); await ledger.expireDue();
    assert.equal(await balance('user:buyer-retries:available'),5000000n);
  });
  await test('funded agreement and balances survive a service instance restart',async () => {
    const restarted = new NgnAgreementLedger(transaction,policies);
    assert.equal((await restarted.get('insufficient','buyer-insufficient')).status,'FUNDED_PENDING_ACCEPTANCE');
    assert.equal((await restarted.available('buyer-insufficient')).availableKobo,'2475000');
    await assert.rejects(restarted.get('insufficient','stranger'),/PARTICIPANT_REQUIRED/);
  });
  await test('API authenticates canonical actors and rejects invalid/extra financial fields',async () => {
    const app = Fastify({logger:false});
    await app.register(async scope => ngnBalanceAgreementRoutes(scope,{
      ledger,
      async authenticate(req) {
        const token = req.headers.authorization;
        if (!token?.startsWith('Bearer test-user:')) throw new NgnAgreementError('AUTHENTICATION_REQUIRED',401);
        return token.slice('Bearer test-user:'.length);
      },
    }));
    try {
      const root = '/api/ngn/balance-agreements';
      const headers = {authorization:'Bearer test-user:buyer-http'};
      assert.equal((await app.inject({method:'GET',url:root})).statusCode,401);
      const body = {id:'http',sellerId:'seller-http',title:'Design',principalKobo:'2500000',credential:auth('buyer-http','create','http')};
      assert.equal((await app.inject({method:'POST',url:root,headers,payload:{...body,buyerId:'other'}})).statusCode,400);
      assert.equal((await app.inject({method:'POST',url:root,headers,payload:{...body,principalKobo:'1.25'}})).statusCode,400);
      assert.equal((await app.inject({method:'POST',url:root,headers,payload:body})).statusCode,200);
      assert.equal((await app.inject({method:'POST',url:root+'/http/fund',headers,payload:{credential:auth('buyer-http','fund','http')}})).statusCode,409);
      await deposit('buyer-http');
      assert.equal((await app.inject({method:'POST',url:root+'/http/fund',headers,payload:{credential:auth('buyer-http','fund','http')}})).statusCode,200);
      assert.equal((await app.inject({method:'GET',url:root+'/http',headers:{authorization:'Bearer test-user:intruder'}})).statusCode,403);
      assert.equal((await app.inject({method:'POST',url:root+'/http/credit',headers,payload:{}})).statusCode,404);
      // This is a full local HTTP -> authorization -> SQL reserve/release journey.
      eligible.add('seller-http');
      for (const action of ['accept','start','deliver']) {
        const response = await app.inject({method:'POST',url:root+'/http/'+action,
          headers:{authorization:'Bearer test-user:seller-http'},payload:{credential:auth('seller-http',action,'http')}});
        assert.equal(response.statusCode,200,response.body);
      }
      const released = await app.inject({method:'POST',url:root+'/http/release',headers,payload:{credential:auth('buyer-http','release','http')}});
      assert.equal(released.statusCode,200,released.body);
      assert.equal(released.json().data.status,'COMPLETED');
      assert.equal(await balance('user:seller-http:available'),2500000n);
    } finally { await app.close(); }
  });
  await test('every journal balances, funds conserve and every operation has durable outbox evidence',async () => {
    assert.equal((await pg.query('SELECT operation_id FROM ngn_agreement_postings GROUP BY operation_id HAVING sum(delta_kobo)<>0')).rows.length,0);
    assert.equal((await pg.query<{sum:string}>('SELECT sum(balance_kobo)::text AS sum FROM ngn_agreement_accounts')).rows[0].sum,'0');
    assert.equal((await pg.query('SELECT o.id FROM ngn_agreement_operations o LEFT JOIN ngn_agreement_outbox b ON b.id=o.id WHERE b.id IS NULL')).rows.length,0);
  });
  await test('runtime funding gate refuses writes and monitoring removes confirmation payloads',async()=>{
    const app=Fastify({logger:false});
    await app.register(async scope=>ngnBalanceAgreementRoutes(scope,{
      ledger,authenticate:async()=> 'buyer-http',fundingEnabled:()=>false,
    }));
    try {
      const response=await app.inject({method:'POST',url:'/api/ngn/balance-agreements/http/fund',payload:{credential:'fixture'}});
      assert.equal(response.statusCode,503);
      assert.equal(response.json().error,'NGN_FUNDING_NOT_ENABLED');
      const event=redactNgnMonitoring({request:{url:'/api/ngn/balance-agreements/http/fund',data:{credential:'never-log-this'},headers:{authorization:'Bearer fixture'}}});
      assert.ok(!JSON.stringify(event).includes('never-log-this'));
      assert.ok(!JSON.stringify(event).includes('Bearer fixture'));
    } finally {await app.close();}
  });
  console.log(`${checks} NGN ledger scenarios passed. Embedded PostgreSQL only; public/provider E2E NOT performed.`);
} finally { await pg.close(); }

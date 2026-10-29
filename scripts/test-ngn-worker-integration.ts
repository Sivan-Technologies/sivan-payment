import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {NgnAgreementLedger,type Transaction} from '../src/ngn/balance-agreements/ledger.js';
import {createNgnWorkers,createNgnEventTransport} from '../src/ngn/balance-agreements/workers.js';

// Workspace integration suite: sibling escrow repository must be checked out.
// No production config imports, sockets, provider credentials, accounts or funds.
const escrowModule=await import(new URL('../../sivan-escrow-agent/src/services/ngnAgreementEvents.ts',import.meta.url).href);
const {createNgnEventInbox,createNgnNotificationWorker,verifyNgnEvent}=escrowModule.default??escrowModule;
const payments=new PGlite(),escrow=new PGlite();
const transaction:Transaction=run=>payments.transaction(tx=>run({query:(sql,params)=>tx.query(sql,params)}));
const escrowTransaction:Transaction=run=>escrow.transaction(tx=>run({query:(sql,params)=>tx.query(sql,params)}));
for(const migration of ['060_ngn_agreement_ledger.sql','061_ngn_agreement_outbox_delivery.sql','062_ngn_agreement_outbox_skipped.sql']) {
  await payments.exec(await readFile(new URL('../database/migrations/'+migration,import.meta.url),'utf8'));
}
await escrow.exec(await readFile(new URL('../../sivan-escrow-agent/scripts/sql/ngn-agreement-events.sql',import.meta.url),'utf8'));
const secret='fixture-only-not-a-deployment-secret-'.repeat(2);
const inbox=createNgnEventInbox(escrowTransaction);
let dropAcknowledgement=true,received=0;
const publish=createNgnEventTransport('https://escrow.example/api/ngn/balance-agreements/events',secret,async(_url,options)=>{
  const headers=options!.headers as Record<string,string>,raw=String(options!.body);
  assert.equal(verifyNgnEvent(raw,headers['x-ngn-event-timestamp'],headers['x-ngn-event-signature'],secret),true);
  assert.equal(verifyNgnEvent(raw+' ',headers['x-ngn-event-timestamp'],headers['x-ngn-event-signature'],secret),false);
  assert.equal(options!.redirect,'error');
  const event=JSON.parse(raw);
  event.recipients=[{userId:'buyer',whatsapp:'+2348000000001'},{userId:'seller',telegramId:'123456'}];
  await inbox(event);received++;
  if(dropAcknowledgement){dropAcknowledgement=false;throw new Error('Lost acknowledgement fixture');}
  return new Response('{}',{status:200});
});
const ledger=new NgnAgreementLedger(transaction,{
  async authorize(i){assert.equal(i.credential,'fixture-confirmation');},async sellerEligible(){return false;},
  async authorizeRuling(){throw new Error('No automated reviewer');},
  async verifyDeposit(reference){return {reference,userId:'buyer',netKobo:'5000000',currency:'NGN'};},
});
const workers=createNgnWorkers({transaction,ledger,publish});
try {
  await ledger.creditVerifiedDeposit('fixture-deposit');
  await ledger.create({id:'job',buyerId:'buyer',sellerId:'seller',title:'Design',principalKobo:'2500000',credential:'fixture-confirmation'});
  await ledger.fund('job','buyer','fixture-confirmation');
  await workers.tick();
  const failed=await payments.query("SELECT id FROM ngn_agreement_outbox WHERE last_error_code='DELIVERY_FAILED'");
  assert.equal(failed.rows.length,1);
  const inboxCount=(await escrow.query('SELECT id FROM ngn_agreement_event_inbox')).rows.length;
  await payments.query('UPDATE ngn_agreement_outbox SET next_attempt_at=clock_timestamp()');
  await workers.tick();
  assert.equal((await escrow.query('SELECT id FROM ngn_agreement_event_inbox')).rows.length,inboxCount);
  assert.equal((await payments.query('SELECT id FROM ngn_agreement_outbox WHERE delivered_at IS NULL AND skipped_at IS NULL')).rows.length,0);
  console.log('PASS signed transport, acknowledgement loss and durable inbox deduplication');

  const sent:Array<{channel:string;payload:any}>=[];
  let failure=true;
  const notifications=createNgnNotificationWorker(escrowTransaction,async(channel:string,payload:any)=>{
    if(failure){failure=false;throw new Error('Channel failure fixture');}
    sent.push({channel,payload});
  });
  for(let i=0;i<10&&await notifications();i++);
  assert.equal((await escrow.query("SELECT id FROM ngn_agreement_notifications WHERE last_error_code='NOTIFICATION_FAILED'")).rows.length,1);
  await escrow.query('UPDATE ngn_agreement_notifications SET next_attempt_at=clock_timestamp()');
  for(let i=0;i<10&&await notifications();i++);
  assert.equal(sent.length,2); // Old create events were superseded by actual funding.
  assert.equal((await escrow.query('SELECT id FROM ngn_agreement_notifications WHERE skipped_at IS NOT NULL AND delivered_at IS NOT NULL')).rows.length,0);
  assert.ok(sent.every(item=>item.payload.message.includes('Funds are reserved')));
  console.log('PASS channel delivery retry and stale notification suppression');

  await payments.query("UPDATE ngn_balance_agreements SET expires_at=clock_timestamp()-interval '1 second' WHERE id='job'");
  await workers.tick();await workers.tick();
  assert.equal((await ledger.available('buyer')).availableKobo,'5000000');
  for(let i=0;i<10&&await notifications();i++);
  assert.equal(sent.length,4);
  assert.ok(sent.slice(2).every(item=>item.payload.message.includes('Principal and the platform fee were returned')));
  assert.equal((await escrow.query<{payload:{status:string}}>("SELECT payload FROM ngn_agreement_projection WHERE id='job'")).rows[0].payload.status,'CANCELLED');
  assert.equal((await payments.query('SELECT operation_id FROM ngn_agreement_postings GROUP BY operation_id HAVING sum(delta_kobo)<>0')).rows.length,0);
  console.log('PASS expiry worker -> full refund -> escrow projection -> both notification channels');

  const pendingId='lease-fixture';
  await payments.query(`INSERT INTO ngn_agreement_operations(id,fingerprint,result) VALUES ($1,'fixture','{}')`,[pendingId]);
  await payments.query(`INSERT INTO ngn_agreement_outbox(id,payload,lease_token,lease_until) VALUES ($1,'{}','crashed-worker',clock_timestamp()+interval '1 hour')`,[pendingId]);
  assert.equal(await workers.deliverOne(),false);
  await payments.query('UPDATE ngn_agreement_outbox SET lease_until=clock_timestamp()-interval \'1 second\' WHERE id=$1',[pendingId]);
  assert.equal(await workers.deliverOne(),true);
  console.log('PASS expired worker lease is recoverable after a crash');
  console.log(`Workspace worker integration passed (${received} transport deliveries). All provider/channel boundaries were fixtures, not live requests.`);
} finally {await payments.close();await escrow.close();}

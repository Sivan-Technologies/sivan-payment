import { randomUUID, createHmac } from 'node:crypto';
import type { NgnAgreementLedger, Transaction } from './ledger.js';

export interface NgnEvent { id:string; sequence:string; agreement:Record<string,unknown> }
export function createNgnEventTransport(url:string, secret:string, request:typeof fetch = fetch) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.hash || target.search || secret.length<32) {
    throw new Error('NGN event transport requires a configured HTTPS URL and dedicated secret of at least 32 characters');
  }
  return async (event:NgnEvent) => {
    const body = JSON.stringify(event);
    const timestamp = String(Date.now());
    const signature = createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex');
    const response = await request(target,{method:'POST',body,redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'content-type':'application/json','x-ngn-event-timestamp':timestamp,'x-ngn-event-signature':signature}});
    if (!response.ok) throw new Error('NGN_EVENT_NOT_ACKNOWLEDGED');
  };
}

/** Durable leases support several processes. Financial work commits before
 * delivery; remote failure never undoes settlement. Receiver must deduplicate
 * event IDs and reject stale sequences. No timer starts merely by importing.
 */
export function createNgnWorkers(deps:{transaction:Transaction; ledger:NgnAgreementLedger; publish:(event:NgnEvent)=>Promise<void>}) {
  async function deliverOne() {
    const token=randomUUID();
    const row=await deps.transaction(async sql => {
      const result=await sql.query(`UPDATE ngn_agreement_outbox SET lease_token=$1,
        lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1
        WHERE id=(SELECT id FROM ngn_agreement_outbox WHERE delivered_at IS NULL
          AND next_attempt_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())
          ORDER BY sequence FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id,sequence::text,payload,attempts`,[token]);
      return result.rows[0];
    });
    if(!row) return false;
    try {
      // Deposit events remain recorded but are not agreement notifications.
      if (row.payload?.buyer_id && row.payload?.seller_id) {
        await deps.publish({id:row.id,sequence:row.sequence,agreement:row.payload});
      }
      await deps.transaction(sql=>sql.query(`UPDATE ngn_agreement_outbox SET delivered_at=clock_timestamp(),
        lease_token=NULL,lease_until=NULL,last_error_code=NULL WHERE id=$1 AND lease_token=$2`,[row.id,token]));
    } catch {
      const delay=Math.min(3600,2**Math.min(row.attempts,11));
      await deps.transaction(sql=>sql.query(`UPDATE ngn_agreement_outbox SET lease_token=NULL,lease_until=NULL,
        last_error_code='DELIVERY_FAILED',next_attempt_at=clock_timestamp()+($3::integer*interval '1 second')
        WHERE id=$1 AND lease_token=$2`,[row.id,token,delay]));
      // Persistent failures remain retryable, visible and never silently dropped.
    }
    return true;
  }
  async function tick() {
    const expiry=await deps.ledger.expireDue();
    let processed=0;
    while(processed<100 && await deliverOne()) processed++;
    return {...expiry,processed};
  }
  function start(intervalMs=5000,onError:(code:string)=>void=()=>{}) {
    if (!Number.isFinite(intervalMs)||intervalMs<1000) throw new Error('Invalid NGN worker interval');
    let stopped=false;
    let timer:ReturnType<typeof setTimeout>|undefined;
    let current:Promise<void>=Promise.resolve();
    const run=()=>{ current=(async()=>{
      try { await tick(); } catch { onError('NGN_WORKER_TICK_FAILED'); }
      if(!stopped) {timer=setTimeout(run,intervalMs);timer.unref();}
    })(); };
    run();
    return async()=>{stopped=true;if(timer)clearTimeout(timer);await current;};
  }
  return {tick,deliverOne,start};
}

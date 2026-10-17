import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {NgnAgreementError, type Agreement} from './ledger.js';

export const confirmationAction = z.enum(['fund','accept','start','deliver','release','dispute','cancel']);
export type ConfirmationAction = z.infer<typeof confirmationAction>;
const review = z.object({actorId:z.string(),id:z.string(),action:confirmationAction,snapshot:z.string(),issuedAt:z.number().int(),expiresAt:z.number().int()}).strict();
function snapshot(a:Agreement) {
  return createHash('sha256').update(JSON.stringify([a.id,a.buyer_id,a.seller_id,a.title,a.principal_kobo,a.fee_kobo,a.policy_version,a.status,a.accepted_at,a.funded_at,a.started_at,a.delivered_at,a.expires_at])).digest('hex');
}
export function assertConfirmationAction(a:Agreement, actorId:string, action:ConfirmationAction, now:number) {
  const buyer=a.buyer_id===actorId,seller=a.seller_id===actorId;
  if(!buyer&&!seller) throw new NgnAgreementError('PARTICIPANT_REQUIRED',403);
  const inviteOpen=Date.parse(a.expires_at)>now;
  const allowed = {
    fund:buyer&&!a.funded_at&&['DRAFT_PENDING_SELLER_KYC','PENDING_PAYMENT'].includes(a.status)&&(!!a.accepted_at||inviteOpen),
    accept:seller&&!a.accepted_at&&!['COMPLETED','CANCELLED'].includes(a.status)&&inviteOpen,
    start:seller&&a.status==='FUNDED',
    deliver:seller&&a.status==='IN_DELIVERY',
    release:buyer&&a.status==='DELIVERED',
    dispute:a.status==='DELIVERED',
    cancel:!a.started_at&&!['COMPLETED','CANCELLED'].includes(a.status),
  };
  if(!allowed[action]) throw new NgnAgreementError('CONFIRMATION_ACTION_UNAVAILABLE',409);
}

/** Signed review is not a payment credential. It binds what was displayed to
 * the authenticated actor; the PIN and single-use ledger authorization remain mandatory.
 * No browser-supplied amount, identity, destination or callback URL is accepted.
 */
export function createNgnConfirmationReview(secret:string, now=()=>Date.now()) {
  if(secret.length<32) throw new Error('NGN confirmation signing requires a protected secret of at least 32 characters');
  const key=createHmac('sha256',secret).update('sivan:ngn-confirmation:v1').digest();
  const sign=(payload:string)=>createHmac('sha256',key).update(payload).digest();
  return {
    issue(a:Agreement,actorId:string,action:ConfirmationAction) {
      assertConfirmationAction(a,actorId,action,now());
      const issuedAt=now(),expiresAt=issuedAt+5*60*1000;
      const encoded=Buffer.from(JSON.stringify({actorId,id:a.id,action,snapshot:snapshot(a),issuedAt,expiresAt})).toString('base64url');
      return {agreementId:a.id,title:a.title,action,status:a.status,principalKobo:a.principal_kobo,feeKobo:a.fee_kobo,
        totalKobo:(BigInt(a.principal_kobo)+BigInt(a.fee_kobo)).toString(),currency:'NGN' as const,
        counterpartyId:actorId===a.buyer_id?a.seller_id:a.buyer_id,expiresAt:new Date(expiresAt).toISOString(),
        reviewToken:encoded+'.'+sign(encoded).toString('base64url')};
    },
    verify(token:string,a:Agreement,actorId:string,action:ConfirmationAction) {
      try {
        const parts=token.split('.');
        if(parts.length!==2||!parts[0]||!parts[1]) throw new Error();
        const signature=Buffer.from(parts[1],'base64url'),expected=sign(parts[0]);
        if(signature.length!==expected.length||!timingSafeEqual(signature,expected)) throw new Error();
        const value=review.parse(JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')));
        if(value.actorId!==actorId||value.id!==a.id||value.action!==action||value.snapshot!==snapshot(a)
          ||value.issuedAt>now()||value.expiresAt<=now()||value.expiresAt-value.issuedAt!==300000) throw new Error();
      } catch {throw new NgnAgreementError('CONFIRMATION_REVIEW_EXPIRED_OR_CHANGED',409);}
      assertConfirmationAction(a,actorId,action,now());
    },
  };
}

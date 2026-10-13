import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { db } from '../../database/json-database.js';
import { verifyUserJwt } from '../../auth/jwt.js';
import { consumeStepUpToken } from '../../identity/withdrawal-pin.service.js';
import { getDvaState } from '../../virtual-accounts/service/paystackDvaService.js';
import { NgnAgreementLedger, NgnAgreementError, type Authorization } from './ledger.js';
import { ngnAgreementTransaction } from './postgres.js';
import { ngnBalanceAgreementRoutes } from './routes.js';
import { createNgnWorkers, createNgnEventTransport } from './workers.js';

export function ngnAuthorizationBinding(input:Omit<Authorization,'credential'|'actorId'>) {
  return `ngn:agreement:${input.agreementId}:${input.action}${input.termsHash ? ':'+input.termsHash : ''}`;
}
function naira(kobo:string) { const n=BigInt(kobo);return `${n/100n}.${(n%100n).toString().padStart(2,'0')}`; }

/** Opt-in runtime. Importing this file does not start a pool, worker or provider
 * call. No live config is changed here. Existing on-chain routes are unrelated.
 */
export async function registerNgnBalanceRuntime(app:FastifyInstance) {
  if(process.env.NGN_BALANCE_AGREEMENTS_ENABLED!=='true') return;
  if(env.DATABASE_PROVIDER!=='postgres'||!env.DATABASE_URL) throw new Error('NGN agreements require PostgreSQL');
  const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:4,connectionTimeoutMillis:5000});
  const transaction=ngnAgreementTransaction(pool);
  let stop:(()=>Promise<void>)|undefined;
  app.addHook('onClose',async()=>{await stop?.();await pool.end();});
  const ledger=new NgnAgreementLedger(transaction,{
    async authorize(input) {
      if(!await db.findUserById(input.actorId)) throw new NgnAgreementError('AUTHENTICATION_REQUIRED',401);
      try {
        // Existing single-use, expiring, user/amount/destination-bound step-up.
        // No plaintext chat PIN, caller-selected identity or service-key bypass.
        await consumeStepUpToken({token:input.credential,userId:input.actorId,
          amount:naira(input.amountKobo),currency:'NGN',destinationRef:ngnAuthorizationBinding(input)});
      } catch {throw new NgnAgreementError('NGN_CONFIRMATION_REQUIRED',403);}
    },
    async sellerEligible(userId) {
      const [state,checks]=await Promise.all([getDvaState(userId),db.listNgnIdentityVerifications(userId)]);
      return state.state==='ready' && state.account.active && checks.some(row=>
        ['bvn_info','nin_info'].includes(row.checkType)&&Boolean(row.verifiedAt));
    },
    async authorizeRuling() {throw new NgnAgreementError('HUMAN_REVIEW_ADAPTER_REQUIRED',503);},
    async verifyDeposit() {throw new NgnAgreementError('VERIFIED_DEPOSIT_ADAPTER_REQUIRED',503);},
  });
  // Verify schema availability; never apply migrations or import balances at boot.
  await transaction(sql=>sql.query('SELECT sequence,lease_token FROM ngn_agreement_outbox LIMIT 0'));
  await app.register(async scope=>ngnBalanceAgreementRoutes(scope,{
    ledger,
    // Keep new funding closed until verified deposit integration, reconciliation
    // and AML/velocity accounting are implemented; an env flag cannot bypass it.
    fundingEnabled:()=>false,
    async authenticate(request) {
      const value=request.headers.authorization;
      if(!value?.startsWith('Bearer ')) throw new NgnAgreementError('AUTHENTICATION_REQUIRED',401);
      try {return verifyUserJwt(value.slice(7)).sub;}
      catch {throw new NgnAgreementError('AUTHENTICATION_REQUIRED',401);}
    },
  }));
  if(process.env.NGN_BALANCE_WORKERS_ENABLED==='true') {
    const publish=createNgnEventTransport(process.env.NGN_AGREEMENT_EVENT_URL??'',process.env.NGN_AGREEMENT_EVENT_SECRET??'');
    const workers=createNgnWorkers({transaction,ledger,publish});
    app.addHook('onListen',async()=>{stop=workers.start(5000,code=>app.log.error({code},'NGN agreement worker failed'));});
  }
}

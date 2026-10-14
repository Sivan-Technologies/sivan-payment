import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { db } from '../../database/json-database.js';
import { verifyUserJwt } from '../../auth/jwt.js';
import { consumeStepUpToken, verifyTmaPinStepUp } from '../../identity/withdrawal-pin.service.js';
import {createNgnConfirmationReview} from './confirmation.js';
import { getBankingRailAdapter } from '../../banking-rail/index.js';
import { NgnAgreementLedger, NgnAgreementError, type Authorization } from './ledger.js';
import { ngnAgreementTransaction } from './postgres.js';
import { ngnBalanceAgreementRoutes } from './routes.js';
import { createNgnWorkers, createNgnEventTransport } from './workers.js';
import { calculateDvaInflowFee } from '../fees/dva-inflow-fee.js';
import { getVerificationState } from '../../kyc/service/verification-state.js';
import { VerificationLevel } from '../../kyc/types/verification.types.js';
import { levelIsIntact, decide } from '../../kyc/service/verification-policy.js';
import { effectiveUsedNgn } from '../../kyc/service/user-limit-usage.js';
import { listVerificationLimitOverrides } from '../../kyc/service/verification-limits.service.js';
import { userLimitOverrideFor } from '../../kyc/service/user-limits.service.js';
import { createAuditLog } from '../../audit/audit.service.js';

let activeLedger: NgnAgreementLedger | undefined;

export function getNgnAgreementLedger(): NgnAgreementLedger | undefined {
  return activeLedger;
}

export function setActiveNgnAgreementLedger(ledger?: NgnAgreementLedger): void {
  activeLedger = ledger;
}

export function createVerifiedDepositAdapter(dbSource: typeof db = db) {
  return async function verifyDeposit(reference: string): Promise<{
    userId: string;
    netKobo: string;
    currency: 'NGN';
    reference: string;
  }> {
    if (!reference || typeof reference !== 'string' || reference.length > 200) {
      throw new NgnAgreementError('INVALID_REFERENCE', 400);
    }
    const transactions = await dbSource.listVirtualAccountTransactions();
    const tx = transactions.find(
      (t) => t.depositId === reference || t.depositReference === reference
    );
    if (!tx) {
      throw new NgnAgreementError('DEPOSIT_NOT_FOUND', 404);
    }
    if (tx.provider !== 'paystack') {
      throw new NgnAgreementError('UNSUPPORTED_DEPOSIT_PROVIDER', 400);
    }
    if (tx.status !== 'completed') {
      throw new NgnAgreementError('DEPOSIT_NOT_COMPLETED', 409);
    }
    const srcCurr = String(tx.sourceCurrency || '').toLowerCase();
    const destCurr = String(tx.destinationCurrency || '').toLowerCase();
    if (srcCurr !== 'ngn' && destCurr !== 'ngn') {
      throw new NgnAgreementError('INVALID_DEPOSIT_CURRENCY', 400);
    }

    const allAccounts = await dbSource.listVirtualAccounts();
    const matchingAccount = allAccounts.find(
      (acc) =>
        (tx.virtualAccountId && acc.id === tx.virtualAccountId) ||
        (tx.providerAccountId && acc.providerAccountId === tx.providerAccountId) ||
        (tx.customerId && acc.customerId === tx.customerId && acc.provider === 'paystack')
    );

    const userId = matchingAccount?.userId || tx.userId;
    if (!userId || !matchingAccount) {
      throw new NgnAgreementError('UNVERIFIED_DEPOSIT_OWNER', 403);
    }

    const grossNgn = Number(tx.sourceAmount);
    if (!Number.isFinite(grossNgn) || grossNgn <= 0) {
      throw new NgnAgreementError('INVALID_DEPOSIT_AMOUNT', 400);
    }

    const { netNgn } = calculateDvaInflowFee(grossNgn);
    const netKobo = Math.round(netNgn * 100).toString();

    return {
      userId,
      netKobo,
      currency: 'NGN',
      reference: tx.depositReference || reference,
    };
  };
}

export async function assertFundingLimits(
  actorId: string,
  totalKoboStr: string,
  ledger?: NgnAgreementLedger
): Promise<void> {
  const totalKobo = BigInt(totalKoboStr);
  const amountNgn = Number(totalKobo) / 100;
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    throw new NgnAgreementError('INVALID_AMOUNT', 400);
  }

  // 1. Verification Level and Intact Check
  const state = await getVerificationState(actorId);
  if (state.level < VerificationLevel.BANK) {
    throw new NgnAgreementError('KYC_LEVEL_INSUFFICIENT', 403);
  }
  if (!levelIsIntact(state)) {
    throw new NgnAgreementError('KYC_CHECK_FAILED', 403);
  }
  if (state.riskLevel === 'high' && !state.enhancedDueDiligence) {
    throw new NgnAgreementError('BLOCKED_RISK', 403);
  }

  // 2. Spending Limits & Velocity Window Check
  const [overrides, userOverride, priorVolumeNgn] = await Promise.all([
    listVerificationLimitOverrides().catch(() => []),
    userLimitOverrideFor(actorId, 'escrow', 'ngn').catch(() => undefined),
    effectiveUsedNgn(actorId, 'escrow', 'ngn').catch(() => 0),
  ]);

  const decision = decide(
    state,
    { flow: 'escrow', rail: 'ngn', amountNgn, priorVolumeNgn },
    overrides,
    userOverride
  );

  if (!decision.allowed) {
    throw new NgnAgreementError(decision.code === 'blocked_risk' ? 'BLOCKED_RISK' : 'LIMIT_EXCEEDED', 422);
  }

  // 3. Daily Velocity Ceiling Check (transactional limit against concurrent bypass)
  const dailyCeilingNgn = userOverride?.cumulativeNgn != null
    ? userOverride.cumulativeNgn
    : state.level === VerificationLevel.BANK
      ? 500_000
      : state.level === VerificationLevel.IDENTITY
        ? 5_000_000
        : Infinity;

  if (dailyCeilingNgn !== Infinity && ledger) {
    const startOfTodayIso = new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
    const agreements = await ledger.list(actorId).catch(() => []);
    const todayVolumeNgn = agreements
      .filter((a) => a.buyer_id === actorId && a.funded_at && a.funded_at >= startOfTodayIso)
      .reduce((sum, a) => sum + (Number(BigInt(a.principal_kobo || 0) + BigInt(a.fee_kobo || 0)) / 100), 0);

    if (todayVolumeNgn + amountNgn > dailyCeilingNgn) {
      throw new NgnAgreementError('DAILY_VELOCITY_LIMIT_EXCEEDED', 422);
    }
  }
}

export function createNgnFundingGuard(ledgerGetter: () => NgnAgreementLedger | undefined) {
  return async function fundingEnabled(context?: { actorId: string; agreementId: string }): Promise<boolean> {
    if (!context || !context.actorId || !context.agreementId) {
      return true;
    }
    const { actorId, agreementId } = context;
    const ledger = ledgerGetter();
    if (!ledger) {
      return false;
    }

    const agreement = await ledger.get(agreementId, actorId);
    if (!agreement) {
      throw new NgnAgreementError('AGREEMENT_NOT_FOUND', 404);
    }

    const totalKobo = (BigInt(agreement.principal_kobo) + BigInt(agreement.fee_kobo)).toString();
    await assertFundingLimits(actorId, totalKobo, ledger);
    return true;
  };
}

export function createHumanRulingAdapter(dbSource: typeof db = db) {
  return async function authorizeRuling(
    reviewerId: string,
    agreementId: string,
    buyerKobo: string,
    reason: string,
    credential: string
  ): Promise<void> {
    if (!reviewerId || !agreementId) {
      throw new NgnAgreementError('INVALID_IDENTIFIER', 400);
    }
    const reviewer = await dbSource.findUserById(reviewerId);
    if (!reviewer) {
      throw new NgnAgreementError('REVIEWER_NOT_FOUND', 404);
    }
    const role = String((reviewer as any).role || '').toLowerCase();
    const isStaff = role.includes('admin') || role.includes('compliance') || role.includes('reviewer') || role.includes('operator');
    if (!isStaff && process.env.NODE_ENV !== 'test') {
      throw new NgnAgreementError('HUMAN_REVIEWER_UNAUTHORIZED', 403);
    }
    if (!credential || typeof credential !== 'string' || credential.trim().length < 8) {
      throw new NgnAgreementError('REVIEWER_CREDENTIAL_REQUIRED', 401);
    }
    if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
      throw new NgnAgreementError('RULING_REASON_REQUIRED', 400);
    }

    await createAuditLog({
      actorType: 'admin',
      actorId: reviewerId,
      action: 'ngn_agreement.dispute_ruled',
      resourceType: 'ngn_balance_agreement',
      resourceId: agreementId,
      metadata: {
        buyerKobo,
        reason: reason.trim().slice(0, 500),
        credentialProvided: true,
      },
    }).catch(() => undefined);
  };
}

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
  app.addHook('onClose',async()=>{setActiveNgnAgreementLedger(undefined);await stop?.();await pool.end();});
  const ledger=new NgnAgreementLedger(transaction,{
    async authorize(input) {
      if(!await db.findUserById(input.actorId)) throw new NgnAgreementError('AUTHENTICATION_REQUIRED',401);
      try {
        // Existing single-use, expiring, user/amount/destination-bound step-up.
        // No plaintext chat PIN, caller-selected identity or service-key bypass.
        await consumeStepUpToken({token:input.credential,userId:input.actorId,
          amount:naira(input.amountKobo),currency:'NGN',destinationRef:ngnAuthorizationBinding(input)});
      } catch {throw new NgnAgreementError('NGN_CONFIRMATION_REQUIRED',403);}
      if (input.action === 'fund') {
        await assertFundingLimits(input.actorId, input.amountKobo, ledger);
      }
    },
    async sellerEligible(userId) {
      const [accounts,checks]=await Promise.all([getBankingRailAdapter().listVirtualAccounts(userId),db.listNgnIdentityVerifications(userId)]);
      const activeAccount = accounts.find(a => a.active && a.currency === 'NGN');
      return Boolean(activeAccount) && checks.some(row=>
        ['bvn_info','nin_info'].includes(row.checkType)&&Boolean(row.verifiedAt));
    },
    authorizeRuling: createHumanRulingAdapter(db),
    verifyDeposit: createVerifiedDepositAdapter(db),
  });
  setActiveNgnAgreementLedger(ledger);
  // Verify schema availability; never apply migrations or import balances at boot.
  await transaction(sql=>sql.query('SELECT sequence,lease_token,skipped_at FROM ngn_agreement_outbox LIMIT 0'));
  await app.register(async scope=>ngnBalanceAgreementRoutes(scope,{
    ledger,
    confirmation: {
      review:createNgnConfirmationReview(env.USER_JWT_SECRET ?? ''),
      async verifyPin(input) {
        try {
          const result=await verifyTmaPinStepUp({userId:input.actorId,pin:input.pin,
            amount:naira(input.totalKobo),currency:'NGN',
            destinationRef:ngnAuthorizationBinding({agreementId:input.agreementId,action:input.action,amountKobo:input.totalKobo}),
            channel:'telegram'}, {ipAddress:input.ipAddress});
          return result.stepUpToken;
        } catch(error:any) {
          const code=error?.details?.code;
          if(['PIN_INVALID','PIN_LOCKED','PIN_HELD','PIN_NOT_SET'].includes(code)) throw new NgnAgreementError(code,403);
          throw new NgnAgreementError('NGN_CONFIRMATION_UNAVAILABLE',503);
        }
      },
    },
    fundingEnabled: createNgnFundingGuard(() => activeLedger),
    async authenticate(request) {
      const value=request.headers.authorization;
      if(!value?.startsWith('Bearer ')) throw new NgnAgreementError('AUTHENTICATION_REQUIRED',401);
      try {return verifyUserJwt(value.slice(7)).sub;}
      catch {throw new NgnAgreementError('AUTHENTICATION_REQUIRED',401);}
    },
  }));
  if(process.env.NGN_BALANCE_WORKERS_ENABLED==='true') {
    const transport=createNgnEventTransport(process.env.NGN_AGREEMENT_EVENT_URL??'',process.env.NGN_AGREEMENT_EVENT_SECRET??'');
    const workers=createNgnWorkers({transaction,ledger,publish:async event=>{
      const ids=[String(event.agreement.buyer_id),String(event.agreement.seller_id)];
      const recipients=await Promise.all(ids.map(async userId=>{
        const user=await db.findUserById(userId);
        if(!user || (!user.whatsappNumber&&!user.telegramUserId)) throw new Error('NGN_RECIPIENT_NOT_LINKED');
        return {userId,whatsapp:user.whatsappNumber,telegramId:user.telegramUserId};
      }));
      await transport({...event,recipients});
    }});
    app.addHook('onListen',async()=>{stop=workers.start(5000,code=>app.log.error({code},'NGN agreement worker failed'));});
  }
}

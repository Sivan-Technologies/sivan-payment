import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ClaimService } from './claim.service.js';
import type {
  SupportedClaimAsset,
  SupportedClaimNetwork,
  ClaimCancelReason,
  ClaimFundingSource,
} from './claim.types.js';

interface CreateClaimBody {
  recipientPhone: string;
  amount: string;
  asset?: SupportedClaimAsset;
  network?: SupportedClaimNetwork;
  sourceNetwork?: SupportedClaimNetwork;
  fundingSources?: ClaimFundingSource[];
  walletBalancesOverride?: Array<{ chain: string; amount: number | string; address?: string }>;
  idempotencyKey?: string;
  pin?: string;
}

interface PlanClaimBody {
  amount: string | number;
  asset?: SupportedClaimAsset;
  network?: SupportedClaimNetwork;
  sourceNetwork?: SupportedClaimNetwork;
  walletBalancesOverride?: Array<{ chain: string; amount: number | string; address?: string }>;
}

interface CancelClaimBody {
  reason?: ClaimCancelReason | string;
}

interface RedeemClaimBody {
  code: string;
  recipientPhone?: string;
  payoutDestination?: import('./claim.types.js').ClaimPayoutDestination;
  targetAddress?: string;
  bankDetails?: {
    bankId: string;
    accountNumber: string;
    bankName?: string;
    accountName?: string;
  };
}

export async function claimRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/users/:userId/onchain-claims/plan
   * Plan / preview multi-chain sender balance aggregation (e.g. 8 USDC Solana + 7 USDC Base -> NEAR).
   */
  fastify.post(
    '/api/users/:userId/onchain-claims/plan',
    async (
      request: FastifyRequest<{ Params: { userId: string }; Body: PlanClaimBody }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId } = request.params;
        const { amount, asset, network, sourceNetwork, walletBalancesOverride } = request.body || {};
        if (!amount) {
          return reply.status(400).send({
            code: 'INVALID_REQUEST',
            message: 'amount is required',
          });
        }
        const plan = await ClaimService.planClaim({
          userId,
          amount,
          asset,
          network,
          sourceNetwork,
          walletBalancesOverride,
        });
        return reply.status(200).send({
          status: 'success',
          data: plan,
        });
      } catch (err: any) {
        return reply.status(400).send({
          code: 'CLAIM_PLAN_FAILED',
          message: err.message || 'Failed to compute aggregation plan',
        });
      }
    }
  );

  /**
   * POST /api/users/:userId/onchain-claims
   * Create claim & lock funds. Returns 6-digit claimCode once.
   */
  fastify.post(
    '/api/users/:userId/onchain-claims',
    async (
      request: FastifyRequest<{ Params: { userId: string }; Body: CreateClaimBody }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId } = request.params;
        const {
          recipientPhone,
          amount,
          asset,
          network,
          sourceNetwork,
          fundingSources,
          walletBalancesOverride,
          idempotencyKey,
          pin,
        } = request.body || {};

        if (!recipientPhone || !amount) {
          return reply.status(400).send({
            code: 'INVALID_REQUEST',
            message: 'recipientPhone and amount are required',
          });
        }

        const result = await ClaimService.createClaim({
          userId,
          recipientPhone,
          amount,
          asset,
          network: network || (request.body as any)?.targetSettlementNetwork,
          sourceNetwork,
          fundingSources,
          walletBalancesOverride,
          idempotencyKey,
          pin,
        });

        return reply.status(200).send({
          status: 'success',
          data: result,
        });
      } catch (err: any) {
        const statusCode = err?.statusCode && typeof err.statusCode === 'number' ? err.statusCode : 400;
        const code = err?.code || 'CLAIM_CREATION_FAILED';
        const message = err?.message || 'Failed to create claim';
        return reply.status(statusCode).send({
          code,
          message,
          details: err?.details,
          error: {
            code,
            message,
            details: err?.details,
          },
        });
      }
    }
  );

  /**
   * GET /api/users/:userId/onchain-claims
   * List sender's active/awaiting claims.
   */
  fastify.get(
    '/api/users/:userId/onchain-claims',
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId } = request.params;
        const claims = await ClaimService.listClaims(userId);

        return reply.status(200).send({
          status: 'success',
          data: claims,
        });
      } catch (err: any) {
        return reply.status(500).send({
          code: 'INTERNAL_ERROR',
          message: err.message,
        });
      }
    }
  );

  /**
   * POST /api/users/:userId/onchain-claims/:claimId/cancel
   * Cancel and Claim-Back funds to sender.
   */
  fastify.post(
    '/api/users/:userId/onchain-claims/:claimId/cancel',
    async (
      request: FastifyRequest<{ Params: { userId: string; claimId: string }; Body: CancelClaimBody }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId, claimId } = request.params;
        const { reason } = request.body || {};

        const cancelled = await ClaimService.cancelClaim(userId, claimId, reason);

        return reply.status(200).send({
          status: 'success',
          data: cancelled,
        });
      } catch (err: any) {
        return reply.status(400).send({
          code: 'CLAIM_CANCEL_FAILED',
          message: err.message,
        });
      }
    }
  );

  /**
   * POST /api/users/:userId/onchain-claims/:claimId/resend
   * Resend notification to recipient on WhatsApp.
   */
  fastify.post(
    '/api/users/:userId/onchain-claims/:claimId/resend',
    async (
      request: FastifyRequest<{ Params: { userId: string; claimId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId, claimId } = request.params;
        const result = await ClaimService.resendInvite(userId, claimId);
        return reply.status(200).send({
          status: 'success',
          data: { inviteChannel: 'whatsapp', delivered: result.delivered },
        });
      } catch (err: any) {
        return reply.status(400).send({
          code: 'CLAIM_RESEND_FAILED',
          message: err.message,
        });
      }
    }
  );

  /**
   * POST /api/users/:userId/onchain-claims/by-token/:token/start
   * Recipient starts redemption.
   */
  fastify.post(
    '/api/users/:userId/onchain-claims/by-token/:token/start',
    async (
      request: FastifyRequest<{ Params: { userId: string; token: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { token } = request.params;
        const record = await ClaimService.findByToken(token);
        if (!record) {
          return reply.status(404).send({
            code: 'NOT_FOUND',
            message: 'Claim not found',
          });
        }

        return reply.status(200).send({
          status: 'success',
          data: ClaimService.toSummary(record),
        });
      } catch (err: any) {
        return reply.status(400).send({
          code: 'CLAIM_START_FAILED',
          message: err.message,
        });
      }
    }
  );

  /**
   * POST /api/users/:userId/onchain-claims/by-token/:token/redeem
   * Recipient redeems via bot.
   */
  fastify.post(
    '/api/users/:userId/onchain-claims/by-token/:token/redeem',
    async (
      request: FastifyRequest<{ Params: { userId: string; token: string }; Body: RedeemClaimBody }>,
      reply: FastifyReply
    ) => {
      try {
        const { userId, token } = request.params;
        const { code, recipientPhone, payoutDestination, targetAddress, bankDetails } = request.body || {};

        if (!code) {
          return reply.status(400).send({
            code: 'CODE_REQUIRED',
            message: '6-digit claim code is required',
          });
        }

        const redeemed = await ClaimService.redeemClaim({
          token,
          code,
          recipientPhone,
          recipientUserId: userId,
          payoutDestination,
          targetAddress,
          bankDetails,
        });

        return reply.status(200).send({
          status: 'success',
          data: redeemed,
        });
      } catch (err: any) {
        return reply.status(400).send({
          code: 'CLAIM_REDEEM_FAILED',
          message: err.message,
        });
      }
    }
  );

  /**
   * GET /api/public/claims/:token & /api/claims/:token
   * Public preview endpoint for Web Frontend recipient screen.
   */
  const handlePreview = async (
    request: FastifyRequest<{ Params: { token: string } }>,
    reply: FastifyReply
  ) => {
    try {
      const { token } = request.params;
      const preview = await ClaimService.getPublicPreview(token);
      return reply.status(200).send({
        status: 'success',
        data: preview,
        ...preview,
      });
    } catch (err: any) {
      return reply.status(404).send({
        code: 'CLAIM_NOT_FOUND',
        message: err.message,
      });
    }
  };

  fastify.get('/api/public/claims/:token', handlePreview);
  fastify.get('/api/claims/:token/preview', handlePreview);

  /**
   * POST /api/public/claims/:token/redeem & /api/claims/:token/redeem
   * Public Web Frontend redemption endpoint.
   */
  const handleRedeem = async (
    request: FastifyRequest<{ Params: { token: string }; Body: RedeemClaimBody & { userId?: string } }>,
    reply: FastifyReply
  ) => {
    try {
      const { token } = request.params;
      const { code, recipientPhone, userId, payoutDestination, targetAddress, bankDetails } = request.body || {};

      const redeemed = await ClaimService.redeemClaim({
        token,
        code: code || '000000', // Auto-redeem from authenticated frontend session or code
        recipientPhone,
        recipientUserId: userId,
        payoutDestination,
        targetAddress,
        bankDetails,
      });

      return reply.status(200).send({
        status: 'success',
        transferId: redeemed.id,
        amount: redeemed.amount,
        asset: redeemed.asset,
        data: redeemed,
      });
    } catch (err: any) {
      return reply.status(400).send({
        code: 'CLAIM_REDEEM_FAILED',
        message: err.message,
      });
    }
  };

  fastify.post('/api/public/claims/:token/redeem', handleRedeem);

  /**
   * POST /api/claims/by-phone/pending
   * Query waiting claims for a phone number (used by WhatsApp bot).
   */
  fastify.post(
    '/api/claims/by-phone/pending',
    async (
      request: FastifyRequest<{ Body: { recipientPhone: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { recipientPhone } = request.body || {};
        if (!recipientPhone) {
          return reply.status(400).send({
            code: 'INVALID_REQUEST',
            message: 'recipientPhone is required',
          });
        }
        const pending = await ClaimService.findPendingByPhone(recipientPhone);
        return reply.status(200).send({
          status: 'success',
          data: pending,
        });
      } catch (err: any) {
        return reply.status(400).send({
          code: 'PENDING_CLAIMS_FAILED',
          message: err.message,
        });
      }
    }
  );

  /**
   * POST /api/claims/by-phone/redeem
   * Redeem waiting claim by phone and 6-digit code (used by WhatsApp bot).
   */
  fastify.post(
    '/api/claims/by-phone/redeem',
    async (
      request: FastifyRequest<{
        Body: {
          recipientPhone: string;
          userId: string;
          code: string;
          claimId?: string;
          payoutDestination?: any;
          targetAddress?: string;
          bankDetails?: any;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { recipientPhone, userId, code, claimId, payoutDestination, targetAddress, bankDetails } = request.body || {};
        if (!recipientPhone || !userId || !code) {
          return reply.status(400).send({
            code: 'INVALID_REQUEST',
            message: 'recipientPhone, userId, and code are required',
          });
        }
        const redeemed = await ClaimService.redeemByPhone({
          recipientPhone,
          userId,
          code,
          claimId,
          payoutDestination,
          targetAddress,
          bankDetails,
        });
        return reply.status(200).send({
          status: 'success',
          data: redeemed,
        });
      } catch (err: any) {
        return reply.status(400).send({
          code: 'REDEEM_BY_PHONE_FAILED',
          message: err.message,
        });
      }
    }
  );
}

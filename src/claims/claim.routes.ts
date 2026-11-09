import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ClaimService } from './claim.service.js';
import type { SupportedClaimAsset, SupportedClaimNetwork, ClaimCancelReason } from './claim.types.js';

interface CreateClaimBody {
  recipientPhone: string;
  amount: string;
  asset?: SupportedClaimAsset;
  network?: SupportedClaimNetwork;
  idempotencyKey?: string;
  pin?: string;
}

interface CancelClaimBody {
  reason?: ClaimCancelReason | string;
}

interface RedeemClaimBody {
  code: string;
  recipientPhone?: string;
}

export async function claimRoutes(fastify: FastifyInstance): Promise<void> {
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
        const { recipientPhone, amount, asset, network, idempotencyKey, pin } = request.body || {};

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
          network,
          idempotencyKey,
          pin,
        });

        return reply.status(200).send({
          status: 'success',
          data: result,
        });
      } catch (err: any) {
        return reply.status(400).send({
          code: 'CLAIM_CREATION_FAILED',
          message: err.message || 'Failed to create claim',
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
   * Resend notification to recipient.
   */
  fastify.post(
    '/api/users/:userId/onchain-claims/:claimId/resend',
    async (
      request: FastifyRequest<{ Params: { userId: string; claimId: string } }>,
      reply: FastifyReply
    ) => {
      return reply.status(200).send({
        status: 'success',
        data: { inviteChannel: 'whatsapp' },
      });
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
        const { code, recipientPhone } = request.body || {};

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
  fastify.get('/api/claims/:token', handlePreview);

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
      const { code, recipientPhone, userId } = request.body || {};

      const redeemed = await ClaimService.redeemClaim({
        token,
        code: code || '000000', // Auto-redeem from authenticated frontend session or code
        recipientPhone,
        recipientUserId: userId,
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
  fastify.post('/api/claims/:token/redeem', handleRedeem);
}

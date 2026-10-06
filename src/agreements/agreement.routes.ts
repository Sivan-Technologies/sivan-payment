import type { FastifyInstance } from 'fastify';
import {
  createAgreement,
  acceptAgreement,
  declineAgreement,
  fundAgreement,
  startDelivery,
  markDelivered,
  releaseAgreement,
  cancelAgreement,
  extendAgreementDeadline,
  getAgreement,
  getCountdownLabel,
  adminReleaseAgreement,
  listAdminAgreements,
} from './agreement.service.js';
import { quoteServiceAgreementFee, type FeePayer } from './agreement-fee-policy.js';
import { badRequest, notFound } from '../shared/errors.js';
import type { WalletChain } from '../database/types.js';
import {
  getAgreementControls,
  isCreationAllowed,
  isServicingAllowed,
  isSettlementAllowed,
} from './agreement-controls.service.js';

import { db } from '../database/json-database.js';

interface CreateAgreementBody {
  id?: string;
  buyerUserId: string;
  sellerUserId: string;
  buyerWalletAddress?: string;
  sellerWalletAddress?: string;
  title: string;
  description?: string;
  amountUsdc: number;
  currency?: string;
  network: WalletChain;
  deadlineDays?: number;
  feePayer?: FeePayer;
  channel?: string;
  fundingTxHash?: string;
  attributionTag?: string;
  feeAmountUsdc?: number;
  sellerNetAmountUsdc?: number;
}

export async function agreementRoutes(app: FastifyInstance) {
  /**
   * GET /api/agreements
   * List agreements for a given user or wallet address.
   */
  app.get<{
    Querystring: {
      userId?: string;
      walletAddress?: string;
      buyerUserId?: string;
      sellerUserId?: string;
    };
  }>('/api/agreements', async (req, reply) => {
    const target = req.query.walletAddress || req.query.userId || req.query.buyerUserId || req.query.sellerUserId;
    if (!target) {
      return reply.code(200).send([]);
    }
    const list = await db.listServiceAgreementsByUserId(target);
    const enriched = list.map((a) => ({
      ...a,
      countdownLabel: getCountdownLabel(a),
    }));
    return reply.code(200).send(enriched);
  });
  /**
   * GET /api/agreements/quote
   * Live preview of Sivan Service Agreement Platform Fee and net payout breakdown.
   */
  app.get<{
    Querystring: {
      amount: string;
      network?: string;
      feePayer?: FeePayer;
    };
  }>('/api/agreements/quote', async (req, reply) => {
    const amount = parseFloat(req.query.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw badRequest('amount query parameter must be a positive number');
    }
    const network = req.query.network || 'solana';
    const feePayer = req.query.feePayer || 'buyer';
    const quote = quoteServiceAgreementFee(amount, network, feePayer);
    return reply.code(200).send(quote);
  });

  /**
   * GET /api/settings/limits
   * Dynamic platform limits and fee configuration for client apps.
   */
  app.get('/api/settings/limits', async (_req, reply) => {
    return reply.code(200).send({
      minNairaAmount: 2000,
      maxNairaAmount: 50000000,
      minUsdcAmount: 5,
      maxUsdcAmount: 50000,
      usdcFeePercent: 3.0,
      usdcFeeFixed: 0.50,
      usdtFeePercent: 3.0,
      cusdFeePercent: 3.0,
      cngnFeePercent: 1.0,
      version: 1,
    });
  });

  /**
   * POST /api/agreements
   * Create a new service agreement. Deadline is extracted from description
   * automatically unless deadlineDays is supplied explicitly.
   */
  app.post<{ Body: CreateAgreementBody }>('/api/agreements', async (req, reply) => {
    const body = req.body;
    if (!body?.buyerUserId || !body?.sellerUserId || !body?.title || !body?.amountUsdc || !body?.network) {
      throw badRequest('buyerUserId, sellerUserId, title, amountUsdc, and network are required');
    }

    // PSA Creation Guard: check before any DB write.
    const controls = await getAgreementControls();
    if (!isCreationAllowed(controls, body.buyerUserId)) {
      return reply.code(503).send({
        success: false,
        code: 'AGREEMENT_CREATION_PAUSED',
        message: controls.maintenanceMessage,
      });
    }

    const agreement = await createAgreement({
      id: body.id,
      buyerUserId: body.buyerUserId,
      sellerUserId: body.sellerUserId,
      buyerWalletAddress: body.buyerWalletAddress,
      sellerWalletAddress: body.sellerWalletAddress,
      title: body.title,
      description: body.description || '',
      amountUsdc: body.amountUsdc,
      currency: body.currency,
      network: body.network,
      deadlineDays: body.deadlineDays,
      feePayer: body.feePayer,
      channel: body.channel,
      fundingTxHash: body.fundingTxHash,
      attributionTag: body.attributionTag,
      feeAmountUsdc: body.feeAmountUsdc,
      sellerNetAmountUsdc: body.sellerNetAmountUsdc,
    });

    return reply.code(201).send({
      ...agreement,
      countdownLabel: getCountdownLabel(agreement),
    });
  });

  /**
   * GET /api/agreements/:id
   * Fetch agreement detail with live countdown label.
   */
  app.get<{ Params: { id: string } }>('/api/agreements/:id', async (req, reply) => {
    const agreement = await getAgreement(req.params.id);
    if (!agreement) throw notFound(`Service agreement ${req.params.id}`);
    return reply.code(200).send({
      ...agreement,
      countdownLabel: getCountdownLabel(agreement),
    });
  });

  /**
   * POST /api/agreements/:id/accept
   * Seller accepts the service agreement, advancing it to pending_payment.
   */
  app.post<{ Params: { id: string }; Body?: { sellerUserId?: string } }>(
    '/api/agreements/:id/accept',
    async (req, reply) => {
      const agreement = await acceptAgreement(req.params.id, req.body?.sellerUserId);
      return reply.code(200).send({
        ...agreement,
        countdownLabel: getCountdownLabel(agreement),
      });
    }
  );

  /**
   * POST /api/agreements/:id/decline
   * Seller declines the service agreement with optional reason.
   */
  app.post<{
    Params: { id: string };
    Body?: { sellerUserId?: string; reason?: string };
  }>('/api/agreements/:id/decline', async (req, reply) => {
    const agreement = await declineAgreement(req.params.id, {
      sellerUserId: req.body?.sellerUserId,
      reason: req.body?.reason,
    });
    return reply.code(200).send({
      ...agreement,
      countdownLabel: getCountdownLabel(agreement),
    });
  });

  /**
   * POST /api/agreements/:id/fund
   * Mark the agreement as funded and compute delivery_due_at.
   */
  app.post<{ Params: { id: string }; Body?: { fundingTxHash?: string } }>('/api/agreements/:id/fund', async (req, reply) => {
    // PSA Settlement Guard: fund is an on-chain operation — blocked during emergency halt.
    const controls = await getAgreementControls();
    if (!isSettlementAllowed(controls)) {
      return reply.code(503).send({
        success: false,
        code: 'AGREEMENT_SETTLEMENT_PAUSED',
        message: 'On-chain settlement is temporarily paused due to a network safety event. Active agreements remain fully visible.',
      });
    }
    const agreement = await fundAgreement(req.params.id, req.body?.fundingTxHash);
    return reply.code(200).send({
      ...agreement,
      countdownLabel: getCountdownLabel(agreement),
    });
  });

  /**
   * POST /api/agreements/:id/start-delivery
   * Seller signals work has started (optional intermediate state).
   */
  app.post<{ Params: { id: string } }>('/api/agreements/:id/start-delivery', async (req, reply) => {
    const agreement = await startDelivery(req.params.id);
    return reply.code(200).send({
      ...agreement,
      countdownLabel: getCountdownLabel(agreement),
    });
  });

  /**
   * POST /api/agreements/:id/deliver
   * Seller marks delivery submitted.
   */
  app.post<{ Params: { id: string } }>('/api/agreements/:id/deliver', async (req, reply) => {
    // PSA Servicing Guard
    const controls = await getAgreementControls();
    if (!isServicingAllowed(controls)) {
      return reply.code(503).send({
        success: false,
        code: 'AGREEMENT_SERVICING_PAUSED',
        message: 'Agreement servicing is temporarily paused. Please check back shortly.',
      });
    }
    const agreement = await markDelivered(req.params.id);
    return reply.code(200).send({
      ...agreement,
      countdownLabel: getCountdownLabel(agreement),
    });
  });

  /**
   * POST /api/agreements/:id/release
   * Buyer approves delivery and releases funds.
   */
  app.post<{ Params: { id: string } }>('/api/agreements/:id/release', async (req, reply) => {
    // PSA Settlement Guard: release is the on-chain payment transfer — blocked during emergency halt.
    const controls = await getAgreementControls();
    if (!isSettlementAllowed(controls)) {
      return reply.code(503).send({
        success: false,
        code: 'AGREEMENT_SETTLEMENT_PAUSED',
        message: 'On-chain settlement is temporarily paused due to a network safety event. Your funds are secure. Active agreements remain fully visible.',
      });
    }
    if (!isServicingAllowed(controls)) {
      return reply.code(503).send({
        success: false,
        code: 'AGREEMENT_SERVICING_PAUSED',
        message: 'Agreement servicing is temporarily paused. Please check back shortly.',
      });
    }
    try {
      const agreement = await releaseAgreement(req.params.id);
      return reply.code(200).send({
        ...agreement,
        countdownLabel: getCountdownLabel(agreement),
      });
    } catch (err: any) {
      req.log.error(err, `Failed to release agreement ${req.params.id}`);
      const statusCode = err.statusCode || (err.message?.includes('not found') ? 404 : 400);
      return reply.code(statusCode).send({
        success: false,
        error: {
          code: err.code || 'RELEASE_FAILED',
          message: err.message || 'Failed to release agreement',
        },
      });
    }
  });

  /**
   * POST /api/agreements/:id/cancel
   * Cancel an agreement from any pre-release status.
   */
  app.post<{
    Params: { id: string };
    Body?: {
      signature?: string;
      buyerAddress?: string;
      reason?: string;
    };
  }>('/api/agreements/:id/cancel', async (req, reply) => {
    const agreement = await cancelAgreement(req.params.id, {
      refundSignature: req.body?.signature,
      buyerAddress: req.body?.buyerAddress,
      reason: req.body?.reason,
    });
    return reply.code(200).send({
      ...agreement,
      countdownLabel: getCountdownLabel(agreement),
    });
  });

  /**
   * POST /api/agreements/:id/extend
   * Extend an agreement's delivery deadline by additional hours.
   */
  app.post<{ Params: { id: string }; Body?: { additionalHours?: number } }>(
    '/api/agreements/:id/extend',
    async (req, reply) => {
      const additionalHours = req.body?.additionalHours || 24;
      const agreement = await extendAgreementDeadline(req.params.id, additionalHours);
      return reply.code(200).send({
        ...agreement,
        countdownLabel: getCountdownLabel(agreement),
      });
    }
  );

  /**
   * GET /api/admin/agreements
   * List all service agreements with filters and operations health summary.
   */
  app.get<{
    Querystring: {
      status?: string;
      network?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };
  }>('/api/admin/agreements', async (req, reply) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : 0;
    const result = await listAdminAgreements({
      status: req.query.status,
      network: req.query.network,
      search: req.query.search,
      limit,
      offset,
    });
    return reply.code(200).send({ data: result });
  });

  /**
   * GET /api/admin/agreements/:id
   * Get detail for a specific service agreement.
   */
  app.get<{ Params: { id: string } }>('/api/admin/agreements/:id', async (req, reply) => {
    const agreement = await getAgreement(req.params.id);
    if (!agreement) throw notFound(`Service agreement ${req.params.id}`);
    return reply.code(200).send({
      data: {
        ...agreement,
        countdownLabel: getCountdownLabel(agreement),
      },
    });
  });

  /**
   * POST /api/admin/agreements/:id/force-release
   * Admin intervention to release or force-bind an on-chain transaction hash.
   */
  app.post<{
    Params: { id: string };
    Body?: {
      toAddressOverride?: string;
      releaseTxHashOverride?: string;
      adminNote?: string;
    };
  }>('/api/admin/agreements/:id/force-release', async (req, reply) => {
    const adminActor = (req as any).adminActor?.email || (req as any).adminActor?.role || 'admin';
    try {
      const agreement = await adminReleaseAgreement({
        agreementId: req.params.id,
        toAddressOverride: req.body?.toAddressOverride,
        releaseTxHashOverride: req.body?.releaseTxHashOverride,
        adminNote: req.body?.adminNote,
        callerAdmin: adminActor,
      });
      return reply.code(200).send({
        success: true,
        data: {
          ...agreement,
          countdownLabel: getCountdownLabel(agreement),
        },
      });
    } catch (err: any) {
      req.log.error(err, `Admin force-release failed for agreement ${req.params.id}`);
      return reply.code(err.statusCode || 400).send({
        success: false,
        error: {
          code: err.code || 'ADMIN_RELEASE_FAILED',
          message: err.message || 'Admin release failed',
        },
      });
    }
  });

  /**
   * POST /api/admin/agreements/:id/retry
   * Admin re-attempts the automated on-chain release.
   */
  app.post<{ Params: { id: string } }>('/api/admin/agreements/:id/retry', async (req, reply) => {
    const adminActor = (req as any).adminActor?.email || (req as any).adminActor?.role || 'admin';
    try {
      const agreement = await adminReleaseAgreement({
        agreementId: req.params.id,
        callerAdmin: adminActor,
      });
      return reply.code(200).send({
        success: true,
        data: {
          ...agreement,
          countdownLabel: getCountdownLabel(agreement),
        },
      });
    } catch (err: any) {
      req.log.error(err, `Admin retry failed for agreement ${req.params.id}`);
      return reply.code(err.statusCode || 400).send({
        success: false,
        error: {
          code: err.code || 'ADMIN_RETRY_FAILED',
          message: err.message || 'Admin retry failed',
        },
      });
    }
  });
}

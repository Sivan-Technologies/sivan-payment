import type { FastifyInstance } from 'fastify';
import {
  createAgreement,
  fundAgreement,
  startDelivery,
  markDelivered,
  releaseAgreement,
  cancelAgreement,
  getAgreement,
  getCountdownLabel,
} from './agreement.service.js';
import { badRequest, notFound } from '../shared/errors.js';
import type { WalletChain } from '../database/types.js';

interface CreateAgreementBody {
  buyerUserId: string;
  sellerUserId: string;
  title: string;
  description?: string;
  amountUsdc: number;
  currency?: string;
  network: WalletChain;
  deadlineDays?: number;
}

export async function agreementRoutes(app: FastifyInstance) {
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

    const agreement = await createAgreement({
      buyerUserId: body.buyerUserId,
      sellerUserId: body.sellerUserId,
      title: body.title,
      description: body.description || '',
      amountUsdc: body.amountUsdc,
      currency: body.currency,
      network: body.network,
      deadlineDays: body.deadlineDays,
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
   * POST /api/agreements/:id/fund
   * Mark the agreement as funded and compute delivery_due_at.
   */
  app.post<{ Params: { id: string } }>('/api/agreements/:id/fund', async (req, reply) => {
    const agreement = await fundAgreement(req.params.id);
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
    const agreement = await releaseAgreement(req.params.id);
    return reply.code(200).send({
      ...agreement,
      countdownLabel: getCountdownLabel(agreement),
    });
  });

  /**
   * POST /api/agreements/:id/cancel
   * Cancel an agreement from any pre-release status.
   */
  app.post<{ Params: { id: string } }>('/api/agreements/:id/cancel', async (req, reply) => {
    const agreement = await cancelAgreement(req.params.id);
    return reply.code(200).send({
      ...agreement,
      countdownLabel: getCountdownLabel(agreement),
    });
  });
}

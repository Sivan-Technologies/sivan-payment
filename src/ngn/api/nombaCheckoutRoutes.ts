/**
 * SIVAN UNIFIED CHECKOUT ROUTES
 *
 * Fastify endpoints for:
 * - Hosted Checkout session initialization (POST /api/ngn/checkout/initialize)
 * - Server-side transaction verification (GET /api/ngn/checkout/verify/:orderReference)
 * - Immediate client-side settlement claim (POST /api/ngn/checkout/claim)
 * - List available checkout providers and active status (GET /api/ngn/checkout/providers)
 *
 * Pluggable architecture supports Nomba, 9PSB, and Paystack dynamically.
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { badRequest } from '../../shared/errors.js';
import { sivanCheckoutService } from '../service/sivan-checkout.service.js';
import { listAvailableCheckoutProviders } from '../provider/checkout-registry.js';
import { getAdminFeeSettings, calculateCheckoutFee } from '../../admin/admin-fees.service.js';

const initializeCheckoutSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  amountNgn: z.coerce.number().positive('amountNgn must be greater than 0'),
  customerEmail: z.string().email().optional(),
  purpose: z.enum(['deposit', 'fund_agreement']).default('deposit'),
  agreementId: z.string().optional(),
  callbackUrl: z.string().url().optional(),
  allowedPaymentMethods: z.array(z.string()).optional(),
  provider: z.string().optional(),
});

const claimCheckoutSchema = z.object({
  orderReference: z.string().min(1, 'orderReference is required'),
  userId: z.string().min(1, 'userId is required'),
  purpose: z.enum(['deposit', 'fund_agreement']).optional(),
  agreementId: z.string().optional(),
  provider: z.string().optional(),
});

export async function nombaCheckoutRoutes(app: FastifyInstance) {
  /**
   * GET /api/ngn/checkout/providers
   * Returns available checkout providers (Nomba, 9PSB, Paystack) and active default.
   */
  app.get('/api/ngn/checkout/providers', async (_req, reply) => {
    return reply.code(200).send({
      success: true,
      data: listAvailableCheckoutProviders(),
    });
  });

  /**
   * POST /api/ngn/checkout/initialize
   * Generates a hosted checkout order link via active or requested provider.
   */
  app.post(
    '/api/ngn/checkout/initialize',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const input = parseBody(initializeCheckoutSchema, request.body);

      try {
        const order = await sivanCheckoutService.createCheckoutOrder(
          {
            userId: input.userId,
            amountNgn: input.amountNgn,
            customerEmail: input.customerEmail,
            purpose: input.purpose,
            agreementId: input.agreementId,
            callbackUrl: input.callbackUrl,
            allowedPaymentMethods: input.allowedPaymentMethods,
          },
          input.provider
        );

        return reply.code(200).send({
          success: true,
          data: order,
        });
      } catch (err: any) {
        return reply.code(err.statusCode || 400).send({
          success: false,
          error: {
            message: err.message || 'Failed to initialize checkout order',
          },
        });
      }
    }
  );

  /**
   * POST /api/ngn/checkout/quote
   * Returns exact fee breakdown for a deposit amount using live Admin Hub settings.
   */
  app.post(
    '/api/ngn/checkout/quote',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const quoteSchema = z.object({
        amountNgn: z.coerce.number().positive('amountNgn must be greater than 0'),
      });
      const input = parseBody(quoteSchema, request.body);
      const settings = await getAdminFeeSettings().catch(() => undefined);
      const quote = calculateCheckoutFee(input.amountNgn, settings);
      return reply.code(200).send({
        success: true,
        data: quote,
      });
    }
  );

  /**
   * GET /api/ngn/checkout/verify/:orderReference
   * Queries provider upstream to authoritatively verify payment status.
   */
  app.get(
    '/api/ngn/checkout/verify/:orderReference',
    async (
      request: FastifyRequest<{
        Params: { orderReference: string };
        Querystring: { provider?: string };
      }>,
      reply: FastifyReply
    ) => {
      const { orderReference } = request.params;
      const { provider } = request.query;

      if (!orderReference) {
        throw badRequest('orderReference parameter is required');
      }

      try {
        const verification = await sivanCheckoutService.verifyCheckoutTransaction(
          orderReference,
          provider
        );
        return reply.code(200).send({
          success: true,
          data: verification,
        });
      } catch (err: any) {
        return reply.code(err.statusCode || 500).send({
          success: false,
          error: {
            message: err.message || 'Failed to verify checkout transaction',
          },
        });
      }
    }
  );

  /**
   * POST /api/ngn/checkout/claim
   * Enforces server-side re-query and credits the user's NGN balance or funds an agreement immediately.
   */
  app.post(
    '/api/ngn/checkout/claim',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const input = parseBody(claimCheckoutSchema, request.body);

      try {
        const verification = await sivanCheckoutService.verifyCheckoutTransaction(
          input.orderReference,
          input.provider
        );

        if (!verification.verified || verification.status !== 'SUCCESS') {
          return reply.code(400).send({
            success: false,
            error: {
              message: `Payment is not confirmed. Status: ${verification.status}`,
              status: verification.status,
            },
          });
        }

        const processing = await sivanCheckoutService.processCheckoutSuccess(verification);

        return reply.code(200).send({
          success: true,
          data: processing,
        });
      } catch (err: any) {
        return reply.code(err.statusCode || 400).send({
          success: false,
          error: {
            message: err.message || 'Failed to claim checkout payment',
          },
        });
      }
    }
  );
}

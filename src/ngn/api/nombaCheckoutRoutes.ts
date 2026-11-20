/**
 * SIVAN NOMBA CHECKOUT ROUTES
 *
 * Fastify endpoints for:
 * - Hosted Checkout session initialization (POST /api/ngn/checkout/initialize)
 * - Server-side transaction verification (GET /api/ngn/checkout/verify/:orderReference)
 * - Immediate client-side settlement claim (POST /api/ngn/checkout/claim)
 */

import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { badRequest } from '../../shared/errors.js';
import { nombaCheckoutService } from '../service/nomba-checkout.service.js';

const initializeCheckoutSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  amountNgn: z.coerce.number().positive('amountNgn must be greater than 0'),
  customerEmail: z.string().email().optional(),
  purpose: z.enum(['deposit', 'fund_agreement']).default('deposit'),
  agreementId: z.string().optional(),
  callbackUrl: z.string().url().optional(),
  allowedPaymentMethods: z.array(z.enum(['Card', 'Transfer', 'USSD', 'Apple Pay'])).optional(),
});

const claimCheckoutSchema = z.object({
  orderReference: z.string().min(1, 'orderReference is required'),
  userId: z.string().min(1, 'userId is required'),
  purpose: z.enum(['deposit', 'fund_agreement']).optional(),
  agreementId: z.string().optional(),
});

export async function nombaCheckoutRoutes(app: FastifyInstance) {
  /**
   * POST /api/ngn/checkout/initialize
   * Generates a hosted Nomba Checkout order link for balance deposit or Service Agreement funding.
   */
  app.post(
    '/api/ngn/checkout/initialize',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const input = parseBody(initializeCheckoutSchema, request.body);

      try {
        const order = await nombaCheckoutService.createCheckoutOrder({
          userId: input.userId,
          amountNgn: input.amountNgn,
          customerEmail: input.customerEmail,
          purpose: input.purpose,
          agreementId: input.agreementId,
          callbackUrl: input.callbackUrl,
          allowedPaymentMethods: input.allowedPaymentMethods,
        });

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
   * GET /api/ngn/checkout/verify/:orderReference
   * Queries Nomba to authoritatively verify payment status.
   */
  app.get(
    '/api/ngn/checkout/verify/:orderReference',
    async (request: FastifyRequest<{ Params: { orderReference: string } }>, reply: FastifyReply) => {
      const { orderReference } = request.params;
      if (!orderReference) {
        throw badRequest('orderReference parameter is required');
      }

      try {
        const verification = await nombaCheckoutService.verifyCheckoutTransaction(orderReference);
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
        const result = await nombaCheckoutService.processCheckoutSuccess(
          input.orderReference,
          input.userId,
          input.purpose,
          input.agreementId
        );

        return reply.code(200).send({
          success: true,
          data: result,
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

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { b2bMerchantService } from '../service/b2b-merchant.service.js';

const createMerchantSchema = z.object({
  name: z.string().min(2, 'Merchant name is required'),
  slug: z.string().optional(),
  email: z.string().email('Valid email is required'),
  phone: z.string().min(7, 'Valid phone is required'),
  webhookUrl: z.string().url('Must be a valid URL').optional(),
  customGreeting: z.string().optional(),
  customButtonLabel: z.string().optional(),
  customSuccessMessage: z.string().optional(),
});

const dispatchFlowSchema = z.object({
  customerPhone: z.string().min(7, 'customerPhone is required'),
  customerName: z.string().optional(),
  amountNgn: z.number().positive('amountNgn must be a positive number'),
  currency: z.string().optional().default('NGN'),
  orderReference: z.string().optional(),
  flowType: z.string().optional().default('checkout'),
  greetingMessage: z.string().optional(),
  buttonLabel: z.string().optional(),
  successMessage: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export async function businessRoutes(app: FastifyInstance) {
  /**
   * POST /api/v1/business/merchants
   * Onboards a new merchant and provisions their live API key pair.
   */
  app.post('/api/v1/business/merchants', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const input = createMerchantSchema.parse(request.body);
      const result = await b2bMerchantService.createMerchant(input);
      return reply.status(201).send({
        success: true,
        merchant: result.merchant,
        keys: {
          secretKey: result.secretKey,
          publicKey: result.publicKey,
        },
        message: 'Merchant created successfully. Store your secret key securely; it will not be displayed again.',
      });
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err?.message || 'Failed to create merchant',
      });
    }
  });

  /**
   * POST /api/v1/business/flows/dispatch
   * Dispatches an interactive WhatsApp Meta Flow or mobile checkout to a customer.
   * Authenticated via: Authorization: Bearer sk_live_...
   */
  app.post('/api/v1/business/flows/dispatch', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const authHeader = request.headers.authorization;
      const { merchant } = await b2bMerchantService.authenticateApiKey(authHeader);

      const input = dispatchFlowSchema.parse(request.body);
      const flow = await b2bMerchantService.dispatchFlow(merchant, input);

      return reply.status(200).send({
        success: true,
        merchant: {
          id: merchant.id,
          name: merchant.name,
        },
        flow,
      });
    } catch (err: any) {
      const statusCode = err?.message?.includes('Unauthorized') ? 401 : 400;
      return reply.status(statusCode).send({
        success: false,
        error: err?.message || 'Flow dispatch failed',
      });
    }
  });

  /**
   * GET /api/v1/business/flows/:reference
   * Queries status and details of a dispatched flow.
   * Authenticated via: Authorization: Bearer sk_live_...
   */
  app.get('/api/v1/business/flows/:reference', async (request: FastifyRequest<{ Params: { reference: string } }>, reply: FastifyReply) => {
    try {
      const authHeader = request.headers.authorization;
      await b2bMerchantService.authenticateApiKey(authHeader);

      const { reference } = request.params;
      const flow = await b2bMerchantService.getFlowByReference(reference);

      if (!flow) {
        return reply.status(404).send({
          success: false,
          error: `Flow with reference "${reference}" not found`,
        });
      }

      return reply.send({
        success: true,
        flow,
      });
    } catch (err: any) {
      const statusCode = err?.message?.includes('Unauthorized') ? 401 : 400;
      return reply.status(statusCode).send({
        success: false,
        error: err?.message || 'Failed to fetch flow',
      });
    }
  });

  /**
   * POST /api/v1/business/flows/:reference/simulate-complete
   * Simulates settlement of a flow for integration testing and triggers webhook dispatch.
   */
  app.post('/api/v1/business/flows/:reference/simulate-complete', async (request: FastifyRequest<{ Params: { reference: string } }>, reply: FastifyReply) => {
    try {
      const authHeader = request.headers.authorization;
      await b2bMerchantService.authenticateApiKey(authHeader);

      const { reference } = request.params;
      const flow = await b2bMerchantService.getFlowByReference(reference);
      if (!flow) {
        return reply.status(404).send({ success: false, error: 'Flow not found' });
      }

      const ok = await b2bMerchantService.completeFlow(reference, flow.amountNgn);
      return reply.send({
        success: ok,
        reference,
        status: 'COMPLETED',
        message: 'Flow marked as completed and webhook event dispatched to merchant',
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err?.message || 'Failed to complete flow' });
    }
  });
}

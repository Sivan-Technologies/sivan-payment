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

const toggleStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

const dispatchFlowSchema = z.object({
  customerPhone: z.string().min(7, 'customerPhone is required'),
  customerName: z.string().optional(),
  amountNgn: z.number().positive('amountNgn must be a positive number'),
  currency: z.string().optional().default('NGN'),
  orderReference: z.string().optional(),
  flowType: z.string().optional().default('checkout'),
  includeVirtualAccount: z.boolean().optional().default(false),
  greetingMessage: z.string().optional(),
  buttonLabel: z.string().optional(),
  successMessage: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export async function businessRoutes(app: FastifyInstance) {
  /**
   * GET /api/v1/business/merchants
   * Lists all onboarded B2B merchants for the Sivan Admin Hub.
   */
  app.get('/api/v1/business/merchants', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const merchants = await b2bMerchantService.listMerchants();
      return reply.send({
        success: true,
        merchants,
      });
    } catch (err: any) {
      return reply.status(500).send({
        success: false,
        error: err?.message || 'Failed to list merchants',
      });
    }
  });

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
   * PUT /api/v1/business/merchants/:id/status
   * Toggles merchant status between ACTIVE and SUSPENDED.
   */
  app.put('/api/v1/business/merchants/:id/status', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const { status } = toggleStatusSchema.parse(request.body);
      const merchant = await b2bMerchantService.toggleMerchantStatus(id, status);

      if (!merchant) {
        return reply.status(404).send({ success: false, error: 'Merchant not found' });
      }

      return reply.send({
        success: true,
        merchant,
      });
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err?.message || 'Failed to update merchant status',
      });
    }
  });

  /**
   * POST /api/v1/business/merchants/:id/rotate-key
   * Rotates a merchant's API key.
   */
  app.post('/api/v1/business/merchants/:id/rotate-key', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const keys = await b2bMerchantService.rotateApiKey(id, 'live');
      return reply.send({
        success: true,
        keys,
        message: 'New API key generated successfully. Previous keys revoked.',
      });
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err?.message || 'Failed to rotate API key',
      });
    }
  });

  /**
   * GET /api/v1/business/merchants/:id/flows
   * Lists dispatched flows for a specific merchant.
   */
  app.get('/api/v1/business/merchants/:id/flows', async (request: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const limit = Math.min(parseInt(request.query.limit || '50', 10), 100);
      const offset = parseInt(request.query.offset || '0', 10);
      const flows = await b2bMerchantService.listMerchantFlows(id, limit, offset);

      return reply.send({
        success: true,
        flows,
      });
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err?.message || 'Failed to list merchant flows',
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
      if (!authHeader) {
        return reply.status(401).send({ success: false, error: 'Missing Authorization header' });
      }

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
      const statusCode = err?.message?.includes('Authentication failed') ? 401 : 400;
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
      if (!authHeader) {
        return reply.status(401).send({ success: false, error: 'Missing Authorization header' });
      }

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
      const statusCode = err?.message?.includes('Authentication failed') ? 401 : 400;
      return reply.status(statusCode).send({
        success: false,
        error: err?.message || 'Failed to fetch flow',
      });
    }
  });

  /**
   * POST /api/v1/business/flows/:reference/simulate-complete
   * Simulates settlement of a flow for integration testing and queues webhook into outbox.
   */
  app.post('/api/v1/business/flows/:reference/simulate-complete', async (request: FastifyRequest<{ Params: { reference: string } }>, reply: FastifyReply) => {
    try {
      const authHeader = request.headers.authorization;
      if (!authHeader) {
        return reply.status(401).send({ success: false, error: 'Missing Authorization header' });
      }

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
        message: 'Flow marked as completed and webhook event queued into durable outbox',
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err?.message || 'Failed to complete flow' });
    }
  });

  /**
   * POST /api/v1/business/webhooks/:id/retry
   * Manually retries a webhook outbox delivery.
   */
  app.post('/api/v1/business/webhooks/:id/retry', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const ok = await b2bMerchantService.retryWebhook(id);
      return reply.send({
        success: ok,
        message: 'Webhook delivery triggered',
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err?.message || 'Failed to retry webhook' });
    }
  });
}

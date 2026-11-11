import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { z } from 'zod';
import { b2bMerchantService } from '../service/b2b-merchant.service.js';
import type { B2bMerchantRecord } from '../../database/types.js';

const createMerchantSchema = z.object({
  name: z.string().min(2, 'Merchant name is required'),
  slug: z.string().optional(),
  email: z.string().email('Valid email is required'),
  phone: z.string().min(7, 'Valid phone is required'),
  password: z.string().min(6, 'Password must be at least 6 characters').optional(),
  webhookUrl: z.string().url('Must be a valid URL').optional(),
  sandboxWebhookUrl: z.string().url('Must be a valid URL').optional(),
  customGreeting: z.string().optional(),
  customButtonLabel: z.string().optional(),
  customSuccessMessage: z.string().optional(),
});

const partnerSignupSchema = z.object({
  name: z.string().min(2, 'Business name is required'),
  slug: z.string().optional(),
  email: z.string().email('Valid email is required'),
  phone: z.string().min(7, 'Valid phone is required'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  webhookUrl: z.string().url('Must be a valid URL').optional().or(z.literal('')),
  sandboxWebhookUrl: z.string().url('Must be a valid URL').optional().or(z.literal('')),
  customGreeting: z.string().optional(),
  customButtonLabel: z.string().optional(),
  customSuccessMessage: z.string().optional(),
});

const partnerLoginSchema = z.object({
  email: z.string().email('Valid email is required'),
  password: z.string().min(1, 'Password is required'),
});

const partnerWebhookUpdateSchema = z.object({
  webhookUrl: z.string().url('Must be a valid URL').optional().or(z.literal('')),
  sandboxWebhookUrl: z.string().url('Must be a valid URL').optional().or(z.literal('')),
});

const partnerRotateKeySchema = z.object({
  mode: z.enum(['test', 'live']).default('test'),
});

const requestLiveAccessSchema = z.object({
  websiteUrl: z.string().url('Must be a valid URL').optional().or(z.literal('')),
  useCase: z.string().min(5, 'Use case description is required (min 5 characters)'),
  estimatedMonthlyVolume: z.string().min(1, 'Estimated monthly volume is required'),
  businessDescription: z.string().optional(),
  targetLaunchDate: z.string().optional(),
});

const toggleLiveApiSchema = z.object({
  isLiveEnabled: z.boolean(),
  approvedBy: z.string().optional(),
});

const toggleStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
});

async function authenticatePartner(request: FastifyRequest): Promise<B2bMerchantRecord> {
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    throw new Error('Missing Authorization header');
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    throw new Error('Invalid bearer token');
  }
  return await b2bMerchantService.verifyPartnerToken(token);
}

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
   * GET /api/v1/business/merchants/:id/customers
   * Admin endpoint to inspect individual customer breakdown for a merchant.
   */
  app.get('/api/v1/business/merchants/:id/customers', async (request: FastifyRequest<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const limit = Math.min(parseInt(request.query.limit || '50', 10), 100);
      const offset = parseInt(request.query.offset || '0', 10);
      const data = await b2bMerchantService.getPartnerCustomerMetrics(id, limit, offset);

      return reply.send({
        success: true,
        summary: data.summary,
        customers: data.customers,
      });
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err?.message || 'Failed to fetch customer metrics for merchant',
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

  // ==========================================
  // PARTNER PORTAL ENDPOINTS (partner.sivantech.online)
  // ==========================================

  /**
   * POST /api/v1/business/partner/signup
   * Self-serve partner onboarding. Provisions sandbox & live keys, hashes password, and returns session token.
   */
  app.post('/api/v1/business/partner/signup', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const input = partnerSignupSchema.parse(request.body);
      const result = await b2bMerchantService.createMerchant({
        name: input.name,
        slug: input.slug,
        email: input.email,
        phone: input.phone,
        password: input.password,
        webhookUrl: input.webhookUrl || undefined,
        sandboxWebhookUrl: input.sandboxWebhookUrl || undefined,
        customGreeting: input.customGreeting,
        customButtonLabel: input.customButtonLabel,
        customSuccessMessage: input.customSuccessMessage,
      });

      const token = b2bMerchantService.generatePartnerToken(result.merchant.id);

      return reply.status(201).send({
        success: true,
        token,
        merchant: result.merchant,
        keys: {
          sandbox: {
            secretKey: result.sandboxSecretKey,
            publicKey: result.sandboxPublicKey,
          },
          live: {
            secretKey: result.secretKey,
            publicKey: result.publicKey,
          },
        },
        message: 'Partner account created successfully. Store your keys securely.',
      });
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err?.message || 'Partner signup failed',
      });
    }
  });

  /**
   * POST /api/v1/business/partner/login
   * Authenticates partner via email + password and issues a signed session token.
   */
  app.post('/api/v1/business/partner/login', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { email, password } = partnerLoginSchema.parse(request.body);
      const { token, merchant } = await b2bMerchantService.partnerLogin(email, password);

      return reply.send({
        success: true,
        token,
        merchant,
      });
    } catch (err: any) {
      return reply.status(401).send({
        success: false,
        error: err?.message || 'Invalid email or password',
      });
    }
  });

  /**
   * GET /api/v1/business/partner/profile
   * Returns authenticated partner profile with masked keys and webhook configuration.
   */
  app.get('/api/v1/business/partner/profile', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const merchant = await authenticatePartner(request);
      const profile = await b2bMerchantService.getMerchantProfile(merchant.id);

      if (!profile) {
        return reply.status(404).send({ success: false, error: 'Merchant profile not found' });
      }

      return reply.send({
        success: true,
        merchant: profile.merchant,
        keys: profile.keys,
      });
    } catch (err: any) {
      const statusCode = err?.message?.includes('token') || err?.message?.includes('Authorization') ? 401 : 400;
      return reply.status(statusCode).send({
        success: false,
        error: err?.message || 'Failed to fetch partner profile',
      });
    }
  });

  /**
   * POST /api/v1/business/partner/rotate-key
   * Rotates partner's test or live API key and returns the raw secret key once.
   */
  app.post('/api/v1/business/partner/rotate-key', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const merchant = await authenticatePartner(request);
      const { mode } = partnerRotateKeySchema.parse(request.body);
      const keys = await b2bMerchantService.rotateApiKey(merchant.id, mode);

      return reply.send({
        success: true,
        mode,
        keys,
        message: `New ${mode} API key generated. Previous ${mode} key has been revoked.`,
      });
    } catch (err: any) {
      const statusCode = err?.message?.includes('token') || err?.message?.includes('Authorization') ? 401 : 400;
      return reply.status(statusCode).send({
        success: false,
        error: err?.message || 'Failed to rotate API key',
      });
    }
  });

  /**
   * POST /api/v1/business/partner/request-live-access
   * Submits a request for live production API access.
   */
  app.post('/api/v1/business/partner/request-live-access', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const merchant = await authenticatePartner(request);
      const input = requestLiveAccessSchema.parse(request.body);
      const application = await b2bMerchantService.submitLiveAccessRequest(merchant.id, input);

      return reply.send({
        success: true,
        application,
        message: 'Live access application submitted successfully. Sivan compliance will review your request shortly.',
      });
    } catch (err: any) {
      const statusCode = err?.message?.includes('token') || err?.message?.includes('Authorization') ? 401 : 400;
      return reply.status(statusCode).send({
        success: false,
        error: err?.message || 'Failed to submit live access request',
      });
    }
  });

  /**
   * PUT /api/v1/business/partner/webhook
   * Updates partner live and sandbox webhook callback URLs.
   */
  app.put('/api/v1/business/partner/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const merchant = await authenticatePartner(request);
      const { webhookUrl, sandboxWebhookUrl } = partnerWebhookUpdateSchema.parse(request.body);
      const updated = await b2bMerchantService.updateMerchantWebhooks(merchant.id, {
        webhookUrl: webhookUrl || undefined,
        sandboxWebhookUrl: sandboxWebhookUrl || undefined,
      });

      return reply.send({
        success: true,
        merchant: updated,
        message: 'Webhook endpoints updated successfully.',
      });
    } catch (err: any) {
      const statusCode = err?.message?.includes('token') || err?.message?.includes('Authorization') ? 401 : 400;
      return reply.status(statusCode).send({
        success: false,
        error: err?.message || 'Failed to update webhook URLs',
      });
    }
  });

  /**
   * GET /api/v1/business/partner/customers
   * Returns individual customer breakdown and aggregate metrics for partner dashboard.
   */
  app.get('/api/v1/business/partner/customers', async (request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>, reply: FastifyReply) => {
    try {
      const merchant = await authenticatePartner(request);
      const limit = Math.min(parseInt(request.query.limit || '50', 10), 100);
      const offset = parseInt(request.query.offset || '0', 10);
      const data = await b2bMerchantService.getPartnerCustomerMetrics(merchant.id, limit, offset);

      return reply.send({
        success: true,
        summary: data.summary,
        customers: data.customers,
      });
    } catch (err: any) {
      const statusCode = err?.message?.includes('token') || err?.message?.includes('Authorization') ? 401 : 400;
      return reply.status(statusCode).send({
        success: false,
        error: err?.message || 'Failed to fetch customer metrics',
      });
    }
  });

  /**
   * GET /api/v1/business/partner/flows
   * Lists dispatched flows for the authenticated partner.
   */
  app.get('/api/v1/business/partner/flows', async (request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>, reply: FastifyReply) => {
    try {
      const merchant = await authenticatePartner(request);
      const limit = Math.min(parseInt(request.query.limit || '50', 10), 100);
      const offset = parseInt(request.query.offset || '0', 10);
      const flows = await b2bMerchantService.listMerchantFlows(merchant.id, limit, offset);

      return reply.send({
        success: true,
        flows,
      });
    } catch (err: any) {
      const statusCode = err?.message?.includes('token') || err?.message?.includes('Authorization') ? 401 : 400;
      return reply.status(statusCode).send({
        success: false,
        error: err?.message || 'Failed to fetch flows',
      });
    }
  });

  /**
   * POST /api/v1/business/partner/webhook/test-ping
   * Queues an immediate test webhook delivery to test partner endpoints.
   */
  app.post('/api/v1/business/partner/webhook/test-ping', async (request: FastifyRequest<{ Body: { mode?: 'sandbox' | 'live' } }>, reply: FastifyReply) => {
    try {
      const merchant = await authenticatePartner(request);
      const mode = (request.body as any)?.mode || 'sandbox';
      const targetUrl = mode === 'live' ? merchant.webhookUrl : (merchant.sandboxWebhookUrl || merchant.webhookUrl);

      if (!targetUrl) {
        return reply.status(400).send({
          success: false,
          error: `No ${mode} webhook URL configured. Please set your webhook URL first.`,
        });
      }

      const pingPayload = {
        event: 'ping',
        merchantId: merchant.id,
        mode,
        timestamp: new Date().toISOString(),
        message: `Sivan Ai Partner Webhook Verification (${mode.toUpperCase()})`,
        data: {
          sampleCustomerPhone: '+2348012345678',
          sampleReference: `TEST_PING_${Date.now()}`,
          sampleAmountNgn: 5000,
          currency: 'NGN',
          status: 'VERIFIED',
        },
      };

      const payloadString = JSON.stringify(pingPayload);
      const signature = crypto
        .createHmac('sha256', merchant.webhookSecret || 'default_secret')
        .update(payloadString)
        .digest('hex');

      const pool = (b2bMerchantService as any).getPool();
      await pool.query(
        `INSERT INTO b2b_webhook_outbox (
           merchant_id, flow_id, event_type, destination_url, payload, signature_header, attempts, status, next_retry_at
         ) VALUES ($1, null, 'ping', $2, $3, $4, 0, 'PENDING', NOW())`,
        [merchant.id, targetUrl, pingPayload, signature]
      );

      // Trigger immediate background sweep
      void (b2bMerchantService as any).processWebhookOutbox().catch(() => { });

      return reply.send({
        success: true,
        mode,
        destinationUrl: targetUrl,
        message: `Test ping dispatched to ${targetUrl}`,
      });
    } catch (err: any) {
      const statusCode = err?.message?.includes('token') || err?.message?.includes('Authorization') ? 401 : 400;
      return reply.status(statusCode).send({
        success: false,
        error: err?.message || 'Failed to dispatch test ping',
      });
    }
  });

  /**
   * PUT /api/v1/business/merchants/:id/live-toggle
   * Sivan Admin endpoint to enable/disable live API keys for a partner.
   */
  app.put('/api/v1/business/merchants/:id/live-toggle', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const { id } = request.params;
      const { isLiveEnabled, approvedBy } = toggleLiveApiSchema.parse(request.body);
      const merchant = await b2bMerchantService.toggleMerchantLiveApi(id, isLiveEnabled, approvedBy || 'sivan_admin');

      if (!merchant) {
        return reply.status(404).send({ success: false, error: 'Merchant not found' });
      }

      return reply.send({
        success: true,
        merchant,
        message: `Merchant live API access ${isLiveEnabled ? 'ENABLED' : 'DISABLED'}`,
      });
    } catch (err: any) {
      return reply.status(400).send({
        success: false,
        error: err?.message || 'Failed to toggle merchant live API access',
      });
    }
  });
}

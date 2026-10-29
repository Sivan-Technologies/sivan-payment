import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { badRequest } from '../../shared/errors.js';
import {
  getDvaState,
  resolveOrCreateDva,
  syncDvaWithPaystack,
  adminGetDvaDetails,
  adminSyncUserDva,
  adminAssignUserDva,
  adminResetUserDva,
  adminOverrideUserDva,
  grantStagingDvaTestCredit,
  backfillStagingDvaTestCredits,
  findDvaRecord,
  type DvaState,
} from '../service/paystackDvaService.js';
import type { IdentificationType } from '../types/paystackDvaTypes.js';
import crypto from 'node:crypto';
import { db } from '../../database/json-database.js';
import { isPaystackLive, paystackMode, paystackWebhookSecret } from '../../config/paystackConfig.js';
import { processPaystackWebhook } from '../../webhooks/paystackWebhookHandler.js';

const createDvaSchema = z
  .object({
    userId: z.string().min(1, 'userId is required'),
    legalName: z.string().min(2, 'legalName is required'),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    identifier: z
      .string()
      .regex(/^\d{11}$/, 'Identifier (BVN) must be exactly 11 digits')
      .optional()
      .or(z.literal('')),
    identifierType: z.enum(['bvn', 'nin']).default('bvn'),
    phone: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (isPaystackLive() && (!val.identifier || !val.identifier.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identifier'],
        message: 'Identifier (BVN) is required in live mode and must be exactly 11 digits',
      });
    }
  });

const adminOverrideSchema = z.object({
  accountNumber: z.string().min(8, 'accountNumber is required'),
  bankName: z.string().optional(),
  accountName: z.string().optional(),
  status: z.enum(['active', 'provisioning', 'rejected']).optional(),
});

const adminResetSchema = z.object({
  reason: z.string().optional(),
});

/**
 * Extracts a clean phone number from explicit phone input or WhatsApp userId.
 * E.g. "whatsapp:+2348102524846" -> "+2348102524846"
 */
export function extractPhone(phone?: string, userId?: string): string {
  if (phone && phone.trim()) {
    return phone.trim();
  }
  if (!userId) return '';
  const cleaned = userId.replace(/^whatsapp:/i, '').trim();
  if (/^\+?\d{10,15}$/.test(cleaned)) {
    return cleaned;
  }
  return '';
}

export async function paystackDvaRoutes(app: FastifyInstance) {
  /**
   * GET /api/virtual-accounts/paystack/user/:userId
   * Fast, read-only lookup of the user's Dedicated Virtual Account state.
   */
  app.get(
    '/api/virtual-accounts/paystack/user/:userId',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const { userId } = request.params;
      if (!userId || !userId.trim()) {
        throw badRequest('userId parameter is required');
      }

      const state: DvaState = await getDvaState(userId);
      return reply.code(200).send({
        status: 'success',
        data: {
          ...state,
          mode: paystackMode(),
        },
      });
    }
  );

  /**
   * POST /api/virtual-accounts/paystack/user/:userId/sync
   * Actively polls Paystack to check if BVN identity verification has resolved
   * or if a dedicated account has been assigned.
   */
  app.post(
    '/api/virtual-accounts/paystack/user/:userId/sync',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const { userId } = request.params;
      if (!userId || !userId.trim()) {
        throw badRequest('userId parameter is required');
      }

      const state: DvaState = await syncDvaWithPaystack(userId);
      return reply.code(200).send({
        status: 'success',
        data: {
          ...state,
          mode: paystackMode(),
        },
      });
    }
  );

  /**
   * POST /api/virtual-accounts/paystack/create
   * Initiates or advances DVA creation. Accepts legal name and 11-digit BVN/NIN in live mode.
   * In test mode, creates directly without blocking on BVN.
   * Auto-extracts WhatsApp phone if not explicitly provided.
   */
  app.post(
    '/api/virtual-accounts/paystack/create',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = parseBody(createDvaSchema, request.body);
      const phone = extractPhone(body.phone, body.userId);

      const state: DvaState = await resolveOrCreateDva({
        userId: body.userId,
        legalName: body.legalName,
        firstName: body.firstName || undefined,
        lastName: body.lastName || undefined,
        identifier: body.identifier || undefined,
        identifierType: body.identifierType as IdentificationType,
        phone,
      });

      const responsePayload = {
        ...state,
        mode: paystackMode(),
      };

      if (state.state === 'ready') {
        return reply.code(200).send({
          status: 'success',
          data: responsePayload,
        });
      }

      if (state.state === 'verifying') {
        return reply.code(202).send({
          status: 'verifying',
          data: responsePayload,
        });
      }

      if (state.state === 'failed') {
        return reply.code(400).send({
          status: 'failed',
          data: responsePayload,
        });
      }

      return reply.code(200).send({
        status: 'awaiting_identity',
        data: responsePayload,
      });
    }
  );

  /**
   * ADMIN ROUTES: Virtual Account Diagnostics & Resolution
   */

  /**
   * GET /api/admin/virtual-accounts/paystack/user/:userId
   * Full diagnostics of user's Paystack DVA state, DB records, and upstream Paystack account.
   */
  app.get(
    '/api/admin/virtual-accounts/paystack/user/:userId',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const { userId } = request.params;
      const details = await adminGetDvaDetails(userId);
      return reply.code(200).send({
        status: 'success',
        data: details,
      });
    }
  );

  /**
   * POST /api/admin/virtual-accounts/paystack/user/:userId/sync
   * Admin triggers live Paystack sync to auto-resolve pending NIBSS verifications.
   */
  app.post(
    '/api/admin/virtual-accounts/paystack/user/:userId/sync',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const { userId } = request.params;
      const result = await adminSyncUserDva(userId);
      return reply.code(200).send({
        status: 'success',
        data: result,
      });
    }
  );

  /**
   * POST /api/admin/virtual-accounts/paystack/user/:userId/assign
   * Admin triggers dedicated virtual account assignment for an already identified customer.
   */
  app.post(
    '/api/admin/virtual-accounts/paystack/user/:userId/assign',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const { userId } = request.params;
      const state = await adminAssignUserDva(userId);
      return reply.code(200).send({
        status: 'success',
        data: state,
      });
    }
  );

  /**
   * POST /api/admin/virtual-accounts/paystack/user/:userId/reset
   * Admin resets stuck/failed DVA record so the user can re-enter BVN in chat.
   */
  app.post(
    '/api/admin/virtual-accounts/paystack/user/:userId/reset',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const { userId } = request.params;
      const body = request.body ? parseBody(adminResetSchema, request.body) : {};
      const res = await adminResetUserDva(userId, body.reason);
      return reply.code(200).send({
        status: 'success',
        data: res,
      });
    }
  );

  /**
   * POST /api/admin/virtual-accounts/paystack/user/:userId/override
   * Admin manually fixes/overrides virtual account details for the naira flow.
   */
  app.post(
    '/api/admin/virtual-accounts/paystack/user/:userId/override',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const { userId } = request.params;
      const body = parseBody(adminOverrideSchema, request.body);
      const state = await adminOverrideUserDva(userId, body);
      return reply.code(200).send({
        status: 'success',
        data: state,
      });
    }
  );

  /**
   * POST /api/admin/virtual-accounts/paystack/fund-staging-wallets
   * Backfills 50,000 NGN test credit facility across existing staging users with DVAs.
   * Strictly blocked in production.
   */
  app.post(
    '/api/admin/virtual-accounts/paystack/fund-staging-wallets',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const result = await backfillStagingDvaTestCredits();
      return reply.code(200).send({
        status: 'success',
        data: result,
      });
    }
  );

  /**
   * POST /api/admin/virtual-accounts/paystack/user/:userId/test-credit
   * Grants 50,000 NGN test credit facility to a specific user in staging.
   * Strictly blocked in production.
   */
  app.post(
    '/api/admin/virtual-accounts/paystack/user/:userId/test-credit',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const { userId } = request.params;
      const funded = await grantStagingDvaTestCredit(userId);
      return reply.code(200).send({
        status: 'success',
        data: { userId, funded },
      });
    }
  );

  /**
   * POST /api/virtual-accounts/sandbox/simulate-inflow
   * POST /api/virtual-accounts/paystack/sandbox/simulate-inflow
   * Option B: Test Checkout Simulation Route (Simulate Payment & Catch Webhook).
   * STRICTLY BLOCKED in production.
   * Generates an authentic signed Paystack charge.success webhook for dedicated_nuban
   * and processes it through the authoritative Paystack webhook handler.
   */
  const simulateInflowHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    if (isPaystackLive() || process.env.APP_ENV === 'production' || process.env.DATABASE_MODE === 'live') {
      return reply.code(403).send({
        status: 'forbidden',
        error: 'Simulation routes are strictly disabled in production mode.',
        mode: 'production',
      });
    }

    const body = (request.body as any) || {};
    const amount = Number(body.amount || 50000);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw badRequest('Amount must be a positive number');
    }

    const allAccounts = await db.listVirtualAccounts();
    let account = allAccounts.find(
      (acc) =>
        (body.userId && acc.userId === body.userId) ||
        (body.accountNumber && acc.accountNumberMasked?.endsWith(body.accountNumber.slice(-4))) ||
        (body.customerCode && acc.customerId === body.customerCode)
    );

    if (!account && body.userId) {
      account = (await findDvaRecord(body.userId)) ?? undefined;
    }

    if (!account) {
      throw badRequest('Could not locate an active virtual account for the provided userId, customerCode, or accountNumber');
    }

    const user = await db.findUserById(account.userId);
    const customerCode = account.customerId || `CUS_test_${account.userId}`;
    const amountKobo = Math.round(amount * 100);
    const reference = `sim_inflow_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const eventPayload = {
      event: 'charge.success',
      data: {
        id: Date.now(),
        domain: 'test',
        status: 'success',
        reference,
        amount: amountKobo,
        currency: 'NGN',
        channel: 'dedicated_nuban',
        customer: {
          id: 123456,
          customer_code: customerCode,
          email: user?.email || `${account.userId}@sivan.test`,
          first_name: user?.fullName?.split(' ')[0] || 'Staging',
          last_name: user?.fullName?.split(' ').slice(1).join(' ') || 'Tester',
          phone: user?.whatsappNumber || '',
        },
        paid_at: new Date().toISOString(),
      },
    };

    const rawBody = Buffer.from(JSON.stringify(eventPayload), 'utf8');
    const secret = paystackWebhookSecret();
    const signature = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

    const result = await processPaystackWebhook(eventPayload, rawBody, signature);

    return reply.code(200).send({
      status: 'success',
      environment: 'staging',
      simulation: true,
      mode: 'sandbox',
      reference,
      amount,
      currency: 'NGN',
      creditedUserId: account.userId,
      webhookResult: result,
    });
  };

  app.post('/api/virtual-accounts/sandbox/simulate-inflow', simulateInflowHandler);
  app.post('/api/virtual-accounts/paystack/sandbox/simulate-inflow', simulateInflowHandler);
}



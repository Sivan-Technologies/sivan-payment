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
  type DvaState,
} from '../service/paystackDvaService.js';
import type { IdentificationType } from '../types/paystackDvaTypes.js';
import { isPaystackLive, paystackMode } from '../../config/paystackConfig.js';

const createDvaSchema = z
  .object({
    userId: z.string().min(1, 'userId is required'),
    legalName: z.string().min(2, 'legalName is required'),
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
}


import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { badRequest } from '../../shared/errors.js';
import {
  getDvaState,
  resolveOrCreateDva,
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
}

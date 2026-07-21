import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../../shared/validation.js';
import { env } from '../../config/env.js';
import { forbidden } from '../../shared/errors.js';
import { answerAceSupport } from '../service/ace-support.service.js';
import { answerWhatsappAceSupport } from '../service/ace-whatsapp.service.js';
import { aceSupportRequestSchema } from '../types/ace.types.js';

const adminAceSupportRequestSchema = aceSupportRequestSchema.extend({ userId: z.string().optional() });
const whatsappAceSupportRequestSchema = aceSupportRequestSchema.extend({ whatsappNumber: z.string().min(8).max(32) });

function requireAceServiceSecret(request: any) {
  const configured = env.IDENTITY_LINK_SERVICE_SECRET || env.ADMIN_API_KEY;
  if (!configured) throw forbidden('Ace WhatsApp service secret is not configured.');
  const provided = request.headers['x-sivan-identity-link-secret'] || request.headers['x-admin-api-key'];
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (value !== configured) throw forbidden('Invalid Ace WhatsApp service secret.');
}

export async function aceSupportRoutes(app: FastifyInstance) {
  app.post('/api/users/:userId/ace/support', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(aceSupportRequestSchema, request.body);
    return { data: await answerAceSupport({ userId, ...body, admin: false }) };
  });

  app.post('/api/admin/ace/support', async (request) => {
    const body = parseBody(adminAceSupportRequestSchema, request.body);
    return { data: await answerAceSupport({ userId: body.userId, message: body.message, resourceType: body.resourceType, resourceId: body.resourceId, channel: 'admin_hub', admin: true }) };
  });

  app.post('/api/ace/whatsapp/support', async (request) => {
    requireAceServiceSecret(request);
    const body = parseBody(whatsappAceSupportRequestSchema, request.body);
    return { data: await answerWhatsappAceSupport({ whatsappNumber: body.whatsappNumber, message: body.message, resourceType: body.resourceType, resourceId: body.resourceId }) };
  });
}

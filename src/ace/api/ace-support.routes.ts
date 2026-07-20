import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../../shared/validation.js';
import { answerAceSupport } from '../service/ace-support.service.js';
import { aceSupportRequestSchema } from '../types/ace.types.js';

const adminAceSupportRequestSchema = aceSupportRequestSchema.extend({ userId: z.string().optional() });

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
}

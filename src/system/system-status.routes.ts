import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { getSystemStatus, updateSystemStatus, updateSystemStatusSchema } from './system-status.service.js';

export async function systemStatusRoutes(app: FastifyInstance) {
  app.get('/api/system/status', async () => ({ data: await getSystemStatus() }));
  app.get('/api/admin/system/status', async () => ({ data: await getSystemStatus() }));
  app.put('/api/admin/system/status', async (request) => {
    const body = parseBody(updateSystemStatusSchema, request.body);
    return { data: await updateSystemStatus(body) };
  });
}

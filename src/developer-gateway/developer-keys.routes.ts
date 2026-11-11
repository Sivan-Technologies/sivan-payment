import type { FastifyInstance } from 'fastify';
import { developerKeysService, IssueDeveloperKeyInput } from './developer-keys.service.js';

export async function developerKeysRoutes(app: FastifyInstance) {
  // Admin list all developer keys
  app.get('/api/admin/developer-keys', async () => {
    const keys = await developerKeysService.listKeys();
    return { success: true, keys, total: keys.length };
  });

  // Admin issue new developer key
  app.post('/api/admin/developer-keys', async (request, reply) => {
    const body = (request.body as IssueDeveloperKeyInput) || {};
    if (!body.developerName || !body.email) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'developerName and email are required' },
      });
    }

    const createdBy = (request as any).adminUser?.id || (request.headers['x-admin-actor'] as string) || 'superadmin';
    const result = await developerKeysService.issueKey({ ...body, createdBy });
    return reply.code(201).send({
      success: true,
      key: result.record,
      secretKey: result.secretKey, // Returned once only!
    });
  });

  // Admin revoke developer key
  app.post('/api/admin/developer-keys/:id/revoke', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { reason?: string }) || {};
    const success = await developerKeysService.revokeKey(id, body.reason);
    if (!success) {
      return reply.code(404).send({
        error: { code: 'not_found', message: 'Developer API key not found' },
      });
    }
    return { success: true, message: 'Developer API key revoked' };
  });

  // Admin view key request logs
  app.get('/api/admin/developer-keys/:id/logs', async (request) => {
    const { id } = request.params as { id: string };
    const query = (request.query as { limit?: string }) || {};
    const limit = Number(query.limit) > 0 ? Number(query.limit) : 50;
    const logs = await developerKeysService.getKeyLogs(id, limit);
    return { success: true, logs, total: logs.length };
  });

  // Admin view aggregate usage analytics
  app.get('/api/admin/developer-analytics', async () => {
    const analytics = await developerKeysService.getAnalytics();
    return { success: true, analytics };
  });
}

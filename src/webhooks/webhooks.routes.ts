import type { FastifyInstance } from 'fastify';
import { processBridgeWebhook } from './webhooks.service.js';

export async function webhooksRoutes(app: FastifyInstance) {
  app.post('/api/webhooks/bridge', async (request, reply) => {
    const rawBody = (request as any).rawBody as Buffer | undefined;
    const signature = request.headers['x-webhook-signature'];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;
    const result = await processBridgeWebhook(request.body as any, rawBody ?? Buffer.from(JSON.stringify(request.body ?? {})), signatureHeader);
    return reply.code(200).send({ data: result });
  });
}

import type { FastifyInstance } from 'fastify';
import { processBridgeWebhook } from './webhooks.service.js';

export async function webhooksRoutes(app: FastifyInstance) {
  app.post('/api/webhooks/bridge', async (request, reply) => {
    const rawBody = (request as any).rawBody as Buffer | undefined;
    const signature = request.headers['x-webhook-signature'];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;
    /**
     * `?? {}` because a POST with NO BODY AT ALL never reaches a content-type
     * parser - Fastify skips parsing entirely and leaves request.body
     * undefined. The service then read `payload.event_id` off undefined and
     * threw a TypeError, which surfaced as a 500 rather than the honest 400.
     *
     * Found while fixing the raw-body crash: a bare `curl -X POST` with no
     * body and no Content-Type, which is exactly the shape of a naive
     * uptime check or a provider's connectivity probe.
     */
    const result = await processBridgeWebhook(
      (request.body ?? {}) as any,
      rawBody ?? Buffer.from(JSON.stringify(request.body ?? {})),
      signatureHeader
    );
    return reply.code(200).send({ data: result });
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notifyOpsClientError, sendTelegramOpsMessage } from '../monitoring/telegram-ops-alert.js';

const clientErrorSchema = z.object({
  message: z.string().min(1).max(1000),
  route: z.string().optional().default('/'),
  stack: z.string().optional(),
  userAgent: z.string().optional(),
  platform: z.string().optional(),
  userId: z.string().optional(),
  appVersion: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

// In-memory sliding window rate limiter: max 10 errors per minute per IP
const ipRateLimits = new Map<string, { count: number; windowStart: number }>();
// Signature debounce: 60s per unique error message signature
const recentSignatures = new Map<string, number>();

export async function telemetryRoutes(app: FastifyInstance) {
  /**
   * Ingest client-side errors from sivan-user-frontend (app.sivantech.online).
   * Rate-limited and debounced before dispatching to Telegram Ops.
   */
  app.post('/api/telemetry/client-error', async (request, reply) => {
    const ip = request.ip || 'unknown';
    const now = Date.now();

    // 1. IP rate limiting (max 10 error reports per minute per IP)
    const limit = ipRateLimits.get(ip) || { count: 0, windowStart: now };
    if (now - limit.windowStart > 60000) {
      limit.count = 1;
      limit.windowStart = now;
    } else {
      limit.count++;
      if (limit.count > 10) {
        return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many error reports from this origin' } });
      }
    }
    ipRateLimits.set(ip, limit);

    // 2. Parse & validate body
    const parsed = clientErrorSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_payload', message: 'Invalid error report format' } });
    }

    const data = parsed.data;
    const signature = `${ip}:${data.route}:${data.message}`;
    const lastSent = recentSignatures.get(signature) || 0;

    // 3. Debounce identical error signatures for 60s
    if (now - lastSent > 60000) {
      recentSignatures.set(signature, now);

      // Clean up old signatures periodically
      if (recentSignatures.size > 200) {
        for (const [k, v] of recentSignatures.entries()) {
          if (now - v > 60000) recentSignatures.delete(k);
        }
      }

      void notifyOpsClientError({
        message: data.message,
        route: data.route,
        stack: data.stack,
        userAgent: data.userAgent || (request.headers['user-agent'] as string) || data.platform,
        userId: data.userId,
        clientIp: ip,
      });
    }

    return { success: true };
  });

  /**
   * Harmless synthetic ping route for ops health testing.
   */
  app.post('/api/telemetry/ops-ping', async (request) => {
    const body = (request.body || {}) as { service?: string; reason?: string };
    const serviceName = body.service || 'sivan-payments';
    const reason = body.reason || 'Synthetic operational health ping';
    const text = `🔔 *SIVAN OPS SYNTHETIC PING*\n*Service:* \`${serviceName}\`\n*Reason:* ${reason}\n*Timestamp:* \`${new Date().toISOString()}\``;
    const delivered = await sendTelegramOpsMessage(text);
    return { success: true, delivered, timestamp: new Date().toISOString() };
  });
}

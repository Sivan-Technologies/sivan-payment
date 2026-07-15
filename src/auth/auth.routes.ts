import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { startEmailAuth, startEmailAuthSchema, verifyEmailAuth, verifyEmailAuthSchema } from './auth.service.js';
import { verifyUserJwt } from './jwt.js';
import { getUser } from '../users/users.service.js';

export async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/email/start', async (request) => {
    const body = parseBody(startEmailAuthSchema, request.body);
    return { data: await startEmailAuth(body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/auth/email/verify', async (request) => {
    const body = parseBody(verifyEmailAuthSchema, request.body);
    return { data: await verifyEmailAuth(body) };
  });

  app.get('/api/auth/me', async (request, reply) => {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) return reply.code(401).send({ error: { code: 'auth_required', message: 'Authentication required' } });
    try {
      const payload = verifyUserJwt(token);
      return { data: { user: await getUser(payload.sub), tokenExpiresAt: new Date(payload.exp * 1000).toISOString() } };
    } catch {
      return reply.code(401).send({ error: { code: 'invalid_token', message: 'Invalid or expired token' } });
    }
  });
}

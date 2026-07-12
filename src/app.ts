import Fastify from 'fastify';
import cors from '@fastify/cors';
import rawBody from 'fastify-raw-body';
import { env } from './config/env.js';
import { registerRoutes } from './api/routes.js';
import { AppError } from './shared/errors.js';
import { captureError } from './monitoring/sentry.js';
import { verifyUserJwt } from './auth/jwt.js';
import { checkRateLimit } from './shared/rate-limit.js';

export async function buildApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, trustProxy: true });

  await app.register(cors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((item) => item.trim())
  });

  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: false,
    runFirst: true,
    routes: ['/api/webhooks/bridge']
  });

  app.addHook('preHandler', async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const decision = checkRateLimit({
      ip: request.ip,
      method: request.method,
      url: request.url,
      email: typeof body?.email === 'string' ? body.email : undefined
    });

    if (!decision) return;

    reply.header('X-RateLimit-Limit', String(decision.limit));
    reply.header('X-RateLimit-Remaining', String(decision.remaining));
    reply.header('X-RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));

    if (!decision.allowed) {
      reply.header('Retry-After', String(decision.retryAfterSeconds));
      return reply.code(429).send({
        error: {
          code: 'rate_limited',
          message: 'Too many requests. Please try again later.',
          retryAfterSeconds: decision.retryAfterSeconds
        }
      });
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!env.AUTH_REQUIRE_USER || !requiresUserAuth(request.method, request.url)) return;
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
    if (!token) {
      return reply.code(401).send({ error: { code: 'auth_required', message: 'Authentication required' } });
    }
    try {
      const payload = verifyUserJwt(token);
      const targetUserId = getTargetUserId(request);
      if (targetUserId && targetUserId !== payload.sub) {
        return reply.code(403).send({ error: { code: 'forbidden', message: 'You cannot access another user account' } });
      }
      (request as any).authUser = payload;
    } catch {
      return reply.code(401).send({ error: { code: 'invalid_token', message: 'Invalid or expired token' } });
    }
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/admin')) return;
    if (!env.ADMIN_API_KEY) return;
    const providedKey = request.headers['x-admin-api-key'];
    const adminKey = Array.isArray(providedKey) ? providedKey[0] : providedKey;
    if (adminKey !== env.ADMIN_API_KEY) {
      return reply.code(401).send({ error: { code: 'admin_auth_required', message: 'Admin API key is required' } });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        captureError(error, { requestId: request.id, url: request.url, method: request.method, code: error.code, details: error.details });
      }
      request.log.warn({ error: error.message, code: error.code, details: error.details });
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details } });
    }

    const err = error as Error & { statusCode?: number };
    const statusCode = err.statusCode ?? 500;
    captureError(err, { requestId: request.id, url: request.url, method: request.method });
    request.log.error(err);
    return reply.code(statusCode).send({
      error: {
        code: statusCode === 500 ? 'internal_server_error' : 'request_error',
        message: statusCode === 500 ? 'Internal server error' : err.message
      }
    });
  });

  await registerRoutes(app);
  return app;
}

function requiresUserAuth(method: string, url: string): boolean {
  if (url.startsWith('/api/admin')) return false;
  if (url.startsWith('/api/auth')) return false;
  if (method === 'POST' && url === '/api/users') return false;

  if (url === '/api/customers') return true;

  const protectedPatterns = [
    /^\/api\/customers\//,
    /^\/api\/customers\/kyc-link/,
    /^\/api\/external-accounts/,
    /^\/api\/withdrawals/,
    /^\/api\/users\/[^/]+\/external-accounts/,
    /^\/api\/users\/[^/]+\/withdrawals/,
    /^\/api\/users\/[^/]+\/deposit-addresses/,
    /^\/api\/deposit-addresses\//
  ];
  return protectedPatterns.some((pattern) => pattern.test(url));
}

function getTargetUserId(request: any): string | undefined {
  const params = request.params as Record<string, string> | undefined;
  const body = request.body as Record<string, unknown> | undefined;
  return params?.userId || (typeof body?.userId === 'string' ? body.userId : undefined);
}
